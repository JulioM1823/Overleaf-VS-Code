const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildCommentThreadParityByDocId,
    summarizeInlineCommentSnapshot,
    summarizeReviewEntries,
} = require('../out/comments/commentDebugParity.js');

test('summarizeInlineCommentSnapshot ignores threads without messages and keeps doc identity', () => {
    const summary = summarizeInlineCommentSnapshot({
        docId: 'doc-1',
        permissions: {},
        threads: [
            {
                range: {
                    id: 'thread-1',
                    metadata: undefined,
                    op: {c: 'inline text', p: 4, t: 'thread-1'},
                    resolved: false,
                },
                thread: {
                    messages: [
                        {content: 'root', id: 'message-1', timestamp: '2026-04-20T00:00:00.000Z', user_id: 'user-1'},
                    ],
                    resolved: false,
                },
            },
            {
                range: {
                    id: 'thread-2',
                    metadata: undefined,
                    op: {c: 'skip me', p: 10, t: 'thread-2'},
                    resolved: false,
                },
                thread: {
                    messages: [],
                    resolved: false,
                },
            },
        ],
    });

    assert.deepEqual(summary, [{
        docId: 'doc-1',
        messageCount: 1,
        messageIds: ['message-1'],
        resolved: false,
        rootMessageId: 'message-1',
        selectedText: 'inline text',
        threadId: 'thread-1',
    }]);
});

test('buildCommentThreadParityByDocId reports missing and mismatched review threads', () => {
    const inlineThreads = summarizeInlineCommentSnapshot({
        docId: 'doc-1',
        permissions: {},
        threads: [
            {
                range: {
                    id: 'thread-a',
                    metadata: undefined,
                    op: {c: 'alpha', p: 0, t: 'thread-a'},
                    resolved: false,
                },
                thread: {
                    messages: [
                        {content: 'root a', id: 'message-a1', timestamp: '2026-04-20T00:00:00.000Z', user_id: 'user-1'},
                    ],
                    resolved: false,
                },
            },
            {
                range: {
                    id: 'thread-b',
                    metadata: undefined,
                    op: {c: 'beta', p: 10, t: 'thread-b'},
                    resolved: false,
                },
                thread: {
                    messages: [
                        {content: 'root b', id: 'message-b1', timestamp: '2026-04-20T00:00:00.000Z', user_id: 'user-1'},
                        {content: 'reply b', id: 'message-b2', timestamp: '2026-04-20T00:01:00.000Z', user_id: 'user-2'},
                    ],
                    resolved: true,
                },
            },
        ],
    });
    const reviewThreads = summarizeReviewEntries([
        {
            canDeleteRootComment: false,
            canEditRootComment: false,
            canReply: true,
            canResolveThread: true,
            docId: 'doc-1',
            filePath: 'main.tex',
            lastActivityAt: 0,
            messages: [
                {authorName: 'A', canDelete: false, canEdit: false, content: 'root a', deleteOwnOnly: true, id: 'message-a1', isRoot: true, timestamp: '', userColor: '#000000'},
            ],
            overleafUri: 'overleaf-workshop:/main.tex',
            rangeEnd: {character: 1, line: 0, offset: 1},
            rangeStart: {character: 0, line: 0, offset: 0},
            resolved: false,
            rootCommentId: 'message-a1',
            selectedText: 'alpha',
            threadId: 'thread-a',
        },
        {
            canDeleteRootComment: false,
            canEditRootComment: false,
            canReply: true,
            canResolveThread: true,
            docId: 'doc-1',
            filePath: 'main.tex',
            lastActivityAt: 0,
            messages: [
                {authorName: 'B', canDelete: false, canEdit: false, content: 'root c', deleteOwnOnly: true, id: 'message-c1', isRoot: true, timestamp: '', userColor: '#000000'},
            ],
            overleafUri: 'overleaf-workshop:/main.tex',
            rangeEnd: {character: 1, line: 2, offset: 21},
            rangeStart: {character: 0, line: 2, offset: 20},
            resolved: false,
            rootCommentId: 'message-c1',
            selectedText: 'gamma',
            threadId: 'thread-c',
        },
    ]);

    assert.deepEqual(buildCommentThreadParityByDocId({inlineThreads, reviewThreads}), [{
        docId: 'doc-1',
        inlineThreadCount: 2,
        matchingThreadCount: 1,
        messageCountMismatches: [],
        missingInInline: ['thread-c'],
        missingInReview: ['thread-b'],
        resolvedMismatches: [],
        reviewThreadCount: 2,
        selectedTextMismatches: [],
    }]);
});

test('buildCommentThreadParityByDocId detects message, resolved, and selected-text mismatches on shared threads', () => {
    const parity = buildCommentThreadParityByDocId({
        inlineThreads: [{
            docId: 'doc-2',
            messageCount: 2,
            messageIds: ['message-1', 'message-2'],
            resolved: false,
            rootMessageId: 'message-1',
            selectedText: 'inline selection',
            threadId: 'thread-2',
        }],
        reviewThreads: [{
            docId: 'doc-2',
            messageCount: 1,
            messageIds: ['message-1'],
            resolved: true,
            rootMessageId: 'message-1',
            selectedText: 'review selection',
            threadId: 'thread-2',
        }],
    });

    assert.deepEqual(parity, [{
        docId: 'doc-2',
        inlineThreadCount: 1,
        matchingThreadCount: 1,
        messageCountMismatches: ['thread-2'],
        missingInInline: [],
        missingInReview: [],
        resolvedMismatches: ['thread-2'],
        reviewThreadCount: 1,
        selectedTextMismatches: ['thread-2'],
    }]);
});
