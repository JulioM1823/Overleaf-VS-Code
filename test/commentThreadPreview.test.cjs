const test = require('node:test');
const assert = require('node:assert/strict');

const {
    formatCommentThreadPreview,
} = require('../out/comments/commentThreadPreview.js');

test('formatCommentThreadPreview keeps short anchored text intact', () => {
    assert.equal(
        formatCommentThreadPreview('We conclude that our calculations are robust.'),
        '"We conclude that our calculations are robust."',
    );
});

test('formatCommentThreadPreview normalizes whitespace for the single-line header', () => {
    assert.equal(
        formatCommentThreadPreview('Methods to measure\n\n the   circulation'),
        '"Methods to measure the circulation"',
    );
});

test('formatCommentThreadPreview truncates long anchored text with an ellipsis', () => {
    assert.equal(
        formatCommentThreadPreview('abcdefghijklmnopqrstuvwxyz', 10),
        '"abcdefg…"'
    );
});

test('formatCommentThreadPreview returns undefined for empty selections', () => {
    assert.equal(formatCommentThreadPreview('   \n\t  '), undefined);
    assert.equal(formatCommentThreadPreview(undefined), undefined);
});
