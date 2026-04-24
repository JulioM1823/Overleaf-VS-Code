const test = require('node:test');
const assert = require('node:assert/strict');

const {
    mergeOfflineCommentState,
} = require('../out/comments/offlineCommentState.js');

test('mergeOfflineCommentState preserves in-memory comments missing from the persisted offline snapshot', () => {
    const merged = mergeOfflineCommentState({
        inMemoryCommentRangesByDocId: new Map([
            ['doc-1', [{
                id: 'thread-1',
                op: {
                    c: 'selected text',
                    p: 12,
                    t: 'thread-1',
                },
            }]],
        ]),
        inMemoryCommentThreads: new Map([
            ['thread-1', {
                messages: [{
                    content: 'offline comment',
                    id: 'offline-comment-1',
                    timestamp: '2026-04-17T08:00:00.000Z',
                    user_id: 'user-1',
                }],
            }],
        ]),
        persistedCommentRangesByDocId: {},
        persistedCommentThreads: {},
    });

    assert.deepEqual(merged.commentRangesByDocId.get('doc-1'), [{
        id: 'thread-1',
        metadata: undefined,
        op: {
            c: 'selected text',
            p: 12,
            resolved: undefined,
            t: 'thread-1',
        },
        resolved: undefined,
    }]);
    assert.deepEqual(merged.commentThreads.get('thread-1')?.messages.map((message) => message.id), ['offline-comment-1']);
});

test('mergeOfflineCommentState keeps persisted comments while preferring newer in-memory state for overlapping threads', () => {
    const merged = mergeOfflineCommentState({
        inMemoryCommentRangesByDocId: new Map([
            ['doc-1', [{
                id: 'thread-1',
                op: {
                    c: 'new anchor',
                    p: 20,
                    t: 'thread-1',
                },
            }]],
            ['doc-3', [{
                id: 'thread-3',
                op: {
                    c: 'third anchor',
                    p: 5,
                    t: 'thread-3',
                },
            }]],
        ]),
        inMemoryCommentThreads: new Map([
            ['thread-1', {
                messages: [{
                    content: 'older server comment',
                    id: 'message-1',
                    timestamp: '2026-04-17T08:00:00.000Z',
                    user_id: 'user-1',
                }, {
                    content: 'new local comment',
                    id: 'offline-comment-2',
                    timestamp: '2026-04-17T08:01:00.000Z',
                    user_id: 'user-1',
                }],
                resolved: false,
            }],
            ['thread-3', {
                messages: [{
                    content: 'third thread',
                    id: 'message-3',
                    timestamp: '2026-04-17T08:02:00.000Z',
                    user_id: 'user-1',
                }],
            }],
        ]),
        persistedCommentRangesByDocId: {
            'doc-1': [{
                id: 'thread-1',
                op: {
                    c: 'old anchor',
                    p: 2,
                    t: 'thread-1',
                },
            }],
            'doc-2': [{
                id: 'thread-2',
                op: {
                    c: 'persisted anchor',
                    p: 7,
                    t: 'thread-2',
                },
            }],
        },
        persistedCommentThreads: {
            'thread-1': {
                messages: [{
                    content: 'older server comment',
                    id: 'message-1',
                    timestamp: '2026-04-17T08:00:00.000Z',
                    user_id: 'user-1',
                }],
                resolved: true,
            },
            'thread-2': {
                messages: [{
                    content: 'persisted thread',
                    id: 'message-2',
                    timestamp: '2026-04-17T07:59:00.000Z',
                    user_id: 'user-2',
                }],
            },
        },
    });

    assert.deepEqual(merged.commentRangesByDocId.get('doc-1'), [{
        id: 'thread-1',
        metadata: undefined,
        op: {
            c: 'new anchor',
            p: 20,
            resolved: undefined,
            t: 'thread-1',
        },
        resolved: undefined,
    }]);
    assert.deepEqual(merged.commentRangesByDocId.get('doc-2')?.map((range) => range.op.t), ['thread-2']);
    assert.deepEqual(merged.commentRangesByDocId.get('doc-3')?.map((range) => range.op.t), ['thread-3']);
    assert.equal(merged.commentThreads.get('thread-1')?.resolved, false);
    assert.deepEqual(merged.commentThreads.get('thread-1')?.messages.map((message) => message.id), [
        'message-1',
        'offline-comment-2',
    ]);
    assert.deepEqual(merged.commentThreads.get('thread-2')?.messages.map((message) => message.id), ['message-2']);
    assert.deepEqual(merged.commentThreads.get('thread-3')?.messages.map((message) => message.id), ['message-3']);
});

test('mergeOfflineCommentState does not resurrect deleted loaded-doc threads from the persisted snapshot', () => {
    const merged = mergeOfflineCommentState({
        inMemoryCommentRangesByDocId: new Map([
            ['doc-1', []],
        ]),
        inMemoryCommentThreads: new Map(),
        persistedCommentRangesByDocId: {
            'doc-1': [{
                id: 'thread-1',
                op: {
                    c: 'old anchor',
                    p: 2,
                    t: 'thread-1',
                },
            }],
        },
        persistedCommentThreads: {
            'thread-1': {
                messages: [{
                    content: 'persisted thread',
                    id: 'message-1',
                    timestamp: '2026-04-17T07:59:00.000Z',
                    user_id: 'user-1',
                }],
            },
        },
    });

    assert.deepEqual(merged.commentRangesByDocId.get('doc-1'), []);
    assert.equal(merged.commentThreads.get('thread-1'), undefined);
});

test('mergeOfflineCommentState prefers edited in-memory messages over persisted copies for loaded docs', () => {
    const merged = mergeOfflineCommentState({
        inMemoryCommentRangesByDocId: new Map([
            ['doc-1', [{
                id: 'thread-1',
                op: {
                    c: 'anchor',
                    p: 4,
                    t: 'thread-1',
                },
            }]],
        ]),
        inMemoryCommentThreads: new Map([
            ['thread-1', {
                messages: [{
                    content: 'edited locally',
                    id: 'message-1',
                    timestamp: '2026-04-17T08:00:00.000Z',
                    user_id: 'user-1',
                }],
            }],
        ]),
        persistedCommentRangesByDocId: {
            'doc-1': [{
                id: 'thread-1',
                op: {
                    c: 'anchor',
                    p: 4,
                    t: 'thread-1',
                },
            }],
        },
        persistedCommentThreads: {
            'thread-1': {
                messages: [{
                    content: 'persisted content',
                    id: 'message-1',
                    timestamp: '2026-04-17T08:00:00.000Z',
                    user_id: 'user-1',
                }],
            },
        },
    });

    assert.deepEqual(merged.commentThreads.get('thread-1')?.messages.map((message) => message.content), ['edited locally']);
});
