const test = require('node:test');
const assert = require('node:assert/strict');

const {
    shouldDeferThreadOnlyCommentCreateChange,
} = require('../out/comments/commentChangeEmissionPolicy.js');

test('shouldDeferThreadOnlyCommentCreateChange defers brand-new thread events without doc ids', () => {
    assert.equal(shouldDeferThreadOnlyCommentCreateChange({
        docIds: [],
        hasPreviousThread: false,
        reason: 'thread_message_created_offline',
    }), true);

    assert.equal(shouldDeferThreadOnlyCommentCreateChange({
        docIds: [],
        hasPreviousThread: false,
        reason: 'thread_message_created',
    }), true);
});

test('shouldDeferThreadOnlyCommentCreateChange keeps other comment events live', () => {
    assert.equal(shouldDeferThreadOnlyCommentCreateChange({
        docIds: ['doc-1'],
        hasPreviousThread: false,
        reason: 'thread_message_created_offline',
    }), false);

    assert.equal(shouldDeferThreadOnlyCommentCreateChange({
        docIds: [],
        hasPreviousThread: true,
        reason: 'thread_message_created_offline',
    }), false);

    assert.equal(shouldDeferThreadOnlyCommentCreateChange({
        docIds: [],
        hasPreviousThread: false,
        reason: 'thread_reply_created_offline',
    }), false);
});
