import * as vscode from 'vscode';
import {
    createBlobId,
    createPersistedDocumentSyncState,
    DocumentSyncConflictState,
    DocumentSyncRecord,
    parsePersistedDocumentSyncState,
    PersistedDocumentSyncState,
    serializePersistedDocumentSyncState,
} from './documentSyncJournalState';

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
    return normalized.replace(/[\/\\]/g, '__');
}

export class DocumentSyncJournal {
    constructor(
        private readonly resolveStorage: () => Promise<DocumentSyncJournalStorage>,
    ) {}

    async loadState(): Promise<PersistedDocumentSyncState> {
        const {stateUri} = await this.resolveStorage();
        try {
            const raw = await vscode.workspace.fs.readFile(stateUri);
            return parsePersistedDocumentSyncState(new TextDecoder().decode(raw));
        } catch {
            return createPersistedDocumentSyncState();
        }
    }

    async saveState(state: PersistedDocumentSyncState) {
        const {storageRoot, stateUri} = await this.resolveStorage();
        await vscode.workspace.fs.createDirectory(storageRoot);
        await vscode.workspace.fs.writeFile(stateUri, Buffer.from(serializePersistedDocumentSyncState(state)));
    }

    async withState<T>(updater: (state: PersistedDocumentSyncState) => T | Promise<T>) {
        const state = await this.loadState();
        const result = await updater(state);
        await this.saveState(state);
        return result;
    }

    async readBlob(blobId: string): Promise<Uint8Array | undefined> {
        const {blobDirectoryUri} = await this.resolveStorage();
        try {
            return await vscode.workspace.fs.readFile(vscode.Uri.joinPath(blobDirectoryUri, blobId));
        } catch {
            return undefined;
        }
    }

    async writeBlob(content: Uint8Array): Promise<string> {
        const {blobDirectoryUri} = await this.resolveStorage();
        const blobId = createBlobId(content);
        const blobUri = vscode.Uri.joinPath(blobDirectoryUri, blobId);
        await vscode.workspace.fs.createDirectory(blobDirectoryUri);
        try {
            await vscode.workspace.fs.stat(blobUri);
            return blobId;
        } catch {
            await vscode.workspace.fs.writeFile(blobUri, content);
            return blobId;
        }
    }

    async materializeConflictFiles(relPath: string, conflict: DocumentSyncConflictState): Promise<DocumentSyncConflictMaterialization> {
        const {conflictDirectoryUri} = await this.resolveStorage();
        const baseContent = conflict.baseBlobId ? await this.readBlob(conflict.baseBlobId) : undefined;
        const localContent = conflict.localBlobId ? await this.readBlob(conflict.localBlobId) : undefined;
        const remoteContent = conflict.remoteBlobId ? await this.readBlob(conflict.remoteBlobId) : undefined;
        const targetDirectory = vscode.Uri.joinPath(
            conflictDirectoryUri,
            `${sanitizeRelPathForDirectory(relPath)}-${conflict.detectedAt.replace(/[:.]/g, '-')}`,
        );
        await vscode.workspace.fs.createDirectory(targetDirectory);
        const result: DocumentSyncConflictMaterialization = {};
        if (baseContent) {
            result.base = vscode.Uri.joinPath(targetDirectory, 'base');
            await vscode.workspace.fs.writeFile(result.base, baseContent);
        }
        if (localContent) {
            result.local = vscode.Uri.joinPath(targetDirectory, 'local');
            await vscode.workspace.fs.writeFile(result.local, localContent);
        }
        if (remoteContent) {
            result.remote = vscode.Uri.joinPath(targetDirectory, 'remote');
            await vscode.workspace.fs.writeFile(result.remote, remoteContent);
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
