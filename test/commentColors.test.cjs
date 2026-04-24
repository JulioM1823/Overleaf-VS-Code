const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_COMMENT_USER_PALETTE,
    isValidCommentUserColorHex,
    normalizeCommentUserPalette,
    resolveCommentUserColorByIndex,
    resolveCommentUserIdentifier,
} = require('../out/comments/commentColors.js');

test('resolveCommentUserIdentifier prefers stable backend ids', () => {
    assert.equal(resolveCommentUserIdentifier({
        id: 'message-1',
        user: {
            email: 'fallback@example.com',
            name: 'Fallback User',
        },
        user_id: 'user-1',
    }), 'user-1');
});

test('resolveCommentUserColorByIndex uses the predefined palette for the first six users', () => {
    assert.deepEqual([
        resolveCommentUserColorByIndex(0),
        resolveCommentUserColorByIndex(1),
        resolveCommentUserColorByIndex(2),
        resolveCommentUserColorByIndex(3),
        resolveCommentUserColorByIndex(4),
        resolveCommentUserColorByIndex(5),
    ], [
        '#ef6b73',
        '#f6bb58',
        '#6fd36b',
        '#63b3ed',
        '#6b66e8',
        '#ef476f',
    ]);
});

test('resolveCommentUserColorByIndex accepts a custom six-color palette', () => {
    const customPalette = [
        '#ff6b6b',
        '#f7b267',
        '#7bd389',
        '#6ec1e4',
        '#9d8df1',
        '#f45b69',
    ];
    assert.deepEqual([
        resolveCommentUserColorByIndex(0, customPalette),
        resolveCommentUserColorByIndex(1, customPalette),
        resolveCommentUserColorByIndex(2, customPalette),
        resolveCommentUserColorByIndex(3, customPalette),
        resolveCommentUserColorByIndex(4, customPalette),
        resolveCommentUserColorByIndex(5, customPalette),
    ], customPalette);
});

test('resolveCommentUserColorByIndex generates distinct supplemental colors after the base palette', () => {
    const generated = [
        resolveCommentUserColorByIndex(6),
        resolveCommentUserColorByIndex(7),
        resolveCommentUserColorByIndex(8),
    ];
    assert.equal(new Set(generated).size, generated.length);
    generated.forEach((color) => {
        assert.match(color, /^#[0-9a-f]{6}$/i);
    });
});

test('isValidCommentUserColorHex accepts only six-digit hex colors', () => {
    assert.equal(isValidCommentUserColorHex('#FF6B6B'), true);
    assert.equal(isValidCommentUserColorHex('#ff6b6b'), true);
    assert.equal(isValidCommentUserColorHex('#fff'), false);
    assert.equal(isValidCommentUserColorHex('ff6b6b'), false);
    assert.equal(isValidCommentUserColorHex('#zzzzzz'), false);
});

test('normalizeCommentUserPalette falls back to the defaults when the configured palette is invalid', () => {
    assert.deepEqual(normalizeCommentUserPalette([
        '#ff6b6b',
        '#f7b267',
        '#7bd389',
    ]), DEFAULT_COMMENT_USER_PALETTE);
    assert.deepEqual(normalizeCommentUserPalette([
        '#ff6b6b',
        '#f7b267',
        '#7bd389',
        '#6ec1e4',
        '#9d8df1',
        'invalid-color',
    ]), DEFAULT_COMMENT_USER_PALETTE);
});
