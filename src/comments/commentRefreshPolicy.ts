export interface PendingCommentRefreshSuppression {
    expiresAt: number;
    threadId: string;
}

export function shouldSuppressCommentRefresh(options: {
    now?: number,
    pending?: PendingCommentRefreshSuppression,
    reason: string,
    threadIds?: string[],
}) {
    const { pending, reason, threadIds } = options;
    const now = options.now ?? Date.now();
    if (!pending || now >= pending.expiresAt) {
        return false;
    }
    if (reason!=='thread_reply_created') {
        return false;
    }
    if (threadIds && threadIds.length > 0 && !threadIds.includes(pending.threadId)) {
        return false;
    }
    return true;
}

export function shouldForceRemoteCommentThreadRebuild(options: {
    existingThreadCount: number,
    isOfflineVisibilityPreservingReason: boolean,
    isRemoteScheme: boolean,
    reason: string,
    trackedHandleCount: number,
}) {
    if (!options.isRemoteScheme) {
        return false;
    }
    if (options.isOfflineVisibilityPreservingReason) {
        return false;
    }
    if (!options.reason.includes('comments_changed_event:')) {
        return false;
    }
    if (!options.reason.includes('duplicate_rebuild:')) {
        return false;
    }
    return options.existingThreadCount > 0 || options.trackedHandleCount > 0;
}
