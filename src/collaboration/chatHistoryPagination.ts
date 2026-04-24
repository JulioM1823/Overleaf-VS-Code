import type { ProjectMessageResponseSchema } from '../api/base';

export const CHAT_HISTORY_PAGE_SIZE = 50;
export const CHAT_HISTORY_MAX_PAGES = 40;
export const CHAT_HISTORY_INITIAL_FETCH_LIMIT = 200;

function normalizeChatTimestamp(timestamp: number | undefined) {
    return Number.isFinite(timestamp) && timestamp! > 0 ? timestamp : undefined;
}

export function resolveNextChatHistoryCursor(messages: readonly ProjectMessageResponseSchema[]) {
    let oldestTimestamp: number | undefined;
    for (const message of messages) {
        const timestamp = normalizeChatTimestamp(message.timestamp);
        if (timestamp===undefined) {
            continue;
        }
        if (oldestTimestamp===undefined || timestamp < oldestTimestamp) {
            oldestTimestamp = timestamp;
        }
    }
    return oldestTimestamp;
}

export function shouldContinueChatHistoryPagination({
    maxPages = CHAT_HISTORY_MAX_PAGES,
    nextBefore,
    pageMessageCount,
    pageNumber,
    pageSize = CHAT_HISTORY_PAGE_SIZE,
    previousBefore,
}: {
    maxPages?: number,
    nextBefore?: number,
    pageMessageCount: number,
    pageNumber: number,
    pageSize?: number,
    previousBefore?: number,
}) {
    if (pageMessageCount < pageSize) {
        return false;
    }
    if (!nextBefore) {
        return false;
    }
    if (pageNumber >= maxPages) {
        return false;
    }
    if (previousBefore!==undefined && nextBefore >= previousBefore) {
        return false;
    }
    return true;
}

export function mergeUniqueChatHistoryPages(messages: readonly ProjectMessageResponseSchema[]) {
    const dedupedMessages = new Map<string, ProjectMessageResponseSchema>();
    for (const message of messages) {
        if (!message.id) {
            continue;
        }
        dedupedMessages.set(message.id, message);
    }
    return [...dedupedMessages.values()];
}
