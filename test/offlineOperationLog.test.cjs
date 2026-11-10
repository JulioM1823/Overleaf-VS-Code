const test = require('node:test');
const assert = require('node:assert/strict');

const {
    appendDeferredSyncOperation,
    createDeferredSyncQueueState,
    foldPendingCommentMessageContentIntoDeferredOperations,
    hasDeferredSyncOperationsExcludingKinds,
    hasDeferredSyncOperationsForKind,
    isDeferredSyncChatOperation,
    parseDeferredSyncQueueState,
    replaceDeferredSyncChatMessageId,
    replaceDeferredSyncMessageId,
} = require('../out/offline/offlineOperationLog.js');

test('corrupt deferred operations are rejected without silently discarding queued user actions', () => {
    assert.throws(() => parseDeferredSyncQueueState(JSON.stringify({version: 1, operations: [{id: 'pending', kind: 'comment.create', payload: {}}]})), /Invalid/);
    assert.throws(() => parseDeferredSyncQueueState('null'), /Invalid/);
});

test('deferred operations retain causal order across equal timestamps and clock rollback', () => {
    const {serializeDeferredSyncQueueState} = require('../out/offline/offlineOperationLog');
    const operations = [
        {id: 'z', createdAt: '2026-01-02', kind: 'chat.send', payload: {content: 'original', localMessageId: 'm'}},
        {id: 'a', createdAt: '2026-01-02', kind: 'chat.edit', payload: {content: 'edited', messageId: 'm'}},
        {id: 'b', createdAt: '2026-01-01', kind: 'chat.delete', payload: {messageId: 'm'}},
    ];
    assert.deepEqual(parseDeferredSyncQueueState(serializeDeferredSyncQueueState(createDeferredSyncQueueState(operations))).operations, operations);
});

test('replaceDeferredSyncMessageId updates follow-up operations for the same thread', () => {
    const initialState = createDeferredSyncQueueState();
    const nextState = [
        {
            createdAt: '2026-04-08T00:00:00.000Z',
            id: 'create',
            kind: 'comment.create',
            payload: {
                content: 'root comment',
                docId: 'doc-1',
                filePath: 'main.tex',
                localMessageId: 'offline-message-1',
                selectedText: 'selected',
                startOffset: 42,
                threadId: 'thread-1',
            },
        },
        {
            createdAt: '2026-04-08T00:00:01.000Z',
            id: 'anchor',
            kind: 'comment.anchorExistingThread',
            payload: {
                content: 'root comment',
                docId: 'doc-1',
                filePath: 'main.tex',
                localMessageId: 'offline-message-1',
                selectedText: 'selected',
                startOffset: 42,
                threadId: 'thread-1',
            },
        },
        {
            createdAt: '2026-04-08T00:00:02.000Z',
            id: 'edit',
            kind: 'comment.edit',
            payload: {
                content: 'edited',
                messageId: 'offline-message-1',
                threadId: 'thread-1',
            },
        },
        {
            createdAt: '2026-04-08T00:00:03.000Z',
            id: 'delete',
            kind: 'comment.deleteMessage',
            payload: {
                messageId: 'offline-message-1',
                ownOnly: true,
                threadId: 'thread-1',
            },
        },
    ].reduce((state, operation) => appendDeferredSyncOperation(state, operation), initialState);

    const replacedState = replaceDeferredSyncMessageId(
        nextState,
        'thread-1',
        'offline-message-1',
        'server-message-99',
    );

    const [createOperation, anchorOperation, editOperation, deleteOperation] = replacedState.operations;
    assert.equal(createOperation.payload.localMessageId, 'server-message-99');
    assert.equal(anchorOperation.payload.localMessageId, 'server-message-99');
    assert.equal(anchorOperation.payload.serverMessageId, 'server-message-99');
    assert.equal(editOperation.payload.messageId, 'server-message-99');
    assert.equal(deleteOperation.payload.messageId, 'server-message-99');
});

test('deferred sync helpers distinguish chat-only queues from broader recovery work', () => {
    const chatOnlyState = createDeferredSyncQueueState([
        {
            createdAt: '2026-04-10T00:00:00.000Z',
            id: 'chat-1',
            kind: 'chat.send',
            payload: {
                content: 'hello',
                localMessageId: 'offline-chat-1',
            },
        },
    ]);
    const mixedState = createDeferredSyncQueueState([
        ...chatOnlyState.operations,
        {
            createdAt: '2026-04-10T00:00:01.000Z',
            id: 'comment-1',
            kind: 'comment.reply',
            payload: {
                content: 'reply',
                localMessageId: 'offline-comment-1',
                threadId: 'thread-1',
            },
        },
    ]);

    assert.equal(hasDeferredSyncOperationsForKind(chatOnlyState, 'chat.send'), true);
    assert.equal(hasDeferredSyncOperationsExcludingKinds(chatOnlyState, ['chat.send']), false);
    assert.equal(hasDeferredSyncOperationsExcludingKinds(mixedState, ['chat.send']), true);
});

test('replaceDeferredSyncChatMessageId updates chat edit and delete follow-ups', () => {
    const initialState = createDeferredSyncQueueState([
        {
            createdAt: '2026-04-10T00:00:00.000Z',
            id: 'chat-send',
            kind: 'chat.send',
            payload: {
                content: 'hello',
                localMessageId: 'offline-chat-1',
            },
        },
        {
            createdAt: '2026-04-10T00:00:01.000Z',
            id: 'chat-edit',
            kind: 'chat.edit',
            payload: {
                content: 'hello world',
                messageId: 'offline-chat-1',
            },
        },
        {
            createdAt: '2026-04-10T00:00:02.000Z',
            id: 'chat-delete',
            kind: 'chat.delete',
            payload: {
                messageId: 'offline-chat-1',
            },
        },
    ]);

    const replacedState = replaceDeferredSyncChatMessageId(
        initialState,
        'offline-chat-1',
        'server-chat-99',
    );

    assert.equal(replacedState.operations[0].payload.localMessageId, 'server-chat-99');
    assert.equal(replacedState.operations[1].payload.messageId, 'server-chat-99');
    assert.equal(replacedState.operations[2].payload.messageId, 'server-chat-99');
    assert.equal(replacedState.operations.every(isDeferredSyncChatOperation), true);
});


test('foldPendingCommentMessageContentIntoDeferredOperations compacts pending-message edits into the queued create', () => {
    const initialState = createDeferredSyncQueueState([
        {
            createdAt: '2026-04-20T00:00:00.000Z',
            id: 'create',
            kind: 'comment.create',
            payload: {
                content: 'original offline root comment',
                docId: 'doc-1',
                filePath: 'main.tex',
                localMessageId: 'pending-comment-1',
                selectedText: 'selected',
                startOffset: 21,
                threadId: 'thread-1',
            },
        },
        {
            createdAt: '2026-04-20T00:00:01.000Z',
            id: 'edit',
            kind: 'comment.edit',
            payload: {
                content: 'latest offline root comment',
                messageId: 'pending-comment-1',
                threadId: 'thread-1',
            },
        },
    ]);

    const folded = foldPendingCommentMessageContentIntoDeferredOperations(
        initialState,
        'thread-1',
        'pending-comment-1',
        'latest offline root comment',
    );

    assert.equal(folded.merged, true);
    assert.equal(folded.state.operations.length, 1);
    assert.equal(folded.state.operations[0].kind, 'comment.create');
    assert.equal(folded.state.operations[0].payload.content, 'latest offline root comment');
});
