import { RealtimeConnectionPhase } from '../core/connectionPhase';
import { DeferredSynchronizationMode } from '../core/offlineSyncState';
import { resolveSyncNotificationState } from '../core/syncNotificationPolicy';
import {
    DEFAULT_COMMENT_USER_PALETTE,
    resolveCommentUserColorByIndex,
} from '../comments/commentColors';

export interface CollaboratorCursorLocation {
    docId: string,
    row: number,
    column: number,
}

export interface CollaboratorQuickPickItem {
    clientId: string,
    description?: string,
    detail?: string,
    label: string,
    lastActive: number,
}

export type CollaboratorConnectionIndicatorState = 'connected' | 'disconnected' | 'reconnecting';
export const COLLABORATOR_CONNECTION_INDICATOR_CONNECTED_HOLD_MS = 1_500;

export function escapeCollaboratorMarkdownText(value: string) {
    return value
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/([\\`*_{}\[\]()#+\-.!<>|])/g, '\\$1');
}

function hashString(value: string) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export function resolveCollaboratorCursorColor(
    presenceKey: string,
    usedColors: ReadonlySet<string>,
    palette: readonly string[] = DEFAULT_COMMENT_USER_PALETTE,
) {
    const hash = hashString(presenceKey);
    const paletteSize = Math.max(1, palette.length);
    const paletteStart = hash % paletteSize;
    for (let offset = 0; offset < paletteSize; offset += 1) {
        const candidate = resolveCommentUserColorByIndex((paletteStart + offset) % paletteSize, palette);
        if (!usedColors.has(candidate)) {
            return candidate;
        }
    }

    // Fallback for large rooms: reuse the comment tag overflow color generator
    // so cursor presence and comment author tags stay in the same color family.
    for (let attempt = 0; attempt < 720; attempt += 1) {
        const candidate = resolveCommentUserColorByIndex(paletteSize + ((hash + attempt) % 720), palette);
        if (!usedColors.has(candidate)) {
            return candidate;
        }
    }

    return resolveCommentUserColorByIndex(paletteSize + 720 + (hash % 720), palette);
}

export function didCollaboratorMove(
    previous: CollaboratorCursorLocation | undefined,
    next: CollaboratorCursorLocation,
) {
    return previous === undefined
        || previous.docId !== next.docId
        || previous.row !== next.row
        || previous.column !== next.column;
}

export function formatCollaboratorCursorInfo(docPath: string | undefined, row: number) {
    if (docPath === undefined || row < 0) { return; }
    return {
        docPath: docPath.startsWith('/') ? docPath.slice(1) : docPath,
        row: row + 1,
    };
}

export function formatCollaboratorActivityAge(sinceMs: number) {
    const seconds = Math.max(0, Math.floor(sinceMs / 1000));
    if (seconds < 10) {
        return 'Active just now';
    }
    if (seconds < 60) {
        return `Active ${seconds}s ago`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `Active ${minutes}m ago`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `Active ${hours}h ago`;
    }

    const days = Math.floor(hours / 24);
    return `Active ${days}d ago`;
}

export function createCollaboratorQuickPickItem(options: {
    clientId: string,
    cursorInfo?: string,
    email?: string,
    lastActive: number,
    name: string,
    now?: number,
}): CollaboratorQuickPickItem {
    const age = formatCollaboratorActivityAge((options.now ?? Date.now()) - options.lastActive);
    const detailSegments = [options.cursorInfo, age].filter(Boolean);
    return {
        clientId: options.clientId,
        description: options.email || undefined,
        detail: detailSegments.join(' • '),
        label: options.name,
        lastActive: options.lastActive,
    };
}

export function sortCollaboratorQuickPickItems(items: CollaboratorQuickPickItem[]) {
    return [...items].sort((left, right) => {
        if (left.lastActive !== right.lastActive) {
            return right.lastActive - left.lastActive;
        }
        return left.label.localeCompare(right.label);
    });
}

// The collaboration status bar should follow the project-level connection
// state, not raw socket flapping, so offline recovery does not oscillate
// between online and disconnected on each reconnect attempt.
export function resolveCollaboratorConnectionIndicatorState(options: {
    connectionPhase: RealtimeConnectionPhase,
    synchronizationMode: DeferredSynchronizationMode,
    transportConnected?: boolean,
}) : CollaboratorConnectionIndicatorState {
    const syncState = resolveSyncNotificationState({
        connectionPhase: options.connectionPhase,
        synchronizationMode: options.synchronizationMode,
    });
    if (options.connectionPhase!=='initializing' && options.transportConnected===true && syncState!=='disconnected') {
        return 'connected';
    }
    switch (syncState) {
        case 'disconnected':
            return 'disconnected';
        case 'idle':
        case 'reconnecting':
            return 'reconnecting';
        case 'connected':
        default:
            return 'connected';
    }
}

export function resolveCollaboratorConnectionIndicatorVisualState(options: {
    currentTimeMs?: number,
    lastNonConnectedAtMs?: number,
    previousVisualState?: CollaboratorConnectionIndicatorState,
    requestedState: CollaboratorConnectionIndicatorState,
}): {
    holdMs: number,
    state: CollaboratorConnectionIndicatorState,
} {
    if (options.requestedState!=='connected') {
        return {
            holdMs: 0,
            state: options.requestedState,
        };
    }
    if (!options.previousVisualState
        || options.previousVisualState==='connected'
        || options.lastNonConnectedAtMs===undefined) {
        return {
            holdMs: 0,
            state: 'connected',
        };
    }

    const currentTimeMs = options.currentTimeMs ?? Date.now();
    const remainingHoldMs = COLLABORATOR_CONNECTION_INDICATOR_CONNECTED_HOLD_MS
        - (currentTimeMs - options.lastNonConnectedAtMs);
    if (remainingHoldMs <= 0) {
        return {
            holdMs: 0,
            state: 'connected',
        };
    }

    return {
        holdMs: remainingHoldMs,
        state: options.previousVisualState,
    };
}
