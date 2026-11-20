const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const noop = () => {};
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const timers = new Set(), commands = [], logs = [];
    const disposable = (fn = noop) => ({dispose:fn});
    const exports = {};
    const warnings=[];
    const mocks = {
        crypto:require('node:crypto'), vscode:{Uri:{joinPath:()=>({})},l10n:{t:value=>value},commands:{executeCommand:async (...args)=>{commands.push(args);}},
            window:{showWarningMessage:async message=>{warnings.push(message);},registerWebviewViewProvider:()=>disposable()},workspace:{}},
        '../consts':{ROOT_NAME:'overleaf-workshop'},
        '../utils/diagnostics':{logDiagnostic:(...args)=>logs.push(args),registerDiagnosticStateProvider:()=>disposable()},
        '../utils/eventBus':{EventBus:{on:()=>disposable(),fire:noop}},
        './chatMessageFormatting':{normalizeChatMessage:value=>value},
    };
    vm.runInNewContext(fs.readFileSync(process.env.CHAT_VIEW_AUDIT_SOURCE||path.join(__dirname,'../out/collaboration/chatViewProvider.js'),'utf8'),
        {exports,require:name=>mocks[name]??{},setTimeout:fn=>{timers.add(fn);return fn;},clearTimeout:fn=>timers.delete(fn)});
    const provider = new exports.ChatViewProvider({cachedChatMessages:[],getChatMessageDelivery:()=>({}),
        origin:{toString:()=> 'project'},projectId:'id',serverName:'server'},{});
    provider.loadWebviewHtml=async()=> '<html></html>';
    function view() {
        const events = new Map(), posts = [];
        const on = name => callback => {events.set(name,callback);return disposable(()=>events.delete(name));};
        return {events,posts,visible:true,webview:{html:'',postMessage:async message=>{posts.push(message);return true;},
            onDidReceiveMessage:on('message')},onDidDispose:on('dispose'),onDidChangeVisibility:on('visibility')};
    }
    return {provider,timers,commands,logs,warnings,vscode:mocks.vscode,view,runTimers(){for(const fn of [...timers]){timers.delete(fn);fn();}}};
}
test('composer actions wait for the existing webview-ready handshake without polling timers',async()=>{
    const f=fixture();f.provider.insertText('first');f.provider.focusMainComposer();
    assert.equal(f.timers.size,0);
    const view=f.view();await f.provider.resolveWebviewView(view);
    assert.equal(view.posts.some(message=>message.type==='insert-text'||message.type==='focus-root-input'),false);
    view.events.get('message')({type:'chat-ready'});await tick();
    assert.deepEqual(view.posts.filter(message=>['insert-text','focus-root-input'].includes(message.type)).map(message=>message.type),['insert-text','focus-root-input']);
    f.provider.dispose();await tick();
});
test('disposal cancels pending composer work and later calls cannot re-open the view',async()=>{
    const f=fixture();f.provider.focusMainComposer();await tick();f.provider.dispose();
    const before=f.commands.length;f.runTimers();f.provider.insertText('late');f.provider.focusMainComposer();await tick();
    assert.equal(f.timers.size,0);assert.equal(f.commands.length,before);
});
test('an old HTML load cannot attach handlers after a newer view has resolved',async()=>{
    const f=fixture();let firstDone,secondDone,calls=0;
    f.provider.loadWebviewHtml=()=>new Promise(resolve=>{if(calls++===0)firstDone=resolve;else secondDone=resolve;});
    const first=f.view(),second=f.view();const a=f.provider.resolveWebviewView(first),b=f.provider.resolveWebviewView(second);
    secondDone('new');await b;firstDone('old');await a;
    assert.equal(first.events.size,0);assert.equal(first.webview.html,'');assert.equal(second.events.size,3);
    f.provider.dispose();assert.equal(second.events.size,0);
});
test('a pending HTML load cannot reattach listeners after provider disposal',async()=>{
    const f=fixture();let finish;f.provider.loadWebviewHtml=()=>new Promise(resolve=>{finish=resolve;});
    const view=f.view(),loading=f.provider.resolveWebviewView(view);f.provider.dispose();finish('late');await loading;
    assert.equal(view.events.size,0);assert.equal(view.webview.html,'');
});
test('queued text remains ordered and exceeding the explicit queue limit preserves accepted snippets',async()=>{
    const f=fixture();
    for(let index=0;index<128;index++)assert.equal(f.provider.insertText(String(index)),true);
    assert.equal(f.provider.insertText('rejected intact'),false);assert.equal(f.warnings.length,1);
    const view=f.view();await f.provider.resolveWebviewView(view);view.events.get('message')({type:'chat-ready'});await tick();
    assert.deepEqual(view.posts.filter(message=>message.type==='insert-text').map(message=>message.content),Array.from({length:128},(_,index)=>String(index)));
    assert.equal(f.provider.pendingComposerMessages.length,0);assert.equal(f.timers.size,0);f.provider.dispose();
});
test('a rejected message retains its entire draft for an explicit retry and focus failures are observed',async()=>{
    const f=fixture(),view=f.view();await f.provider.resolveWebviewView(view);view.events.get('message')({type:'chat-ready'});await tick();
    const post=view.webview.postMessage;view.webview.postMessage=async message=>{if(message.type==='insert-text')throw new Error('View unavailable');return post(message);};
    f.provider.insertText('keep all of this');await tick();assert.equal(f.provider.pendingComposerMessages.length,1);
    assert.equal(f.logs.some(entry=>entry[1]==='webview.message_failed'),true);
    view.webview.postMessage=post;f.provider.focusMainComposer();await tick();
    assert.deepEqual(view.posts.filter(message=>message.type==='insert-text').map(message=>message.content),['keep all of this']);
    f.vscode.commands.executeCommand=async()=>{throw new Error('Focus failed');};f.provider.revealChatView();await tick();
    assert.equal(f.logs.some(entry=>entry[1]==='webview.focus_failed'),true);f.provider.dispose();
});
test('view replacement reports cancelled draft intents and drains new text after an old delivery settles',async()=>{
    const f=fixture(),first=f.view();await f.provider.resolveWebviewView(first);first.events.get('message')({type:'chat-ready'});await tick();
    let finish;first.webview.postMessage=message=>message.type==='insert-text'?new Promise(resolve=>{finish=resolve;}):Promise.resolve(true);
    f.provider.insertText('old');await tick();
    const second=f.view();await f.provider.resolveWebviewView(second);assert.equal(f.warnings.length,1);
    f.provider.insertText('new');second.events.get('message')({type:'chat-ready'});await tick();
    finish(true);await tick();
    assert.deepEqual(second.posts.filter(message=>message.type==='insert-text').map(message=>message.content),['new']);
    f.provider.dispose();
});
