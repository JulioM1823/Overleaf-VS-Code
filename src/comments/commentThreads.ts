/* eslint-disable @typescript-eslint/naming-convention */
import { cloneCommentRange } from './commentRanges';
import {
    OverleafCommentMessage,
    OverleafCommentThread,
    OverleafDocumentCommentSnapshot,
} from './types';

const LOCAL_PENDING_COMMENT_ID_PREFIXES = [
    'offline-comment-',
    'pending-comment-',
];

function isLocalPendingCommentMessageId(messageId: string | undefined) {
    if (!messageId) {
        return false;
    }
    return LOCAL_PENDING_COMMENT_ID_PREFIXES.some((prefix) => messageId.startsWith(prefix));
}

function normalizeCommentContentForMatch(content: string | undefined) {
    return (content ?? '').trim();
}

function resolveMessageTimestampMs(message: OverleafCommentMessage) {
    return normalizeTimestampValue(message.timestamp)?.valueOf() ?? 0;
}

function getExactSemanticCommentMessageKey(message: OverleafCommentMessage) {
    return `${message.user_id ?? ''}\u0000${normalizeCommentContentForMatch(message.content)}\u0000${resolveMessageTimestampMs(message)}`;
}

function canPendingMessageMatchConfirmedMessage(
    pendingMessage: OverleafCommentMessage,
    confirmedMessage: OverleafCommentMessage,
) {
    if (normalizeCommentContentForMatch(pendingMessage.content)!==normalizeCommentContentForMatch(confirmedMessage.content)) {
        return false;
    }
    if (pendingMessage.user_id && confirmedMessage.user_id && pendingMessage.user_id!==confirmedMessage.user_id) {
        return false;
    }
    const timestampDifferenceMs = Math.abs(resolveMessageTimestampMs(confirmedMessage) - resolveMessageTimestampMs(pendingMessage));
    return timestampDifferenceMs <= 120_000;
}

function normalizeTimestampValue(timestamp: Date | number | string | undefined) {
    if (timestamp instanceof Date) {
        return timestamp;
    }
    if (typeof timestamp === 'number') {
        return new Date(timestamp);
    }
    if (typeof timestamp === 'string') {
        const parsed = new Date(timestamp);
        if (!Number.isNaN(parsed.valueOf())) {
            return parsed;
        }
    }
    return undefined;
}

export function normalizeCommentMessage(message: OverleafCommentMessage): OverleafCommentMessage {
    const timestamp = normalizeTimestampValue(message.timestamp);
    return {
        ...message,
        content: message.content ?? '',
        timestamp: timestamp ?? new Date(0),
        user: message.user ? {...message.user} : undefined,
    };
}

export function normalizeCommentThread(thread: OverleafCommentThread): OverleafCommentThread {
    const normalizedMessages = [...thread.messages]
        .map(normalizeCommentMessage)
        .sort((left, right) => {
            const leftValue = normalizeTimestampValue(left.timestamp)?.valueOf() ?? 0;
            const rightValue = normalizeTimestampValue(right.timestamp)?.valueOf() ?? 0;
            return leftValue - rightValue;
        });

    const seenMessageIds = new Set<string>();
    const dedupedMessages: OverleafCommentMessage[] = [];
    for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
        const message = normalizedMessages[index];
        if (seenMessageIds.has(message.id)) {
            continue;
        }
        seenMessageIds.add(message.id);
        dedupedMessages.push(message);
    }
    dedupedMessages.reverse();

    const confirmedMessages = dedupedMessages
        .filter((message) => !isLocalPendingCommentMessageId(message.id))
        .map((message) => ({
            consumed: false,
            message,
        }));
    const normalizedMessagesWithoutPendingDuplicates: OverleafCommentMessage[] = [];
    for (const message of dedupedMessages) {
        if (!isLocalPendingCommentMessageId(message.id)) {
            normalizedMessagesWithoutPendingDuplicates.push(message);
            continue;
        }
        const matchedConfirmedEntry = confirmedMessages.find((entry) => {
            if (entry.consumed) {
                return false;
            }
            return canPendingMessageMatchConfirmedMessage(message, entry.message);
        });
        if (matchedConfirmedEntry) {
            matchedConfirmedEntry.consumed = true;
            continue;
        }
        normalizedMessagesWithoutPendingDuplicates.push(message);
    }

    const seenSemanticMessageKeys = new Set<string>();
    const fullyDedupedMessages: OverleafCommentMessage[] = [];
    for (const message of normalizedMessagesWithoutPendingDuplicates) {
        const semanticKey = getExactSemanticCommentMessageKey(message);
        if (seenSemanticMessageKeys.has(semanticKey)) {
            continue;
        }
        seenSemanticMessageKeys.add(semanticKey);
        fullyDedupedMessages.push(message);
    }

    return {
        ...thread,
        messages: fullyDedupedMessages,
        resolved_by_user: thread.resolved_by_user ? {...thread.resolved_by_user} : undefined,
    };
}

export function dedupeDocumentCommentSnapshotThreadsByThreadId(
    threads: OverleafDocumentCommentSnapshot['threads'],
) {
    const threadsById = new Map<string, OverleafDocumentCommentSnapshot['threads'][number]>();
    for (const entry of threads) {
        const threadId = entry.range.op.t || entry.range.id;
        if (!threadId || threadsById.has(threadId)) {
            continue;
        }
        threadsById.set(threadId, {
            range: cloneCommentRange(entry.range),
            thread: entry.thread ? normalizeCommentThread(entry.thread) : undefined,
        });
    }
    return Array.from(threadsById.values());
}

export function mergeCommentMessageIntoThread(
    thread: OverleafCommentThread | undefined,
    message: OverleafCommentMessage,
) {
    const normalizedMessage = normalizeCommentMessage(message);
    const baseThread = normalizeCommentThread(thread ?? {messages: []});
    const existingIndex = baseThread.messages.findIndex((candidate) => candidate.id===normalizedMessage.id);
    if (existingIndex >= 0) {
        baseThread.messages[existingIndex] = normalizedMessage;
    } else {
        baseThread.messages.push(normalizedMessage);
    }
    return normalizeCommentThread(baseThread);
}

export function editCommentMessageInThread(
    thread: OverleafCommentThread | undefined,
    messageId: string,
    content: string,
) {
    const baseThread = normalizeCommentThread(thread ?? {messages: []});
    baseThread.messages = baseThread.messages.map((message) => {
        if (message.id!==messageId) {
            return message;
        }
        return {
            ...message,
            content,
            edited_at: new Date().toISOString(),
        };
    });
    return baseThread;
}

export function removeCommentMessageFromThread(
    thread: OverleafCommentThread | undefined,
    messageId: string,
) {
    if (!thread) {
        return undefined;
    }
    const baseThread = normalizeCommentThread(thread);
    baseThread.messages = baseThread.messages.filter((message) => message.id!==messageId);
    return baseThread;
}
