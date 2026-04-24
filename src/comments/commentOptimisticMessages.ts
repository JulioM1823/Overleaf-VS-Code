/* eslint-disable @typescript-eslint/naming-convention */

export type PendingOptimisticCommentMessages = Map<string, string[]>;

function getOptimisticCommentMessageKey(threadId: string, userId: string, content: string) {
    return `${threadId.trim()}\u0000${userId.trim()}\u0000${content}`;
}

export function recordOptimisticCommentMessage(
    pendingMessages: PendingOptimisticCommentMessages,
    message: {
        threadId: string,
        userId: string,
        content: string,
        id: string,
    },
) {
    if (!message.threadId || !message.userId) {
        return;
    }
    const key = getOptimisticCommentMessageKey(message.threadId, message.userId, message.content);
    const existingIds = pendingMessages.get(key) ?? [];
    pendingMessages.set(key, [...existingIds, message.id]);
}

export function consumeOptimisticCommentMessageId(
    pendingMessages: PendingOptimisticCommentMessages,
    message: {
        threadId: string,
        userId: string,
        content: string,
    },
) {
    if (!message.threadId || !message.userId) {
        return undefined;
    }
    const key = getOptimisticCommentMessageKey(message.threadId, message.userId, message.content);
    const existingIds = pendingMessages.get(key) ?? [];
    const [nextId, ...restIds] = existingIds;
    if (!nextId) {
        return undefined;
    }
    if (restIds.length > 0) {
        pendingMessages.set(key, restIds);
    } else {
        pendingMessages.delete(key);
    }
    return nextId;
}

export function discardOptimisticCommentMessageId(
    pendingMessages: PendingOptimisticCommentMessages,
    messageId: string,
) {
    for (const [key, existingIds] of pendingMessages.entries()) {
        const nextIds = existingIds.filter((candidate) => candidate!==messageId);
        if (nextIds.length===existingIds.length) {
            continue;
        }
        if (nextIds.length===0) {
            pendingMessages.delete(key);
        } else {
            pendingMessages.set(key, nextIds);
        }
    }
}
