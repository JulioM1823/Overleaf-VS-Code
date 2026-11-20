const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const noop=()=>{};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function uri(text,scheme='file'){return {scheme,toString:()=>text};}
function fixture(){
    const a=uri('/a/main.tex'),b=uri('/b/chapter.tex'),outside=uri('/unlinked/main.tex');
    const remoteA=uri('remote-a','overleaf-workshop'),remoteB=uri('remote-b','overleaf-workshop');
    const rootA=uri('/a'),rootB=uri('/b');
    const bindings=new Map([[a,{mode:'localReplica',workspaceRootUri:rootA,overleafProjectUri:remoteA,overleafUri:remoteA}],
        [b,{mode:'localReplica',workspaceRootUri:rootB,overleafProjectUri:remoteB,overleafUri:remoteB}]]);
    bindings.set(rootA,bindings.get(a));bindings.set(rootB,bindings.get(b));
    const commands=[];
    const disposable=()=>({dispose:noop});
    const vscode={DiagnosticSeverity:{Error:0,Warning:1,Information:2},StatusBarAlignment:{Left:0},l10n:{t:x=>x},Uri:{parse:()=>remoteA},
        window:{activeTextEditor:{document:{uri:b}},createStatusBarItem:()=>({dispose:noop}),showWarningMessage:async()=>{}},
        languages:{createDiagnosticCollection:()=>({dispose:noop})},
        workspace:{workspaceFolders:[{uri:rootA},{uri:rootB}],saveAll:async()=>true,onDidSaveTextDocument:disposable},
        commands:{registerCommand:disposable,getCommands:async()=>['latex-workshop.build'],executeCommand:async(...args)=>{commands.push(args);return true;}}};
    const exports={};
    const mocks={vscode,path,'../consts':{ROOT_NAME:'overleaf-workshop'},
        '../core/projectWorkspaceBinding':{
            resolveProjectDocumentBinding:async target=>bindings.get(target),
            resolveProjectWorkspaceBindingForUri:async target=>bindings.get(target),
            resolveActiveProjectWorkspaceBinding:async()=>bindings.get(vscode.window.activeTextEditor?.document.uri)??bindings.get(a)},
        '../scm/localReplicaSCM':{LocalReplicaSCMProvider:{readSettings:async()=>({uri:'wrong-first-project'})}},
        '../utils/diagnostics':{logDiagnostic:noop,registerDiagnosticStateProvider:disposable,startDiagnosticSpan:()=>({end:noop,fail:noop})},
        '../utils/eventBus':{EventBus:{on:disposable}}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../out/compile/compileManager.js'),'utf8'),{exports,require:name=>mocks[name]??{},setTimeout,clearTimeout});
    const manager=new exports.CompileManager({prefetch:async()=>({isOfflineMode:false})});manager.update=async()=>{};
    return {a,b,outside,rootA,rootB,remoteA,remoteB,vscode,commands,manager,CompileManager:exports.CompileManager};
}
test('compile checks resolve explicit and active local files against their own project binding',async()=>{
    const f=fixture();assert.equal(await f.CompileManager.check(f.b),f.remoteB);
    assert.equal(await f.CompileManager.check(),f.remoteB);assert.equal(await f.CompileManager.check(f.a),f.remoteA);
    assert.equal(await f.CompileManager.check(f.outside),undefined);
    delete f.vscode.window.activeTextEditor;assert.equal(await f.CompileManager.check(),f.remoteA);
});
test('local compile eligibility and offline fallback reject unrelated files and mismatched active replicas',async()=>{
    const f=fixture();assert.equal(await f.manager.shouldPreferLocalReplicaCompileTarget(f.b),true);
    assert.equal(await f.manager.shouldPreferLocalReplicaCompileTarget(f.outside),false);
    assert.equal(await f.manager.tryOfflineLocalReplicaCompileFallback(f.a),false);
    assert.equal(await f.manager.tryOfflineLocalReplicaCompileFallback(f.outside),false);
    assert.equal(await f.manager.tryOfflineLocalReplicaCompileFallback(f.b),true);
    assert.equal(f.commands.length,1);
});
test('an editor switch during local command discovery cannot build the other project',async()=>{
    const f=fixture();let finish;f.vscode.commands.getCommands=()=>new Promise(resolve=>{finish=resolve;});
    const building=f.manager.tryOfflineLocalReplicaCompileFallback(f.b);await tick();
    f.vscode.window.activeTextEditor={document:{uri:f.a}};finish(['latex-workshop.build']);
    assert.equal(await building,false);assert.equal(f.commands.length,0);
});
test('remote compile stays bound to the captured editor while asynchronous preparation runs',async()=>{
    const f=fixture();f.vscode.window.activeTextEditor={document:{uri:f.remoteB}};
    let finish,target;f.manager.shouldPreferLocalReplicaCompileTarget=()=>new Promise(resolve=>{finish=resolve;});
    f.manager.prepareForRemoteCompile=async uri=>{target=uri;return 'blocked';};
    const compiling=f.manager.compile(true);await tick();
    f.vscode.window.activeTextEditor={document:{uri:f.remoteA}};finish(false);await compiling;
    assert.equal(target,f.remoteB);
});
test('no-editor local-replica builds preserve the workspace fallback',async()=>{
    const f=fixture();delete f.vscode.window.activeTextEditor;f.vscode.workspace.workspaceFolders=[{uri:f.rootA}];
    await f.manager.compile(true);assert.equal(f.commands.length,1);
    assert.equal(f.commands[0][0],'latex-workshop.build');
});
test('no-editor local builds reject ambiguous multi-root command targets',async()=>{
    const f=fixture();delete f.vscode.window.activeTextEditor;
    assert.equal(await f.manager.tryOfflineLocalReplicaCompileFallback(f.b),false);assert.equal(f.commands.length,0);
});
test('no-editor local build cannot follow a different workspace after command discovery',async()=>{
    const f=fixture();delete f.vscode.window.activeTextEditor;f.vscode.workspace.workspaceFolders=[{uri:f.rootB}];
    let finish;f.vscode.commands.getCommands=()=>new Promise(resolve=>{finish=resolve;});
    const building=f.manager.tryOfflineLocalReplicaCompileFallback(f.b);await tick();
    f.vscode.workspace.workspaceFolders=[{uri:f.rootA}];finish(['latex-workshop.build']);
    assert.equal(await building,false);assert.equal(f.commands.length,0);
});
test('queued automatic compilation retains its original target after the editor switches',async()=>{
    const f=fixture();f.vscode.window.activeTextEditor={document:{uri:f.remoteB}};f.manager.inCompiling=true;
    await f.manager.compile(false,{source:'save'});f.vscode.window.activeTextEditor={document:{uri:f.remoteA}};
    assert.equal(f.manager.pendingCompileRequest.options.targetUri,f.remoteB);f.manager.clearPendingCompileRequests();
});
test('rapid manual compilation cannot enter two asynchronous preflight pipelines',async()=>{
    const f=fixture();f.vscode.window.activeTextEditor={document:{uri:f.remoteB}};
    let finish,started=0;const gate=new Promise(resolve=>{finish=resolve;});
    f.manager.prepareForRemoteCompile=async()=>{started++;return gate;};
    const first=f.manager.compile(true);await tick();const second=f.manager.compile(true);await tick();
    try {assert.equal(started,1);} finally {finish('blocked');await Promise.all([first,second]);f.manager.clearPendingCompileRequests();}
});
test('automatic requests queue behind preflight with their captured project target',async()=>{
    const f=fixture();f.vscode.window.activeTextEditor={document:{uri:f.remoteB}};
    let finish,started=0;const gate=new Promise(resolve=>{finish=resolve;});
    f.manager.prepareForRemoteCompile=async()=>{started++;return gate;};
    const first=f.manager.compile(true);await tick();f.vscode.window.activeTextEditor={document:{uri:f.remoteA}};
    const second=f.manager.compile(false,{source:'save'});await tick();
    try {assert.equal(started,1);assert.equal(f.manager.pendingCompileRequest.options.targetUri,f.remoteA);}
    finally {finish('blocked');await Promise.all([first,second]);f.manager.clearPendingCompileRequests();}
});
test('disposal during automatic preflight cannot resurrect retries, status updates or new compile requests',async()=>{
    const f=fixture();f.vscode.window.activeTextEditor={document:{uri:f.remoteB}};
    let finish,started=0,renders=0;const gate=new Promise(resolve=>{finish=resolve;});
    f.manager.prepareForRemoteCompile=async()=>{started++;return gate;};f.manager.update=async()=>{renders++;};
    const triggers=f.manager.triggers;const compiling=f.manager.compile(false,{source:'save'});await tick();
    triggers.forEach(trigger=>trigger.dispose());finish('blocked');await compiling;
    try {
        assert.equal(f.manager.pendingCompileRequest,undefined);assert.equal(f.manager.pendingCompileRetryTimer,undefined);
        assert.equal(renders,0);await f.manager.compile(true);assert.equal(started,1);
    } finally {f.manager.clearPendingCompileRequests();}
});
