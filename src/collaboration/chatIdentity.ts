import { Identity } from '../api/base';

function isUsableIdentity(identity?: Identity) {
    return Boolean(identity?.cookies?.trim() && identity.csrfToken?.trim());
}

export function resolvePreferredChatIdentity(liveIdentity?: Identity, persistedIdentity?: Identity) {
    if (isUsableIdentity(liveIdentity)) {
        return liveIdentity;
    }
    return isUsableIdentity(persistedIdentity) ? persistedIdentity : undefined;
}

export const resolvePreferredRealtimeIdentity = resolvePreferredChatIdentity;

export function shouldPersistChatIdentity(liveIdentity?: Identity, persistedIdentity?: Identity) {
    if (!isUsableIdentity(liveIdentity)) {
        return false;
    }
    if (!isUsableIdentity(persistedIdentity)) {
        return true;
    }
    return liveIdentity!.cookies!==persistedIdentity!.cookies
        || liveIdentity!.csrfToken!==persistedIdentity!.csrfToken;
}

export const shouldPersistRealtimeIdentity = shouldPersistChatIdentity;
