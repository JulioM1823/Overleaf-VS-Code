const test = require('node:test');
const assert = require('node:assert/strict');

const {mergeScopedReviewThreadEntries} = require('../out/comments/reviewEntryRefresh.js');

function createEntry(overrides = {}) {
    return {
        canDeleteRootComment: false,
        canEditRootComment: false,
        canReply: true,
        canResolveThread: true,
        docId: 'doc-1',
        filePath: 'main.tex',
        lastActivityAt: 0,
        messages: [],
        overleafUri: 'overleaf-workshop:/main.tex',
        rangeEnd: {character: 1, line: 0, offset: 1},
        rangeStart: {character: 0, line: 0, offset: 0},
        resolved: false,
        selectedText: 'x',
        threadId: 'thread-1',
        ...overrides,
    };
}

test('mergeScopedReviewThreadEntries replaces the full collection when no doc scope is provided', () => {
    const merged = mergeScopedReviewThreadEntries([
        createEntry({docId: 'doc-a', threadId: 'thread-a'}),
    ], [
        createEntry({docId: 'doc-b', threadId: 'thread-b'}),
    ]);

    assert.deepEqual(merged.map((entry) => entry.threadId), ['thread-b']);
});

test('mergeScopedReviewThreadEntries preserves non-target docs while replacing the refreshed doc slice', () => {
    const merged = mergeScopedReviewThreadEntries([
        createEntry({docId: 'doc-a', threadId: 'thread-a-1'}),
        createEntry({docId: 'doc-b', threadId: 'thread-b-1'}),
        createEntry({docId: 'doc-b', threadId: 'thread-b-2'}),
    ], [
        createEntry({docId: 'doc-b', threadId: 'thread-b-2', selectedText: 'updated'}),
        createEntry({docId: 'doc-b', threadId: 'thread-b-3'}),
    ], ['doc-b']);

    assert.deepEqual(
        merged.map((entry) => [entry.docId, entry.threadId, entry.selectedText]),
        [
            ['doc-a', 'thread-a-1', 'x'],
            ['doc-b', 'thread-b-2', 'updated'],
            ['doc-b', 'thread-b-3', 'x'],
        ],
    );
});

test('mergeScopedReviewThreadEntries removes stale entries from the targeted docs when the refreshed slice is empty', () => {
    const merged = mergeScopedReviewThreadEntries([
        createEntry({docId: 'doc-a', threadId: 'thread-a-1'}),
        createEntry({docId: 'doc-b', threadId: 'thread-b-1'}),
    ], [], ['doc-b']);

    assert.deepEqual(
        merged.map((entry) => [entry.docId, entry.threadId]),
        [['doc-a', 'thread-a-1']],
    );
});
