const test = require('node:test');
const assert = require('node:assert/strict');

const {
    CHAT_HISTORY_PAGE_SIZE,
    mergeUniqueChatHistoryPages,
    resolveNextChatHistoryCursor,
    shouldContinueChatHistoryPagination,
} = require('../out/collaboration/chatHistoryPagination.js');

test('resolveNextChatHistoryCursor returns the oldest message timestamp in a page', () => {
    assert.equal(resolveNextChatHistoryCursor([
        { id: 'm3', timestamp: 300 },
        { id: 'm1', timestamp: 100 },
        { id: 'm2', timestamp: 200 },
    ]), 100);
});

test('shouldContinueChatHistoryPagination continues only while a full page yields an older cursor', () => {
    assert.equal(shouldContinueChatHistoryPagination({
        nextBefore: 900,
        pageMessageCount: CHAT_HISTORY_PAGE_SIZE,
        pageNumber: 1,
        previousBefore: 950,
    }), true);
    assert.equal(shouldContinueChatHistoryPagination({
        nextBefore: 900,
        pageMessageCount: CHAT_HISTORY_PAGE_SIZE - 1,
        pageNumber: 1,
        previousBefore: 950,
    }), false);
    assert.equal(shouldContinueChatHistoryPagination({
        nextBefore: 950,
        pageMessageCount: CHAT_HISTORY_PAGE_SIZE,
        pageNumber: 1,
        previousBefore: 950,
    }), false);
});

test('mergeUniqueChatHistoryPages removes duplicate message ids while preserving first-seen order', () => {
    const merged = mergeUniqueChatHistoryPages([
        { id: 'm3', timestamp: 300, content: 'latest' },
        { id: 'm2', timestamp: 200, content: 'middle' },
        { id: 'm3', timestamp: 300, content: 'duplicate latest' },
        { id: 'm1', timestamp: 100, content: 'oldest' },
    ]);
    assert.deepEqual(merged.map((message) => message.id), ['m3', 'm2', 'm1']);
    assert.equal(merged[0].content, 'duplicate latest');
});
