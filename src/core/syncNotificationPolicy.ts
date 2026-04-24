import { RealtimeConnectionPhase } from './connectionPhase';
import { DeferredSynchronizationMode } from './offlineSyncState';

/**
 * User-facing sync notifications are driven by coarse connection state instead
 * of routine file-sync activity. This keeps logs detailed while restricting UI
 * notifications to meaningful connection transitions only.
 */
export type SyncNotificationState = 'connected' | 'disconnected' | 'idle' | 'reconnecting';
export type SyncNotificationKind = 'connected' | 'disconnected' | 'reconnected';

/**
 * Brief outages are common while the socket renegotiates. Delay the disconnect
 * warning slightly so fast recoveries do not produce disconnect/reconnect spam.
 */
export const SYNC_DISCONNECT_NOTIFICATION_GRACE_MS = 1_500;

/**
 * State guards prevent most duplicates already; this adds a final debounce so
 * rapid state flapping cannot repeatedly emit the same banner.
 */
export const SYNC_NOTIFICATION_DEDUP_MS = 10_000;

/**
 * Background sync/reconnect work should stay silent until the project is back
 * in a stable online state. This prevents retry loops from leaking routine
 * transport failures into the user-facing notification layer.
 */
export function shouldSuppressBackgroundSyncFailureNotification(options: {
    connectionPhase: RealtimeConnectionPhase,
    synchronizationMode: DeferredSynchronizationMode,
}) {
    if (options.synchronizationMode!=='online') {
        return true;
    }
    return options.connectionPhase==='fallback'
        || options.connectionPhase==='initializing'
        || options.connectionPhase==='recovering';
}

export function resolveSyncNotificationState(options: {
    connectionPhase: RealtimeConnectionPhase,
    synchronizationMode: DeferredSynchronizationMode,
}): SyncNotificationState {
    if (options.synchronizationMode==='offline' || options.connectionPhase==='fallback') {
        return 'disconnected';
    }
    if (options.connectionPhase==='initializing') {
        return 'idle';
    }
    if (options.connectionPhase==='recovering' || options.synchronizationMode==='sync-recovery') {
        return 'reconnecting';
    }
    return 'connected';
}

export function shouldScheduleDisconnectNotification(options: {
    nextState: SyncNotificationState,
    previousState: SyncNotificationState,
}) {
    if (options.nextState==='connected' || options.nextState==='idle') {
        return false;
    }
    return options.previousState==='connected' || options.previousState==='idle';
}

export function resolveConnectedSyncNotificationKind(options: {
    hasShownConnectedNotification: boolean,
    hasShownDisconnectNotification: boolean,
}): SyncNotificationKind | undefined {
    if (!options.hasShownConnectedNotification) {
        return 'connected';
    }
    if (options.hasShownDisconnectNotification) {
        return 'reconnected';
    }
    return undefined;
}

/**
 * Routine reconnect churn should stay in diagnostics/status UI. The only sync
 * notification that still warrants a popup is the fallback read-only case,
 * because that changes what the user can do with the project.
 */
export function shouldSurfaceSyncNotification(options: {
    connectionPhase: RealtimeConnectionPhase,
    kind: SyncNotificationKind,
}) {
    if (options.kind==='disconnected') {
        return options.connectionPhase==='fallback';
    }
    return false;
}

export function shouldSuppressSyncNotification(options: {
    currentTimeMs?: number,
    kind: SyncNotificationKind,
    lastNotification?: {at: number, kind: SyncNotificationKind},
}) {
    if (!options.lastNotification || options.lastNotification.kind!==options.kind) {
        return false;
    }
    const currentTimeMs = options.currentTimeMs ?? Date.now();
    return currentTimeMs - options.lastNotification.at < SYNC_NOTIFICATION_DEDUP_MS;
}
