const test = require('node:test');
const assert = require('node:assert/strict');

const {
    shouldBlockReviewCommentHydration,
    shouldPreferLocalCommentReviewStateForReason,
    shouldPreserveLocalReviewEntriesOnEmptyRefresh,
    shouldTreatCommentsChangedRefreshAsProjectWide,
    shouldUseLocalCommentReviewState,
} = require('../out/comments/reviewSyncPolicy.js');

test('shouldUseLocalCommentReviewState prefers local state once thread hydration is established', () => {
    assert.equal(shouldUseLocalCommentReviewState({
        commentThreadsLoaded: true,
        connectionPhase: 'live',
        deferredSynchronizationMode: 'online',
        hasLocalCommentState: true,
        hasCompleteTargetLocalState: false,
        isOfflineMode: false,
        preferLocalState: true,
    }), true);
});

test('shouldUseLocalCommentReviewState prefers complete targeted local state before thread hydration finishes', () => {
    assert.equal(shouldUseLocalCommentReviewState({
        commentThreadsLoaded: false,
        connectionPhase: 'live',
        deferredSynchronizationMode: 'online',
        hasLocalCommentState: true,
        hasCompleteTargetLocalState: true,
        isOfflineMode: false,
        preferLocalState: true,
    }), true);
});

test('shouldUseLocalCommentReviewState avoids partial local thread maps before live hydration', () => {
    assert.equal(shouldUseLocalCommentReviewState({
        commentThreadsLoaded: false,
        connectionPhase: 'live',
        deferredSynchronizationMode: 'online',
        hasLocalCommentState: true,
        hasCompleteTargetLocalState: false,
        isOfflineMode: false,
        preferLocalState: true,
    }), false);
});

test('shouldUseLocalCommentReviewState keeps local authority in offline or recovery modes', () => {
    assert.equal(shouldUseLocalCommentReviewState({
        commentThreadsLoaded: false,
        connectionPhase: 'recovering',
        deferredSynchronizationMode: 'sync-recovery',
        hasLocalCommentState: true,
        hasCompleteTargetLocalState: false,
        isOfflineMode: false,
        preferLocalState: true,
    }), true);

    assert.equal(shouldUseLocalCommentReviewState({
        commentThreadsLoaded: false,
        connectionPhase: 'live',
        deferredSynchronizationMode: 'online',
        hasLocalCommentState: true,
        hasCompleteTargetLocalState: false,
        isOfflineMode: true,
        preferLocalState: true,
    }), true);
});

test('shouldUseLocalCommentReviewState requires both preference and local data', () => {
    assert.equal(shouldUseLocalCommentReviewState({
        commentThreadsLoaded: true,
        connectionPhase: 'live',
        deferredSynchronizationMode: 'online',
        hasLocalCommentState: false,
        hasCompleteTargetLocalState: false,
        isOfflineMode: false,
        preferLocalState: true,
    }), false);

    assert.equal(shouldUseLocalCommentReviewState({
        commentThreadsLoaded: true,
        connectionPhase: 'live',
        deferredSynchronizationMode: 'online',
        hasLocalCommentState: true,
        hasCompleteTargetLocalState: false,
        isOfflineMode: false,
        preferLocalState: false,
    }), false);
});

test('shouldPreferLocalCommentReviewStateForReason keeps connectivity transitions and replay local-first', () => {
    assert.equal(shouldPreferLocalCommentReviewStateForReason('comments_changed:thread_created_offline'), true);
    assert.equal(shouldPreferLocalCommentReviewStateForReason('offline_state_changed:offline:comment_create_queued'), true);
    assert.equal(shouldPreferLocalCommentReviewStateForReason('realtime_state_changed:recovering:socket_disconnect'), true);
    assert.equal(shouldPreferLocalCommentReviewStateForReason('comments_changed:comments_replay_server_thread_id_resolved'), true);
    assert.equal(shouldPreferLocalCommentReviewStateForReason('comments_changed:thread_message_replayed'), true);
    assert.equal(shouldPreferLocalCommentReviewStateForReason('comments_changed:thread_edit_replayed'), true);
    assert.equal(shouldPreferLocalCommentReviewStateForReason('comments_changed:comments_replay_thread_reconciled'), true);
    assert.equal(shouldPreferLocalCommentReviewStateForReason('view_visible'), false);
});

test('shouldTreatCommentsChangedRefreshAsProjectWide marks empty comments_changed doc scopes as project-wide', () => {
    assert.equal(shouldTreatCommentsChangedRefreshAsProjectWide({
        reason: 'comments_changed:thread_message_edited',
    }), true);

    assert.equal(shouldTreatCommentsChangedRefreshAsProjectWide({
        docIds: [],
        reason: 'comments_changed:thread_message_edited',
    }), true);

    assert.equal(shouldTreatCommentsChangedRefreshAsProjectWide({
        docIds: [''],
        reason: 'comments_changed:thread_message_edited',
    }), true);

    assert.equal(shouldTreatCommentsChangedRefreshAsProjectWide({
        docIds: ['doc-1'],
        reason: 'comments_changed:thread_message_edited',
    }), false);

    assert.equal(shouldTreatCommentsChangedRefreshAsProjectWide({
        reason: 'view_visible',
    }), false);
});

test('shouldPreserveLocalReviewEntriesOnEmptyRefresh keeps existing entries during offline or recovery churn', () => {
    assert.equal(shouldPreserveLocalReviewEntriesOnEmptyRefresh({
        connectionPhase: 'recovering',
        deferredSynchronizationMode: 'sync-recovery',
        existingEntryCount: 1,
        isOfflineMode: false,
        nextEntryCount: 0,
        reason: 'offline_state_changed:offline:comment_create_queued',
    }), true);

    assert.equal(shouldPreserveLocalReviewEntriesOnEmptyRefresh({
        connectionPhase: 'live',
        deferredSynchronizationMode: 'online',
        existingEntryCount: 1,
        isOfflineMode: false,
        nextEntryCount: 0,
        reason: 'view_visible',
    }), false);

    assert.equal(shouldPreserveLocalReviewEntriesOnEmptyRefresh({
        connectionPhase: 'recovering',
        deferredSynchronizationMode: 'sync-recovery',
        existingEntryCount: 1,
        isOfflineMode: false,
        nextEntryCount: 1,
        reason: 'comments_changed:thread_created_offline',
    }), false);
});

test('shouldPreserveLocalReviewEntriesOnEmptyRefresh does not preserve legitimate offline deletes', () => {
    assert.equal(shouldPreserveLocalReviewEntriesOnEmptyRefresh({
        connectionPhase: 'recovering',
        deferredSynchronizationMode: 'sync-recovery',
        existingEntryCount: 1,
        isOfflineMode: true,
        nextEntryCount: 0,
        reason: 'comments_changed:thread_message_deleted_offline',
    }), false);

    assert.equal(shouldPreserveLocalReviewEntriesOnEmptyRefresh({
        connectionPhase: 'recovering',
        deferredSynchronizationMode: 'sync-recovery',
        existingEntryCount: 1,
        isOfflineMode: true,
        nextEntryCount: 0,
        reason: 'comments_changed:thread_deleted_after_last_message_removed_offline',
    }), false);
});

test('shouldBlockReviewCommentHydration honors explicit blocking requests', () => {
    assert.equal(shouldBlockReviewCommentHydration({
        changedDocIdsCount: 1,
        loadedChangedDocCount: 1,
        loadedCommentDocCount: 0,
        preferLocalState: false,
        projectDocumentCount: 5,
        requestedBlockingHydration: true,
    }), true);
});

test('shouldBlockReviewCommentHydration blocks local-state refreshes when changed docs are not hydrated', () => {
    assert.equal(shouldBlockReviewCommentHydration({
        changedDocIdsCount: 2,
        loadedChangedDocCount: 1,
        loadedCommentDocCount: 2,
        preferLocalState: true,
        projectDocumentCount: 5,
        requestedBlockingHydration: false,
    }), true);
});

test('shouldBlockReviewCommentHydration skips blocking once changed docs are hydrated', () => {
    assert.equal(shouldBlockReviewCommentHydration({
        changedDocIdsCount: 2,
        loadedChangedDocCount: 2,
        loadedCommentDocCount: 5,
        preferLocalState: true,
        projectDocumentCount: 5,
        requestedBlockingHydration: false,
    }), false);

    assert.equal(shouldBlockReviewCommentHydration({
        changedDocIdsCount: 1,
        loadedChangedDocCount: 1,
        loadedCommentDocCount: 10,
        preferLocalState: true,
        projectDocumentCount: 5,
        requestedBlockingHydration: false,
    }), false);
});

test('shouldBlockReviewCommentHydration blocks only cold start when no changed doc ids are available', () => {
    assert.equal(shouldBlockReviewCommentHydration({
        changedDocIdsCount: 0,
        loadedChangedDocCount: 0,
        loadedCommentDocCount: 0,
        preferLocalState: true,
        projectDocumentCount: 12,
        requestedBlockingHydration: false,
    }), true);

    assert.equal(shouldBlockReviewCommentHydration({
        changedDocIdsCount: 0,
        loadedChangedDocCount: 0,
        loadedCommentDocCount: 3,
        preferLocalState: true,
        projectDocumentCount: 12,
        requestedBlockingHydration: false,
    }), false);
});

test('shouldBlockReviewCommentHydration keeps non-local incremental refreshes non-blocking', () => {
    assert.equal(shouldBlockReviewCommentHydration({
        changedDocIdsCount: 1,
        loadedChangedDocCount: 0,
        loadedCommentDocCount: 0,
        preferLocalState: false,
        projectDocumentCount: 12,
        requestedBlockingHydration: false,
    }), false);
});
