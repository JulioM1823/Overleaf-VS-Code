const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const noop = () => {};
const tick = () => new Promise(resolve=>setImmediate(resolve));
function fixture({registered=false,schemes={'file':true},update=async()=>{}}={}) {
    const timers=new Set(),updates=[],logs=[],handlers=new Map();
    const status={hidden:0,shown:0,text:'',hide(){this.hidden++;},show(){this.shown++;},dispose:noop};
    const disposable=(fn=noop)=>({dispose:fn});
    const vscode={Uri:{parse:value=>{const u=new URL(value);return {scheme:u.protocol.slice(0,-1),authority:u.host,path:u.pathname,query:u.search.slice(1)};}},l10n:{t:value=>value},Disposable:class {constructor(fn){this.dispose=fn;}},ConfigurationTarget:{Global:1},StatusBarAlignment:{Left:0},
        MarkdownString:class {constructor(value){this.value=value;}appendMarkdown(){}},
        workspace:{workspaceFolders:undefined,getConfiguration:()=>({has:()=>registered,get:()=>schemes,
            update:(...args)=>{updates.push(args);return update(...args);}}),onDidChangeWorkspaceFolders:()=>disposable()},
        window:{createStatusBarItem:()=>status,onDidChangeActiveTextEditor:()=>disposable()}};
    const exports={};const provider=class {get triggers(){return [];}};
    const mocks={'vscode':vscode,'../consts':{ROOT_NAME:'overleaf-workshop'},
        '../utils/eventBus':{EventBus:{on:(name,callback)=>{handlers.set(name,callback);return disposable();}}},
        '../core/projectWorkspaceBindingHelpers':require('../out/core/projectWorkspaceBindingHelpers'),
        '../utils/diagnostics':{logDiagnostic:(...args)=>logs.push(args)},
        './texDocumentSymbolProvider':{TexDocumentSymbolProvider:provider},'./texDocumentFormatProvider':{TexDocumentFormatProvider:provider},
        './langMisspellingCheckProvider':{MisspellingCheckProvider:provider},'./projectSearchProvider':{ProjectSearchProvider:provider},
        './langCompletionProvider':{CommandCompletionProvider:provider,ConstantCompletionProvider:provider,FilePathCompletionProvider:provider,ReferenceCompletionProvider:provider}};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../out/intellisense/langIntellisenseProvider.js'),'utf8'),
        {exports,require:name=>mocks[name]??{},setTimeout:fn=>{timers.add(fn);return fn;},clearTimeout:fn=>timers.delete(fn)});
    const vfs={getSpellCheckLanguage:()=>({name:'English',code:'en'})};
    const manager=new exports.LangIntellisenseProvider({extensionUri:{}},{prefetch:async()=>vfs});
    return {manager,vscode,status,updates,logs,timers,vfs,handlers,dispose:()=>manager.triggers.forEach(trigger=>trigger.dispose())};
}
test('fresh profiles without the optional CSpell setting never attempt a global configuration write',async()=>{
    const f=fixture();await tick();assert.equal(f.updates.length,0);f.dispose();
});
test('CSpell integration preserves existing scheme configuration without mutating the returned object',async()=>{
    const schemes={file:true};const f=fixture({registered:true,schemes});await tick();
    assert.equal(schemes['overleaf-workshop'],undefined);assert.equal(f.updates.length,1);
    assert.equal(f.updates[0][1]['overleaf-workshop'],true);f.dispose();
});
test('CSpell array settings retain their type and already enabled settings are not rewritten',async()=>{
    const schemes=['file','untitled'];const f=fixture({registered:true,schemes});await tick();
    assert.deepEqual(schemes,['file','untitled']);
    assert.deepEqual(Array.from(f.updates[0][1]),['file','untitled','overleaf-workshop']);f.dispose();
    const enabled=fixture({registered:true,schemes:{file:true,'overleaf-workshop':true}});await tick();
    assert.equal(enabled.updates.length,0);enabled.dispose();
});
test('configuration permission failures are observed without rejecting activation',async()=>{
    const f=fixture({registered:true,update:async()=>{throw new Error('Settings are readonly');}});await tick();
    assert.equal(f.logs.some(entry=>entry[1]==='cspell.configuration_update_failed'),true);f.dispose();
});
test('an in-flight spelling status refresh cannot show a disposed status item',async()=>{
    const f=fixture();f.vscode.workspace.workspaceFolders=[{uri:{scheme:'overleaf-workshop',toString:()=> 'project'}}];
    let finish;f.manager.vfsm.prefetch=()=>new Promise(resolve=>{finish=resolve;});
    const refresh=f.manager.refreshStatus('test');await tick();f.dispose();finish(f.vfs);await refresh;
    assert.equal(f.status.shown,0);
});
test('newer refreshes hide stale status responses after switching workspaces',async()=>{
    const f=fixture();f.vscode.workspace.workspaceFolders=[{uri:{scheme:'overleaf-workshop',toString:()=> 'project'}}];
    let finish;f.manager.vfsm.prefetch=()=>new Promise(resolve=>{finish=resolve;});
    const refresh=f.manager.refreshStatus('slow');await tick();f.vscode.workspace.workspaceFolders=undefined;
    await f.manager.refreshStatus('new');finish(f.vfs);await refresh;
    assert.equal(f.status.shown,0);f.dispose();
});
test('background status network failures are caught and hide stale status',async()=>{
    const f=fixture();f.vscode.workspace.workspaceFolders=[{uri:{scheme:'overleaf-workshop',toString:()=> 'project'}}];
    f.manager.vfsm.prefetch=async()=>{throw new Error('Offline');};
    const callback=[...f.timers][0];f.timers.delete(callback);callback();await tick();
    assert.equal(f.status.hidden,1);assert.equal(f.logs.some(entry=>entry[1]==='status.refresh_failed'),true);f.dispose();
});
test('spelling status uses the active remote editor in a multi-root workspace',async()=>{
    const f=fixture();const first={scheme:'overleaf-workshop'},second={scheme:'overleaf-workshop'};let requested;
    f.vscode.workspace.workspaceFolders=[{uri:first},{uri:second}];f.vscode.window.activeTextEditor={document:{uri:second}};
    f.manager.vfsm.prefetch=async uri=>{requested=uri;return f.vfs;};await f.manager.refreshStatus('active');
    assert.equal(requested,second);assert.equal(f.status.shown,1);f.dispose();
});
test('status connection events follow the active project across multi-root workspaces and account boundaries',()=>{
    const f=fixture();const remote=(project,user='u',file='')=>{
        const value=`overleaf-workshop://server/Project${file}?user=${user}&project=${project}`;
        return {...f.vscode.Uri.parse(value),toString:()=>value};
    };
    f.vscode.workspace.workspaceFolders=[{uri:remote('first')},{uri:remote('second')}];
    f.vscode.window.activeTextEditor={document:{uri:remote('second','u','/main.tex')}};
    const triggers=f.manager.triggers;const before=f.manager.statusRefreshRevision;
    f.handlers.get('offlineSynchronizationStateChangedEvent')({origin:remote('second').toString()});
    assert.equal(f.manager.statusRefreshRevision,before+1);
    f.handlers.get('realtimeConnectionStateChangedEvent')({origin:remote('second').toString()});
    assert.equal(f.manager.statusRefreshRevision,before+2);
    for(const origin of [remote('first'),remote('second','other')]) {
        f.handlers.get('realtimeConnectionStateChangedEvent')({origin:origin.toString()});
    }
    assert.equal(f.manager.statusRefreshRevision,before+2);triggers.forEach(trigger=>trigger.dispose());
});
