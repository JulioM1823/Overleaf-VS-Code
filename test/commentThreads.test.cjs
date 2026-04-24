const test = require('node:test');
const assert = require('node:assert/strict');

const {
    dedupeDocumentCommentSnapshotThreadsByThreadId,
    editCommentMessageInThread,
    mergeCommentMessageIntoThread,
    normalizeCommentThread,
    removeCommentMessageFromThread,
} = require('../out/comments/commentThreads.js');

test('normalizeCommentThread sorts messages chronologically and preserves resolved metadata', () => {
    const thread = normalizeCommentThread({
        messages: [
            { id: 'b', content: 'second', timestamp: '2026-04-06T12:01:00.000Z', user_id: 'user-2' },
            { id: 'a', content: 'first', timestamp: '2026-04-06T12:00:00.000Z', user_id: 'user-1' },
        ],
        resolved: true,
        resolved_by_user: { id: 'user-3', email: 'resolver@example.com' },
    });

    assert.deepEqual(thread.messages.map((message) => message.id), ['a', 'b']);
    assert.equal(thread.resolved, true);
    assert.equal(thread.resolved_by_user?.id, 'user-3');
});

test('normalizeCommentThread dedupes duplicate message ids', () => {
    const thread = normalizeCommentThread({
        messages: [
            { id: 'message-1', content: 'local-pending', timestamp: '2026-04-06T12:00:00.000Z', user_id: 'user-1' },
            { id: 'message-1', content: 'server-confirmed', timestamp: '2026-04-06T12:01:00.000Z', user_id: 'user-1' },
            { id: 'message-2', content: 'other', timestamp: '2026-04-06T12:02:00.000Z', user_id: 'user-2' },
        ],
    });

    assert.deepEqual(thread.messages.map((message) => message.id), ['message-1', 'message-2']);
    assert.equal(thread.messages[0].content, 'server-confirmed');
});

test('mergeCommentMessageIntoThread upserts messages by id', () => {
    const initial = mergeCommentMessageIntoThread(undefined, {
        id: 'message-1',
        content: 'hello',
        timestamp: '2026-04-06T12:00:00.000Z',
        user_id: 'user-1',
    });
    assert.equal(initial.messages.length, 1);

    const updated = mergeCommentMessageIntoThread(initial, {
        id: 'message-1',
        content: 'updated',
        timestamp: '2026-04-06T12:00:00.000Z',
        user_id: 'user-1',
    });
    assert.equal(updated.messages.length, 1);
    assert.equal(updated.messages[0].content, 'updated');
});

test('editCommentMessageInThread updates message content and marks it edited', () => {
    const thread = editCommentMessageInThread({
        messages: [
            { id: 'message-1', content: 'hello', timestamp: '2026-04-06T12:00:00.000Z', user_id: 'user-1' },
        ],
    }, 'message-1', 'updated');

    assert.equal(thread.messages[0].content, 'updated');
    assert.ok(thread.messages[0].edited_at);
});

test('removeCommentMessageFromThread removes a message and returns undefined for missing threads', () => {
    const thread = removeCommentMessageFromThread({
        messages: [
            { id: 'message-1', content: 'hello', timestamp: '2026-04-06T12:00:00.000Z', user_id: 'user-1' },
            { id: 'message-2', content: 'reply', timestamp: '2026-04-06T12:01:00.000Z', user_id: 'user-2' },
        ],
    }, 'message-1');

    assert.deepEqual(thread.messages.map((message) => message.id), ['message-2']);
    assert.equal(removeCommentMessageFromThread(undefined, 'message-1'), undefined);
});

test('dedupeDocumentCommentSnapshotThreadsByThreadId keeps exactly one snapshot entry per thread id', () => {
    const threads = dedupeDocumentCommentSnapshotThreadsByThreadId([
        {
            range: {
                id: 'range-a',
                op: { c: 'first', p: 10, t: 'thread-1' },
            },
            thread: {
                messages: [
                    { id: 'message-1', content: 'hello', timestamp: '2026-04-06T12:00:00.000Z', user_id: 'user-1' },
                ],
            },
        },
        {
            range: {
                id: 'range-b',
                op: { c: 'second', p: 20, t: 'thread-1' },
            },
            thread: {
                messages: [
                    { id: 'message-2', content: 'duplicate', timestamp: '2026-04-06T12:01:00.000Z', user_id: 'user-2' },
                ],
            },
        },
        {
            range: {
                id: 'range-c',
                op: { c: 'third', p: 30, t: 'thread-2' },
            },
            thread: {
                messages: [
                    { id: 'message-3', content: 'other', timestamp: '2026-04-06T12:02:00.000Z', user_id: 'user-3' },
                ],
            },
        },
    ]);

    assert.equal(threads.length, 2);
    assert.deepEqual(threads.map(({ range }) => range.op.t), ['thread-1', 'thread-2']);
    assert.equal(threads[0].range.id, 'range-a');
});
