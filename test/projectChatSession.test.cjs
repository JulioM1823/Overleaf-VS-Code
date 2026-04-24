const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request==='vscode') {
        return {
            l10n: {
                t(message) {
                    return message;
                },
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const {
    ProjectChatSession,
    prependPaginatedChatPage,
} = require('../out/collaboration/projectChatSession.js');

function buildUser(id = 'user-1') {
    return {
        email: `${id}@example.com`,
        first_name: 'Ada',
        id,
        last_name: 'Lovelace',
    };
}

function buildMessage(id, timestamp, content, userId = 'user-1', clientId) {
    return {
        id,
        content,
        timestamp,
        user_id: userId,
        user: buildUser(userId),
        ...(clientId ? { clientId } : {}),
    };
}

function createHost(options = {}) {
    let operations = [...(options.operations ?? [])];
    let offlineMode = options.isOfflineMode ?? false;
    const stateChanges = [];
    const transitionCalls = [];
    const apiCalls = [];
    const api = {
        async getMessages(...args) {
            apiCalls.push({ kind: 'getMessages', args });
            if (typeof options.getMessages === 'function') {
                return options.getMessages(...args);
            }
            return { type: 'success', messages: [] };
        },
        async sendMessage(...args) {
            apiCalls.push({ kind: 'sendMessage', args });
            if (typeof options.sendMessage === 'function') {
                return options.sendMessage(...args);
            }
            return { type: 'success' };
        },
        async editChatMessage(...args) {
            apiCalls.push({ kind: 'editChatMessage', args });
            if (typeof options.editChatMessage === 'function') {
                return options.editChatMessage(...args);
            }
            return { type: 'success' };
        },
        async deleteChatMessage(...args) {
            apiCalls.push({ kind: 'deleteChatMessage', args });
            if (typeof options.deleteChatMessage === 'function') {
                return options.deleteChatMessage(...args);
            }
            return { type: 'success' };
        },
    };

    const host = {
        api,
        appendDeferredSyncOperation: async (operation) => {
            operations = [...operations, operation];
        },
        canFetchRemoteHistory: () => options.canFetchRemoteHistory ?? true,
        canSendLiveMessages: () => options.canSendLiveMessages ?? true,
        getActiveChatClientId: () => options.clientId ?? 'client-1',
        getAuthenticatedTransportIdentity: async () => ({
            cookies: 'cookie',
            csrfToken: 'csrf-token',
        }),
        getDeferredSyncOperations: () => operations,
        isOfflineMode: () => offlineMode,
        logDiagnostic: () => {},
        onStateChanged: (state, reason, event) => {
            stateChanges.push({
                event,
                reason,
                state: {
                    historyComplete: state.historyComplete,
                    messages: state.messages.map((message) => ({ ...message })),
                },
            });
        },
        projectId: 'project-1',
        removeDeferredSyncOperation: async (operationId) => {
            operations = operations.filter((operation) => operation.id!==operationId);
        },
        replaceDeferredSyncOperations: async (_reason, updater) => {
            operations = updater(operations);
        },
        resolveCurrentProjectMember: () => ({
            _id: 'user-1',
            email: 'ada@example.com',
            first_name: 'Ada',
            last_name: 'Lovelace',
        }),
        transitionToOffline: async (reason, error, fields) => {
            offlineMode = true;
            transitionCalls.push({error, fields, reason});
        },
        userId: 'user-1',
    };

    return {
        apiCalls,
        getOperations: () => operations,
        host,
        stateChanges,
        transitionCalls,
    };
}

test('prependPaginatedChatPage preserves page order while suppressing duplicates', () => {
    const firstPage = [
        buildMessage('m4', 200, 'latest'),
        buildMessage('m3', 100, 'same-ts newer'),
    ];
    const secondPage = [
        buildMessage('m3', 100, 'duplicate boundary'),
        buildMessage('m2', 100, 'same-ts older'),
        buildMessage('m1', 50, 'oldest'),
    ];

    const afterFirst = prependPaginatedChatPage([], firstPage);
    const merged = prependPaginatedChatPage(afterFirst, secondPage);

    assert.deepEqual(merged.map((message) => message.id), ['m1', 'm2', 'm3', 'm4']);
});

test('ProjectChatSession bootstraps full paginated history instead of stopping at the first page', async (t) => {
    const newestPage = Array.from({length: 50}, (_, index) => {
        const ordinal = 52 - index;
        return buildMessage(`m${ordinal}`, ordinal, `message-${ordinal}`);
    });
    const olderPage = [
        buildMessage('m2', 2, 'message-2'),
        buildMessage('m1', 1, 'message-1'),
    ];
    let callCount = 0;
    const {host} = createHost({
        getMessages: async () => {
            callCount += 1;
            if (callCount===1) {
                return { type: 'success', messages: newestPage };
            }
            return { type: 'success', messages: olderPage };
        },
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    const result = await session.ensureHistoryLoaded('bootstrap');

    assert.equal(result.ok, true);
    assert.equal(callCount, 2);
    assert.deepEqual(session.cachedMessages.slice(0, 3).map((message) => message.id), ['m1', 'm2', 'm3']);
    assert.deepEqual(session.cachedMessages.slice(-3).map((message) => message.id), ['m50', 'm51', 'm52']);
});

test('ProjectChatSession confirms optimistic messages from realtime echoes', async (t) => {
    const {host} = createHost();
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    const sendResult = await session.sendMessage('client-1', 'hello');
    assert.equal(sendResult.ok, true);
    assert.equal(session.cachedMessages.length, 1);
    assert.equal(session.cachedMessages[0].deliveryState, undefined);
    const optimisticClientId = session.cachedMessages[0].clientId;

    session.handleIncomingMessage(buildMessage('server-1', 123, 'hello', 'user-1', optimisticClientId));

    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['server-1']);
    assert.equal(session.getMessageDelivery('server-1').state, 'delivered');
});

test('ProjectChatSession matches optimistic self echoes without a server clientId', async (t) => {
    const {host} = createHost();
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    const sendResult = await session.sendMessage('client-1', 'hello');
    assert.equal(sendResult.ok, true);
    assert.equal(session.cachedMessages.length, 1);
    const localMessage = session.cachedMessages[0];

    session.handleIncomingMessage(buildMessage('server-1', localMessage.timestamp + 250, 'hello', 'user-1'));

    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['server-1']);
    assert.equal(session.getMessageDelivery('server-1').state, 'delivered');
});

test('ProjectChatSession reconciles live self echoes by session client id even when content changes slightly', async (t) => {
    const {host} = createHost({
        clientId: 'session-client',
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    const sendResult = await session.sendMessage('session-client', 'Offline chat');
    assert.equal(sendResult.ok, true);
    assert.equal(session.cachedMessages.length, 1);

    const localMessage = session.cachedMessages[0];
    assert.equal(localMessage.clientId, 'session-client');

    session.handleIncomingMessage(
        buildMessage('server-1', localMessage.timestamp + 250, 'Offline Chat', 'user-1', 'session-client'),
    );

    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['server-1']);
    assert.equal(session.cachedMessages[0].content, 'Offline Chat');
    assert.equal(session.getMessageDelivery('server-1').state, 'delivered');
});

test('ProjectChatSession repairs optimistic messages from server snapshots without clientId', async (t) => {
    const now = Date.now();
    const pages = [
        { type: 'success', messages: [buildMessage('server-1', now + 1, 'hello')] },
    ];
    const {host} = createHost({
        getMessages: async () => pages.shift() ?? { type: 'success', messages: [] },
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    const sendResult = await session.sendMessage('client-1', 'hello');
    assert.equal(sendResult.ok, true);
    const localMessageId = session.cachedMessages[0].id;
    assert.match(localMessageId, /^pending-chat-/);

    await session.refreshFromServer('repair');

    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['server-1']);
});

test('ProjectChatSession keeps chat failures local when history fetch hits connectivity errors', async (t) => {
    const {host, transitionCalls} = createHost({
        getMessages: async () => {
            throw new Error('ETIMEDOUT while loading chat history');
        },
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    const result = await session.ensureHistoryLoaded('bootstrap');

    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(transitionCalls.length, 0);
});

test('ProjectChatSession applies queued local edits and deletes over refreshed server history', async (t) => {
    const {host} = createHost({
        operations: [
            {
                createdAt: '2026-04-10T00:00:01.000Z',
                id: 'chat-edit',
                kind: 'chat.edit',
                payload: {
                    content: 'edited locally',
                    messageId: 'server-1',
                },
            },
            {
                createdAt: '2026-04-10T00:00:02.000Z',
                id: 'chat-delete',
                kind: 'chat.delete',
                payload: {
                    messageId: 'server-2',
                },
            },
        ],
        getMessages: async () => ({
            type: 'success',
            messages: [
                buildMessage('server-2', 200, 'delete me'),
                buildMessage('server-1', 100, 'original'),
            ],
        }),
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    await session.ensureHistoryLoaded('bootstrap');

    assert.deepEqual(
        session.cachedMessages.map((message) => [message.id, message.content]),
        [['server-1', 'edited locally']],
    );
});

test('ProjectChatSession replays queued edit and delete operations serially and refreshes after recovery', async (t) => {
    const calls = [];
    let getMessagesCalls = 0;
    const {host, getOperations} = createHost({
        operations: [
            {
                createdAt: '2026-04-10T00:00:01.000Z',
                id: 'chat-edit',
                kind: 'chat.edit',
                payload: {
                    content: 'edited remotely',
                    messageId: 'server-1',
                },
            },
            {
                createdAt: '2026-04-10T00:00:02.000Z',
                id: 'chat-delete',
                kind: 'chat.delete',
                payload: {
                    messageId: 'server-2',
                },
            },
        ],
        editChatMessage: async (_identity, _projectId, messageId, content) => {
            calls.push(['edit', messageId, content]);
            return { type: 'success' };
        },
        deleteChatMessage: async (_identity, _projectId, messageId) => {
            calls.push(['delete', messageId]);
            return { type: 'success' };
        },
        getMessages: async () => {
            getMessagesCalls += 1;
            return {
                type: 'success',
                messages: [
                    buildMessage('server-1', 100, 'edited remotely'),
                ],
            };
        },
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    session.restoreState({
        historyComplete: true,
        messages: [
            buildMessage('server-1', 100, 'edited locally'),
        ],
    });

    await session.replayQueuedOperations('recovery');

    assert.deepEqual(calls, [
        ['edit', 'server-1', 'edited remotely'],
        ['delete', 'server-2'],
    ]);
    assert.equal(getOperations().length, 0);
    assert.equal(getMessagesCalls, 1);
    assert.deepEqual(session.cachedMessages.map((message) => message.content), ['edited remotely']);
});

test('ProjectChatSession accepts a failed live delete when a server refresh confirms the message is gone', async (t) => {
    let getMessagesCalls = 0;
    const {host} = createHost({
        deleteChatMessage: async () => ({
            message: '500: <!DOCTYPE html><html><title>Something went wrong</title></html>',
            responseBody: '<!DOCTYPE html><html><title>Something went wrong</title></html>',
            statusCode: 500,
            type: 'error',
        }),
        getMessages: async () => {
            getMessagesCalls += 1;
            return {
                type: 'success',
                messages: [],
            };
        },
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    session.restoreState({
        historyComplete: true,
        messages: [
            buildMessage('server-1', 100, 'only message'),
        ],
    });

    await session.deleteMessage('server-1');

    assert.equal(getMessagesCalls, 1);
    assert.deepEqual(session.cachedMessages, []);
});

test('ProjectChatSession restores a failed live delete when the server still returns the message', async (t) => {
    let getMessagesCalls = 0;
    const {host} = createHost({
        deleteChatMessage: async () => ({
            message: '500: <!DOCTYPE html><html><title>Something went wrong</title></html>',
            responseBody: '<!DOCTYPE html><html><title>Something went wrong</title></html>',
            statusCode: 500,
            type: 'error',
        }),
        getMessages: async () => {
            getMessagesCalls += 1;
            return {
                type: 'success',
                messages: [
                    buildMessage('server-1', 100, 'only message'),
                ],
            };
        },
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    session.restoreState({
        historyComplete: true,
        messages: [
            buildMessage('server-1', 100, 'only message'),
        ],
    });

    await assert.rejects(
        session.deleteMessage('server-1'),
        /500: <!DOCTYPE html>/,
    );

    assert.equal(getMessagesCalls, 1);
    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['server-1']);
});

test('ProjectChatSession queues connectivity-blurred sends without forcing project offline', async (t) => {
    const {host, transitionCalls, getOperations} = createHost({
        sendMessage: async () => {
            throw new Error('ETIMEDOUT while sending chat');
        },
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    const result = await session.sendMessage('client-1', 'hello');

    assert.equal(result.ok, true);
    assert.equal(result.deliveryState, 'queued');
    assert.equal(transitionCalls.length, 0);
    assert.equal(getOperations().length, 1);
    assert.equal(getOperations()[0].kind, 'chat.send');
});

test('ProjectChatSession does not downgrade to offline when confirmation repair fetches fail', async (t) => {
    const {host, transitionCalls} = createHost({
        getMessages: async () => {
            throw new Error('ETIMEDOUT while refreshing chat history');
        },
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    const firstSend = await session.sendMessage('client-1', 'hello');
    assert.equal(firstSend.ok, true);

    await session.refreshAwaitingRealtimeConfirmations('repair');

    assert.equal(transitionCalls.length, 0);

    const secondSend = await session.sendMessage('client-1', 'world');
    assert.equal(secondSend.ok, true);
    assert.equal(secondSend.deliveryState, 'delivered');
});

test('ProjectChatSession skips the immediate reconnect checkpoint when a fresh snapshot was restored', async (t) => {
    const {host, apiCalls} = createHost();
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    session.restoreState({
        historyComplete: true,
        messages: [buildMessage('server-1', 100, 'cached')],
        savedAt: new Date().toISOString(),
    });

    session.handleConnectionRestored('initialization:initial');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(apiCalls.filter((call) => call.kind==='getMessages').length, 0);
    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['server-1']);
});

test('ProjectChatSession checkpoints complete chat history on socket reconnect', async (t) => {
    const {host, apiCalls} = createHost({
        getMessages: async () => ({
            type: 'success',
            messages: [
                buildMessage('server-2', 200, 'remote while offline'),
                buildMessage('server-1', 100, 'cached'),
            ],
        }),
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    session.restoreState({
        historyComplete: true,
        messages: [buildMessage('server-1', 100, 'cached')],
        savedAt: '2026-04-01T00:00:00.000Z',
    });

    session.handleConnectionRestored('socket_connection_accepted');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(apiCalls.filter((call) => call.kind==='getMessages').length, 1);
    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['server-1', 'server-2']);
});

test('ProjectChatSession prunes stale orphaned sending messages once a delivered duplicate exists', (t) => {
    const {host} = createHost();
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    const staleTimestamp = Date.now() - (3 * 60 * 1000);

    session.restoreState({
        historyComplete: true,
        messages: [
            buildMessage('pending-chat-stale', staleTimestamp, 'Offline chat'),
            buildMessage('server-1', staleTimestamp + 30_000, 'Offline chat'),
        ],
        savedAt: new Date().toISOString(),
    });

    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['server-1']);
    assert.equal(session.getMessageDelivery('server-1').state, 'delivered');
});

test('ProjectChatSession prunes stale orphaned sending messages when the delivered copy differs only by case and whitespace', (t) => {
    const {host} = createHost();
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    const staleTimestamp = Date.now() - (3 * 60 * 1000);

    session.restoreState({
        historyComplete: true,
        messages: [
            buildMessage('pending-chat-stale', staleTimestamp, '  Offline   chat  '),
            buildMessage('server-1', staleTimestamp + 30_000, 'offline CHAT'),
        ],
        savedAt: new Date().toISOString(),
    });

    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['server-1']);
    assert.equal(session.cachedMessages[0].content, 'offline CHAT');
});

test('ProjectChatSession keeps newer in-flight sending messages when the only delivered copy is older', (t) => {
    const {host} = createHost();
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    const staleTimestamp = Date.now() - (3 * 60 * 1000);

    session.restoreState({
        historyComplete: true,
        messages: [
            buildMessage('server-1', staleTimestamp, 'Offline chat'),
            buildMessage('pending-chat-stale', staleTimestamp + 30_000, 'Offline chat'),
        ],
        savedAt: new Date().toISOString(),
    });

    assert.deepEqual(
        session.cachedMessages.map((message) => message.id),
        ['server-1', 'pending-chat-stale'],
    );
    assert.deepEqual(session.getMessageDelivery('pending-chat-stale'), {
        detail: 'sending',
        state: 'pending',
    });
});

test('ProjectChatSession keeps queued temporary messages even when a delivered duplicate exists', (t) => {
    const {host} = createHost({
        operations: [
            {
                createdAt: '2026-04-10T00:00:01.000Z',
                id: 'chat-send',
                kind: 'chat.send',
                payload: {
                    content: 'Offline chat',
                    localMessageId: 'offline-chat-queued',
                },
            },
        ],
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    const staleTimestamp = Date.now() - (3 * 60 * 1000);

    session.restoreState({
        historyComplete: true,
        messages: [
            buildMessage('offline-chat-queued', staleTimestamp, 'Offline chat'),
            buildMessage('server-1', staleTimestamp + 30_000, 'Offline chat'),
        ],
        savedAt: new Date().toISOString(),
    });

    assert.deepEqual(
        session.cachedMessages.map((message) => message.id),
        ['offline-chat-queued', 'server-1'],
    );
    assert.deepEqual(session.getMessageDelivery('offline-chat-queued'), {
        detail: 'queued',
        state: 'pending',
    });
});

test('ProjectChatSession queues later sends behind an existing queued send', async (t) => {
    let sendAttempts = 0;
    const {host, apiCalls, getOperations} = createHost({
        sendMessage: async () => {
            sendAttempts += 1;
            if (sendAttempts===1) {
                return {
                    type: 'error',
                    message: '429: Too Many Requests',
                    statusCode: 429,
                    chatSendErrorCode: 'rate-limited',
                    responseBody: '429 Too Many Requests',
                };
            }
            return { type: 'success' };
        },
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    const firstResult = await session.sendMessage('client-1', 'first');
    const secondResult = await session.sendMessage('client-1', 'second');

    assert.equal(firstResult.ok, true);
    assert.equal(firstResult.deliveryState, 'queued');
    assert.equal(secondResult.ok, true);
    assert.equal(secondResult.deliveryState, 'queued');
    assert.equal(apiCalls.filter((call) => call.kind==='sendMessage').length, 1);
    assert.deepEqual(
        getOperations()
            .filter((operation) => operation.kind==='chat.send')
            .map((operation) => operation.payload.content),
        ['first', 'second'],
    );
});

test('ProjectChatSession restores queued local sends into visible queued messages after reopen', (t) => {
    const {host} = createHost({
        operations: [
            {
                createdAt: '2026-04-10T00:00:01.000Z',
                id: 'chat-send',
                kind: 'chat.send',
                payload: {
                    content: 'queued hello',
                    localMessageId: 'offline-chat-restored',
                },
            },
        ],
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    session.restoreState({
        historyComplete: false,
        messages: [],
        savedAt: new Date().toISOString(),
    });

    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['offline-chat-restored']);
    assert.equal(session.cachedMessages[0].content, 'queued hello');
    assert.deepEqual(session.getMessageDelivery('offline-chat-restored'), {
        detail: 'queued',
        state: 'pending',
    });
});

test('ProjectChatSession keeps missing queued local sends visible across server refreshes before replay', async (t) => {
    const {host} = createHost({
        operations: [
            {
                createdAt: '2026-04-10T00:00:01.000Z',
                id: 'chat-send',
                kind: 'chat.send',
                payload: {
                    content: 'queued hello',
                    localMessageId: 'offline-chat-restored',
                },
            },
        ],
        getMessages: async () => ({
            type: 'success',
            messages: [buildMessage('server-1', 100, 'from server')],
        }),
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    session.reset('refresh_before_replay');
    await session.refreshFromServer('refresh_before_replay');

    assert.deepEqual(
        session.cachedMessages.map((message) => [message.id, message.content]),
        [
            ['server-1', 'from server'],
            ['offline-chat-restored', 'queued hello'],
        ],
    );
    assert.deepEqual(session.getMessageDelivery('offline-chat-restored'), {
        detail: 'queued',
        state: 'pending',
    });
});

test('ProjectChatSession restores missing queued local sends instead of discarding them after reopen', async (t) => {
    const {host, getOperations} = createHost({
        operations: [
            {
                createdAt: '2026-04-10T00:00:01.000Z',
                id: 'chat-send',
                kind: 'chat.send',
                payload: {
                    content: 'queued hello',
                    localMessageId: 'offline-chat-restored',
                },
            },
        ],
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    session.restoreState({
        historyComplete: true,
        messages: [],
        savedAt: new Date().toISOString(),
    });

    await session.replayQueuedOperations('recovery');

    assert.equal(getOperations().length, 0);
    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['offline-chat-restored']);
    assert.equal(session.cachedMessages[0].content, 'queued hello');
});

test('ProjectChatSession reconciles queued replay echoes by the active session client id', async (t) => {
    const {host} = createHost({
        clientId: 'session-client',
        operations: [
            {
                createdAt: '2026-04-10T00:00:01.000Z',
                id: 'chat-send',
                kind: 'chat.send',
                payload: {
                    clientId: 'stale-client',
                    content: 'Offline chat',
                    localMessageId: 'offline-chat-restored',
                },
            },
        ],
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    session.restoreState({
        historyComplete: true,
        messages: [
            buildMessage('offline-chat-restored', Date.now() - 60_000, 'Offline chat', 'user-1', 'stale-client'),
        ],
        savedAt: new Date().toISOString(),
    });

    await session.replayQueuedOperations('recovery');
    session.handleIncomingMessage(
        buildMessage('server-1', Date.now(), 'Offline Chat', 'user-1', 'session-client'),
    );

    assert.deepEqual(session.cachedMessages.map((message) => message.id), ['server-1']);
    assert.equal(session.cachedMessages[0].content, 'Offline Chat');
    assert.equal(session.getMessageDelivery('server-1').state, 'delivered');
});

test('ProjectChatSession bootstraps history before replaying queued sends when history is incomplete', async (t) => {
    const {host, apiCalls} = createHost({
        operations: [
            {
                createdAt: '2026-04-10T00:00:01.000Z',
                id: 'chat-send',
                kind: 'chat.send',
                payload: {
                    content: 'queued hello',
                    localMessageId: 'offline-chat-restored',
                },
            },
        ],
        getMessages: async () => ({
            type: 'success',
            messages: [buildMessage('server-1', 100, 'from server')],
        }),
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());

    session.handleConnectionRestored('socket_connection_accepted');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
        apiCalls
            .filter((call) => call.kind==='getMessages' || call.kind==='sendMessage')
            .map((call) => call.kind),
        ['getMessages', 'sendMessage'],
    );
});

test('ProjectChatSession refreshes server history before replaying queued sends even when cached history is complete', async (t) => {
    const queuedOperation = {
        createdAt: '2026-04-20T10:00:00.000Z',
        id: 'op-1',
        kind: 'chat.send',
        payload: {
            clientId: 'client-1',
            content: 'queued hello',
            localMessageId: 'offline-chat-1',
        },
    };
    const {host, apiCalls} = createHost({
        getMessages: async () => ({
            type: 'success',
            messages: [
                buildMessage('server-remote', 100, 'remote while offline'),
            ],
        }),
        operations: [queuedOperation],
        sendMessage: async () => ({type: 'success'}),
    });
    const session = new ProjectChatSession(host);
    t.after(() => session.dispose());
    session.restoreState({
        historyComplete: true,
        messages: [buildMessage('offline-chat-1', 50, 'queued hello', 'user-1', 'client-1')],
        savedAt: '2026-04-20T09:59:00.000Z',
    });

    session.handleConnectionRestored('socket_connection_accepted');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(apiCalls.filter((call) => call.kind==='getMessages').length, 1);
    assert.equal(apiCalls.filter((call) => call.kind==='sendMessage').length, 1);
    assert.equal(session.cachedMessages.some((message) => message.id==='server-remote'), true);
});
