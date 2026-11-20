const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const noop=()=>{};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
    const timers=new Set();let finishUsers,resolveRender=async()=>({toString:()=> 'target'});
    const disposable=(fn=noop)=>({dispose:fn});
    const vscode={Disposable:class{constructor(fn){this.dispose=fn;}},StatusBarAlignment:{Left:0},
        window:{visibleTextEditors:[],createStatusBarItem:()=>({dispose:noop}),onDidChangeTextEditorSelection:()=>disposable(),onDidChangeVisibleTextEditors:()=>disposable()},
        workspace:{onDidChangeConfiguration:()=>disposable()},commands:{registerCommand:()=>disposable()}};
    const mocks={vscode,'../consts':{ROOT_NAME:'overleaf-workshop'},
        '../comments/reviewViewProvider':{ReviewViewProvider:class{get triggers(){return [];}}},
        '../utils/diagnostics':{logDiagnostic:noop,registerDiagnosticStateProvider:()=>disposable()},
        '../utils/eventBus':{EventBus:{on:()=>disposable()}},
        './collaboratorPresence':require('../out/collaboration/collaboratorPresence'),
        '../core/projectWorkspaceBinding':{resolveProjectRenderUriForPath:(...args)=>resolveRender(...args)}};
    const exports={};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../out/collaboration/clientManager.js'),'utf8'),
        {exports,require:name=>mocks[name]??{},setTimeout:fn=>{timers.add(fn);return fn;},clearTimeout:fn=>timers.delete(fn)});
    const manager=new exports.ClientManager({_userId:'self',_resolveById:()=>({path:'main.tex'}),origin:{}},{},'self-client',
        {isConnected:true,updateEventHandlers:noop,getConnectedUsers:()=>new Promise(resolve=>{finishUsers=resolve;})},{});
    const triggers=manager.triggers;
    return {manager,timers,finishUsers,dispose:()=>triggers.forEach(trigger=>trigger.dispose()),setRender:fn=>{resolveRender=fn;}};
}
test('collaboration disposal releases native decorations and all tracked aliases synchronously',()=>{
    const f=fixture();let disposed=0;
    f.manager.onlineUsers.user={selection:{decoration:{dispose(){disposed++;}}}};
    f.manager.collaboratorAliases.set('client','user');f.manager.collaboratorColors.set('user','red');
    f.dispose();assert.equal(disposed,1);assert.equal(Object.keys(f.manager.onlineUsers).length,0);
    assert.equal(f.manager.collaboratorAliases.size,0);assert.equal(f.manager.collaboratorColors.size,0);
});
test('late connected-user responses and activity updates cannot restart timers after disposal',async()=>{
    const f=fixture();f.dispose();f.finishUsers([]);await tick();f.manager.setStatusActive('late');
    assert.equal(f.timers.size,0);
});
test('an in-flight cursor lookup cannot create a native decoration after disposal',async()=>{
    const f=fixture();let finish,created=0;
    f.setRender(()=>new Promise(resolve=>{finish=resolve;}));
    f.manager.createCollaboratorCursorDecoration=()=>{created++;return {dispose:noop};};
    f.manager.resolveCollaboratorColor=()=> 'red';f.manager.createCollaboratorHoverMessage=()=>({});f.manager.createCollaboratorCursorRanges=()=>[];
    const user={doc_id:'doc'};const rendering=f.manager.renderCursorDecoration('user',user);await tick();f.dispose();
    finish({toString:()=> 'target'});await rendering;assert.equal(created,0);assert.equal(user.selection,undefined);
});
