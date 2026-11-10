const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveCommentThreadDisplayRange,
    resolveCommentThreadExtentRange,
    resolveStableCommentThreadAnchorShape,
    resolveViewportAdjustedCommentThreadRange,
    shouldPinCommentThreadToStartAnchor,
} = require('../out/comments/commentThreadAnchorPolicy.js');

test('resolveStableCommentThreadAnchorShape keeps anchors minimally non-empty on normal lines', () => {
    assert.deepEqual(resolveStableCommentThreadAnchorShape(24, true), {
        endCharacter: 1,
        useLineBreakFallback: false,
    });

    assert.deepEqual(resolveStableCommentThreadAnchorShape(1, false), {
        endCharacter: 1,
        useLineBreakFallback: false,
    });
});

test('resolveStableCommentThreadAnchorShape keeps empty-line anchors on the same line', () => {
    assert.deepEqual(resolveStableCommentThreadAnchorShape(0, true), {
        endCharacter: 0,
        useLineBreakFallback: false,
    });

    assert.deepEqual(resolveStableCommentThreadAnchorShape(0, false), {
        endCharacter: 0,
        useLineBreakFallback: false,
    });
});

test('resolveCommentThreadDisplayRange collapses non-empty comments to a single logical-line anchor', () => {
    assert.deepEqual(resolveCommentThreadDisplayRange({
        anchorLine: 20,
        commentEndCharacter: 14,
        commentEndLine: 22,
        commentStartCharacter: 3,
        commentStartLine: 20,
        hasLineBreak: true,
        lineTextLength: 48,
    }), {
        endCharacter: 4,
        endLine: 20,
        startCharacter: 3,
        startLine: 20,
    });

    assert.deepEqual(resolveCommentThreadDisplayRange({
        anchorLine: 21,
        commentEndCharacter: 140,
        commentEndLine: 21,
        commentStartCharacter: 0,
        commentStartLine: 21,
        hasLineBreak: true,
        lineTextLength: 140,
    }), {
        endCharacter: 1,
        endLine: 21,
        startCharacter: 0,
        startLine: 21,
    });
});

test('resolveCommentThreadDisplayRange synthesizes a minimal fallback only for empty ranges', () => {
    assert.deepEqual(resolveCommentThreadDisplayRange({
        anchorLine: 11,
        commentEndCharacter: 0,
        commentEndLine: 11,
        commentStartCharacter: 0,
        commentStartLine: 11,
        hasLineBreak: false,
        lineTextLength: 32,
    }), {
        endCharacter: 1,
        endLine: 11,
        startCharacter: 0,
        startLine: 11,
    });

    assert.deepEqual(resolveCommentThreadDisplayRange({
        anchorLine: 7,
        commentEndCharacter: 0,
        commentEndLine: 7,
        commentStartCharacter: 0,
        commentStartLine: 7,
        hasLineBreak: true,
        lineTextLength: 0,
    }), {
        endCharacter: 0,
        endLine: 7,
        startCharacter: 0,
        startLine: 7,
    });
});

test('resolveCommentThreadExtentRange preserves the real commented span when it is non-empty', () => {
    assert.deepEqual(resolveCommentThreadExtentRange({
        anchorLine: 20,
        commentEndCharacter: 14,
        commentEndLine: 22,
        commentStartCharacter: 3,
        commentStartLine: 20,
        hasLineBreak: true,
        lineTextLength: 48,
    }), {
        endCharacter: 14,
        endLine: 22,
        startCharacter: 3,
        startLine: 20,
    });
});

test('resolveViewportAdjustedCommentThreadRange preserves the base range within wrapped segments of the same logical line', () => {
    assert.deepEqual(resolveViewportAdjustedCommentThreadRange({
        baseEndCharacter: 140,
        baseEndLine: 21,
        baseStartCharacter: 0,
        baseStartLine: 21,
        visibleRanges: [{
            endCharacter: 0,
            endLine: 30,
            startCharacter: 52,
            startLine: 21,
        }],
    }), {
        endCharacter: 140,
        endLine: 21,
        startCharacter: 0,
        startLine: 21,
    });
});

test('resolveViewportAdjustedCommentThreadRange shifts into later visible lines for multiline threads', () => {
    assert.deepEqual(resolveViewportAdjustedCommentThreadRange({
        baseEndCharacter: 8,
        baseEndLine: 23,
        baseStartCharacter: 4,
        baseStartLine: 21,
        visibleRanges: [{
            endCharacter: 0,
            endLine: 30,
            startCharacter: 0,
            startLine: 22,
        }],
    }), {
        endCharacter: 8,
        endLine: 23,
        startCharacter: 0,
        startLine: 22,
    });
});

test('resolveViewportAdjustedCommentThreadRange preserves the base range when the thread host is still visible', () => {
    assert.deepEqual(resolveViewportAdjustedCommentThreadRange({
        baseEndCharacter: 140,
        baseEndLine: 21,
        baseStartCharacter: 0,
        baseStartLine: 21,
        visibleRanges: [{
            endCharacter: 0,
            endLine: 30,
            startCharacter: 0,
            startLine: 21,
        }],
    }), {
        endCharacter: 140,
        endLine: 21,
        startCharacter: 0,
        startLine: 21,
    });
});

test('shouldPinCommentThreadToStartAnchor pins locally pending comment roots', () => {
    assert.equal(shouldPinCommentThreadToStartAnchor({
        isOfflineMode: false,
        reason: 'create_comment_from_current_window_draft_thread_local_state',
        rootMessageId: 'pending-comment-123',
        synchronizationMode: 'online',
    }), true);

    assert.equal(shouldPinCommentThreadToStartAnchor({
        isOfflineMode: false,
        reason: 'create_comment_from_current_window_draft_thread_local_state',
        rootMessageId: 'offline-comment-123',
        synchronizationMode: 'online',
    }), true);
});

test('shouldPinCommentThreadToStartAnchor pins offline create refreshes until server state arrives', () => {
    assert.equal(shouldPinCommentThreadToStartAnchor({
        isOfflineMode: true,
        reason: 'comments_changed_event:thread_created_offline',
        rootMessageId: 'server-message-1',
        synchronizationMode: 'offline',
    }), true);

    assert.equal(shouldPinCommentThreadToStartAnchor({
        isOfflineMode: false,
        reason: 'comments_changed_event:thread_created',
        rootMessageId: 'server-message-1',
        synchronizationMode: 'online',
    }), false);
});

test('shouldPinCommentThreadToStartAnchor pins all offline and recovery rendering', () => {
    assert.equal(shouldPinCommentThreadToStartAnchor({
        isOfflineMode: true,
        reason: 'transient_document_change',
        rootMessageId: 'server-message-1',
        synchronizationMode: 'offline',
    }), true);

    assert.equal(shouldPinCommentThreadToStartAnchor({
        isOfflineMode: false,
        reason: 'realtime_state_changed:recovering',
        rootMessageId: 'server-message-1',
        synchronizationMode: 'sync-recovery',
    }), true);
});
