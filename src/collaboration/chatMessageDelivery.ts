export type ChatMessageDeliveryState = 'delivered' | 'pending';
export type ChatMessageDeliveryDetail = 'queued' | 'sending';

export interface ChatMessageDelivery {
    detail?: ChatMessageDeliveryDetail,
    state: ChatMessageDeliveryState,
}

const TEMPORARY_CHAT_MESSAGE_ID_PREFIXES = [
    'offline-chat-',
    'pending-chat-',
];

export function isTemporaryChatMessageId(messageId: string) {
    return TEMPORARY_CHAT_MESSAGE_ID_PREFIXES.some((prefix) => messageId.startsWith(prefix));
}

export function resolveChatMessageDelivery(options: {
    isQueued: boolean,
    messageId: string,
}): ChatMessageDelivery {
    if (options.isQueued) {
        return {
            detail: 'queued',
            state: 'pending',
        };
    }
    if (isTemporaryChatMessageId(options.messageId)) {
        return {
            detail: 'sending',
            state: 'pending',
        };
    }
    return {
        state: 'delivered',
    };
}
