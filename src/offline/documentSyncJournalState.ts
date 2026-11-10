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
    localBlobId?: string,
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
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSnapshot(value: unknown): value is LocalReplicaSnapshot {
    return isRecord(value)
        && (value.kind==='file' || value.kind==='directory' || value.kind==='missing')
        && (typeof value.hash === 'number' || typeof value.hash === 'string')
        && Number.isSafeInteger(value.size) && (value.size as number)>=0;
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

function parseDocumentSyncRecord(relPath: string, value: unknown): DocumentSyncRecord {
    const invalid = () => { throw new Error('Invalid document sync record; preserve the journal for recovery'); };
    if (!isRecord(value) || typeof value.localDirty!=='boolean') {
        return invalid();
    }
    for (const field of ['baseBlobId', 'localBlobId', 'docId', 'lastRecoveryRunId']) {
        if (value[field]!==undefined && typeof value[field]!=='string') { invalid(); }
    }
    for (const field of ['baseVersion', 'lastKnownRemoteVersion']) {
        if (value[field]!==undefined && (!Number.isSafeInteger(value[field]) || (value[field] as number)<0)) { invalid(); }
    }
    for (const field of ['baseSnapshot', 'lastKnownRemoteSnapshot']) {
        if (value[field]!==undefined && !isSnapshot(value[field])) { invalid(); }
    }
    if (value.conflict!==undefined && !parseConflictState(value.conflict)) { invalid(); }
    return {
        baseBlobId: typeof value.baseBlobId === 'string' ? value.baseBlobId : undefined,
        baseSnapshot: isSnapshot(value.baseSnapshot) ? value.baseSnapshot : undefined,
        baseVersion: typeof value.baseVersion === 'number' ? value.baseVersion : undefined,
        conflict: parseConflictState(value.conflict),
        docId: typeof value.docId === 'string' ? value.docId : undefined,
        lastKnownRemoteSnapshot: isSnapshot(value.lastKnownRemoteSnapshot) ? value.lastKnownRemoteSnapshot : undefined,
        lastKnownRemoteVersion: typeof value.lastKnownRemoteVersion === 'number' ? value.lastKnownRemoteVersion : undefined,
        lastRecoveryRunId: typeof value.lastRecoveryRunId === 'string' ? value.lastRecoveryRunId : undefined,
        localBlobId: typeof value.localBlobId==='string' ? value.localBlobId : undefined,
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
    if (!isRecord(parsed) || parsed.version!==1 || !isRecord(parsed.records) || Array.isArray(parsed.records)) {
        throw new Error('Invalid document sync journal; preserve it for recovery');
    }
    const records = parsed.records;
    const normalizedRecords = Object.fromEntries(
        Object.entries(records)
            .map(([relPath, value]) => [relPath, parseDocumentSyncRecord(relPath, value)] as const)
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
    return crypto.createHash('sha256').update(content).digest('hex');
}
