import * as vscode from 'vscode';
import { AsyncQueue } from '../utils/asyncQueue';
import { assertSafeLocalPath, isMissingFile, writePrivateFile } from '../utils/safeFile';
import {
    createBlobId,
    createPersistedDocumentSyncState,
    DocumentSyncConflictState,
    DocumentSyncRecord,
    parsePersistedDocumentSyncState,
    PersistedDocumentSyncState,
    serializePersistedDocumentSyncState,
} from './documentSyncJournalState';
import {
    restrictPrivateDirectoryPermissions,
    restrictPrivateFilePermissions,
} from '../utils/filePrivacy';
import { ensureLocalReplicaMetadataDirectory } from '../scm/localReplicaWorkspace';

const DOCUMENT_SYNC_STATE_FILE_NAME = 'document-sync-state.json';
const DOCUMENT_SYNC_BLOB_DIRECTORY_NAME = 'blobs';
const DOCUMENT_SYNC_CONFLICT_DIRECTORY_NAME = 'conflicts';

export interface DocumentSyncConflictMaterialization {
    base?: vscode.Uri,
    local?: vscode.Uri,
    remote?: vscode.Uri,
}

export interface DocumentSyncJournalStorage {
    blobDirectoryUri: vscode.Uri,
    conflictDirectoryUri: vscode.Uri,
    stateUri: vscode.Uri,
    storageRoot: vscode.Uri,
}

function sanitizeRelPathForDirectory(relPath: string) {
    const normalized = relPath === '/' ? 'root' : relPath.replace(/^\/+/, '');
    return normalized.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

export class DocumentSyncJournal {
    private readonly transactions = new AsyncQueue();
    constructor(
        private readonly resolveStorage: () => Promise<DocumentSyncJournalStorage>,
    ) {}

    loadState(): Promise<PersistedDocumentSyncState> {
        return this.transactions.run(() => this.readState());
    }

    private async readState(): Promise<PersistedDocumentSyncState> {
        const {stateUri, storageRoot} = await this.resolveStorage();
        await assertSafeLocalPath(storageRoot, stateUri);
        try {
            const raw = await vscode.workspace.fs.readFile(stateUri);
            return parsePersistedDocumentSyncState(new TextDecoder().decode(raw));
        } catch (error) {
            if (isMissingFile(error)) { return createPersistedDocumentSyncState(); }
            throw error;
        }
    }

    private async saveState(state: PersistedDocumentSyncState) {
        const {storageRoot, stateUri} = await this.resolveStorage();
        await ensureLocalReplicaMetadataDirectory(storageRoot);
        await writePrivateFile(stateUri, Buffer.from(serializePersistedDocumentSyncState(state)));
        await restrictPrivateFilePermissions(stateUri);
    }

    async withState<T>(updater: (state: PersistedDocumentSyncState) => T | Promise<T>) {
        return this.transactions.run(async () => {
            const state = await this.readState();
            const result = await updater(state);
            await this.saveState(state);
            return result;
        });
    }

    async readBlob(blobId: string): Promise<Uint8Array | undefined> {
        if (!/^[a-f0-9]{64}$/.test(blobId)) { throw new Error('Invalid recovery blob identifier'); }
        const {blobDirectoryUri, storageRoot} = await this.resolveStorage();
        const uri = vscode.Uri.joinPath(blobDirectoryUri, blobId);
        await assertSafeLocalPath(storageRoot, uri);
        try {
            const content = await vscode.workspace.fs.readFile(uri);
            if (createBlobId(content)!==blobId) { throw new Error('Recovery blob checksum mismatch'); }
            return content;
        } catch (error) {
            if (isMissingFile(error)) { return undefined; }
            throw error;
        }
    }

    async writeBlob(content: Uint8Array): Promise<string> {
        const {blobDirectoryUri, storageRoot} = await this.resolveStorage();
        const blobId = createBlobId(content);
        const blobUri = vscode.Uri.joinPath(blobDirectoryUri, blobId);
        await ensureLocalReplicaMetadataDirectory(storageRoot);
        await assertSafeLocalPath(storageRoot, blobUri);
        await vscode.workspace.fs.createDirectory(blobDirectoryUri);
        await restrictPrivateDirectoryPermissions(blobDirectoryUri);
        const existing = await this.readBlob(blobId);
        if (!existing) { await writePrivateFile(blobUri, content); }
        return blobId;
    }

    async materializeConflictFiles(relPath: string, conflict: DocumentSyncConflictState): Promise<DocumentSyncConflictMaterialization> {
        const {conflictDirectoryUri, storageRoot} = await this.resolveStorage();
        const baseContent = conflict.baseBlobId ? await this.readBlob(conflict.baseBlobId) : undefined;
        const localContent = conflict.localBlobId ? await this.readBlob(conflict.localBlobId) : undefined;
        const remoteContent = conflict.remoteBlobId ? await this.readBlob(conflict.remoteBlobId) : undefined;
        const targetDirectory = vscode.Uri.joinPath(
            conflictDirectoryUri,
            `${sanitizeRelPathForDirectory(relPath)}-${createBlobId(Buffer.from(relPath + '\0' + conflict.detectedAt)).slice(0, 24)}`,
        );
        await ensureLocalReplicaMetadataDirectory(storageRoot);
        await assertSafeLocalPath(storageRoot, targetDirectory);
        await vscode.workspace.fs.createDirectory(targetDirectory);
        await restrictPrivateDirectoryPermissions(conflictDirectoryUri);
        await restrictPrivateDirectoryPermissions(targetDirectory);
        const result: DocumentSyncConflictMaterialization = {};
        if (baseContent) {
            result.base = vscode.Uri.joinPath(targetDirectory, 'base');
            await writePrivateFile(result.base, baseContent);
            await restrictPrivateFilePermissions(result.base);
        }
        if (localContent) {
            result.local = vscode.Uri.joinPath(targetDirectory, 'local');
            await writePrivateFile(result.local, localContent);
            await restrictPrivateFilePermissions(result.local);
        }
        if (remoteContent) {
            result.remote = vscode.Uri.joinPath(targetDirectory, 'remote');
            await writePrivateFile(result.remote, remoteContent);
            await restrictPrivateFilePermissions(result.remote);
        }
        return result;
    }

    static createStorageResolver(storageRoot: vscode.Uri) {
        return async (): Promise<DocumentSyncJournalStorage> => ({
            blobDirectoryUri: vscode.Uri.joinPath(storageRoot, DOCUMENT_SYNC_BLOB_DIRECTORY_NAME),
            conflictDirectoryUri: vscode.Uri.joinPath(storageRoot, DOCUMENT_SYNC_CONFLICT_DIRECTORY_NAME),
            stateUri: vscode.Uri.joinPath(storageRoot, DOCUMENT_SYNC_STATE_FILE_NAME),
            storageRoot,
        });
    }
}

export type {
    DocumentSyncConflictState,
    DocumentSyncRecord,
    PersistedDocumentSyncState,
} from './documentSyncJournalState';

export {
    createBlobId,
    createPersistedDocumentSyncState,
    parsePersistedDocumentSyncState,
    serializePersistedDocumentSyncState,
} from './documentSyncJournalState';
