const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const tick = () => new Promise(resolve => setImmediate(resolve));
class Emitter {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return {dispose: () => this.listeners.delete(listener)}; };
    fire = value => { for (const listener of this.listeners) listener(value); };
    dispose = () => { this.listeners.clear(); };
}
let watcher;
const vscode = {
    EventEmitter: Emitter,
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    Uri: {joinPath: (uri, segment) => ({...uri, path: uri.path + '/' + segment})},
    workspace: {
        getConfiguration: () => ({get: (_key, fallback) => fallback}),
        createFileSystemWatcher: () => {
            const change = new Emitter(), create = new Emitter(), remove = new Emitter();
            watcher = {change, create, remove, onDidChange: change.event, onDidCreate: create.event,
                onDidDelete: remove.event, disposed: false, dispose() { this.disposed = true; }};
            return watcher;
        },
    },
};
Module._load = function(request, parent, main) {
    if (request === 'vscode') return vscode;
    if (parent?.filename.endsWith('/core/pdfViewEditorProvider.js')) {
        if (request === '../utils/eventBus') return {EventBus: {fire() {}}};
        if (request === '../utils/diagnostics') return {logDiagnostic() {}};
        if (request === '../utils/globalStateManager') return {GlobalStateManager: {getPdfViewPersist: () => ({})}};
    }
    return originalLoad.call(this, request, parent, main);
};
const {PdfViewEditorProvider} = require('../out/core/pdfViewEditorProvider');
async function fixture() {
    const change = new Emitter(), incoming = new Emitter(), disposal = new Emitter();
    const messages = [];
    const uri = {scheme: 'overleaf-workshop', authority: 'server', path: '/Project/.output/output.pdf',
        query: 'project=p&user=u', toString: () => 'pdf'};
    let reads = 0;
    const doc = {uri, cache: new Uint8Array(0), loadError: undefined, onDidChange: change.event,
        refresh: async () => { reads++; }};
    const panel = {onDidDispose: disposal.event, onDidChangeViewState: () => ({dispose() {}}),
        webview: {onDidReceiveMessage: incoming.event, options: {}, asWebviewUri: value => ({toString: () => value.path}),
            postMessage: async value => { messages.push(value); return true; }}};
    const provider = new PdfViewEditorProvider({extensionUri: uri});
    provider.getHtmlForWebview = async () => '<html></html>';
    await provider.resolveCustomEditor(doc, panel);
    return {doc, panel, change, incoming, disposal, messages, watcher, get reads() {return reads;}};
}
test('a ready viewer with a failed first read receives a diagnostic without an empty PDF update', async () => {
    const f = await fixture();
    f.doc.loadError = 'Unable to load PDF (HTTP 404).';
    f.incoming.fire({type: 'ready'}); await tick();
    assert.deepEqual(f.messages.map(m => m.type), ['initState', 'configure', 'loadError']);
    assert.match(f.messages.at(-1).content, /404/);
    f.disposal.fire();
});
test('a superseded failed read cannot send its error after a successful replacement', async () => {
    const f = await fixture();
    f.doc.cache = Uint8Array.from(Buffer.from('%PDF-old')); f.doc.loadError = 'Read failed';
    let release;
    const post = f.panel.webview.postMessage;
    f.panel.webview.postMessage = message => message.type === 'update' && !release
        ? new Promise(resolve => { f.messages.push(message); release = resolve; }) : post(message);
    f.incoming.fire({type: 'ready'}); await tick(); assert(release);
    f.doc.cache = Uint8Array.from(Buffer.from('%PDF-new')); f.doc.loadError = undefined; f.change.fire();
    release(true); await tick();
    assert.deepEqual(f.messages.filter(m => m.type === 'update').map(m => Buffer.from(m.content).toString()), ['%PDF-old', '%PDF-new']);
    assert.equal(f.messages.filter(m => m.type === 'loadError').length, 0);
    f.disposal.fire();
});
test('repeated failures preserve the displayed PDF and rejected updates can be retried', async () => {
    const f = await fixture();
    f.doc.cache = Uint8Array.from(Buffer.from('%PDF-working'));
    f.incoming.fire({type: 'ready'}); await tick();
    f.doc.loadError = 'Read failed'; f.change.fire(); await tick(); f.change.fire(); await tick();
    assert.equal(f.messages.filter(m => m.type === 'update').length, 1);
    assert.equal(f.messages.filter(m => m.type === 'loadError').length, 2);
    f.doc.cache = Uint8Array.from(Buffer.from('%PDF-retry'));
    const post = f.panel.webview.postMessage;
    f.panel.webview.postMessage = async message => { await post(message); return message.type !== 'update'; };
    f.change.fire(); await tick();
    f.panel.webview.postMessage = post; f.change.fire(); await tick();
    assert.equal(f.messages.filter(m => m.type === 'update').length, 3);
    f.disposal.fire();
});
test('watcher events match the artifact without crossing projects and all subscriptions are disposed', async () => {
    const f = await fixture();
    f.watcher.change.fire({...f.doc.uri, query: ''});
    f.watcher.create.fire(f.doc.uri);
    f.watcher.remove.fire({...f.doc.uri, query: 'project=other&user=u'});
    f.watcher.change.fire({...f.doc.uri, path: '/Project/main.tex'});
    assert.equal(f.reads, 2);
    f.disposal.fire();
    assert(f.watcher.disposed);
    assert.equal(f.change.listeners.size, 0);
    assert.equal(f.watcher.change.listeners.size + f.watcher.create.listeners.size + f.watcher.remove.listeners.size, 0);
    f.watcher.change.fire(f.doc.uri); assert.equal(f.reads, 2);
});
