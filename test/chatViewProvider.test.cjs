const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const noop = () => {};
const originalLoad = Module._load;
const executedCommands = [];

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
                registerWebviewViewProvider: () => ({dispose: noop}),
            },
            workspace: {
                getConfiguration: () => ({
                    get: (_key, fallback) => fallback,
                }),
                fs: {
                    readFile: async () => Buffer.from(''),
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
                on: () => ({dispose: noop}),
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

test('revealChatView enables the explorer chat view before focusing it', async () => {
    executedCommands.length = 0;
    const provider = new ChatViewProvider({
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

    provider.revealChatView();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(executedCommands, [
        ['setContext', 'overleaf-workshop.chatViewEnabled', true],
        ['overleaf-workshop.chatWebview.focus'],
    ]);
});
