const test = require('node:test');
const assert = require('node:assert/strict');

const {
    shouldSkipBuiltInCommentLineFocus,
} = require('../out/comments/commentFocusPolicy.js');

test('shouldSkipBuiltInCommentLineFocus keeps the built-in focus command for expanded local-replica threads', () => {
    assert.equal(shouldSkipBuiltInCommentLineFocus({
        mode: 'localReplica',
        threadExpanded: true,
    }), false);
});

test('shouldSkipBuiltInCommentLineFocus keeps the built-in focus command for non-local or collapsed threads', () => {
    assert.equal(shouldSkipBuiltInCommentLineFocus({
        mode: 'currentWindow',
        threadExpanded: true,
    }), false);

    assert.equal(shouldSkipBuiltInCommentLineFocus({
        mode: 'localReplica',
        threadExpanded: false,
    }), false);
});
