const test = require('node:test');
const assert = require('node:assert/strict');

const {
    applyTextOperationsToCommentRanges,
    dedupeCommentRangesByThreadId,
    generateCommentThreadId,
    normalizeCommentRanges,
    removeCommentRange,
    resolveCommentThreadAnchorLine,
    updateCommentRangeResolvedState,
    upsertCommentRange,
} = require('../out/comments/commentRanges.js');
const {
    canDeleteCommentMessage,
    canDeleteThread,
    canEditOwnComment,
    resolveCommentPermissions,
} = require('../out/comments/commentPermissions.js');

test('generateCommentThreadId follows Overleaf object-id style shape', () => {
    const id = generateCommentThreadId(new Date('2026-04-06T12:00:00Z'), () => 0.5);
    assert.equal(id.length, 24);
    assert.match(id, /^[0-9a-f]{24}$/);
});

test('normalizeCommentRanges keeps only valid comment entries', () => {
    const ranges = normalizeCommentRanges([
        { id: 'thread-1', op: { c: 'hello', p: 3, t: 'thread-1' } },
        { id: 'broken', op: { p: 1, t: 'broken' } },
    ]);
    assert.deepEqual(ranges, [
        { id: 'thread-1', op: { c: 'hello', p: 3, resolved: undefined, t: 'thread-1' }, resolved: undefined, metadata: undefined },
    ]);
});

test('normalizeCommentRanges and dedupeCommentRangesByThreadId collapse duplicate thread ids to one anchor', () => {
    const ranges = normalizeCommentRanges([
        { id: 'thread-1', op: { c: 'hello', p: 3, t: 'thread-1' } },
        { id: 'thread-1', op: { c: 'hello', p: 3, t: 'thread-1' } },
    ]);
    assert.equal(ranges.length, 1);
    assert.deepEqual(dedupeCommentRangesByThreadId([
        { id: 'thread-1', op: { c: 'hello', p: 3, t: 'thread-1' } },
        { id: 'thread-1', op: { c: 'hello again', p: 4, t: 'thread-1' } },
    ]), [
        { id: 'thread-1', metadata: undefined, op: { c: 'hello again', p: 4, resolved: undefined, t: 'thread-1' }, resolved: undefined },
    ]);
});

test('upsertCommentRange adds and then updates an existing thread anchor', () => {
    const initial = upsertCommentRange([], { c: 'alpha', p: 4, t: 'thread-1' });
    assert.equal(initial.length, 1);
    const updated = upsertCommentRange(initial, { c: 'beta', p: 8, t: 'thread-1', resolved: true });
    assert.deepEqual(updated, [
        { id: 'thread-1', metadata: undefined, op: { c: 'beta', p: 8, resolved: true, t: 'thread-1' }, resolved: true },
    ]);
});

test('applyTextOperationsToCommentRanges shifts comments on insert and delete', () => {
    const result = applyTextOperationsToCommentRanges([
        { id: 'thread-1', op: { c: 'brown', p: 10, t: 'thread-1' } },
    ], [
        { i: 'very ', p: 10 },
        { d: 'bro', p: 15 },
    ]);
    assert.equal(result.contentMismatchCount, 0);
    assert.deepEqual(result.ranges, [
        { id: 'thread-1', metadata: undefined, op: { c: 'wn', p: 15, resolved: undefined, t: 'thread-1' }, resolved: undefined },
    ]);
});

test('applyTextOperationsToCommentRanges reports delete mismatches without dropping the range', () => {
    const result = applyTextOperationsToCommentRanges([
        { id: 'thread-1', op: { c: 'brown', p: 10, t: 'thread-1' } },
    ], [
        { d: 'xxx', p: 10 },
    ]);
    assert.equal(result.contentMismatchCount, 1);
    assert.deepEqual(result.ranges[0].op.c, 'wn');
});

test('updateCommentRangeResolvedState and removeCommentRange target thread ids', () => {
    const resolved = updateCommentRangeResolvedState([
        { id: 'thread-1', op: { c: 'brown', p: 10, t: 'thread-1' } },
    ], 'thread-1', true);
    assert.equal(resolved[0].resolved, true);
    assert.equal(resolved[0].op.resolved, true);
    assert.deepEqual(removeCommentRange(resolved, 'thread-1'), []);
});

test('resolveCommentThreadAnchorLine anchors threads to the first visual row of the logical line', () => {
    assert.equal(resolveCommentThreadAnchorLine({
        start: {
            line: 21,
        },
    }), 21);
    assert.equal(resolveCommentThreadAnchorLine({
        start: {
            line: -5,
        },
    }), 0);
});

test('resolveCommentPermissions mirrors Overleaf comment capabilities and disables mutations in fallback mode', () => {
    assert.deepEqual(resolveCommentPermissions('review'), {
        comment: true,
        read: true,
        resolveAllComments: false,
        resolveOwnComments: true,
        write: false,
    });
    assert.deepEqual(resolveCommentPermissions('owner', { fallbackReadonly: true }), {
        comment: false,
        read: true,
        resolveAllComments: false,
        resolveOwnComments: false,
        write: false,
    });
});

test('comment permission helpers restrict edit/delete to the same user unless all-comments permission is present', () => {
    const reviewPermissions = resolveCommentPermissions('review');
    const writerPermissions = resolveCommentPermissions('readAndWrite');
    assert.equal(canEditOwnComment(reviewPermissions, 'user-1', 'user-1'), true);
    assert.equal(canEditOwnComment(reviewPermissions, 'user-1', 'user-2'), false);
    assert.equal(canDeleteCommentMessage(reviewPermissions, 'user-1', 'user-2'), false);
    assert.equal(canDeleteCommentMessage(writerPermissions, 'user-1', 'user-2'), true);
    assert.equal(canDeleteThread(reviewPermissions, 'user-1', 'user-1'), true);
});
