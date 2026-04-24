import * as DiffMatchPatch from 'diff-match-patch';

export type LocalReplicaSnapshotKind = 'directory' | 'file' | 'missing';

export interface LocalReplicaSnapshot {
    hash: number,
    kind: LocalReplicaSnapshotKind,
    size: number,
}

export interface LocalReplicaConflictState {
    detectedAt: number,
    reason: string,
}

export interface LocalReplicaPathState {
    baseline?: LocalReplicaSnapshot,
    conflict?: LocalReplicaConflictState,
    lastSynchronizedAt?: number,
}

export interface PersistedLocalReplicaPathState {
    baseline?: LocalReplicaSnapshot,
}

export interface PersistedLocalReplicaSyncState {
    paths: {[relPath: string]: PersistedLocalReplicaPathState},
    version: 1,
}

export type LocalReplicaReconcileDecision =
    | { kind: 'conflict', reason: string }
    | { kind: 'skip', reason: 'in_sync' | 'stable_baseline' }
    | { kind: 'sync_local_to_remote', reason: 'remote_matches_baseline' }
    | { kind: 'sync_remote_to_local', reason: 'bootstrap_local_missing' | 'local_matches_baseline' };

export type LocalReplicaRuntimeDecision =
    | { kind: 'apply', reason: 'bootstrap' | 'source_ahead' }
    | { kind: 'conflict', reason: string }
    | { kind: 'skip', reason: 'already_in_sync' | 'path_conflicted' | 'source_matches_baseline' };

export type LocalReplicaMergeResult =
    | { kind: 'conflict', failedPatchCount?: number, reason: 'missing_baseline' | 'non_text_content' | 'patch_apply_failed' }
    | { kind: 'merged', mergedContent: Uint8Array };

function hashTextContent(content?: Uint8Array): number {
    if (content===undefined) {
        return -1;
    }
    const str = new TextDecoder().decode(content);
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0;
    }
    return hash;
}

function hashSnapshotKind(kind: LocalReplicaSnapshotKind): number {
    switch (kind) {
        case 'missing':
            return -1;
        case 'directory':
            return -2;
        case 'file':
            return 0;
    }
}

export function createLocalReplicaSnapshot(
    kind: LocalReplicaSnapshotKind,
    content?: Uint8Array,
): LocalReplicaSnapshot {
    return {
        hash: kind==='file' ? hashTextContent(content) : hashSnapshotKind(kind),
        kind,
        size: content?.length ?? 0,
    };
}

export function localReplicaSnapshotsEqual(
    left?: LocalReplicaSnapshot,
    right?: LocalReplicaSnapshot,
): boolean {
    return left?.kind===right?.kind
        && left?.hash===right?.hash
        && left?.size===right?.size;
}

export function classifyLocalReplicaReconcile(
    state: LocalReplicaPathState | undefined,
    local: LocalReplicaSnapshot,
    remote: LocalReplicaSnapshot,
): LocalReplicaReconcileDecision {
    if (localReplicaSnapshotsEqual(local, remote)) {
        return localReplicaSnapshotsEqual(local, state?.baseline)
            ? {kind: 'skip', reason: 'stable_baseline'}
            : {kind: 'skip', reason: 'in_sync'};
    }

    const baseline = state?.baseline;
    if (!baseline) {
        if (local.kind==='missing' && remote.kind!=='missing') {
            return {kind: 'sync_remote_to_local', reason: 'bootstrap_local_missing'};
        }
        return {kind: 'conflict', reason: 'missing_baseline'};
    }

    const localChanged = !localReplicaSnapshotsEqual(local, baseline);
    const remoteChanged = !localReplicaSnapshotsEqual(remote, baseline);

    if (!localChanged && !remoteChanged) {
        return {kind: 'skip', reason: 'stable_baseline'};
    }
    if (!localChanged && remoteChanged) {
        return {kind: 'sync_remote_to_local', reason: 'local_matches_baseline'};
    }
    if (localChanged && !remoteChanged) {
        return {kind: 'sync_local_to_remote', reason: 'remote_matches_baseline'};
    }
    return {kind: 'conflict', reason: 'diverged_from_baseline'};
}

export function classifyLocalReplicaRuntimeSync(
    state: LocalReplicaPathState | undefined,
    source: LocalReplicaSnapshot,
    target: LocalReplicaSnapshot,
): LocalReplicaRuntimeDecision {
    if (localReplicaSnapshotsEqual(source, target)) {
        return {kind: 'skip', reason: 'already_in_sync'};
    }
    if (state?.conflict) {
        return {kind: 'conflict', reason: 'path_conflicted'};
    }

    const baseline = state?.baseline;
    if (!baseline) {
        return {kind: 'apply', reason: 'bootstrap'};
    }

    const sourceChanged = !localReplicaSnapshotsEqual(source, baseline);
    const targetChanged = !localReplicaSnapshotsEqual(target, baseline);

    if (!sourceChanged) {
        return {kind: 'skip', reason: 'source_matches_baseline'};
    }
    if (!targetChanged) {
        return {kind: 'apply', reason: 'source_ahead'};
    }
    return {kind: 'conflict', reason: 'diverged_from_baseline'};
}

export function recordLocalReplicaBaseline(
    state: LocalReplicaPathState | undefined,
    baseline: LocalReplicaSnapshot,
    synchronizedAt = Date.now(),
): LocalReplicaPathState {
    return {
        baseline,
        conflict: undefined,
        lastSynchronizedAt: synchronizedAt,
    };
}

export function recordLocalReplicaConflict(
    state: LocalReplicaPathState | undefined,
    reason: string,
    detectedAt = Date.now(),
): LocalReplicaPathState {
    return {
        baseline: state?.baseline,
        conflict: {
            detectedAt,
            reason,
        },
        lastSynchronizedAt: state?.lastSynchronizedAt,
    };
}

function isProbablyTextContent(content: Uint8Array | undefined): boolean {
    if (content===undefined) {
        return false;
    }
    const sampleLength = Math.min(content.length, 4096);
    let controlCount = 0;
    for (let i = 0; i < sampleLength; i += 1) {
        const value = content[i];
        if (value===0) {
            return false;
        }
        if (value < 0x09 || (value > 0x0D && value < 0x20)) {
            controlCount += 1;
        }
    }
    return controlCount / Math.max(sampleLength, 1) < 0.1;
}

export function mergeLocalReplicaText(
    baseContent: Uint8Array | undefined,
    localContent: Uint8Array,
    remoteContent: Uint8Array,
): LocalReplicaMergeResult {
    if (baseContent===undefined) {
        return {kind: 'conflict', reason: 'missing_baseline'};
    }
    if (!isProbablyTextContent(baseContent) || !isProbablyTextContent(localContent) || !isProbablyTextContent(remoteContent)) {
        return {kind: 'conflict', reason: 'non_text_content'};
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const dmp = new DiffMatchPatch();
    const baseText = decoder.decode(baseContent);
    const localText = decoder.decode(localContent);
    const remoteText = decoder.decode(remoteContent);
    const remotePatches = dmp.patch_make(baseText, remoteText);
    const mergedResult = dmp.patch_apply(remotePatches, localText);
    const mergedText = mergedResult[0] as string;
    const patchResults = mergedResult[1] as boolean[];

    if (!patchResults.every(Boolean)) {
        return {
            kind: 'conflict',
            failedPatchCount: patchResults.filter(result => !result).length,
            reason: 'patch_apply_failed',
        };
    }

    return {
        kind: 'merged',
        mergedContent: encoder.encode(mergedText),
    };
}

export function parsePersistedLocalReplicaSyncState(raw: string): PersistedLocalReplicaSyncState {
    const parsed = JSON.parse(raw) as Partial<PersistedLocalReplicaSyncState>;
    const paths = typeof parsed.paths === 'object' && parsed.paths!==null ? parsed.paths : {};
    return {
        paths,
        version: 1,
    };
}

export function serializePersistedLocalReplicaSyncState(
    state: PersistedLocalReplicaSyncState,
): string {
    return JSON.stringify({
        paths: Object.fromEntries(
            Object.entries(state.paths)
                .filter(([, pathState]) => pathState.baseline !== undefined)
                .sort(([left], [right]) => left.localeCompare(right)),
        ),
        version: 1,
    }, null, 4);
}
