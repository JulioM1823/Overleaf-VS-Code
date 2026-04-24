/* eslint-disable @typescript-eslint/naming-convention */
import { ProjectMessageResponseSchema } from '../api/base';

export type PendingOptimisticChatMessages = Map<string, string[]>;

function getOptimisticChatMessageKey(clientId: string, content: string) {
    return `${clientId.trim()}\u0000${content}`;
}

export function buildOptimisticChatMessage(options: {
    clientId: string,
    content: string,
    id: string,
    timestamp?: number,
    user: ProjectMessageResponseSchema['user'],
    userId: string,
}): ProjectMessageResponseSchema {
    return {
        clientId: options.clientId,
        content: options.content,
        id: options.id,
        timestamp: options.timestamp ?? Date.now(),
        user: options.user,
        user_id: options.userId,
    };
}

export function recordOptimisticChatMessage(
    pendingMessages: PendingOptimisticChatMessages,
    message: Pick<ProjectMessageResponseSchema, 'clientId' | 'content' | 'id'>,
) {
    if (!message.clientId) {
        return;
    }
    const key = getOptimisticChatMessageKey(message.clientId, message.content);
    const existingIds = pendingMessages.get(key) ?? [];
    pendingMessages.set(key, [...existingIds, message.id]);
}

export function consumeOptimisticChatMessageId(
    pendingMessages: PendingOptimisticChatMessages,
    message: Pick<ProjectMessageResponseSchema, 'clientId' | 'content'>,
) {
    if (!message.clientId) {
        return undefined;
    }
    const key = getOptimisticChatMessageKey(message.clientId, message.content);
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

export function discardOptimisticChatMessageId(
    pendingMessages: PendingOptimisticChatMessages,
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

export function pruneOptimisticChatMessages(
    pendingMessages: PendingOptimisticChatMessages,
    activeMessageIds: Iterable<string>,
) {
    const activeIds = new Set(activeMessageIds);
    for (const [key, existingIds] of pendingMessages.entries()) {
        const nextIds = existingIds.filter((candidate) => activeIds.has(candidate));
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
