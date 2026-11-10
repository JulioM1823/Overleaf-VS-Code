const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let choice;
const notices=[];
Module._load = function(request,parent,main) {
    if (request==='vscode') return {
        Disposable:class{},workspace:{textDocuments:[],onDidChangeConfiguration:()=>({dispose(){}}),getConfiguration:()=>({get:(_key,fallback)=>fallback})},
        Uri:{parse:value=>value},commands:{executeCommand:async()=>({getCurrentVersion:async()=>4})},
        l10n:{t:x=>x},ProgressLocation:{Window:10},window:{showWarningMessage:async()=>choice,
            showInformationMessage:async message=>notices.push(message),
            withProgress:async(_options,task)=>task({report(){}},{isCancellationRequested:false})},
    };
    return originalLoad.call(this,request,parent,main);
};
const {SocketIOAlt,SyncTimer} = require('../out/api/socketioAlt');
test('closing a document never implicitly uploads alternative-mode drafts', async () => {
    const socket=Object.create(SocketIOAlt.prototype);let acknowledged=false;
    socket.uploadToVFS=()=>assert.fail('implicit upload');
    socket.emit('leaveDoc','d',error=>{assert.equal(error,undefined);acknowledged=true;});
    assert.equal(acknowledged,true);
});
test('cancelled alternative uploads retain pending paths before any network access', async () => {
    const socket=Object.create(SocketIOAlt.prototype);
    socket.localChangesPath={'main.tex':{filename:'main.tex',parentFolderId:'root'}};
    choice=undefined;
    await assert.rejects(socket.uploadToVFS(),/cancelled/);
    assert.equal(socket.unSyncedChanges,1);
});
function uploadFixture(filename='main.tex') {
    const {EventEmitter}=require('node:events');
    const socket=Object.create(SocketIOAlt.prototype), calls=[], persisted=[], events=[];
    let content='pending local draft';
    Object.assign(socket,{projectId:'audit',identity:{},localChangesPath:{[filename]:{filename,parentFolderId:'root'}},
        _eventEmitter:new EventEmitter(),refreshVFS:async()=>{}});
    socket._eventEmitter.on('reciveNewDoc',(_folder,entity)=>events.push(entity));
    socket._vfs={pathToUri:path=>path,openFile:async()=>Buffer.from(content),
        persistTextDocumentDraft:async(...args)=>persisted.push(args),
        requestRealtimeRecovery:async()=>{calls.push({recovery:true});}};
    socket.api={uploadFile:async(_identity,_project,_folder,name,bytes)=>{
        calls.push({name,bytes:bytes.toString()});return {type:'success',entity:{_type:'doc',_id:'copy',name}};
    }};
    return {socket,calls,persisted,events,setContent:value=>{content=value;}};
}
test('recovery uploads create unique copies without changing the original base or pending draft',async()=>{
    choice='Upload recovery copies';const f=uploadFixture();
    await f.socket.uploadToVFS();await f.socket.uploadToVFS();
    assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].name,f.calls[1].name);
    assert.match(f.calls[0].name,/^main\.recovery-[a-f0-9-]+\.tex$/);
    assert.equal(f.calls[0].bytes,'pending local draft');assert.equal(f.events.length,2);
    assert.equal(f.socket.unSyncedChanges,1);assert.deepEqual(f.persisted,[]);
});
test('unknown copy-upload outcomes retain drafts and a retry uses a fresh name',async()=>{
    choice='Upload recovery copies';const f=uploadFixture();let previousName;
    const upload=f.socket.api.uploadFile;
    f.socket.api.uploadFile=async(...args)=>{previousName=args[3];throw new Error('response dropped after commit');};
    await assert.rejects(f.socket.uploadToVFS(),/1 uploads failed/);
    assert.equal(f.socket.unSyncedChanges,1);assert.deepEqual(f.persisted,[]);
    f.socket.api.uploadFile=upload;await f.socket.uploadToVFS();
    assert.notEqual(f.calls[0].name,previousName);assert.equal(f.socket.unSyncedChanges,1);
});
test('new recovery copies remain available when project history is unavailable',async()=>{
    choice='Upload recovery copies';const f=uploadFixture();
    f.socket.refreshVFS=()=>assert.fail('a new copy does not require a history preflight');
    f.socket.refreshPromise=Promise.reject(new Error('history temporarily unavailable'));
    await f.socket.uploadToVFS();
    assert.equal(f.events.length,1);assert.equal(f.socket.unSyncedChanges,1);
    assert.deepEqual(f.persisted,[]);
});
test('typing during explicit whole-file replacement remains pending and is persisted before the entity event',async()=>{
    choice='Upload changes';const f=uploadFixture();const upload=f.socket.api.uploadFile;
    f.socket.api.uploadFile=async(...args)=>{f.setContent('newer typing');return upload(...args);};
    f.socket._eventEmitter.on('reciveNewDoc',()=>assert.equal(f.persisted.length,1));
    await f.socket.uploadToVFS();
    assert.equal(f.calls[0].name,'main.tex');assert.equal(f.socket.unSyncedChanges,1);
    assert.deepEqual(f.persisted,[['main.tex','newer typing','pending local draft']]);
    assert.deepEqual(f.calls[1],{recovery:true});
});
test('recovery copy names are bounded for long Unicode names and unusually long suffixes',async()=>{
    choice='Upload recovery copies';
    for (const name of ['α'.repeat(140)+'.tex','😀'.repeat(70)+'.tex','name.'+'x'.repeat(140)]) {
        const f=uploadFixture(name);await f.socket.uploadToVFS();
        assert(f.calls[0].name.length<=150);assert.notEqual(f.calls[0].name,name);
        assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(f.calls[0].name));
    }
});
test('stopping an in-flight poll cannot schedule another timer', async () => {
    let finish;let calls=0;
    const timer=new SyncTimer(1000,()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
    timer.stop();finish();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1);assert.equal(timer.timer,undefined);
});
test('manual and periodic refreshes share a single in-flight request and retry after failure',async()=>{
    const socket=Object.create(SocketIOAlt.prototype);let finish,calls=0;
    socket.refreshVFSOnce=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
    const first=socket.refreshVFS(),second=socket.refreshVFS();
    assert.equal(first,second);assert.equal(calls,1);finish();await Promise.all([first,second]);
    socket.refreshVFSOnce=async()=>{calls++;throw new Error('temporary failure');};
    await assert.rejects(socket.refreshVFS(),/temporary/);
    socket.refreshVFSOnce=async()=>{calls++;};await socket.refreshVFS();assert.equal(calls,3);
});
test('double-clicked uploads share confirmation and work without duplicating mutations',async()=>{
    const socket=Object.create(SocketIOAlt.prototype);let finish,calls=0;
    socket.uploadToVFSOnce=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
    const first=socket.uploadToVFS(),second=socket.uploadToVFS();assert.equal(first,second);assert.equal(calls,1);
    finish();await first;socket.disconnected=true;
    await assert.rejects(socket.uploadToVFS(),/closed/);assert.equal(calls,1);
});
test('failed history reads retain the checkpoint so a later poll does not silently skip changes',async()=>{
    const socket=Object.create(SocketIOAlt.prototype);socket.vfsLocalVersion=4;socket.connectedUsers=[];
    socket._vfs={getCurrentVersion:async()=>5,getFileTreeDiff:async()=>undefined};
    await assert.rejects(socket.refreshVFS(),/checkpoint retained/);assert.equal(socket.vfsLocalVersion,4);
    socket._vfs.getFileTreeDiff=async()=>({diff:[]});await socket.refreshVFS();assert.equal(socket.vfsLocalVersion,5);
    socket._vfs.getCurrentVersion=async()=>3;
    await assert.rejects(socket.refreshVFS(),/stale/);assert.equal(socket.vfsLocalVersion,5);
});
test('a missing edited-document snapshot cannot advance the history checkpoint',async()=>{
    const socket=Object.create(SocketIOAlt.prototype);socket.vfsLocalVersion=4;socket.connectedUsers=[];
    socket._vfs={getCurrentVersion:async()=>5,getFileTreeDiff:async()=>({diff:[{operation:'edited',pathname:'main.tex'}]}),
        pathToUri:p=>({toString:()=>p}),_resolveUri:async()=>({fileId:'d',fileEntity:{version:4}}),openFile:async()=>Buffer.from('local')};
    socket.readDocSnapshot=async()=>undefined;
    await assert.rejects(socket.refreshVFS(),/Document history unavailable/);assert.equal(socket.vfsLocalVersion,4);
});
test('disconnect cancels bootstrap and prevents late refresh events and version writes',async()=>{
    const {EventEmitter}=require('node:events');const socket=Object.create(SocketIOAlt.prototype);const events=[];
    Object.assign(socket,{_eventEmitter:new EventEmitter(),watchConfigurationsDisposable:{dispose(){}},vfsRefreshTask:{stop(){}},
        connectedUsers:[],vfsLocalVersion:4});
    socket._eventEmitter.on('connect',()=>events.push('connect'));socket._eventEmitter.on('disconnect',()=>events.push('disconnect'));
    let finish;socket._vfs={getCurrentVersion:()=>new Promise(resolve=>{finish=resolve;})};
    socket.bootstrapTimer=setTimeout(()=>socket.emitEvent('connect'),10);
    const pending=socket.refreshVFS();await new Promise(resolve=>setImmediate(resolve));
    socket.disconnect();socket.disconnect();finish(5);await pending;
    assert.deepEqual(events,['disconnect']);assert.equal(socket.vfsLocalVersion,4);
});
test('polls wait for active full-file mutations to finish before reading changed entity state',async()=>{
    const socket=Object.create(SocketIOAlt.prototype);let finish,calls=0;
    socket.uploading=true;socket.uploadPromise=new Promise(resolve=>{finish=()=>{socket.uploading=false;socket.uploadPromise=undefined;resolve();};});
    socket.refreshVFSOnce=async()=>{calls++;};
    const pending=socket.refreshVFS();await Promise.resolve();assert.equal(calls,0);finish();await pending;assert.equal(calls,1);
});
test('alternative bootstrap waits for a valid project and shutdown cancels late connection events',async()=>{
    let project;const record=new Promise(resolve=>{project=resolve;});
    const socket=new SocketIOAlt('url',{}, {},'p',record);let connections=0;
    socket.on('connect',()=>{connections++;});
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(connections,0);
    socket.disconnect();project({name:'late'});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(connections,0);assert.equal(socket.bootstrapTimer,undefined);
});
test('rejected alternative bootstrap reports connection failure without an unhandled rejection',async()=>{
    const socket=new SocketIOAlt('url',{}, {},'p',Promise.reject(new Error('project unavailable')));
    let connected=false;socket.on('connect',()=>{connected=true;});
    await new Promise(resolve=>socket.on('connect_failed',resolve));
    assert.equal(connected,false);socket.disconnect();
});
