const test = require('node:test');
const assert = require('node:assert/strict');

const {
    findCommentThreadIdsByMessageId,
    findCommentThreadIdByMessageId,
} = require('../out/comments/commentThreadLookup.js');

test('findCommentThreadIdByMessageId returns the thread that owns the message', () => {
    const threadId = findCommentThreadIdByMessageId([
        ['thread-1', {
            messages: [
                {id: 'message-1'},
            ],
        }],
        ['thread-2', {
            messages: [
                {id: 'message-2'},
                {id: 'message-3'},
            ],
        }],
    ], 'message-3');

    assert.equal(threadId, 'thread-2');
});

test('findCommentThreadIdByMessageId ignores missing threads and returns undefined when absent', () => {
    const threadId = findCommentThreadIdByMessageId([
        ['thread-1', undefined],
        ['thread-2', {
            messages: [
                {id: 'message-2'},
            ],
        }],
    ], 'missing-message');

    assert.equal(threadId, undefined);
});

test('findCommentThreadIdsByMessageId returns every thread that currently contains the message id', () => {
    const threadIds = findCommentThreadIdsByMessageId([
        ['thread-local', {
            messages: [
                {id: 'message-1'},
            ],
        }],
        ['thread-server', {
            messages: [
                {id: 'message-1'},
            ],
        }],
    ], 'message-1');

    assert.deepEqual(threadIds, ['thread-local', 'thread-server']);
});
