const test = require('node:test');
const assert = require('node:assert/strict');

const {
    shouldForceRemoteCommentThreadRebuild,
    shouldSuppressCommentRefresh,
} = require('../out/comments/commentRefreshPolicy.js');

test('shouldSuppressCommentRefresh only suppresses the matching local reply refresh window', () => {
    const pending = {
        expiresAt: 250,
        threadId: 'thread-1',
    };

    assert.equal(shouldSuppressCommentRefresh({
        now: 100,
        pending,
        reason: 'thread_reply_created',
        threadIds: ['thread-1'],
    }), true);

    assert.equal(shouldSuppressCommentRefresh({
        now: 100,
        pending,
        reason: 'thread_message_edited',
        threadIds: ['thread-1'],
    }), false);

    assert.equal(shouldSuppressCommentRefresh({
        now: 100,
        pending,
        reason: 'thread_reply_created',
        threadIds: ['thread-2'],
    }), false);

    assert.equal(shouldSuppressCommentRefresh({
        now: 250,
        pending,
        reason: 'thread_reply_created',
        threadIds: ['thread-1'],
    }), false);
});

test('shouldSuppressCommentRefresh allows suppression when no thread ids are attached to the event', () => {
    assert.equal(shouldSuppressCommentRefresh({
        now: 50,
        pending: {
            expiresAt: 75,
            threadId: 'thread-1',
        },
        reason: 'thread_reply_created',
    }), true);
});

test('shouldForceRemoteCommentThreadRebuild avoids normal comments-changed flicker', () => {
    assert.equal(shouldForceRemoteCommentThreadRebuild({
        existingThreadCount: 3,
        isOfflineVisibilityPreservingReason: false,
        isRemoteScheme: true,
        reason: 'comments_changed_event:thread_created',
        trackedHandleCount: 3,
    }), false);

    assert.equal(shouldForceRemoteCommentThreadRebuild({
        existingThreadCount: 3,
        isOfflineVisibilityPreservingReason: false,
        isRemoteScheme: true,
        reason: 'duplicate_rebuild:comments_changed_event:thread_created',
        trackedHandleCount: 3,
    }), true);
});

test('shouldForceRemoteCommentThreadRebuild does not rebuild local or offline-preserved render state', () => {
    assert.equal(shouldForceRemoteCommentThreadRebuild({
        existingThreadCount: 3,
        isOfflineVisibilityPreservingReason: false,
        isRemoteScheme: false,
        reason: 'duplicate_rebuild:comments_changed_event:thread_created',
        trackedHandleCount: 3,
    }), false);

    assert.equal(shouldForceRemoteCommentThreadRebuild({
        existingThreadCount: 3,
        isOfflineVisibilityPreservingReason: true,
        isRemoteScheme: true,
        reason: 'duplicate_rebuild:comments_changed_event:thread_created_offline',
        trackedHandleCount: 3,
    }), false);
});
