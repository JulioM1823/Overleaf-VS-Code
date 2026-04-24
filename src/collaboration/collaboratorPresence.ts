export function resolveCollaboratorPresenceKey(options: {
    clientId: string,
    existingUserId?: string,
    userId?: string,
}) {
    const stableUserId = options.userId?.trim() || options.existingUserId?.trim();
    if (stableUserId) {
        return stableUserId;
    }
    return options.clientId.trim();
}

export function isOwnCollaboratorPresence(options: {
    clientId: string,
    selfClientId?: string,
    selfUserId?: string,
    userId?: string,
}) {
    const normalizedUserId = options.userId?.trim();
    const normalizedSelfUserId = options.selfUserId?.trim();
    if (normalizedUserId && normalizedSelfUserId && normalizedUserId===normalizedSelfUserId) {
        return true;
    }

    const normalizedClientId = options.clientId.trim();
    const normalizedSelfClientId = options.selfClientId?.trim();
    return normalizedClientId!=='' && normalizedSelfClientId!=='' && normalizedClientId===normalizedSelfClientId;
}
