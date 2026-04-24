export type DeferredSynchronizationMode = 'offline' | 'online' | 'sync-recovery';

export function isLikelyConnectivityFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETDOWN|ENETRESET|ENETUNREACH|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|Failed to fetch|fetch failed|network|connect_failed|timeout|socket/i.test(message);
}
