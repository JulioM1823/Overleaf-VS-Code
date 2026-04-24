export type InitializationReason = 'document_version_mismatch' | 'initial' | 'socket_disconnect' | 'toggle_invisible_mode';
export type RealtimeConnectionPhase = 'fallback' | 'initializing' | 'invisible' | 'live' | 'recovering';

export function resolveInitializationConnectionPhase(
    reason: InitializationReason,
    preserveRoot: boolean,
): RealtimeConnectionPhase {
    if (reason==='initial' && !preserveRoot) {
        return 'initializing';
    }
    return 'recovering';
}

export function resolveConnectedConnectionPhase(options: {
    readonlyMode: boolean,
    usingAlternativeConnectionScheme: boolean,
}): RealtimeConnectionPhase {
    if (options.readonlyMode) {
        return 'fallback';
    }
    if (options.usingAlternativeConnectionScheme) {
        return 'invisible';
    }
    return 'live';
}

export function resolveConnectionAcceptedPhase(options: {
    initializing: boolean,
    isOfflineMode: boolean,
    readonlyMode: boolean,
    usingAlternativeConnectionScheme: boolean,
}): RealtimeConnectionPhase | undefined {
    if (options.initializing || options.isOfflineMode) {
        return undefined;
    }
    return resolveConnectedConnectionPhase({
        readonlyMode: options.readonlyMode,
        usingAlternativeConnectionScheme: options.usingAlternativeConnectionScheme,
    });
}

export function shouldAutoCompileAfterInitialization(reason: InitializationReason) {
    return reason==='initial';
}

export function shouldBlockDocumentHydrationDuringRecovery(options: {
    isOfflineMode: boolean,
    phase: RealtimeConnectionPhase,
}) {
    return options.isOfflineMode
        || options.phase==='initializing'
        || options.phase==='recovering';
}
