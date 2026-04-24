import * as vscode from 'vscode';
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
    resolveLocalReplicaWorkspaceForOverleafUri,
    sanitizeLocalReplicaProjectFolderName,
} from '../scm/localReplicaWorkspace';

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
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly overleafUri: vscode.Uri,
        private readonly projectId: string,
        private readonly projectName: string,
        private readonly serverName: string,
    ) {}

    private async resolveStorage(): Promise<ResolvedProjectOfflineStorage> {
        const workspace = await resolveLocalReplicaWorkspaceForOverleafUri(this.overleafUri);
        const storageRoot = workspace
            ? vscode.Uri.joinPath(workspace.workspaceRoot, OFFLINE_STORAGE_DIRECTORY_NAME)
            : vscode.Uri.joinPath(
                this.context.globalStorageUri,
                'offline-projects',
                sanitizeLocalReplicaProjectFolderName(this.serverName),
                sanitizeLocalReplicaProjectFolderName(this.projectId || this.projectName),
            );
        return {
            operationLogUri: vscode.Uri.joinPath(storageRoot, OFFLINE_OPERATION_LOG_FILE_NAME),
            snapshotUri: vscode.Uri.joinPath(storageRoot, OFFLINE_PROJECT_STATE_FILE_NAME),
            storageKind: workspace ? 'workspace' : 'global',
            storageRoot,
        };
    }

    async describeStorage() {
        return this.resolveStorage();
    }

    async resolveStorageRoot() {
        return (await this.resolveStorage()).storageRoot;
    }

    async loadProjectState(): Promise<PersistedOfflineProjectState | undefined> {
        const {snapshotUri} = await this.resolveStorage();
        try {
            const raw = await vscode.workspace.fs.readFile(snapshotUri);
            return parsePersistedOfflineProjectState(new TextDecoder().decode(raw));
        } catch {
            return undefined;
        }
    }

    async saveProjectState(state: PersistedOfflineProjectState) {
        const {storageRoot, snapshotUri} = await this.resolveStorage();
        await vscode.workspace.fs.createDirectory(storageRoot);
        await vscode.workspace.fs.writeFile(snapshotUri, Buffer.from(serializePersistedOfflineProjectState(state)));
    }

    async loadOperationQueue(): Promise<DeferredSyncQueueState> {
        const {operationLogUri} = await this.resolveStorage();
        try {
            const raw = await vscode.workspace.fs.readFile(operationLogUri);
            return parseDeferredSyncQueueState(new TextDecoder().decode(raw));
        } catch {
            return createDeferredSyncQueueState();
        }
    }

    async saveOperationQueue(queue: DeferredSyncQueueState) {
        const {storageRoot, operationLogUri} = await this.resolveStorage();
        await vscode.workspace.fs.createDirectory(storageRoot);
        await vscode.workspace.fs.writeFile(operationLogUri, Buffer.from(serializeDeferredSyncQueueState(queue)));
    }
}
