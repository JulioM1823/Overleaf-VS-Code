const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const authState = {authenticate:async()=>({}),assertActiveServerSession:()=>{},updateServerIdentity:async()=>true};
const blockedServices = new Set(['../collaboration/clientManager', '../collaboration/chatViewProvider', '../scm/scmCollectionProvider', '../utils/globalStateManager', './projectWorkspaceBinding', '../offline/projectOfflineStore', '../collaboration/projectChatSession', '../offline/documentSyncJournal', '../comments/commentDiagnostics']);
const vscode = {
    l10n:{t:message=>message},
    Disposable: class {},
    EventEmitter: class {fire(){} event(){return {dispose(){}};}},
    workspace: {textDocuments: [], getConfiguration: () => ({get: (_key, fallback) => fallback})},
    FileChangeType: {Changed: 1},
    FileSystemError: Object.fromEntries(['NoPermissions','Unavailable','FileExists','FileNotFound'].map(name => [name, message => new Error(`${name}: ${message}`)])),
};
Module._load = function(request, parent, main) {
    if (request==='vscode') return vscode;
    if (request==='../utils/globalStateManager') return {GlobalStateManager:authState};
    if (parent?.filename?.endsWith('/core/remoteFileSystemProvider.js') && blockedServices.has(request)) return {};
    return originalLoad.call(this, request, parent, main);
};
const {VirtualFileSystem, RemoteFileSystemProvider} = require('../out/core/remoteFileSystemProvider');

test('unscoped filesystem probes cannot create a socket or initialize a project', async t => {
    const original = VirtualFileSystem.create;
    t.after(()=>{VirtualFileSystem.create=original;});
    let creations=0;
    VirtualFileSystem.create=async()=>{creations++;return {projectName:'',serverName:'www.overleaf.com'};};
    const provider=Object.create(RemoteFileSystemProvider.prototype);
    Object.assign(provider,{vfss:new Map(),pendingVfss:new Map(),notify:()=>{}});
    for (const query of ['', 'user=u', 'project=p']) {
        await assert.rejects(provider.prefetch({scheme:'overleaf-workshop',authority:'www.overleaf.com',path:'/',query}),/FileNotFound/);
    }
    assert.equal(creations,0);assert.equal(provider.vfss.size,0);assert.equal(provider.pendingVfss.size,0);
    const valid={scheme:'overleaf-workshop',authority:'www.overleaf.com',path:'/Audit',query:'user=u&project=p'};
    const active=await provider.prefetch(valid);
    assert.equal(await provider.prefetch({...valid,path:'/Audit/main.tex'}),active);
    assert.equal(creations,1);
});

test('an ended VFS cannot use live socket credentials after the same account signs in again', async t => {
    const original = authState.authenticate;
    t.after(()=>{authState.authenticate=original;});
    authState.authenticate=()=>assert.fail('Ended sessions must not read credentials');
    const vfs=Object.create(VirtualFileSystem.prototype);
    Object.assign(vfs,{disposed:true,socket:{currentIdentity:{cookies:'sid=old',csrfToken:'old'}}});
    await assert.rejects(vfs.getAuthenticatedTransportIdentity('ended'),/session has ended/);
});

test('disposal during authentication cannot fall back to old live socket credentials', async t => {
    const original = authState.authenticate;
    t.after(()=>{authState.authenticate=original;});
    let release;
    authState.authenticate=()=>new Promise(resolve=>{release=resolve;});
    const vfs=Object.create(VirtualFileSystem.prototype);
    Object.assign(vfs,{disposed:false,socket:{currentIdentity:{cookies:'sid=old',csrfToken:'old'}}});
    const pending=vfs.getAuthenticatedTransportIdentity('delayed');
    vfs.disposed=true;release(undefined);
    await assert.rejects(pending,/session has ended/);
});

test('an active VFS retains live credentials when SecretStorage is temporarily unavailable', async t => {
    const original = authState.authenticate;
    t.after(()=>{authState.authenticate=original;});
    authState.authenticate=async()=>{throw new Error('keychain unavailable');};
    const identity={cookies:'sid=active',csrfToken:'active'};
    const vfs=Object.create(VirtualFileSystem.prototype);
    Object.assign(vfs,{disposed:false,socket:{currentIdentity:identity},logDiagnostic:()=>{}});
    assert.equal(await vfs.getAuthenticatedTransportIdentity('memory_fallback'),identity);
});
function fixture() {
    const vfs = Object.create(VirtualFileSystem.prototype);
    const doc = {_id: 'd', version: 4, remoteCache: 'base', localCache: 'base'};
    const effects = {baselines: [], persisted: [], recovery: 0};
    Object.assign(vfs, {
        socket: {applyOtUpdate: async () => {}, updateEventHandlers: handlers => {vfs.handlers=handlers;}},
        ensureDocumentTextInitialized: async () => ({doc, resolvedPath: '/main.tex'}),
        _resolveById: () => ({fileType: 'doc', fileEntity: doc, path: '/main.tex'}),
        markDocumentSyncDirty: async () => {},
        persistTextDocumentDraft: async (_uri, text) => effects.persisted.push(text),
        buildOfflineProjectState: () => ({text: doc.localCache}),
        offlineStore: {saveProjectState: async state => effects.persisted.push(state.text)},
        recordDocumentSyncBaseline: async state => effects.baselines.push(state),
        scheduleOfflineProjectStatePersist: () => {},
        toDocumentSyncRelPathFromProjectPath: p => p,
        buildTextUpdateHash: () => undefined,
        pendingLocalTextEchoes: new Map(),
        logDiagnostic: () => {},
        pathToUri: path => ({toString: () => path}),
        origin: {toString: () => 'origin'},
        notify: () => {}, applyCommentOps: () => {},
        requestRealtimeRecovery: async () => {effects.recovery++;},
    });
    return {vfs, doc, effects};
}
test('unconfirmed edits are durable before send and baselines wait for the committed acknowledgement', async () => {
    const {vfs, doc, effects} = fixture(); let commit;
    vfs.socket.applyOtUpdate = () => new Promise(resolve => {commit=resolve;});
    const pending = vfs.pushTextDocumentChanges({}, 'local change', 'test');
    while (!commit) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(effects.persisted, ['local change']);
    assert.equal(doc.remoteCache, 'base'); assert.equal(effects.baselines.length, 0);
    commit(); assert.deepEqual(await pending, {kind: 'applied'});
    assert.equal(doc.remoteCache, 'local change'); assert.equal(doc.version, 5);
    assert.equal(effects.baselines.length, 1);
});
test('a collaborator update during submission cannot be overwritten by a late acknowledgement', async () => {
    const {vfs, doc, effects} = fixture();
    vfs.socket.applyOtUpdate = async () => {doc.version=5;doc.remoteCache='remote change';};
    assert.deepEqual(await vfs.pushTextDocumentChanges({}, 'local change', 'test'), {kind: 'recovery-required'});
    assert.equal(doc.remoteCache, 'remote change'); assert.equal(doc.localCache, 'local change');
    assert.equal(doc.version, 5); assert.equal(effects.baselines.length, 0); assert.equal(effects.recovery, 1);
});
test('a revision change during durable draft persistence prevents submission against a stale base', async () => {
    const {vfs,doc,effects}=fixture();let sends=0;
    vfs.persistTextDocumentDraft=async()=>{doc.version=5;doc.remoteCache='remote';};
    vfs.socket.applyOtUpdate=async()=>{sends++;};
    assert.deepEqual(await vfs.pushTextDocumentChanges({},'local','test'),{kind:'recovery-required'});
    assert.equal(sends,0);assert.equal(effects.recovery,1);assert.equal(doc.remoteCache,'remote');assert.equal(doc.localCache,'local');
});
test('a committed acknowledgement preserves edits made while it was in flight', async () => {
    const {vfs,doc}=fixture();
    vfs.socket.applyOtUpdate=async()=>{doc.localCache='even newer local';};
    assert.deepEqual(await vfs.pushTextDocumentChanges({},'local','test'),{kind:'applied'});
    assert.equal(doc.localCache,'even newer local');assert.equal(doc.remoteCache,'local');assert.equal(doc.version,5);
});
test('stale remote metadata writes cannot roll recovery checkpoints backwards', async () => {
    const {vfs}=fixture();const record={relPath:'/main.tex',lastKnownRemoteVersion:9,lastKnownRemoteBlobId:'new',localDirty:true};
    const state={records:{'/main.tex':record}};
    vfs.writeDocumentSyncBlob=async()=> 'old';vfs.updateDocumentSyncState=async(_reason,_fields,update)=>update(state);
    await VirtualFileSystem.prototype.recordDocumentSyncRemoteState.call(vfs,{content:Buffer.from('old'),version:8,relPath:'/main.tex'});
    assert.deepEqual(state.records['/main.tex'],record);assert.equal(record.lastKnownRemoteBlobId,'new');
});
test('stale replica snapshots fail before submitting an overwrite', async () => {
    const {vfs, effects} = fixture();
    vfs.socket.applyOtUpdate = () => {throw new Error('must not send');};
    assert.deepEqual(await vfs.pushTextDocumentChanges({}, 'local', 'test', 'stale'), {kind: 'recovery-required'});
    assert.equal(effects.persisted.length, 0);
});

test('alternative buffering does not confirm a remote baseline or advance its revision', async () => {
    const {vfs, doc, effects} = fixture();
    vfs.socket.isUsingAlternativeConnectionScheme = true;
    assert.deepEqual(await vfs.pushTextDocumentChanges({}, 'local draft', 'test'), {kind: 'queued'});
    assert.equal(doc.remoteCache, 'base'); assert.equal(doc.version, 4);
    assert.equal(doc.localCache, 'local draft'); assert.equal(effects.baselines.length, 0);
    assert.deepEqual(effects.persisted, ['local draft']);
});

test('confirmed comment anchors advance the shared revision stream exactly once', async () => {
    const {vfs, doc} = fixture();
    await vfs.applyConfirmedCommentUpdate(doc, {doc:'d', v:4, op:[{p:0,c:'base',t:'thread'}]});
    assert.equal(doc.version,5); assert.equal(doc.lastVersion,4);
    vfs.socket.applyOtUpdate = async () => {doc.version=7;};
    await assert.rejects(vfs.applyConfirmedCommentUpdate(doc, {doc:'d',v:5,op:[]}), /advanced/);
    assert.equal(doc.version,7);
});

test('remote updates cannot overwrite an unconfirmed draft in a saved editor', () => {
    const {vfs, doc} = fixture();
    doc.localCache='local base'; vfs.remoteWatch();
    vfs.handlers.onFileChanged({doc:'d',v:4,op:[{p:4,i:' remote'}]});
    assert.equal(doc.remoteCache,'base remote'); assert.equal(doc.localCache,'local base remote');
});
test('malformed and out-of-order updates preserve recovery copies; duplicates do not advance revisions', () => {
    const {vfs, doc, effects} = fixture(); vfs.remoteWatch(); doc.localCache='unsaved';
    vfs.handlers.onFileChanged({doc:'d',v:4,op:[{p:0,d:'wrong'}]});
    assert.equal(doc.localCache,'unsaved'); assert.equal(doc.remoteCache,'base'); assert.equal(doc.version,4);
    vfs.handlers.onFileChanged({doc:'d',v:7,op:[{p:0,i:'remote'}]});
    assert.equal(doc.localCache,'unsaved'); assert.equal(doc.remoteCache,'base'); assert.equal(effects.recovery,2);
    vfs.handlers.onFileChanged({doc:'d',v:3,op:[{p:0,i:'duplicate'}]});
    assert.equal(effects.recovery,2); assert.equal(doc.version,4);
});
test('stale editor completion cannot roll an advanced remote revision backwards', () => {
    const {vfs, doc} = fixture();
    doc.version=6;doc.remoteCache='latest remote';doc.localCache='latest local';
    vfs.acceptRemoteTextUpdate('d','old remote','old local',5,'stale');
    assert.equal(doc.version,6); assert.equal(doc.remoteCache,'latest remote'); assert.equal(doc.localCache,'latest local');
});

test('a fresh document join restores durable drafts against their saved base', async () => {
    const {vfs} = fixture();
    const doc = {_id:'d'};
    vfs.socket.joinDoc = async () => ({docLines:['base remote'],version:8});
    vfs.getDocumentSyncRecord = async () => ({localDirty:true,localBlobId:'local',baseBlobId:'base'});
    vfs.readDocumentSyncBlob = async id => Buffer.from(id==='local' ? 'local base' : 'base');
    vfs.mergeHydratedCommentRangesWithPendingCreates = () => ({mergedRanges:[],preservedThreadIds:[]});
    vfs.setCommentRanges = () => {};
    await vfs.loadDocumentTextStateFromServer(doc,'/main.tex','restart');
    assert.equal(doc.localCache,'local base remote'); assert.equal(doc.remoteCache,'base remote');
    assert.equal(doc.recoveryRequired,false); assert.equal(doc.version,8);
});
test('overlapping durable drafts remain recoverable conflicts after restart', async () => {
    const {vfs} = fixture(); const doc = {_id:'d'};
    vfs.socket.joinDoc = async () => ({docLines:['ayc'],version:8});
    vfs.getDocumentSyncRecord = async () => ({localDirty:true,localBlobId:'local',baseBlobId:'base'});
    vfs.readDocumentSyncBlob = async id => Buffer.from(id==='local' ? 'axc' : 'abc');
    vfs.mergeHydratedCommentRangesWithPendingCreates = () => ({mergedRanges:[],preservedThreadIds:[]});
    vfs.setCommentRanges = () => {};
    await vfs.loadDocumentTextStateFromServer(doc,'/main.tex','restart');
    assert.equal(doc.localCache,'axc'); assert.equal(doc.remoteCache,'ayc'); assert.equal(doc.recoveryRequired,true);
});
test('a baseline acknowledgement cannot erase a newer local draft or regress its remote revision', async () => {
    const {vfs} = fixture();
    const state = {records:{'/main.tex':{relPath:'/main.tex',localDirty:true,localBlobId:'newer-local',lastKnownRemoteVersion:6}}};
    vfs.writeDocumentSyncBlob = async () => 'acknowledged-local';
    vfs.updateDocumentSyncState = async (_reason, _fields, update) => update(state);
    await VirtualFileSystem.prototype.recordDocumentSyncBaseline.call(vfs,{content:Buffer.from('old'),version:5,relPath:'/main.tex'});
    assert.equal(state.records['/main.tex'].lastKnownRemoteVersion,6);
    await VirtualFileSystem.prototype.recordDocumentSyncBaseline.call(vfs,{content:Buffer.from('old'),version:7,relPath:'/main.tex'});
    assert.equal(state.records['/main.tex'].localBlobId,'newer-local'); assert.equal(state.records['/main.tex'].localDirty,true);
});

function uri(path, project='p') {
    return {path,query:`user=u&project=${project}`,authority:'server',scheme:'overleaf-workshop',
        toString(){return `overleaf-workshop://server${path}?${this.query}`;},
        with(change){return uri(change.path ?? path,project);}};
}
function renameFixture() {
    const {vfs,doc,effects} = fixture();
    doc.name='old.tex';const from={_id:'from'}, to={_id:'to'};
    Object.assign(vfs, {
        ensureWritable(){},nextMutationAttemptId:()=>1,
        toDocumentSyncRelPath:()=>'/old.tex',getDocumentSyncState:async()=>({records:{}}),
        _resolveUri:async u=>u.path==='/project/old.tex'
            ? {fileType:'doc',fileEntity:doc,parentFolder:from,fileName:'old.tex'}
            : {parentFolder:to,fileName:u.path.split('/').pop()},
        removeEntity(){}, insertEntity(){},
        api:{moveEntity:async()=>({type:'success'}),renameEntity:async()=>({type:'success'})},
    });
    return {vfs,doc,effects,from,to};
}
test('rename-overwrite never deletes the destination before an unconfirmed mutation', async () => {
    const {vfs,doc}=renameFixture();let mutations=0;
    vfs.remove=async()=>{mutations++;};vfs.api.renameEntity=async()=>{mutations++;};
    vfs._resolveUri=async u=>({fileType:'doc',fileEntity:u.path.endsWith('old.tex')?doc:{_id:'target'},parentFolder:{}});
    await assert.rejects(vfs.rename(uri('/project/old.tex'),uri('/project/new.tex'),true), /atomically/);
    assert.equal(mutations,0);
});
test('combined moves rename on the server, and failed second steps report the intermediate state', async () => {
    const {vfs,doc,effects}=renameFixture();const calls=[];
    vfs.api.moveEntity=async()=>{calls.push('move');return {type:'success'};};
    vfs.api.renameEntity=async()=>{calls.push('rename');return {type:'error'};};
    await assert.rejects(vfs.rename(uri('/project/old.tex'),uri('/project/folder/new.tex'),false), /file moved/);
    assert.deepEqual(calls,['move','rename']);assert.equal(doc.name,'old.tex');assert.equal(effects.recovery,1);
});
test('renaming pending drafts and moving across accounts/projects are rejected before requests', async () => {
    const {vfs}=renameFixture();
    vfs.getDocumentSyncState=async()=>({records:{'/old.tex':{relPath:'/old.tex',localDirty:true}}});
    vfs.api.moveEntity=async()=>assert.fail('must not move pending work');
    await assert.rejects(vfs.rename(uri('/project/old.tex'),uri('/project/folder/new.tex'),false),/pending document changes/);
    const provider=Object.create(RemoteFileSystemProvider.prototype);
    provider.getVFS=()=>assert.fail('must not open wrong project');
    assert.throws(()=>provider.rename(uri('/project/old.tex'),uri('/project/new.tex','other'),{overwrite:true}),/projects or accounts/);
});
test('a missing pending draft blob blocks hydration instead of adopting the server snapshot', async () => {
    const {vfs,doc}=fixture();
    vfs.socket.joinDoc=async()=>({docLines:['remote'],version:8});
    vfs.getDocumentSyncRecord=async()=>({localDirty:true,localBlobId:'missing'});
    vfs.readDocumentSyncBlob=async()=>undefined;
    await assert.rejects(vfs.loadDocumentTextStateFromServer(doc,'/main.tex','test'), /blob is missing/);
    assert.equal(doc.remoteCache,'base');
});

test('a delayed or stale join cannot roll a concurrently advanced document backwards', async () => {
    const {vfs,doc}=fixture();
    vfs.getDocumentSyncRecord=async()=>undefined;
    vfs.socket.joinDoc=async()=>{doc.version=6;doc.remoteCache='new remote';return {docLines:['stale'],version:5};};
    await assert.rejects(vfs.loadDocumentTextStateFromServer(doc,'/main.tex','test'),/advanced during join/);
    assert.equal(doc.version,6);assert.equal(doc.remoteCache,'new remote');
    vfs.socket.joinDoc=async()=>({docLines:['old'],version:4});
    await assert.rejects(vfs.loadDocumentTextStateFromServer(doc,'/main.tex','test'),/Stale document join/);
    assert.equal(doc.version,6);
});
test('history discovery converges on distant revisions without unsafe numeric probes',async()=>{
    const {vfs}=fixture();const latest=1000000;let requests=0;
    vfs.getFileTreeDiff=async(start,end)=>{requests++;assert.equal(start,end);assert.ok(Number.isSafeInteger(start));return start<=latest?{diff:[]}:undefined;};
    assert.equal(await vfs.getCurrentVersion(),latest);assert.ok(requests<45);
    vfs.currentVersion=Number.MAX_SAFE_INTEGER-5;
    const high=vfs.currentVersion;
    vfs.getFileTreeDiff=async start=>{assert.ok(Number.isSafeInteger(start));return start<=high?{diff:[]}:undefined;};
    assert.equal(await vfs.getCurrentVersion(),high);
});
test('a server accepting every history probe cannot create an infinite request loop',async()=>{
    const {vfs}=fixture();vfs.currentVersion=4;let requests=0;
    vfs.getFileTreeDiff=async start=>{requests++;assert.ok(Number.isSafeInteger(start));return {diff:[]};};
    await assert.rejects(vfs.getCurrentVersion(),/upper revision bound/);assert.ok(requests<60);assert.equal(vfs.currentVersion,4);
});
test('a connection failure cannot restore the older submission over a newer local draft',async()=>{
    const {vfs,doc}=fixture();vfs.transitionToOfflineMode=async()=>{};
    vfs.socket.applyOtUpdate=async()=>{doc.localCache='newer local draft';throw new Error('ECONNRESET');};
    assert.deepEqual(await vfs.pushTextDocumentChanges({},'submitted','test'),{kind:'offline'});
    assert.equal(doc.localCache,'newer local draft');assert.equal(doc.remoteCache,'base');assert.equal(doc.version,4);
});
test('delayed dirty-state writes preserve a newer remote checkpoint and local draft',async()=>{
    const {vfs}=fixture();const remoteSnapshot={hash:'latest',size:6};
    const state={records:{'/main.tex':{relPath:'/main.tex',baseBlobId:'original-base',localBlobId:'newer-local',
        lastKnownRemoteVersion:9,lastKnownRemoteSnapshot:remoteSnapshot,localDirty:true}}};
    vfs.writeDocumentSyncBlob=async()=> 'old-base';vfs.updateDocumentSyncState=async(_reason,_fields,update)=>update(state);
    await VirtualFileSystem.prototype.markDocumentSyncDirty.call(vfs,{baseContent:Buffer.from('old'),baseVersion:4,
        lastKnownRemoteContent:Buffer.from('old'),lastKnownRemoteVersion:4,relPath:'/main.tex',reason:'late'});
    const record=state.records['/main.tex'];assert.equal(record.lastKnownRemoteVersion,9);
    assert.deepEqual(record.lastKnownRemoteSnapshot,remoteSnapshot);assert.equal(record.localBlobId,'newer-local');assert.equal(record.baseBlobId,'original-base');
});
test('newer drafts are ordered after an in-flight conflict checkpoint and remain the latest recovery text',async()=>{
    const {vfs}=fixture();const state={records:{}};let release,firstBlob=true;
    const gate=new Promise(resolve=>{release=resolve;});
    vfs.toDocumentSyncRelPath=()=>'/main.tex';
    vfs.writeDocumentSyncBlob=async bytes=>{if(firstBlob){firstBlob=false;await gate;}return require('node:crypto').createHash('sha256').update(bytes).digest('hex');};
    vfs.updateDocumentSyncState=async(_reason,_fields,update)=>update(state);
    const conflict=VirtualFileSystem.prototype.recordDocumentSyncConflict.call(vfs,{
        baseContent:Buffer.from('base'),localContent:Buffer.from('old local'),remoteContent:Buffer.from('remote'),
        baseVersion:4,lastKnownRemoteVersion:5,relPath:'/main.tex',reason:'test'});
    await new Promise(resolve=>setImmediate(resolve));
    const draft=VirtualFileSystem.prototype.persistTextDocumentDraft.call(vfs,{},'newer local','base');
    release();await Promise.all([conflict,draft]);
    const hash=text=>require('node:crypto').createHash('sha256').update(text).digest('hex');
    assert.equal(state.records['/main.tex'].localBlobId,hash('newer local'));
    assert.equal(state.records['/main.tex'].conflict.localBlobId,hash('old local'));
    assert.equal(state.records['/main.tex'].localDirty,true);
});
test('older conflict snapshots cannot regress a newer remote checkpoint',async()=>{
    const {vfs}=fixture();const snapshot={hash:'latest',size:6};const state={records:{'/main.tex':{
        relPath:'/main.tex',lastKnownRemoteVersion:9,lastKnownRemoteSnapshot:snapshot,localDirty:true}}};
    vfs.writeDocumentSyncBlob=async bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    vfs.updateDocumentSyncState=async(_reason,_fields,update)=>update(state);
    await VirtualFileSystem.prototype.recordDocumentSyncConflict.call(vfs,{localContent:Buffer.from('local'),remoteContent:Buffer.from('old'),
        lastKnownRemoteVersion:6,relPath:'/main.tex',reason:'test'});
    assert.equal(state.records['/main.tex'].lastKnownRemoteVersion,9);assert.deepEqual(state.records['/main.tex'].lastKnownRemoteSnapshot,snapshot);
    assert.ok(state.records['/main.tex'].conflict.remoteBlobId);
});

test('a disconnect during initialization resumes recovery after initialization settles', async t => {
    const vfs=Object.create(VirtualFileSystem.prototype);const recoveryCalls=[];
    Object.assign(vfs,{disposed:false,root:{rootDoc_id:'d'},bootstrapSource:'socket',readonlyMode:false,
        deferredSynchronizationMode:'online',connectionPhase:'recovering',bootstrapAttemptId:0,
        loadDeferredSynchronizationQueue:async()=>{},restorePersistedChatStateForInitialization:async()=>{},
        clearRecoveryTimer:()=>{},setConnectionPhase:()=>{},logDiagnostic:()=>{},
        bootstrapProject:async()=>({rootDoc_id:'d'}),
        finishInitialization:async project=>{vfs.pendingRecoveryReason='socket_disconnect';return project;},
        socket:{isConnected:false},scheduleRecovery:reason=>recoveryCalls.push(reason)});
    const pending=vfs.createInitializationPromise('socket_disconnect',{allowFallback:false,
        autoCompileAfterInitialization:false,preserveRoot:true,showReloadPrompt:false});
    vfs.initializing=pending;await pending;
    assert.equal(vfs.initializing,undefined);
    assert.deepEqual(recoveryCalls,['socket_disconnect'],'Queued disconnect must not be stranded in online mode');
});
test('disposal prevents queued reconnect work from creating another timer or socket', t => {
    const vfs=Object.create(VirtualFileSystem.prototype);
    Object.assign(vfs,{disposed:true,retryConnection:1,logDiagnostic:()=>{},setConnectionPhase:()=>{}});
    t.mock.method(global,'setTimeout',()=>assert.fail('Disposed projects must not reconnect'));
    vfs.scheduleRecovery('socket_disconnect');
});

test('intentional alternative mode does not create an endless realtime reconnect loop', async () => {
    const vfs=Object.create(VirtualFileSystem.prototype);const recoveryCalls=[];
    Object.assign(vfs,{disposed:false,root:{rootDoc_id:'d'},bootstrapSource:'socket',readonlyMode:false,
        deferredSynchronizationMode:'online',connectionPhase:'invisible',bootstrapAttemptId:0,pendingRecoveryReason:'toggle_invisible_mode',
        loadDeferredSynchronizationQueue:async()=>{},restorePersistedChatStateForInitialization:async()=>{},
        clearRecoveryTimer:()=>{},setConnectionPhase:()=>{},logDiagnostic:()=>{},
        bootstrapProject:async()=>({rootDoc_id:'d'}),finishInitialization:async project=>project,
        socket:{isConnected:false,isUsingAlternativeConnectionScheme:true},scheduleRecovery:reason=>recoveryCalls.push(reason)});
    const pending=vfs.createInitializationPromise('toggle_invisible_mode',{allowFallback:false,
        autoCompileAfterInitialization:false,preserveRoot:true,showReloadPrompt:false});
    vfs.initializing=pending;await pending;
    assert.deepEqual(recoveryCalls,[]);
});
test('short-lived accepted connections retain backoff until a stable session', t => {
    const {vfs}=fixture();let now=0;const recovery=[];
    t.mock.method(Date,'now',()=>now);
    Object.assign(vfs,{root:{},disposed:false,retryConnection:3,
        deferredSynchronizationMode:'online',deferredSynchronizationQueue:{operations:[]},
        clearRecoveryTimer:()=>{},setConnectionPhase:()=>{},scheduleRecovery:reason=>recovery.push(reason),
        chatSession:{handleConnectionRestored:()=>{}},refreshCommentStateAfterConnectionRestored:async()=>{}});
    vfs.remoteWatch();vfs.handlers.onConnectionAccepted('first');now=1;vfs.handlers.onDisconnected();
    assert.equal(vfs.retryConnection,4);
    now=10;vfs.handlers.onConnectionAccepted('second');now=11;vfs.handlers.onDisconnected();
    assert.equal(vfs.retryConnection,5);
    now=20;vfs.handlers.onConnectionAccepted('stable');now=60020;vfs.handlers.onDisconnected();
    assert.equal(vfs.retryConnection,1);assert.equal(recovery.length,3);
});

function commentDeletionFixture(mode='online') {
    const vfs=Object.create(VirtualFileSystem.prototype), requests=[],operations=[];
    const thread={messages:[{id:'root',content:'root',user_id:'u'},{id:'reply',content:'reply',user_id:'u'}]};
    Object.assign(vfs,{context:{},serverName:'server',userId:'u',projectId:'p',deferredSynchronizationMode:mode,
        commentThreadAliases:new Map(),commentThreads:new Map([['t',thread]]),commentThreadsFetchSequence:0,
        commentRangesByDocId:new Map([['d',[{op:{t:'t',c:'anchor',p:0}}]]]),
        getCommentThreadPermissions:()=>({canDeleteThread:true}),
        _resolveById:()=>({fileType:'doc',path:'/main.tex'}),
        _resolveUri:async()=>({fileType:'doc',fileEntity:{_id:'d'}}),pathToUri:path=>({toString:()=>path}),
        removeCommentThread:id=>{vfs.commentThreads.delete(id);vfs.commentRangesByDocId.set('d',[]);},
        upsertCommentThread:(id,value)=>vfs.commentThreads.set(id,value),
        restoreCommentRangeSnapshotsForThreadId:(_id,snapshots)=>vfs.commentRangesByDocId.set('d',snapshots.map(s=>s.range)),
        appendDeferredSynchronizationOperation:async operation=>operations.push(operation),
        api:{deleteCommentThread:async(...args)=>{requests.push(args);return {type:'success'};},
            deleteCommentMessage:async()=>assert.fail('Root deletion must remove the document anchor'),
            deleteOwnCommentMessage:async()=>assert.fail('Root deletion must remove the document anchor')},
    });
    return {vfs,requests,operations,thread};
}
test('root comment deletion uses the document-scoped thread endpoint and removes its replies and anchor',async()=>{
    const {vfs,requests}=commentDeletionFixture();
    assert.equal(await vfs.deleteComment('t','root',false),'thread');
    assert.deepEqual(requests.map(r=>r.slice(1)),[['p','d','t']]);
    assert.equal(vfs.commentThreads.has('t'),false);assert.equal(vfs.commentRangesByDocId.get('d').length,0);
});
test('offline root deletion queues one first-class thread deletion with the document ID',async()=>{
    const {vfs,operations,requests}=commentDeletionFixture('offline');
    assert.equal(await vfs.deleteComment('t','root',true),'thread');
    assert.equal(requests.length,0);assert.equal(operations.length,1);
    assert.equal(operations[0].kind,'comment.deleteThread');assert.deepEqual(operations[0].payload,{docId:'d',threadId:'t'});
});
test('missing thread or message state cannot select a destructive endpoint or remove an anchor',async()=>{
    const {vfs,requests,operations}=commentDeletionFixture();
    await assert.rejects(vfs.deleteComment('t','unknown',false),/comment is unavailable/);
    vfs.commentThreads.clear();
    await assert.rejects(vfs.deleteComment('t','root',false),/comment is unavailable/);
    assert.equal(requests.length,0);assert.equal(operations.length,0);
    assert.equal(vfs.commentRangesByDocId.get('d').length,1);
});
test('root deletion refuses a missing or unauthorized anchor and rolls back definitive server failures',async()=>{
    const {vfs,requests}=commentDeletionFixture();
    vfs.getCommentThreadPermissions=()=>({canDeleteThread:false});
    await assert.rejects(vfs.deleteComment('t','root',true),/current user/);assert.equal(requests.length,0);
    vfs.getCommentThreadPermissions=()=>({canDeleteThread:true});
    vfs._resolveById=()=>undefined;
    await assert.rejects(vfs.deleteComment('t','root',false),/anchor is unavailable/);assert.equal(requests.length,0);
    vfs._resolveById=()=>({fileType:'doc',path:'/main.tex'});
    vfs.api.deleteCommentThread=async()=>({type:'error',message:'403: forbidden'});
    await assert.rejects(vfs.deleteComment('t','root',false),/403/);
    assert.equal(vfs.commentThreads.get('t').messages.length,2);assert.equal(vfs.commentRangesByDocId.get('d').length,1);
});
test('a thread snapshot started before deletion cannot resurrect a deleted thread',async()=>{
    const {vfs,thread}=commentDeletionFixture();let finish;
    Object.assign(vfs,{deferredSynchronizationQueue:{operations:[]},connectionPhase:'live',commentsChangedEventSequence:1,logDiagnostic(){},isRecoveryInProgress:()=>false,
        api:{getCommentThreads:()=>new Promise(resolve=>{finish=resolve;})}});
    const fetch=vfs.ensureCommentThreadsLoaded(true);
    for(let i=0;!finish && i<20;i++) await new Promise(resolve=>setImmediate(resolve));
    assert.ok(finish,'Snapshot request must have started');
    vfs.commentThreads.delete('t');vfs.commentRangesByDocId.set('d',[]);vfs.commentsChangedEventSequence++;
    finish({type:'success',commentThreads:{t:thread}});await fetch;
    assert.equal(vfs.commentThreads.has('t'),false);
});
test('forced comment refreshes cannot roll back newer snapshots or clear another fetch ownership',async()=>{
    for(const olderFinishesFirst of [false,true]){
        const {vfs,thread}=commentDeletionFixture();const requests=[];
        Object.assign(vfs,{deferredSynchronizationQueue:{operations:[]},connectionPhase:'live',commentsChangedEventSequence:1,
            logDiagnostic(){},isRecoveryInProgress:()=>false,
            api:{getCommentThreads:()=>new Promise(resolve=>requests.push(resolve))}});
        const older=vfs.ensureCommentThreadsLoaded(true);
        while(requests.length<1) await new Promise(resolve=>setImmediate(resolve));
        const newer=vfs.ensureCommentThreadsLoaded(true);
        while(requests.length<2) await new Promise(resolve=>setImmediate(resolve));
        const newestLoading=vfs.commentThreadsLoading;
        if(olderFinishesFirst){
            requests[0]({type:'success',commentThreads:{t:thread}});await older;
            assert.equal(vfs.commentThreadsLoading,newestLoading);
        }
        requests[1]({type:'success',commentThreads:{}});await newer;
        if(!olderFinishesFirst){requests[0]({type:'success',commentThreads:{t:thread}});await older;}
        assert.equal(vfs.commentThreads.has('t'),false);
        assert.equal(vfs.commentThreadsLoading,undefined);
    }
});
