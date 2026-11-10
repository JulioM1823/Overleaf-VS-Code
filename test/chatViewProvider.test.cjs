const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const noop = () => {};
const originalLoad = Module._load;
const executedCommands = [];
let eventBusListenerDisposeCount = 0;
let eventBusListenerRegistrationCount = 0;
let throwOnWebviewProviderRegistration = false;
let webviewHtml = '';
let webviewProviderDisposeCount = 0;
let webviewProviderRegistrationCount = 0;

function resetHarnessState() {
    executedCommands.length = 0;
    eventBusListenerDisposeCount = 0;
    eventBusListenerRegistrationCount = 0;
    throwOnWebviewProviderRegistration = false;
    webviewHtml = '';
    webviewProviderDisposeCount = 0;
    webviewProviderRegistrationCount = 0;
}

Module._load = function patchedLoad(request, parent, isMain) {
    if (request==='vscode') {
        return {
            commands: {
                executeCommand: async (...args) => {
                    executedCommands.push(args);
                    return true;
                },
            },
            window: {
                registerWebviewViewProvider: () => {
                    webviewProviderRegistrationCount += 1;
                    if (throwOnWebviewProviderRegistration) {
                        throw new Error('duplicate webview provider');
                    }
                    return {
                        dispose: () => {
                            webviewProviderDisposeCount += 1;
                        },
                    };
                },
            },
            workspace: {
                getConfiguration: () => ({
                    get: (_key, fallback) => fallback,
                }),
                fs: {
                    readFile: async () => Buffer.from(webviewHtml),
                },
            },
            Uri: {
                joinPath: () => ({}),
            },
        };
    }
    if (request==='../utils/diagnostics' && parent?.id?.endsWith('/chatViewProvider.js')) {
        return {
            logDiagnostic: noop,
            registerDiagnosticStateProvider: () => ({dispose: noop}),
        };
    }
    if (request==='../utils/eventBus' && parent?.id?.endsWith('/chatViewProvider.js')) {
        return {
            EventBus: {
                fire: noop,
                on: () => {
                    eventBusListenerRegistrationCount += 1;
                    return {
                        dispose: () => {
                            eventBusListenerDisposeCount += 1;
                        },
                    };
                },
            },
        };
    }
    if (request==='./chatMessageFormatting' && parent?.id?.endsWith('/chatViewProvider.js')) {
        return {
            normalizeChatMessage: (message) => message,
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { ChatViewProvider } = require('../out/collaboration/chatViewProvider.js');

function createProvider() {
    return new ChatViewProvider({
        cachedChatMessages: [],
        chatQueueLength: 0,
        getChatMessageDelivery: () => ({detail: '', state: 'delivered'}),
        origin: {
            toString: () => 'overleaf://server/project',
        },
        projectId: 'project-id',
        projectName: 'project',
        realtimeConnectionPhase: 'connected',
        serverName: 'server',
        synchronizationMode: 'remote',
    }, {});
}

test('revealChatView enables the explorer chat view before focusing it', async () => {
    resetHarnessState();
    const provider = createProvider();

    provider.revealChatView();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(executedCommands, [
        ['setContext', 'overleaf-workshop.chatViewEnabled', true],
        ['overleaf-workshop.chatWebview.focus'],
    ]);
});

test('triggers register once and are disposed with the provider', () => {
    resetHarnessState();
    const provider = createProvider();

    const firstTriggers = provider.triggers;
    const secondTriggers = provider.triggers;

    assert.equal(firstTriggers, secondTriggers);
    assert.equal(webviewProviderRegistrationCount, 1);
    assert.equal(eventBusListenerRegistrationCount, 1);

    provider.dispose();

    assert.equal(firstTriggers.length, 0);
    assert.equal(webviewProviderDisposeCount, 1);
    assert.equal(eventBusListenerDisposeCount, 1);
});

test('failed webview registration does not leave a chat event listener behind', () => {
    resetHarnessState();
    throwOnWebviewProviderRegistration = true;
    const provider = createProvider();

    assert.throws(() => provider.triggers, /duplicate webview provider/);

    assert.equal(webviewProviderRegistrationCount, 1);
    assert.equal(webviewProviderDisposeCount, 0);
    assert.equal(eventBusListenerRegistrationCount, 0);
    assert.equal(eventBusListenerDisposeCount, 0);

    provider.dispose();
});

test('loadWebviewHtml allows embedded codicon fonts under the CSP', async () => {
    resetHarnessState();
    webviewHtml = [
        '<!doctype html><html><head>',
        '<link rel="icon" href="/favicon.ico">',
        '</head><body><script type="module">console.log("ready")</script></body></html>',
    ].join('');
    const provider = createProvider();

    const html = await provider.loadWebviewHtml({cspSource: 'vscode-resource:'});

    assert.match(html, /font-src vscode-resource: data:/);
    assert.doesNotMatch(html, /rel="icon"/);
    assert.match(html, /<script nonce="[^"]+" type="module">/);
});
