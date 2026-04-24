export interface ReviewLocalStatePolicyInput {
    commentThreadsLoaded: boolean;
    connectionPhase: string;
    deferredSynchronizationMode: string;
    hasLocalCommentState: boolean;
    hasCompleteTargetLocalState: boolean;
    isOfflineMode: boolean;
    preferLocalState: boolean;
}

export function shouldUseLocalCommentReviewState(input: ReviewLocalStatePolicyInput) {
    if (!input.preferLocalState || !input.hasLocalCommentState) {
        return false;
    }

    // A targeted comment mutation can be rendered immediately before the
    // project-wide thread index finishes hydrating if every changed doc already
    // has local ranges and thread messages.
    if (input.hasCompleteTargetLocalState) {
        return true;
    }

    // Once thread metadata has been hydrated at least once, keep comment-changed
    // refreshes anchored to local state so inline and review stay lockstep.
    if (input.commentThreadsLoaded) {
        return true;
    }

    // Before first hydration, local thread maps may be incomplete in live mode.
    // Preserve existing offline/recovery behavior where local state is authoritative.
    return input.isOfflineMode
        || input.deferredSynchronizationMode==='sync-recovery'
        || input.connectionPhase!=='live';
}

function normalizeReviewRefreshReason(reason: string) {
    return reason.startsWith('comments_changed:')
        ? reason.slice('comments_changed:'.length)
        : reason;
}

function shouldAllowEmptyReviewStateForReason(reason: string) {
    const normalizedReason = normalizeReviewRefreshReason(reason);
    return normalizedReason==='delete_comment'
        || normalizedReason==='delete_thread'
        || normalizedReason==='thread_deleted'
        || normalizedReason==='thread_deleted_after_last_message_removed'
        || normalizedReason==='thread_deleted_after_last_message_removed_offline'
        || normalizedReason==='thread_deleted_offline'
        || normalizedReason==='thread_message_deleted'
        || normalizedReason==='thread_message_deleted_offline';
}

export function shouldPreferLocalCommentReviewStateForReason(reason: string) {
    const normalizedReason = normalizeReviewRefreshReason(reason);
    return reason.startsWith('comments_changed:')
        || normalizedReason==='comments_recovery_ranges_preserved'
        || normalizedReason==='comments_replay_server_thread_id_resolved'
        || normalizedReason==='thread_message_replayed'
        || normalizedReason==='thread_reply_replayed'
        || normalizedReason==='thread_edit_replayed'
        || normalizedReason==='comments_replay_thread_id_reconciled'
        || normalizedReason==='comments_replay_thread_reconciled'
        || normalizedReason==='comments_replay_range_restored_from_operation_payload'
        || normalizedReason.startsWith('offline_state_changed:')
        || normalizedReason.startsWith('realtime_state_changed:');
}

export function shouldTreatCommentsChangedRefreshAsProjectWide(input: {
    docIds?: string[];
    reason: string;
}) {
    if (!input.reason.startsWith('comments_changed:')) {
        return false;
    }
    const normalizedDocIds = (input.docIds ?? []).filter((docId) => typeof docId==='string' && docId.length > 0);
    return normalizedDocIds.length===0;
}

export interface ReviewEntryPreservationPolicyInput {
    connectionPhase: string;
    deferredSynchronizationMode: string;
    existingEntryCount: number;
    isOfflineMode: boolean;
    nextEntryCount: number;
    reason: string;
}

export function shouldPreserveLocalReviewEntriesOnEmptyRefresh(input: ReviewEntryPreservationPolicyInput) {
    if (input.existingEntryCount===0 || input.nextEntryCount > 0) {
        return false;
    }
    if (shouldAllowEmptyReviewStateForReason(input.reason)) {
        return false;
    }
    if (!shouldPreferLocalCommentReviewStateForReason(input.reason)) {
        return false;
    }
    return input.isOfflineMode
        || input.deferredSynchronizationMode==='sync-recovery'
        || input.connectionPhase!=='live';
}

export interface ReviewHydrationPolicyInput {
    changedDocIdsCount: number;
    loadedChangedDocCount: number;
    loadedCommentDocCount: number;
    preferLocalState: boolean;
    projectDocumentCount: number;
    requestedBlockingHydration: boolean;
}

export function shouldBlockReviewCommentHydration(input: ReviewHydrationPolicyInput) {
    if (input.requestedBlockingHydration) {
        return true;
    }

    if (!input.preferLocalState) {
        return false;
    }

    if (input.changedDocIdsCount > 0) {
        return input.loadedChangedDocCount < input.changedDocIdsCount;
    }

    // For comments_changed refreshes without doc ids, block only during initial
    // cold-start hydration. Once any ranges are loaded, keep refreshes realtime
    // and let hydration continue in the background.
    return input.loadedCommentDocCount===0 && input.projectDocumentCount > 0;
}
