export const CHAT_SEND_MIN_INTERVAL_MS = 0;
const CHAT_RATE_LIMIT_INLINE_RETRY_DELAYS_MS: number[] = [];
const CHAT_REALTIME_CONFIRMATION_REFRESH_DELAYS_MS = [
    15_000,
    60_000,
];

const CHAT_RATE_LIMIT_RETRY_DELAYS_MS = [
    15_000,
    30_000,
    60_000,
    120_000,
    300_000,
    300_000,
];

export function calculateChatRateLimitRetryDelayMs(attempt: number) {
    if (!Number.isFinite(attempt) || attempt <= 1) {
        return CHAT_RATE_LIMIT_RETRY_DELAYS_MS[0];
    }

    const index = Math.min(
        CHAT_RATE_LIMIT_RETRY_DELAYS_MS.length - 1,
        Math.floor(attempt) - 1,
    );
    return CHAT_RATE_LIMIT_RETRY_DELAYS_MS[index];
}

export function calculateChatDispatchDelayMs(lastDispatchAt: number | undefined, now = Date.now()) {
    if (!lastDispatchAt || !Number.isFinite(lastDispatchAt)) {
        return 0;
    }
    return Math.max(0, CHAT_SEND_MIN_INTERVAL_MS - (now - lastDispatchAt));
}

export function getChatRateLimitInlineRetryDelayMs(attempt: number) {
    if (!Number.isFinite(attempt) || attempt <= 0) {
        return undefined;
    }
    return CHAT_RATE_LIMIT_INLINE_RETRY_DELAYS_MS[attempt - 1];
}

// Overleaf chat is asymmetric by design: messages are created via HTTP POST, but
// both local and remote clients learn about the final server message via the
// realtime `new-chat-message` fan-out. To match that architecture, successful
// outbound sends should normally wait for the socket echo, and only fall back to
// a slower history refresh if that confirmation never arrives.
export function calculateChatRealtimeConfirmationRefreshDelayMs(attempt: number) {
    if (!Number.isFinite(attempt) || attempt <= 1) {
        return CHAT_REALTIME_CONFIRMATION_REFRESH_DELAYS_MS[0];
    }

    const index = Math.min(
        CHAT_REALTIME_CONFIRMATION_REFRESH_DELAYS_MS.length - 1,
        Math.floor(attempt) - 1,
    );
    return CHAT_REALTIME_CONFIRMATION_REFRESH_DELAYS_MS[index];
}
