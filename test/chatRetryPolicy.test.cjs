const test = require('node:test');
const assert = require('node:assert/strict');

const {
    CHAT_SEND_MIN_INTERVAL_MS,
    calculateChatRealtimeConfirmationRefreshDelayMs,
    calculateChatDispatchDelayMs,
    calculateChatRateLimitRetryDelayMs,
    getChatRateLimitInlineRetryDelayMs,
} = require('../out/collaboration/chatRetryPolicy.js');

test('calculateChatDispatchDelayMs allows immediate sends when idle', () => {
    assert.equal(calculateChatDispatchDelayMs(undefined, 100), 0);
});

test('calculateChatDispatchDelayMs does not delay healthy live sends', () => {
    assert.equal(calculateChatDispatchDelayMs(1_000, 1_250), 0);
    assert.equal(calculateChatDispatchDelayMs(1_000, 2_500), 0);
    assert.equal(CHAT_SEND_MIN_INTERVAL_MS, 0);
});

test('calculateChatRateLimitRetryDelayMs starts with a conservative retry window', () => {
    assert.equal(calculateChatRateLimitRetryDelayMs(1), 15_000);
    assert.equal(calculateChatRateLimitRetryDelayMs(0), 15_000);
});

test('calculateChatRateLimitRetryDelayMs increases gradually before capping', () => {
    assert.equal(calculateChatRateLimitRetryDelayMs(2), 30_000);
    assert.equal(calculateChatRateLimitRetryDelayMs(3), 60_000);
    assert.equal(calculateChatRateLimitRetryDelayMs(4), 120_000);
    assert.equal(calculateChatRateLimitRetryDelayMs(5), 300_000);
});

test('calculateChatRateLimitRetryDelayMs caps at five minutes for sustained rate limits', () => {
    assert.equal(calculateChatRateLimitRetryDelayMs(6), 300_000);
    assert.equal(calculateChatRateLimitRetryDelayMs(20), 300_000);
});

test('getChatRateLimitInlineRetryDelayMs avoids immediate retries on explicit rate limits', () => {
    assert.equal(getChatRateLimitInlineRetryDelayMs(1), undefined);
    assert.equal(getChatRateLimitInlineRetryDelayMs(2), undefined);
    assert.equal(getChatRateLimitInlineRetryDelayMs(3), undefined);
});

test('calculateChatRealtimeConfirmationRefreshDelayMs gives the socket echo a longer grace period first', () => {
    assert.equal(calculateChatRealtimeConfirmationRefreshDelayMs(1), 15_000);
    assert.equal(calculateChatRealtimeConfirmationRefreshDelayMs(0), 15_000);
});

test('calculateChatRealtimeConfirmationRefreshDelayMs backs off after the first repair attempt', () => {
    assert.equal(calculateChatRealtimeConfirmationRefreshDelayMs(2), 60_000);
    assert.equal(calculateChatRealtimeConfirmationRefreshDelayMs(3), 60_000);
    assert.equal(calculateChatRealtimeConfirmationRefreshDelayMs(20), 60_000);
});
