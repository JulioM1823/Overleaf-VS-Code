const test = require('node:test');
const assert = require('node:assert/strict');

const {
    compareReviewThreadEntries,
    describeOverleafCommentAuthor,
    positionAtOffset,
    sortReviewThreadEntries,
} = require('../out/comments/reviewIndex.js');

test('describeOverleafCommentAuthor prefers explicit backend display names', () => {
    assert.equal(describeOverleafCommentAuthor({
        id: 'message-1',
        user: {
            email: 'fallback@example.com',
            name: 'Primary Name',
        },
        user_id: 'user-1',
    }), 'Primary Name');
});

test('positionAtOffset resolves line and character from document offsets', () => {
    assert.deepEqual(positionAtOffset('alpha\nbeta\ngamma', 8), {
        character: 2,
        line: 1,
        offset: 8,
    });
});

test('compareReviewThreadEntries sorts threads by document position before any non-positional metadata', () => {
    const baseEntry = {
        canDeleteRootComment: false,
        canEditRootComment: false,
        canResolveThread: false,
        docId: 'doc-1',
        filePath: 'main.tex',
        headerPreview: '"preview"',
        lastActivityAt: 10,
        messages: [],
        overleafUri: 'overleaf-workshop://server/main.tex',
        rangeEnd: {character: 1, line: 0, offset: 1},
        rangeStart: {character: 0, line: 0, offset: 0},
        resolved: false,
        selectedText: 'preview',
        threadId: 'thread-1',
    };

    assert.equal(compareReviewThreadEntries(
        {
            ...baseEntry,
            lastActivityAt: 999,
            rangeEnd: {character: 6, line: 1, offset: 12},
            rangeStart: {character: 3, line: 1, offset: 9},
            resolved: true,
            threadId: 'thread-lower',
        },
        {
            ...baseEntry,
            lastActivityAt: 1,
            rangeEnd: {character: 3, line: 0, offset: 3},
            rangeStart: {character: 0, line: 0, offset: 0},
            resolved: false,
            threadId: 'thread-upper',
        },
    ) > 0, true);
});

test('sortReviewThreadEntries returns a stable top-to-bottom ordering for review panel entries', () => {
    const baseEntry = {
        canDeleteRootComment: false,
        canEditRootComment: false,
        canReply: false,
        canResolveThread: false,
        docId: 'doc-1',
        filePath: 'main.tex',
        headerPreview: '"preview"',
        lastActivityAt: 10,
        messages: [],
        overleafUri: 'overleaf-workshop://server/main.tex',
        rangeEnd: {character: 1, line: 0, offset: 1},
        rangeStart: {character: 0, line: 0, offset: 0},
        resolved: false,
        selectedText: 'preview',
        threadId: 'thread-1',
    };

    const sorted = sortReviewThreadEntries([
        {
            ...baseEntry,
            filePath: 'z-main.tex',
            rangeEnd: {character: 8, line: 3, offset: 40},
            rangeStart: {character: 2, line: 3, offset: 34},
            threadId: 'thread-bottom',
        },
        {
            ...baseEntry,
            filePath: 'a-main.tex',
            rangeEnd: {character: 6, line: 2, offset: 20},
            rangeStart: {character: 4, line: 2, offset: 18},
            threadId: 'thread-other-file',
        },
        {
            ...baseEntry,
            filePath: 'z-main.tex',
            lastActivityAt: 999,
            rangeEnd: {character: 9, line: 1, offset: 15},
            rangeStart: {character: 4, line: 1, offset: 10},
            resolved: true,
            threadId: 'thread-middle-a',
        },
        {
            ...baseEntry,
            filePath: 'z-main.tex',
            lastActivityAt: 0,
            rangeEnd: {character: 9, line: 1, offset: 15},
            rangeStart: {character: 4, line: 1, offset: 10},
            resolved: false,
            threadId: 'thread-middle-b',
        },
    ]);

    assert.deepEqual(sorted.map((entry) => entry.threadId), [
        'thread-other-file',
        'thread-middle-a',
        'thread-middle-b',
        'thread-bottom',
    ]);
});
