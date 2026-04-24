export function resolveActiveChatClientId(currentPublicId?: string, initialPublicId?: string) {
    const normalizedCurrent = currentPublicId?.trim();
    if (normalizedCurrent) {
        return normalizedCurrent;
    }
    const normalizedInitial = initialPublicId?.trim();
    return normalizedInitial || undefined;
}

// Match Overleaf's own chat client behavior: optimistic sends are confirmed by
// the echoed socket message's client id, not by any additional user-id check.
export function isOwnChatMessageClient(messageClientId?: string, currentPublicId?: string) {
    const normalizedMessageClientId = messageClientId?.trim();
    const normalizedCurrentPublicId = currentPublicId?.trim();
    return Boolean(
        normalizedMessageClientId
        && normalizedCurrentPublicId
        && normalizedMessageClientId===normalizedCurrentPublicId,
    );
}
