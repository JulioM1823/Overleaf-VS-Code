export interface CommentThreadCollapsibleHandle {
    collapsibleState: number;
}

export interface StableCommentRenderHandle {
    author?: {
        iconPath?: unknown;
        name?: string;
    };
    body?: unknown;
    contextValue?: string;
    label?: string;
    mode?: number;
    overleafMessageId?: string;
    overleafThreadId?: string;
    overleafUserId?: string;
}

const COMMENT_THREAD_COLLAPSIBLE_STATE_COLLAPSED = 0;
const COMMENT_THREAD_COLLAPSIBLE_STATE_EXPANDED = 1;

function stableRenderValue(value: unknown): string {
    if (value===undefined || value===null) {
        return '';
    }
    if (typeof value==='string' || typeof value==='number' || typeof value==='boolean') {
        return String(value);
    }
    if (typeof value==='object' && 'value' in value) {
        const candidate = (value as {value?: unknown}).value;
        if (candidate!==undefined && candidate!==null) {
            return stableRenderValue(candidate);
        }
    }
    if (typeof value==='object' && 'light' in value && 'dark' in value) {
        const iconPath = value as {dark?: unknown, light?: unknown};
        return `${stableRenderValue(iconPath.light)}\u0000${stableRenderValue(iconPath.dark)}`;
    }
    if (typeof (value as {toString?: unknown}).toString==='function') {
        return (value as {toString: () => string}).toString();
    }
    return String(value);
}

export function areStableCommentRenderEntriesEqual(
    left: StableCommentRenderHandle,
    right: StableCommentRenderHandle,
) {
    return left.overleafMessageId===right.overleafMessageId
        && left.overleafThreadId===right.overleafThreadId
        && left.overleafUserId===right.overleafUserId
        && left.contextValue===right.contextValue
        && left.label===right.label
        && left.mode===right.mode
        && left.author?.name===right.author?.name
        && stableRenderValue(left.author?.iconPath)===stableRenderValue(right.author?.iconPath)
        && stableRenderValue(left.body)===stableRenderValue(right.body);
}

export function areStableCommentRenderListsEqual(
    left: readonly StableCommentRenderHandle[],
    right: readonly StableCommentRenderHandle[],
) {
    if (left.length!==right.length) {
        return false;
    }
    return left.every((leftComment, index) => {
        return areStableCommentRenderEntriesEqual(leftComment, right[index]);
    });
}

export function collapseExpandedCommentThreads<T extends CommentThreadCollapsibleHandle>(threads: Iterable<T>) {
    let collapsedCount = 0;
    for (const thread of threads) {
        if (thread.collapsibleState!==COMMENT_THREAD_COLLAPSIBLE_STATE_EXPANDED) {
            continue;
        }
        thread.collapsibleState = COMMENT_THREAD_COLLAPSIBLE_STATE_COLLAPSED;
        collapsedCount += 1;
    }
    return collapsedCount;
}
