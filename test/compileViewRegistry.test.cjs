const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const noop = () => {};
function fixture() {
    const listeners = new Map();
    const disposable = (fn = noop) => ({dispose: fn});
    const events = {on(name, callback) {
        const callbacks = listeners.get(name) ?? new Set();
        callbacks.add(callback); listeners.set(name, callbacks);
        return disposable(() => callbacks.delete(callback));
    }};
    const PositionRange = class {constructor(line,character,endLine,endCharacter){this.start={line,character};this.end={line:endLine,character:endCharacter};}};
    const vscode = {Selection:PositionRange,Range:PositionRange,TextEditorRevealType:{InCenter:0},DiagnosticSeverity:{Error:0,Warning:1,Information:2}, StatusBarAlignment:{Left:0},
        languages:{createDiagnosticCollection:()=>({dispose:noop})},
        commands:{registerCommand:()=>disposable()},
        workspace:{onDidSaveTextDocument:()=>disposable()},
        window:{createStatusBarItem:()=>({dispose:noop})}};
    const exports = {};
    const mocks = {'vscode':vscode, path,
        '../core/remoteFileSystemProvider':{parseUri:uri=>({identifier:'same-user/same-project/Same',
            serverName:uri.authority,userId:'same-user',projectId:'same-project',pathParts:['.output','output.pdf']})},
        '../consts':{ROOT_NAME:'overleaf-workshop',OUTPUT_FOLDER_NAME:'.output'},
        '../utils/eventBus':{EventBus:events},
        '../utils/diagnostics':{logDiagnostic:noop,registerDiagnosticStateProvider:()=>disposable()},
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../out/compile/compileManager.js'),'utf8'),
        {exports,require:name=>mocks[name]??{},setTimeout,clearTimeout,URLSearchParams});
    const manager = new exports.CompileManager({});
    const fire = event => [...(listeners.get('pdfWillOpenEvent')??[])].forEach(callback=>callback(event));
    function view(server='one') {
        let refreshCount=0, onDispose;
        const result={uri:{authority:server,toString:()=>`overleaf-workshop://${server}/Same/.output/output.pdf`},
            doc:{refresh:async()=>{refreshCount++;}},
            webviewPanel:{onDidDispose:callback=>{onDispose=callback;return disposable(()=>{onDispose=undefined;});}},
            close:()=>onDispose?.(),get refreshCount(){return refreshCount;}};
        return result;
    }
    return {manager,listeners,fire,view};
}
test('PDF refreshes remain isolated between servers with otherwise identical project identities',()=>{
    const {manager,fire,view}=fixture(); const a=view('one'), b=view('two'); fire(a);fire(b);
    manager.refreshPdfViews(a.uri);assert.equal(a.refreshCount,1);assert.equal(b.refreshCount,0);
    manager.refreshPdfViews(b.uri);assert.equal(b.refreshCount,1);
});
test('closing a replaced PDF panel leaves its newer replacement registered',()=>{
    const {manager,fire,view}=fixture();const older=view(),current=view();fire(older);fire(current);older.close();
    manager.refreshPdfViews(current.uri);assert.equal(current.refreshCount,1);assert.equal(older.refreshCount,0);
});
test('disposing compile triggers removes the PDF-open subscription and retained panel callbacks',()=>{
    const {manager,listeners,fire,view}=fixture();const opened=view();fire(opened);
    for(const trigger of manager.triggers)trigger.dispose();
    assert.equal(listeners.get('pdfWillOpenEvent').size,0);
    manager.refreshPdfViews(opened.uri);assert.equal(opened.refreshCount,0);
});

test('PDF reverse sync locates literal punctuation instead of evaluating PDF text as a regular expression',()=>{
    const {manager}=fixture();
    for(const identifier of ['[', '(', 'a+b', '$5.00', 'x.*y']) {
        const text='prefix '+identifier+' suffix';
        const editor={document:{lineCount:1,lineAt:()=>({text})},selections:[],revealRange(){}};
        assert.doesNotThrow(()=>manager._revealSelectionInEditor(editor,1,identifier),identifier);
        assert.equal(editor.selections[0].start.character,7,identifier);
    }
});
test('repeated PDF open/close cycles release registrations and separate manager instances retain no shared state',()=>{
    const a=fixture(),b=fixture();
    for(let i=0;i<1000;i++){
        const panel=a.view();a.fire(panel);panel.close();
    }
    assert.equal(a.manager.collectDiagnosticsState().pdfViewCount,0);
    assert.equal(a.manager.pdfViewSubscriptions.size,0);
    const panel=a.view();a.fire(panel);b.manager.refreshPdfViews(panel.uri);
    assert.equal(panel.refreshCount,0);
    for(const trigger of a.manager.triggers)trigger.dispose();
    for(const trigger of b.manager.triggers)trigger.dispose();
});
