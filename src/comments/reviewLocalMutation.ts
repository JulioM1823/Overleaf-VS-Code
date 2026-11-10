import { OverleafReviewMessageEntry, OverleafReviewThreadEntry } from './reviewIndex';

export interface ReviewLocalMutation {
    content?: string;
    kind: 'deleteMessage' | 'deleteThread' | 'editMessage';
    messageId: string;
    threadId: string;
}

function normalizeRemainingMessages(messages: OverleafReviewMessageEntry[]) {
    return messages.map((message, index) => ({
        ...message,
        isRoot: index===0,
    }));
}

export function applyReviewMessageEditLocally(
    entry: OverleafReviewThreadEntry,
    messageId: string,
    content: string,
): OverleafReviewThreadEntry {
    let changed = false;
    const nextMessages = entry.messages.map((message) => {
        if (message.id!==messageId) {
            return message;
        }
        changed = true;
        return {
            ...message,
            content,
        };
    });
    if (!changed) {
        return entry;
    }
    return {
        ...entry,
        messages: nextMessages,
    };
}

export function applyReviewMessageDeleteLocally(
    entry: OverleafReviewThreadEntry,
    messageId: string,
): OverleafReviewThreadEntry | undefined {
    const remainingMessages = entry.messages.filter((message) => message.id!==messageId);
    if (remainingMessages.length===entry.messages.length) {
        return entry;
    }
    if (remainingMessages.length===0) {
        return undefined;
    }
    const normalizedMessages = normalizeRemainingMessages(remainingMessages);
    const rootMessage = normalizedMessages[0];
    return {
        ...entry,
        canDeleteRootComment: rootMessage.canDelete,
        canEditRootComment: rootMessage.canEdit,
        messages: normalizedMessages,
        rootCommentId: rootMessage.id,
        rootCommentUserId: rootMessage.userId,
    };
}

export function resolveReviewEntryByThreadOrMessage(
    entries: Iterable<OverleafReviewThreadEntry>,
    threadId: string,
    messageId?: string,
) {
    let fallbackEntry: OverleafReviewThreadEntry | undefined;
    for (const entry of entries) {
        if (entry.threadId===threadId) {
            return {
                entry,
                matchedBy: 'threadId' as const,
            };
        }
        if (!fallbackEntry && messageId && entry.messages.some((message) => message.id===messageId)) {
            fallbackEntry = entry;
        }
    }
    if (!fallbackEntry) {
        return undefined;
    }
    return {
        entry: fallbackEntry,
        matchedBy: 'messageId' as const,
    };
}

export function applyPendingReviewLocalMutations(
    entries: OverleafReviewThreadEntry[],
    mutations: ReviewLocalMutation[],
) {
    const nextEntries = [...entries];
    const retainedMutations: ReviewLocalMutation[] = [];

    for (const mutation of mutations) {
        const resolvedTarget = resolveReviewEntryByThreadOrMessage(
            nextEntries,
            mutation.threadId,
            mutation.messageId,
        );
        if (!resolvedTarget) {
            if (mutation.kind==='editMessage') {
                retainedMutations.push(mutation);
            }
            continue;
        }

        const existingEntry = resolvedTarget.entry;
        const existingIndex = nextEntries.findIndex((candidate) => candidate.threadId===existingEntry.threadId);
        if (existingIndex < 0) {
            if (mutation.kind==='editMessage') {
                retainedMutations.push(mutation);
            }
            continue;
        }

        if (mutation.kind==='deleteThread') {
            nextEntries.splice(existingIndex, 1);
            retainedMutations.push(mutation);
            continue;
        }
        const existingMessage = existingEntry.messages.find((message) => message.id===mutation.messageId);
        if (mutation.kind==='editMessage') {
            if (!existingMessage) {
                retainedMutations.push(mutation);
                continue;
            }
            if (existingMessage.content===mutation.content) {
                continue;
            }
            nextEntries.splice(
                existingIndex,
                1,
                applyReviewMessageEditLocally(existingEntry, mutation.messageId, mutation.content ?? ''),
            );
            retainedMutations.push(mutation);
            continue;
        }

        if (!existingMessage) {
            continue;
        }
        const nextEntry = applyReviewMessageDeleteLocally(existingEntry, mutation.messageId);
        if (!nextEntry) {
            nextEntries.splice(existingIndex, 1);
        } else {
            nextEntries.splice(existingIndex, 1, nextEntry);
        }
        retainedMutations.push(mutation);
    }

    return {
        entries: nextEntries,
        retainedMutations,
    };
}
