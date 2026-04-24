import * as crypto from 'crypto';
import { LocalReplicaSnapshot } from '../scm/localReplicaSyncState';

export interface DocumentSyncConflictState {
    baseBlobId?: string,
    detectedAt: string,
    localBlobId?: string,
    reason: string,
    remoteBlobId?: string,
}

export interface DocumentSyncRecord {
    baseBlobId?: string,
    baseSnapshot?: LocalReplicaSnapshot,
    baseVersion?: number,
    conflict?: DocumentSyncConflictState,
    docId?: string,
    lastKnownRemoteSnapshot?: LocalReplicaSnapshot,
    lastKnownRemoteVersion?: number,
    lastRecoveryRunId?: string,
    localDirty: boolean,
    relPath: string,
}

export interface PersistedDocumentSyncState {
    records: Record<string, DocumentSyncRecord>,
    version: 1,
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isSnapshot(value: unknown): value is LocalReplicaSnapshot {
    return isRecord(value)
        && typeof value.kind === 'string'
        && typeof value.hash === 'number'
        && typeof value.size === 'number';
}

function parseConflictState(value: unknown): DocumentSyncConflictState | undefined {
    if (!isRecord(value) || typeof value.detectedAt !== 'string' || typeof value.reason !== 'string') {
        return undefined;
    }
    return {
        baseBlobId: typeof value.baseBlobId === 'string' ? value.baseBlobId : undefined,
        detectedAt: value.detectedAt,
        localBlobId: typeof value.localBlobId === 'string' ? value.localBlobId : undefined,
        reason: value.reason,
        remoteBlobId: typeof value.remoteBlobId === 'string' ? value.remoteBlobId : undefined,
    };
}

function parseDocumentSyncRecord(relPath: string, value: unknown): DocumentSyncRecord | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    return {
        baseBlobId: typeof value.baseBlobId === 'string' ? value.baseBlobId : undefined,
        baseSnapshot: isSnapshot(value.baseSnapshot) ? value.baseSnapshot : undefined,
        baseVersion: typeof value.baseVersion === 'number' ? value.baseVersion : undefined,
        conflict: parseConflictState(value.conflict),
        docId: typeof value.docId === 'string' ? value.docId : undefined,
        lastKnownRemoteSnapshot: isSnapshot(value.lastKnownRemoteSnapshot) ? value.lastKnownRemoteSnapshot : undefined,
        lastKnownRemoteVersion: typeof value.lastKnownRemoteVersion === 'number' ? value.lastKnownRemoteVersion : undefined,
        lastRecoveryRunId: typeof value.lastRecoveryRunId === 'string' ? value.lastRecoveryRunId : undefined,
        localDirty: value.localDirty === true,
        relPath,
    };
}

export function createPersistedDocumentSyncState(
    records: Record<string, DocumentSyncRecord> = {},
): PersistedDocumentSyncState {
    return {
        records,
        version: 1,
    };
}

export function parsePersistedDocumentSyncState(raw: string): PersistedDocumentSyncState {
    const parsed = JSON.parse(raw) as Partial<PersistedDocumentSyncState>;
    const records = isRecord(parsed.records) ? parsed.records : {};
    const normalizedRecords = Object.fromEntries(
        Object.entries(records)
            .map(([relPath, value]) => [relPath, parseDocumentSyncRecord(relPath, value)] as const)
            .filter((entry): entry is readonly [string, DocumentSyncRecord] => entry[1] !== undefined)
            .sort(([left], [right]) => left.localeCompare(right)),
    );
    return createPersistedDocumentSyncState(normalizedRecords);
}

export function serializePersistedDocumentSyncState(state: PersistedDocumentSyncState): string {
    return JSON.stringify({
        records: Object.fromEntries(
            Object.entries(state.records)
                .sort(([left], [right]) => left.localeCompare(right)),
        ),
        version: 1,
    }, null, 4);
}

export function createBlobId(content: Uint8Array) {
    return crypto.createHash('sha1').update(content).digest('hex');
}
