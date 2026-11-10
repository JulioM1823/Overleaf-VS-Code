const test = require('node:test');
const assert = require('node:assert/strict');

const {
    shouldSkipBuiltInCommentLineFocus,
} = require('../out/comments/commentFocusPolicy.js');

test('shouldSkipBuiltInCommentLineFocus keeps built-in focus command enabled for expanded threads', () => {
    assert.equal(shouldSkipBuiltInCommentLineFocus({
        mode: 'localReplica',
        threadExpanded: true,
    }), false);

    assert.equal(shouldSkipBuiltInCommentLineFocus({
        mode: 'currentWindow',
        threadExpanded: true,
    }), false);
});

test('shouldSkipBuiltInCommentLineFocus keeps built-in focus command enabled for unsupported and collapsed threads', () => {
    assert.equal(shouldSkipBuiltInCommentLineFocus({
        mode: 'unsupported',
        threadExpanded: true,
    }), false);

    assert.equal(shouldSkipBuiltInCommentLineFocus({
        mode: 'localReplica',
        threadExpanded: false,
    }), false);
});
