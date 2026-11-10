const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const root = path.resolve(__dirname, '../..');
const diagnostics = require(path.join(root, 'out/utils/diagnostics'));
const {GlobalStateManager} = require(path.join(root, 'out/utils/globalStateManager'));
const {getManagedDocumentState} = require(path.join(root, 'out/core/liveTextDocumentRegistry'));
exports.run = async () => {
 const reportPath = process.env.OVERLEAF_CONNECTION_REPORT;
 const projectId = process.env.OVERLEAF_TEST_PROJECT, userId = process.env.OVERLEAF_TEST_USER;
 const server = process.env.OVERLEAF_TEST_SERVER, projectName = process.env.OVERLEAF_TEST_PROJECT_NAME;
 assert(projectName?.startsWith('Overleaf Workshop Reliability Audit '));
 const started = Date.now(), timeline = [], samples = [], effects = [];
 const report = {status: 'running', mode: process.env.OVERLEAF_CONNECTION_MODE, effects, timeline, samples};
 const save = () => fs.writeFileSync(reportPath, JSON.stringify({...report, elapsedMs: Date.now()-started}, null, 2), {mode:0o600});
 const log = (event, data={}) => { timeline.push({elapsedMs:Date.now()-started,event,...data}); save(); };
 const observed = new WeakSet(), observerListeners=new WeakSet();
 const cleanups=[];
 const windowStateSubscription=vscode.window.onDidChangeWindowState(state=>log('window.focus_changed',{focused:state.focused}));
 cleanups.push(()=>windowStateSubscription.dispose());
 let vfs, second;
 function observe(api, label) {
  const socket=api.socket, transport=socket?.socket?.transport;
  if (!socket || observed.has(socket)) {return;}
  observed.add(socket);
  log('transport.observed',{label, session:api.getDiagnosticsState().sessionId, transport:transport?.name,
   heartbeatTimeoutMs:socket.socket?.heartbeatTimeout, closeTimeoutMs:socket.socket?.closeTimeout});
  const disconnected=reason=>log('transport.disconnect',{label,reason:reason==='booted'?'booted':'transport'});
  observerListeners.add(disconnected);socket.on('disconnect',disconnected);cleanups.push(()=>socket.removeListener('disconnect',disconnected));
  const ws=transport?.websocket;
  if(ws){
   const message=data=> { const type=String(data).split(':',1)[0];if(type==='2'){log('transport.heartbeat',{label});} };
   const close=code=>log('transport.close',{label,code});
   ws.on('message',message);ws.on('close',close);
   cleanups.push(()=>{ws.removeListener('message',message);ws.removeListener('close',close);});
  }
 }
 async function waitFor(predicate,label,timeout=90000){
  const until=Date.now()+timeout;
  while(Date.now()<until){if(await predicate()){return;}await new Promise(r=>setTimeout(r,100));}
  throw new Error(`Timed out: ${label}`);
 }
 const extension = vscode.extensions.getExtension(`${require(path.join(root,'package.json')).publisher}.overleaf-workshop`);
 assert.equal(fs.realpathSync(extension.extensionPath),fs.realpathSync(root));
 await extension.activate();
 diagnostics.configureDiagnostics({enabled:true,verbose:true,minLevel:'debug',maxBufferRecords:5000,consoleEnabled:false});
 diagnostics.setDiagnosticSink((_scope,_formatted,record)=> {
  if(/^(socket\.|join_project\.|recovery\.|init\.|bootstrap\.|connection\.)/.test(String(record.event))){
   timeline.push({elapsedMs:Date.now()-started,diagnostic:record});save();
  }
 });
 const sampleTimer=setInterval(()=>{
  if(!vfs)return;
  observe(vfs.socket,'primary');if(second)observe(second,'collaborator');
  samples.push({elapsedMs:Date.now()-started,phase:vfs.realtimeConnectionPhase,connected:vfs.socket.isConnected,
   initializing:!!vfs.initializing,recoveryTimer:!!vfs.recoveryTimer,retryConnection:vfs.retryConnection,
   session:vfs.socket.getDiagnosticsState().sessionId});
  save();
 },1000);
 try{
  const projectUri=vscode.Uri.from({scheme:'overleaf-workshop',authority:server,path:`/${projectName}`,
   query:new URLSearchParams({user:userId,project:projectId}).toString()});
  vfs=await vscode.commands.executeCommand('remoteFileSystem.prefetch',projectUri);
  await vfs.init({autoCompileAfterInitialization:false});
  assert(!vfs.socket.isUsingAlternativeConnectionScheme);
  if(process.env.OVERLEAF_CONNECTION_MODE==='upload'){
   const identity=await GlobalStateManager.authenticate(vfs.context,server,userId);
   const bytes=new Uint8Array([0,255,128,65,13,10]);
   const result=await vfs.api.uploadFile(identity,projectId,vfs.root.rootFolder[0]._id,`connection-audit-${Date.now()}.bin`,bytes);
   assert.equal(result.type,'success');assert.equal(result.entity._type,'file');
   const downloaded=await vfs.api.getFile(identity,projectId,result.entity._id);
   assert.equal(downloaded.type,'success');assert.deepEqual(Buffer.from(downloaded.content),Buffer.from(bytes));
   effects.push({scenario:'real-multipart-binary-upload-and-download',bytes:bytes.length,passed:true});
   report.status='passed';save();return;
  }
  observe(vfs.socket,'primary');
  const filename=process.env.OVERLEAF_CONNECTION_FILENAME || `connection-audit-${Date.now()}.tex`;
  assert(filename.startsWith('connection-audit-'));
  const uri=vfs.pathToUri('/'+filename);
  const baseline='\\documentclass{article}\n\\begin{document}\nConnection lifecycle audit.\n\\end{document}\n';
  try{await vfs.writeFile(uri,new Uint8Array(),true,false);}
  catch(error){if(error.code!=='FileExists'){throw error;}}
  const document=await vscode.workspace.openTextDocument(uri);await vscode.window.showTextDocument(document);
  const session=await vfs.ensureTextDocumentSession(uri),docId=session.docId;
  if(document.getText().length===0){
   const edit=new vscode.WorkspaceEdit();edit.insert(uri,new vscode.Position(0,0),baseline);assert(await vscode.workspace.applyEdit(edit));
  }
  log('scenario.ready',{filename});
  const initialSession=vfs.socket.getDiagnosticsState().sessionId;
  // Repeated real editor edits. Do not simulate the synchronization layer.
  for(let index=0;index<40;index++){
   const edit=new vscode.WorkspaceEdit();edit.insert(uri,document.positionAt(document.getText().length),`% active-${index}\n`);
   assert(await vscode.workspace.applyEdit(edit));await new Promise(r=>setTimeout(r,150));
  }
  await waitFor(async()=> {const s=await vfs.ensureTextDocumentSession(uri);return s.localText===s.remoteText;},'active edits settle');
  effects.push({scenario:'40-real-editor-edits',passed:true});log('scenario.active_complete');
  if(process.env.OVERLEAF_CONNECTION_MODE==='verify'){
   const originalFinish=vfs.finishInitialization.bind(vfs);let dropped=false;
   vfs.finishInitialization=async(...args)=>{const project=await originalFinish(...args);if(!dropped){dropped=true;vfs.socket.socket.socket.transport.onClose();log('injected.disconnect_during_initialization');}return project;};
   await vfs.requestRealtimeRecovery('document_version_mismatch');
   await waitFor(()=>dropped&&vfs.socket.isConnected&&!vfs.initializing&&getManagedDocumentState(uri)==='live','initialization disconnect recovers');
   vfs.finishInitialization=originalFinish;effects.push({scenario:'disconnect-during-initialization-automatic-recovery',passed:true});
   const otherUri=vfs.pathToUri(`/connection-audit-${Date.now()}-tab.tex`);
   await vfs.writeFile(otherUri,new Uint8Array(),true,false);const otherDoc=await vscode.workspace.openTextDocument(otherUri);
   for(let i=0;i<8;i++){await vscode.window.showTextDocument(otherDoc);await vscode.window.showTextDocument(document);}
   effects.push({scenario:'eight-editor-tab-switches',passed:true});log('scenario.background_window_ready');
  }
  const idleMs=Number(process.env.OVERLEAF_CONNECTION_IDLE_MS || 180000);
  const until=Date.now()+idleMs;while(Date.now()<until){await new Promise(r=>setTimeout(r,1000));}
  effects.push({scenario:'idle',durationMs:idleMs,connected:vfs.socket.isConnected,phase:vfs.realtimeConnectionPhase,
   initialSession,finalSession:vfs.socket.getDiagnosticsState().sessionId});log('scenario.idle_complete');
  if(process.env.OVERLEAF_CONNECTION_MODE==='reproduce'){
   const primaryId=vfs.publicId;
   const runtime=await GlobalStateManager.initSocketIOAPI(vfs.context,server,projectId,userId);second=runtime.socket;
   second.socketConnectionTarget={...vfs.socket.socketConnectionTarget};await second.prepareForJoin();await second.joinProject(projectId);
   effects.push({scenario:'cross-client-acceptance',reproduced:vfs.publicId!==primaryId});
   const originalFinish=vfs.finishInitialization.bind(vfs);let dropped=false;
   vfs.finishInitialization=async(...args)=>{const project=await originalFinish(...args);if(!dropped){dropped=true;vfs.socket.socket.socket.transport.onClose();log('injected.disconnect_during_initialization');}return project;};
   await vfs.requestRealtimeRecovery('document_version_mismatch');
   await waitFor(()=>dropped&&!vfs.initializing,'drop during initialization observed');
   await new Promise(r=>setTimeout(r,3000));
   const stranded=!vfs.socket.isConnected&&!vfs.recoveryTimer&&!vfs.initializing;
   effects.push({scenario:'disconnect-during-initialization',reproduced:stranded,phase:vfs.realtimeConnectionPhase});
   assert(stranded,'Expected pre-fix initialization disconnect to stall recovery');report.status='reproduced';save();return;
  }
  if(process.env.OVERLEAF_CONNECTION_MODE!=='observe'){
   // Independent client must not reset the primary connection/public ID.
   const primaryId=vfs.publicId;const primarySession=vfs.socket.getDiagnosticsState().sessionId;
   const primaryRaw=vfs.socket.socket;const listenerCounts=socket=>({disconnect:socket.listeners('disconnect').filter(f=>!observerListeners.has(f)).length,otUpdateApplied:socket.listeners('otUpdateApplied').length});
   const beforeListeners=listenerCounts(primaryRaw);
   const runtime=await GlobalStateManager.initSocketIOAPI(vfs.context,server,projectId,userId);second=runtime.socket;
   second.socketConnectionTarget={...vfs.socket.socketConnectionTarget};await second.prepareForJoin();await second.joinProject(projectId);
   await second.joinDoc(docId);assert.equal(vfs.publicId,primaryId,'Second client must not replace primary public ID');
   effects.push({scenario:'isolated-client-acceptance',passed:true});
   const continuousStarted=Date.now();
   for(let index=0;index<120;index++){
    const edit=new vscode.WorkspaceEdit();edit.insert(uri,document.positionAt(document.getText().length),`% continuous-${index}\n`);
    assert(await vscode.workspace.applyEdit(edit));await new Promise(r=>setTimeout(r,500));
   }
   await waitFor(async()=> (await second.joinDoc(docId)).docLines.join('\n')===document.getText(),'continuous edits settle on collaborator');
   effects.push({scenario:'120-continuous-editor-edits',durationMs:Date.now()-continuousStarted,passed:true});
   const remote=await second.joinDoc(docId);
   await second.applyOtUpdate(docId,{doc:docId,v:remote.version,op:[{p:0,i:'% collaborator soak marker\n'}]});
   await waitFor(()=>document.getText().startsWith('% collaborator soak marker\n'),'collaborator edit arrives exactly once');
   assert.equal(document.getText().split('% collaborator soak marker').length-1,1);
   effects.push({scenario:'bidirectional-collaborator-edit',passed:true});
   for(let i=0;i<5;i++){
    const raw=vfs.socket.socket.socket.transport.websocket;assert(raw);raw.terminate();
    const edit=new vscode.WorkspaceEdit();edit.insert(uri,document.positionAt(document.getText().length),`% interruption-${i}\n`);
    assert(await vscode.workspace.applyEdit(edit));
    await waitFor(()=>vfs.socket.isConnected&&getManagedDocumentState(uri)==='live','automatic reconnect');
    await waitFor(async()=> (await second.joinDoc(docId)).docLines.join('\n')===document.getText(),'offline edit reaches server');
    const active=vfs.socket.socket;
    assert.equal(listenerCounts(active).disconnect,beforeListeners.disconnect,'Disconnect listener count must stay stable');
    assert.equal(active.listeners('otUpdateApplied').length,beforeListeners.otUpdateApplied,'OT listener count must stay stable');
    effects.push({scenario:'transport-termination-and-offline-edit',cycle:i,passed:true,listenersStable:true});
   }
   effects.push({scenario:'reconnect-generation-count',count:vfs.socket.getDiagnosticsState().sessionId-primarySession});
  }
  assert(vfs.socket.isConnected,'Idle leaves transport connected');
  report.status='passed';save();
 }catch(error){report.status='failed';report.reason=error.message;save();throw error;}
 finally{clearInterval(sampleTimer);cleanups.forEach(f=>f());second?.disconnect();await vfs?.flushPendingWrites();diagnostics.setDiagnosticSink(undefined);}
};
