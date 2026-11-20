const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const root = path.resolve(__dirname, '../..');
const {ChatViewProvider} = require(path.join(root, 'out/collaboration/chatViewProvider'));
const {EventBus} = require(path.join(root, 'out/utils/eventBus'));

exports.run = async function () {
    const started = Date.now();
    const reportPath = process.env.OVERLEAF_CHAT_SMOKE_REPORT;
    assert(reportPath, 'OVERLEAF_CHAT_SMOKE_REPORT is required');
    const unsafeText = '<img id="chat-smoke-injected" src=x onerror="globalThis.__chatSmokeInjected=true"> <script>globalThis.__chatSmokeInjected=true</script> & Unicode 漢字 😀';
    const queuedText = 'Queued before ready: <literal> 漢字 ';
    const liveText = 'after-ready 😀';
    const origin = 'overleaf-workshop://synthetic.invalid/Chat?user=synthetic-self&project=synthetic-project';
    const self = {id: 'synthetic-self', first_name: 'Synthetic', last_name: 'Self', email: 'self@example.invalid'};
    const deliveries = new Map();
    const sends = [];
    const messages = [{id: 'synthetic-history', content: unsafeText, timestamp: Date.now(), user_id: 'synthetic-other',
        user: {id: 'synthetic-other', first_name: '<b>Collaborator</b>', last_name: 'Fixture', email: 'other@example.invalid'}}];
    const vfs = {
        origin: vscode.Uri.parse(origin), serverName: 'synthetic.invalid', projectId: 'synthetic-project', projectName: 'Synthetic Chat',
        realtimeConnectionPhase: 'fallback', synchronizationMode: 'offline', currentPublicId: 'synthetic-connection',
        _userId: self.id, cachedChatMessages: messages, chatQueueLength: 0,
        getChatMessageDelivery: id => deliveries.get(id) || {state: 'delivered', detail: ''},
        async sendMessage(clientId, content) {
            sends.push({clientId, content});
            const message = {id: 'synthetic-queued', content, timestamp: Date.now(), user_id: self.id, user: self};
            messages.push(message);
            deliveries.set(message.id, {state: 'pending', detail: 'queued'});
            this.chatQueueLength = 1;
            EventBus.fire('chatMessagesChangedEvent', {origin: this.origin.toString(), projectId: this.projectId, serverName: this.serverName, reason: 'synthetic_queued', message});
            return {ok: true, deliveryState: 'queued', mode: 'offline-queued', queuedMessageId: message.id, transport: 'offline'};
        },
    };
    const listenerBaseline = new Set(EventBus.getDiagnosticsState().listeners.map(listener => listener.listenerId));
    let ownedListeners = [];
    const provider = new ChatViewProvider(vfs, vscode.Uri.file(root));
    let panel;
    let commandId = 0;
    let cspPreserved = false;
    let readyCount = 0;
    let latest;
    const checkpoints = [];
    const report = {
        status: 'running', vscode: vscode.version, credentialsUsed: false, externalNetworkRequestedByFixture: false,
        sandboxDisabled: false, workspaceTrustDisabled: false, productionProvider: true, productionVueBundle: true,
        panelAdapter: true, syntheticVfs: true,
        bundleSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'views/chat-view/dist/index.html'))).digest('hex'),
        checkpoints,
    };
    function save() {
        fs.mkdirSync(path.dirname(reportPath), {recursive: true});
        fs.writeFileSync(reportPath, JSON.stringify({...report, elapsedMs: Date.now() - started}, null, 2) + '\n', {mode: 0o600});
    }
    // A WebviewPanel adapts visibility/focus only; use the production queue,
    // HTML/CSP builder, message validation, message delivery, and disposal.
    provider.revealChatView = () => panel?.reveal(vscode.ViewColumn.One);
    const originalHtml = provider.loadWebviewHtml.bind(provider);
    provider.loadWebviewHtml = async webview => {
        const html = await originalHtml(webview);
        const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
        const probe = fs.readFileSync(path.join(__dirname, 'chatWebviewProbe.js'), 'utf8');
        const injected = html.replace(/(<script\b[^>]*\bnonce="([^"]+)"[^>]*>)/i,
            (_match, original, nonce) => `<script nonce="${nonce}">${probe}</script>${original}`);
        cspPreserved = injected.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1]===csp;
        assert(cspPreserved && csp.includes("connect-src 'none'") && csp.includes("script-src 'nonce-"));
        return injected;
    };
    function inspect(action) {
        const id = ++commandId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { listener.dispose(); reject(new Error('Chat DOM probe timed out')); }, 15000);
            const listener = panel.webview.onDidReceiveMessage(message => {
                if (message.type==='chatSmokeResult' && message.id===id) {
                    clearTimeout(timer); listener.dispose();
                    if (message.failure) { reject(new Error(message.failure)); }
                    else { resolve(message); }
                }
            });
            panel.webview.postMessage({type: 'chatSmokeCommand', id, action}).then(delivered => {
                if (!delivered) { clearTimeout(timer); listener.dispose(); reject(new Error('Chat probe message rejected')); }
            }, reject);
        });
    }
    async function until(predicate) {
        const deadline = Date.now() + 20000;
        do {
            latest = await inspect();
            if (predicate(latest)) { return latest; }
            await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        throw new Error('Chat DOM did not reach the expected state: ' + JSON.stringify(latest));
    }
    try {
        provider.triggers;
        ownedListeners = EventBus.getDiagnosticsState().listeners.filter(listener => !listenerBaseline.has(listener.listenerId));
        assert.equal(ownedListeners.length, 1);
        assert.equal(provider.insertText(queuedText), true, 'pre-ready text must enter the production queue');
        provider.focusMainComposer();
        panel = vscode.window.createWebviewPanel('overleaf-chat-smoke', 'Synthetic Overleaf chat smoke', vscode.ViewColumn.One,
            {enableScripts: true, retainContextWhenHidden: true});
        const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => { listener.dispose(); reject(new Error('Production chat-ready handshake timed out')); }, 30000);
            const listener = panel.webview.onDidReceiveMessage(message => {
                if (message.type==='chat-ready') { readyCount++; clearTimeout(timer); listener.dispose(); resolve(); }
            });
        });
        const adapter = {
            webview: panel.webview,
            get visible() { return panel.visible; },
            onDidDispose: listener => panel.onDidDispose(listener),
            onDidChangeVisibility: listener => panel.onDidChangeViewState(() => listener()),
        };
        await provider.resolveWebviewView(adapter, {}, new vscode.CancellationTokenSource().token);
        await ready;
        // DOM changes can arrive before the host's final postMessage promise settles.
        const initial = await until(state => state.contents.includes(unsafeText) && state.composer===queuedText
            && provider.pendingComposerMessages.length===0 && provider.pendingComposerTextLength===0);
        assert.equal(initial.metrics.readyMessages, 1);
        assert.equal(readyCount, 1);
        assert.equal(initial.contentChildElements, 0);
        assert.equal(initial.authorChildElements, 0);
        assert.equal(initial.injectedElements, 0);
        assert.equal(initial.injectedScriptRan, false);
        assert(initial.authors.includes('<b>Collaborator</b> Fixture'));
        checkpoints.push({phase: 'ready-safe-history-and-pre-ready-queue', ...initial});
        assert.equal(provider.pendingComposerMessages.length, 0);
        assert.equal(provider.pendingComposerTextLength, 0);

        assert.equal(provider.insertText(liveText), true);
        provider.focusMainComposer();
        const composed = await until(state => state.composer===queuedText + liveText && state.composerFocused);
        checkpoints.push({phase: 'live-composer-insertion', ...composed});
        await inspect('enter');
        const queued = await until(state => state.deliveryLabels.includes('Queued') && state.composer==='');
        assert.deepEqual(sends, [{clientId: vfs.currentPublicId, content: (queuedText + liveText).trim()}]);
        assert.equal(queued.metrics.sendMessages, 1);
        assert(queued.contents.includes((queuedText + liveText).trim()));
        checkpoints.push({phase: 'synthetic-offline-queue', ...queued});

        deliveries.set('synthetic-queued', {state: 'delivered', detail: ''});
        vfs.chatQueueLength = 0;
        EventBus.fire('chatMessagesChangedEvent', {origin: vfs.origin.toString(), projectId: vfs.projectId, serverName: vfs.serverName, reason: 'synthetic_delivered'});
        const delivered = await until(state => state.deliveryLabels.length===0 && state.ownActionButtons===2);
        assert.deepEqual(delivered.metrics.errors, []);
        assert.deepEqual(delivered.metrics.rejections, []);
        checkpoints.push({phase: 'synthetic-delivery-state', ...delivered});

        let disposed = false;
        panel.onDidDispose(() => disposed = true);
        panel.dispose();
        assert(disposed, 'real WebviewPanel disposal event must fire');
        provider.dispose();
        assert.equal(provider.insertText('after disposal'), false);
        assert.equal(provider.webviewView, undefined);
        assert.equal(provider.pendingComposerMessages.length, 0);
        const remainingListeners = new Set(EventBus.getDiagnosticsState().listeners.map(listener => listener.listenerId));
        assert(ownedListeners.every(listener => !remainingListeners.has(listener.listenerId)), 'all listeners owned by this provider must be removed');
        checkpoints.push({phase: 'disposed', realPanelDisposed: disposed, queueLength: 0, ownedListenersRemoved: true});
        Object.assign(report, {status: 'passed', cspPreserved, readyCount,
            note: 'Real installed VS Code renderer + production ChatViewProvider and Vue bundle. VFS/auth/network delivery is synthetic.'});
        save();
        console.log('Native chat webview smoke passed: ready, safe rendering, queued/live insertion, send, delivery state and disposal.');
    } catch (error) {
        Object.assign(report, {status: 'failed', cspPreserved, readyCount, latest,
            syntheticMessages: messages.length, syntheticSends: sends.length,
            eventListeners: EventBus.getDiagnosticsState().totalListenerCount,
            reason: error.message});
        save();
        throw error;
    } finally { provider.dispose(); panel?.dispose(); }
};
