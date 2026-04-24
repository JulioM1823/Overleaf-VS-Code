const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildCommentAnchorUpdate,
} = require('../out/comments/commentAnchorUpdate.js');

test('buildCommentAnchorUpdate preserves undefined lastVersion for fresh joined docs', () => {
    assert.deepEqual(buildCommentAnchorUpdate({
        docId: 'doc-1',
        docVersion: 12,
        lastVersion: undefined,
        selectedText: 'alpha',
        startOffset: 4,
        threadId: 'thread-1',
    }), {
        doc: 'doc-1',
        lastV: undefined,
        op: [{
            c: 'alpha',
            p: 4,
            t: 'thread-1',
        }],
        v: 12,
    });
});

test('buildCommentAnchorUpdate preserves an existing lastVersion for follow-up ops', () => {
    assert.deepEqual(buildCommentAnchorUpdate({
        docId: 'doc-2',
        docVersion: 18,
        lastVersion: 17,
        selectedText: 'beta',
        startOffset: 9,
        threadId: 'thread-2',
    }), {
        doc: 'doc-2',
        lastV: 17,
        op: [{
            c: 'beta',
            p: 9,
            t: 'thread-2',
        }],
        v: 18,
    });
});
