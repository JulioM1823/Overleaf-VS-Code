import { createHash } from 'crypto';
import { AsyncQueue } from '../utils/asyncQueue';
import { LatestTaskQueue } from '../utils/latestTaskQueue';
import * as vscode from 'vscode';
import { assertSafeLocalPath, isMissingFile, writePrivateFile } from '../utils/safeFile';
import { ProjectEntity } from '../core/remoteFileSystemProvider';
import { ProjectMessageResponseSchema } from '../api/base';
import { OverleafCommentRange, OverleafCommentThread, OverleafPermissionsLevel } from '../comments/types';
import {
    createDeferredSyncQueueState,
    DeferredSyncQueueState,
    parseDeferredSyncQueueState,
    serializeDeferredSyncQueueState,
} from './offlineOperationLog';
import {
    ensureLocalReplicaMetadataDirectory,
    resolveLocalReplicaWorkspaceForOverleafUri,
    sanitizeLocalReplicaProjectFolderName,
} from '../scm/localReplicaWorkspace';
import {
    restrictPrivateFilePermissions,
} from '../utils/filePrivacy';

const OFFLINE_STORAGE_DIRECTORY_NAME = '.overleaf';
const OFFLINE_PROJECT_STATE_FILE_NAME = 'offline-project-state.json';
const OFFLINE_OPERATION_LOG_FILE_NAME = 'offline-operations.json';

export interface PersistedOfflineProjectState {
    bootstrapSource: 'fallback' | 'offline' | 'socket',
    chatHistoryComplete: boolean,
    chatMessages: ProjectMessageResponseSchema[],
    commentRangesByDocId: Record<string, OverleafCommentRange[]>,
    commentThreads: Record<string, OverleafCommentThread>,
    currentVersion?: number,
    outputBuildId?: string,
    permissionsLevel: OverleafPermissionsLevel,
    project: ProjectEntity,
    readonlyMode: boolean,
    savedAt: string,
    version: 1,
}

export interface ResolvedProjectOfflineStorage {
    operationLogUri: vscode.Uri,
    snapshotUri: vscode.Uri,
    storageKind: 'global' | 'workspace',
    storageRoot: vscode.Uri,
}

function parsePersistedOfflineProjectState(raw: string): PersistedOfflineProjectState {
    const parsed = JSON.parse(raw) as Partial<PersistedOfflineProjectState>;
    return {
        bootstrapSource: parsed.bootstrapSource ?? 'offline',
        chatHistoryComplete: parsed.chatHistoryComplete ?? false,
        chatMessages: Array.isArray(parsed.chatMessages) ? parsed.chatMessages : [],
        commentRangesByDocId: typeof parsed.commentRangesByDocId==='object' && parsed.commentRangesByDocId!==null
            ? parsed.commentRangesByDocId as Record<string, OverleafCommentRange[]>
            : {},
        commentThreads: typeof parsed.commentThreads==='object' && parsed.commentThreads!==null
            ? parsed.commentThreads as Record<string, OverleafCommentThread>
            : {},
        currentVersion: parsed.currentVersion,
        outputBuildId: parsed.outputBuildId,
        permissionsLevel: parsed.permissionsLevel ?? 'readOnly',
        project: parsed.project as ProjectEntity,
        readonlyMode: parsed.readonlyMode ?? false,
        savedAt: parsed.savedAt ?? new Date().toISOString(),
        version: 1,
    };
}

function serializePersistedOfflineProjectState(state: PersistedOfflineProjectState): string {
    return JSON.stringify({
        ...state,
        savedAt: state.savedAt,
        version: 1,
    }, null, 4);
}

export class ProjectOfflineStore {
    private readonly projectWrites = new LatestTaskQueue<Buffer>(async content => {
        const {storageRoot, snapshotUri} = await this.resolveStorage();
        await ensureLocalReplicaMetadataDirectory(storageRoot);
        await writePrivateFile(snapshotUri, content);
    });
    private readonly operationWrites = new AsyncQueue();
    private legacyStorageCheck?: Promise<void>;
    async flush() { await Promise.all([this.projectWrites.idle(), this.operationWrites.idle()]); }
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly overleafUri: vscode.Uri,
        private readonly projectId: string,
        private readonly projectName: string,
        private readonly serverName: string,
    ) {}

    private async resolveStorage(): Promise<ResolvedProjectOfflineStorage> {
        const workspace = await resolveLocalReplicaWorkspaceForOverleafUri(this.overleafUri);
        const userId = new URLSearchParams(this.overleafUri.query).get('user');
        if (!userId) { throw new Error('Offline storage requires a project account identity'); }
        const accountKey = createHash('sha256').update(JSON.stringify([this.serverName, this.projectId, userId])).digest('hex');
        const storageRoot = workspace
            ? vscode.Uri.joinPath(workspace.workspaceRoot, OFFLINE_STORAGE_DIRECTORY_NAME)
            : vscode.Uri.joinPath(this.context.globalStorageUri, 'offline-accounts', accountKey);
        if (!workspace) {
            this.legacyStorageCheck ??= this.checkLegacyRecoveryState();
            await this.legacyStorageCheck;
        }
        return {
            operationLogUri: vscode.Uri.joinPath(storageRoot, OFFLINE_OPERATION_LOG_FILE_NAME),
            snapshotUri: vscode.Uri.joinPath(storageRoot, OFFLINE_PROJECT_STATE_FILE_NAME),
            storageKind: workspace ? 'workspace' : 'global',
            storageRoot,
        };
    }

    private async checkLegacyRecoveryState() {
        const root = vscode.Uri.joinPath(this.context.globalStorageUri, 'offline-projects',
            sanitizeLocalReplicaProjectFolderName(this.serverName), sanitizeLocalReplicaProjectFolderName(this.projectId || this.projectName));
        for (const filename of ['offline-operations.json', 'document-sync-state.json', 'offline-project-state.json']) {
            try {
                const uri = vscode.Uri.joinPath(root, filename);
                await assertSafeLocalPath(root, uri);
                const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
                const data = JSON.parse(raw);
                const hasDraft = (value: any): boolean => value && typeof value==='object'
                    && ((typeof value.localCache==='string' && value.localCache!==value.remoteCache)
                        || value.localDirty===true || Boolean(value.conflict)
                        || Object.values(value).some(hasDraft));
                if ((filename==='offline-operations.json' && (!Array.isArray(data.operations) || data.operations.length > 0))
                    || hasDraft(data)) {
                    throw new Error('Legacy offline data has pending work without an account identity. Preserve and review it before migration.');
                }
            } catch (error) {
                if (!isMissingFile(error)) { throw error; }
            }
        }
    }

    async describeStorage() {
        return this.resolveStorage();
    }

    async resolveStorageRoot() {
        return (await this.resolveStorage()).storageRoot;
    }

    async loadProjectState(): Promise<PersistedOfflineProjectState | undefined> {
        const {snapshotUri, storageRoot} = await this.resolveStorage();
        await assertSafeLocalPath(storageRoot, snapshotUri);
        try {
            const raw = await vscode.workspace.fs.readFile(snapshotUri);
            return parsePersistedOfflineProjectState(new TextDecoder().decode(raw));
        } catch (error) {
            if (isMissingFile(error)) { return undefined; }
            throw error;
        }
    }

    async saveProjectState(state: PersistedOfflineProjectState) {
        const content = Buffer.from(serializePersistedOfflineProjectState(state));
        await this.projectWrites.enqueue(content);
    }

    async loadOperationQueue(): Promise<DeferredSyncQueueState> {
        const {operationLogUri, storageRoot} = await this.resolveStorage();
        await assertSafeLocalPath(storageRoot, operationLogUri);
        try {
            const raw = await vscode.workspace.fs.readFile(operationLogUri);
            return parseDeferredSyncQueueState(new TextDecoder().decode(raw));
        } catch (error) {
            if (isMissingFile(error)) { return createDeferredSyncQueueState(); }
            throw error;
        }
    }

    async saveOperationQueue(queue: DeferredSyncQueueState) {
        const content = Buffer.from(serializeDeferredSyncQueueState(queue));
        await this.operationWrites.run(async () => {
            const {storageRoot, operationLogUri} = await this.resolveStorage();
            await ensureLocalReplicaMetadataDirectory(storageRoot);
            await writePrivateFile(operationLogUri, content);
        });
    }
}
