const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildOptimisticChatMessage,
    consumeOptimisticChatMessageId,
    discardOptimisticChatMessageId,
    pruneOptimisticChatMessages,
    recordOptimisticChatMessage,
} = require('../out/collaboration/chatOptimisticMessages.js');

test('optimistic chat messages are consumed in FIFO order for identical content', () => {
    const pendingMessages = new Map();
    recordOptimisticChatMessage(pendingMessages, {
        clientId: 'client-1',
        content: 'hello',
        id: 'local-1',
    });
    recordOptimisticChatMessage(pendingMessages, {
        clientId: 'client-1',
        content: 'hello',
        id: 'local-2',
    });

    assert.equal(consumeOptimisticChatMessageId(pendingMessages, {
        clientId: 'client-1',
        content: 'hello',
    }), 'local-1');
    assert.equal(consumeOptimisticChatMessageId(pendingMessages, {
        clientId: 'client-1',
        content: 'hello',
    }), 'local-2');
    assert.equal(consumeOptimisticChatMessageId(pendingMessages, {
        clientId: 'client-1',
        content: 'hello',
    }), undefined);
});

test('optimistic chat messages can be discarded explicitly', () => {
    const pendingMessages = new Map();
    recordOptimisticChatMessage(pendingMessages, {
        clientId: 'client-1',
        content: 'hello',
        id: 'local-1',
    });

    discardOptimisticChatMessageId(pendingMessages, 'local-1');

    assert.equal(consumeOptimisticChatMessageId(pendingMessages, {
        clientId: 'client-1',
        content: 'hello',
    }), undefined);
});

test('pruning removes optimistic ids that are no longer in the message list', () => {
    const pendingMessages = new Map();
    recordOptimisticChatMessage(pendingMessages, {
        clientId: 'client-1',
        content: 'hello',
        id: 'local-1',
    });
    recordOptimisticChatMessage(pendingMessages, {
        clientId: 'client-1',
        content: 'hello',
        id: 'local-2',
    });

    pruneOptimisticChatMessages(pendingMessages, ['local-2']);

    assert.equal(consumeOptimisticChatMessageId(pendingMessages, {
        clientId: 'client-1',
        content: 'hello',
    }), 'local-2');
});

test('buildOptimisticChatMessage preserves the provided client identity', () => {
    const message = buildOptimisticChatMessage({
        clientId: 'client-1',
        content: 'hello',
        id: 'local-1',
        timestamp: 123,
        user: {
            id: 'user-1',
            first_name: 'Ada',
            email: 'ada@example.com',
        },
        userId: 'user-1',
    });

    assert.deepEqual(message, {
        clientId: 'client-1',
        content: 'hello',
        id: 'local-1',
        timestamp: 123,
        user: {
            id: 'user-1',
            first_name: 'Ada',
            email: 'ada@example.com',
        },
        user_id: 'user-1',
    });
});
