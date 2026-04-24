const test = require('node:test');
const assert = require('node:assert/strict');

const {
    consumeOptimisticCommentMessageId,
    discardOptimisticCommentMessageId,
    recordOptimisticCommentMessage,
} = require('../out/comments/commentOptimisticMessages.js');

test('optimistic comment messages are consumed in FIFO order per thread and content', () => {
    const pendingMessages = new Map();
    recordOptimisticCommentMessage(pendingMessages, {
        threadId: 'thread-1',
        userId: 'user-1',
        content: 'same',
        id: 'local-1',
    });
    recordOptimisticCommentMessage(pendingMessages, {
        threadId: 'thread-1',
        userId: 'user-1',
        content: 'same',
        id: 'local-2',
    });

    assert.equal(consumeOptimisticCommentMessageId(pendingMessages, {
        threadId: 'thread-1',
        userId: 'user-1',
        content: 'same',
    }), 'local-1');
    assert.equal(consumeOptimisticCommentMessageId(pendingMessages, {
        threadId: 'thread-1',
        userId: 'user-1',
        content: 'same',
    }), 'local-2');
    assert.equal(consumeOptimisticCommentMessageId(pendingMessages, {
        threadId: 'thread-1',
        userId: 'user-1',
        content: 'same',
    }), undefined);
});

test('optimistic comment keys are isolated by thread and user', () => {
    const pendingMessages = new Map();
    recordOptimisticCommentMessage(pendingMessages, {
        threadId: 'thread-1',
        userId: 'user-1',
        content: 'same',
        id: 'local-1',
    });

    assert.equal(consumeOptimisticCommentMessageId(pendingMessages, {
        threadId: 'thread-2',
        userId: 'user-1',
        content: 'same',
    }), undefined);
    assert.equal(consumeOptimisticCommentMessageId(pendingMessages, {
        threadId: 'thread-1',
        userId: 'user-2',
        content: 'same',
    }), undefined);
    assert.equal(consumeOptimisticCommentMessageId(pendingMessages, {
        threadId: 'thread-1',
        userId: 'user-1',
        content: 'same',
    }), 'local-1');
});

test('optimistic comment messages can be discarded explicitly', () => {
    const pendingMessages = new Map();
    recordOptimisticCommentMessage(pendingMessages, {
        threadId: 'thread-1',
        userId: 'user-1',
        content: 'same',
        id: 'local-1',
    });

    discardOptimisticCommentMessageId(pendingMessages, 'local-1');

    assert.equal(consumeOptimisticCommentMessageId(pendingMessages, {
        threadId: 'thread-1',
        userId: 'user-1',
        content: 'same',
    }), undefined);
});
