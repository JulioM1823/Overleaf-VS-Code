export interface ChatTransportStateInput {
    activeChatClientId?: string,
    bootstrapSource: 'socket' | 'fallback' | 'offline',
}

function normalizeChatClientId(clientId?: string) {
    const normalizedClientId = clientId?.trim();
    return normalizedClientId || undefined;
}

// Chat should attempt the network independently of broader project bootstrap
// state. If the request truly cannot reach Overleaf, the caller will downgrade
// to cached history or queued delivery based on the concrete failure.
export function canFetchRemoteChatHistory({bootstrapSource}: ChatTransportStateInput) {
    void bootstrapSource;
    return true;
}

export function canSendLiveChatMessages(input: ChatTransportStateInput) {
    return Boolean(normalizeChatClientId(input.activeChatClientId));
}
