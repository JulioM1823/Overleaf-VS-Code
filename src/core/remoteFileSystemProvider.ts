/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import * as DiffMatchPatch from 'diff-match-patch';
import { v4 as uuidv4 } from 'uuid';
import {
    BaseAPI,
    Identity,
    MemberEntity,
    ProjectMessageResponseSchema,
    ProjectSettingsSchema,
} from '../api/base';
import type { ChatSendApiResponseSchema } from '../api/base';
import { SocketIOAPI, UpdateSchema } from '../api/socketio';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { GlobalStateManager } from '../utils/globalStateManager';
import {
    collectDiagnosticSnapshot,
    logDiagnostic,
    registerDiagnosticStateProvider,
    sanitizeDiagnosticPayload,
    startDiagnosticSpan,
} from '../utils/diagnostics';
import { ClientManager } from '../collaboration/clientManager';
import { ChatViewProvider } from '../collaboration/chatViewProvider';
import { EventBus } from '../utils/eventBus';
import { SCMCollectionProvider } from '../scm/scmCollectionProvider';
import { ExtendedBaseAPI, ProjectLinkedFileProvider, UrlLinkedFileProvider } from '../api/extendedBase';
import {
    buildProjectEntityFromFlatEntities,
    isSyntheticEntityId,
    ProjectPageMetadata,
} from '../api/projectBootstrap';
import {
    decodeArchiveTextEntry,
    loadProjectArchiveEntries,
} from '../api/projectArchive';
import {
    allPatchApplicationsSucceeded,
    classifyWritePlan,
    hasFolderChildren,
} from './mutationSafety';
import {
    InitializationReason,
    RealtimeConnectionPhase,
    resolveConnectionAcceptedPhase,
    resolveConnectedConnectionPhase,
    resolveInitializationConnectionPhase,
    shouldBlockDocumentHydrationDuringRecovery,
    shouldAutoCompileAfterInitialization,
} from './connectionPhase';
import {
    calculateRecoveryDelayMs,
    extractOutputBuildId,
    hasCompileOutputs,
    shouldClearAuxFilesBeforeCompile,
} from './recoveryPolicy';
import {
    DeferredSynchronizationMode,
    isLikelyConnectivityFailure,
} from './offlineSyncState';
import {
    resolveConnectedSyncNotificationKind,
    resolveSyncNotificationState,
    shouldScheduleDisconnectNotification,
    shouldSuppressBackgroundSyncFailureNotification,
    shouldSurfaceSyncNotification,
    shouldSuppressSyncNotification,
    SYNC_DISCONNECT_NOTIFICATION_GRACE_MS,
    type SyncNotificationKind,
    type SyncNotificationState,
} from './syncNotificationPolicy';
import {
    resolvePrimaryPdfRenderPath,
    resolvePrimaryPdfOutputPath,
    selectPrimaryPdfArtifact,
} from '../compile/compileArtifacts';
import {
    canDeleteCommentMessage,
    canDeleteThread,
    canEditOwnComment,
    resolveCommentPermissions,
} from '../comments/commentPermissions';
import {
    applyTextOperationsToCommentRanges,
    cloneCommentRange,
    dedupeCommentRangesByThreadId,
    generateCommentThreadId,
    normalizeCommentRanges,
    updateCommentRangeResolvedState,
    upsertCommentRange,
} from '../comments/commentRanges';
import {
    editCommentMessageInThread,
    mergeCommentMessageIntoThread,
    normalizeCommentThread,
    removeCommentMessageFromThread,
} from '../comments/commentThreads';
import {
    consumeOptimisticCommentMessageId,
    discardOptimisticCommentMessageId,
    recordOptimisticCommentMessage,
} from '../comments/commentOptimisticMessages';
import {
    OverleafCommentMessage,
    OverleafCommentPermissions,
    OverleafCommentRange,
    OverleafCommentThread,
    OverleafDocumentCommentSnapshot,
    OverleafPermissionsLevel,
} from '../comments/types';
import {
    describeOverleafCommentAuthor,
    OverleafReviewThreadEntry,
    positionAtOffset,
    sortReviewThreadEntries,
} from '../comments/reviewIndex';
import {
    shouldBlockReviewCommentHydration,
    shouldUseLocalCommentReviewState,
} from '../comments/reviewSyncPolicy';
import {
    buildCommentAnchorUpdate,
} from '../comments/commentAnchorUpdate';
import {
    findCommentThreadIdsByMessageId as findCommentThreadIdsByMessageIdInThreads,
    findCommentThreadIdByMessageId as findCommentThreadIdByMessageIdInThreads,
} from '../comments/commentThreadLookup';
import {
    mergeOfflineCommentState,
} from '../comments/offlineCommentState';
import {
    evaluateCommentReplayAgainstManagedDocument,
    evaluateCommentReplayAgainstQueuedLocalReplica,
} from '../comments/commentReplaySafety';
import {
    applyTextOperationsToString,
    buildTextOperations,
    extractTextOperations,
    resolveJoinedDocumentTextState,
    serializeTextOperations,
} from './documentSessionText';
import {
    buildOverleafChatSendFailure,
} from '../collaboration/chatSendResult';
import type { OverleafChatSendResult } from '../collaboration/chatSendResult';
import {
    calculateChatRealtimeConfirmationRefreshDelayMs,
    calculateChatRateLimitRetryDelayMs,
    getChatRateLimitInlineRetryDelayMs,
} from '../collaboration/chatRetryPolicy';
import {
    isOwnChatMessageClient,
} from '../collaboration/chatClientId';
import {
    canFetchRemoteChatHistory,
    canSendLiveChatMessages,
} from '../collaboration/chatTransportState';
import {
    resolvePreferredRealtimeIdentity,
    shouldPersistRealtimeIdentity,
} from '../collaboration/chatIdentity';
import {
    buildOptimisticChatMessage,
    consumeOptimisticChatMessageId,
    discardOptimisticChatMessageId,
    pruneOptimisticChatMessages,
    recordOptimisticChatMessage,
} from '../collaboration/chatOptimisticMessages';
import {
    isTemporaryChatMessageId,
    resolveChatMessageDelivery,
    type ChatMessageDelivery,
} from '../collaboration/chatMessageDelivery';
import {
    CHAT_HISTORY_INITIAL_FETCH_LIMIT,
} from '../collaboration/chatHistoryPagination';
import {
    getManagedDocumentState,
    type ManagedTextDocumentState,
} from './liveTextDocumentRegistry';
import { formatCommentThreadPreview } from '../comments/commentThreadPreview';
import { formatOverleafCommentTimestamp } from '../comments/commentTimestamps';
import {
    getConfiguredCommentUserPalette,
} from '../comments/commentColorConfiguration';
import {
    resolveCommentUserColorByIndex,
    resolveCommentUserIdentifier,
} from '../comments/commentColors';
import { logCommentDiagnostics } from '../comments/commentDiagnostics';
import {
    appendDeferredSyncOperation,
    createDeferredSyncQueueState,
    DeferredSyncOperation,
    DeferredSyncQueueState,
    foldPendingCommentMessageContentIntoDeferredOperations,
    hasDeferredSyncOperationsExcludingKinds,
    hasDeferredSyncOperationsForKind,
    hasDeferredSyncOperations,
    removeDeferredSyncOperation,
    replaceDeferredSyncMessageId,
} from '../offline/offlineOperationLog';
import {
    PersistedOfflineProjectState,
    ProjectOfflineStore,
} from '../offline/projectOfflineStore';
import {
    ProjectChatLoadResult,
    ProjectChatSession,
} from '../collaboration/projectChatSession';
import {
    DocumentSyncConflictState,
    DocumentSyncJournal,
    DocumentSyncRecord,
    PersistedDocumentSyncState,
} from '../offline/documentSyncJournal';
import {
    resolveLocalReplicaWorkspaceForOverleafUri,
} from '../scm/localReplicaWorkspace';
import {
    doesVfsMatchActiveWorkspaceProject,
    resolveProjectRenderUriForPath,
} from './projectWorkspaceBinding';
import {
    createLocalReplicaSnapshot,
} from '../scm/localReplicaSyncState';

const __OUTPUTS_ID = `${ROOT_NAME}-outputs`;
const __PRIMARY_PDF_OUTPUT_ID = `${ROOT_NAME}-primary-pdf-output`;

function shouldTreatCommentMutationFailureAsTransient(error: unknown) {
    if (isLikelyConnectivityFailure(error)) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /(^|\b)(408|425|429|500|502|503|504)\s*:|service unavailable|temporarily unavailable|bad gateway|gateway timeout|proxy error|upstream|socket hang up|network request failed|fetch error/i.test(message);
}

type CommentStateTransitionKind =
    | 'range.appended'
    | 'range.merged'
    | 'range.replaced'
    | 'thread.appended'
    | 'thread.merged'
    | 'thread.removed'
    | 'thread.replaced';

export type FileType = 'doc' | 'file' | 'folder' | 'outputs';
export type FolderKey = 'docs' | 'fileRefs' | 'folders' | 'outputs';
const FolderKeys: {[_type:string]: FolderKey} = {
    'folder': 'folders',
    'doc': 'docs',
    'file': 'fileRefs',
    'outputs': 'outputs',
};

export interface FileEntity {
    _id: string,
    name: string,
    _type?: FileType,
    readonly?: boolean,
}

export interface DocumentEntity extends FileEntity {
    version?: number,
    mtime?: number,
    lastVersion?: number,
    localCache?: string,
    remoteCache?: string,
}

export interface FileRefEntity extends FileEntity {
    linkedFileData: ProjectLinkedFileProvider | UrlLinkedFileProvider | null,
    created: string, //ISO date string
}

export interface OutputFileEntity extends FileEntity {
    path: string, //output file name
    url: string, // `project/${projectId}/user/${userId}/output/${build}/output/${path}`
    type: string, //output file type (postfix)
    build: string, //build id
}

interface ReplayCommentAnchorOperationInput {
    id: string,
    kind: 'comment.anchorExistingThread' | 'comment.create',
    payload: {
        content: string,
        docId: string,
        filePath?: string,
        localMessageId: string,
        selectedText: string,
        serverMessageId?: string,
        startOffset: number,
        threadId: string,
    },
}

export interface FolderEntity extends FileEntity {
    docs: Array<DocumentEntity>,
    fileRefs: Array<FileRefEntity>,
    folders: Array<FolderEntity>,
    outputs?: Array<OutputFileEntity>,
}

export interface ProjectEntity {
    _id: string,
    name: string,
    rootDoc_id: string,
    rootFolder: Array<FolderEntity>,
    publicAccessLevel: string, //"tokenBased"
    compiler: string,
    spellCheckLanguage: string,
    deletedDocs: Array<{
        _id: string,
        name: string,
        deletedAt: string,
    }>,
    members: Array<MemberEntity>,
    invites: Array<MemberEntity>,
    owner: MemberEntity,
    features: {[key:string]:any},
    settings: ProjectSettingsSchema,
}

export class File implements vscode.FileStat {
    type: vscode.FileType;
    name: string;
    ctime: number;
    mtime: number;
    size: number;
    permissions?: vscode.FilePermission;
    constructor(name: string, type: vscode.FileType, ctime?: number, permissions?:vscode.FilePermission) {
        this.type = type;
        this.name = name;
        this.ctime = ctime || Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.permissions = permissions;
    }
}

export function parseUri(uri: vscode.Uri) {
    const query:any = uri.query.split('&').reduce((acc, v) => {
        const [key,value] = v.split('=');
        return {...acc, [key]:value};
    }, {});
    const [userId, projectId] = [query.user, query.project];
    const _pathParts = uri.path.split('/');
    const serverName = uri.authority;
    const projectName = decodeURIComponent(_pathParts[1]);
    const pathParts = _pathParts.splice(2);
    const identifier = `${userId}/${projectId}/${projectName}`;
    return {userId, projectId, serverName, projectName, identifier, pathParts};
}

export interface OverleafTextDocumentSessionState {
    docId: string,
    loadedFromCache: boolean,
    localText: string,
    overleafUri: vscode.Uri,
    remoteText: string,
    version: number,
}

export type LiveTextDocumentSyncResult =
    | { kind: 'applied' }
    | { kind: 'noop' }
    | { kind: 'offline' }
    | { kind: 'recovery-required' };

export type ChatMessagesLoadResult = ProjectChatLoadResult;

export class VirtualFileSystem extends vscode.Disposable {
    private root?: ProjectEntity;
    private currentVersion?: number;
    private context: vscode.ExtensionContext;
    private api: BaseAPI;
    private socket: SocketIOAPI;
    private publicId?: string;
    private userId: string;
    private isDirty: boolean = true;
    private initializing?: Promise<ProjectEntity>;
    private retryConnection: number = 0;
    private remoteWatchRegistered: boolean = false;
    private readonlyMode: boolean = false;
    private bootstrapSource: 'socket' | 'fallback' | 'offline' = 'socket';
    private outputBuildId?: string;
    private fallbackCurrentArchiveVersion?: number;
    private fallbackCurrentArchiveFiles?: Map<string, Uint8Array>;
    private fallbackArchiveVersion?: number;
    private fallbackArchiveFiles?: Map<string, Uint8Array>;
    private bootstrapAttemptId = 0;
    private fileOpenAttemptId = 0;
    private mutationAttemptId = 0;
    private recoveryAttemptId = 0;
    private recoveryTimer?: ReturnType<typeof setTimeout>;
    private pendingRecoveryReason?: InitializationReason;
    private connectionPhase: RealtimeConnectionPhase = 'initializing';
    private connectionPhaseSequence = 0;
    private deferredSynchronizationMode: DeferredSynchronizationMode = 'online';
    private syncNotificationState: SyncNotificationState = 'idle';
    private pendingDisconnectNotificationTimer?: ReturnType<typeof setTimeout>;
    private hasShownConnectedNotification = false;
    private hasShownDisconnectNotification = false;
    private lastSyncNotification?: {at: number, kind: SyncNotificationKind};
    private deferredSynchronizationQueue: DeferredSyncQueueState = createDeferredSyncQueueState();
    private readonly offlineStore: ProjectOfflineStore;
    private readonly documentSyncJournal: DocumentSyncJournal;
    private offlineStatePersistPromise: Promise<void> = Promise.resolve();
    private offlineStatePersistTimer?: ReturnType<typeof setTimeout>;
    private deferredSynchronizationRecovery?: Promise<void>;
    private deferredSynchronizationRetryTimer?: ReturnType<typeof setTimeout>;
    private deferredSynchronizationRetryDeadline?: number;
    private queuedChatSynchronizationRecovery?: Promise<void>;
    private queuedChatSynchronizationRetryTimer?: ReturnType<typeof setTimeout>;
    private queuedChatSynchronizationRetryDeadline?: number;
    private chatMessages: ProjectMessageResponseSchema[] = [];
    private chatHistoryLoaded = false;
    private chatHistoryLoadPromise?: Promise<ChatMessagesLoadResult>;
    private permissionsLevel: OverleafPermissionsLevel = 'readOnly';
    private commentRangesByDocId = new Map<string, OverleafCommentRange[]>();
    private commentThreads = new Map<string, OverleafCommentThread>();
    private commentThreadAliases = new Map<string, string>();
    private commentThreadsLoaded = false;
    private commentThreadsLoading?: Promise<void>;
    private commentReconnectRefreshPromise?: Promise<void>;
    private projectCommentRangesHydrationPromise?: Promise<void>;
    private projectCommentWarmupPromise?: Promise<void>;
    private commentsChangedEventSequence = 0;
    private readonly commentStateTransitionCounts = new Map<CommentStateTransitionKind, number>();
    private readonly chatClientId = uuidv4();
    private chatRateLimitRetryAttempt = 0;
    private pendingOptimisticCommentMessages = new Map<string, string[]>();
    private pendingOptimisticChatMessages = new Map<string, string[]>();
    private awaitingRealtimeChatConfirmationMessageIds = new Set<string>();
    private chatRealtimeConfirmationRefreshAttempt = 0;
    private chatRealtimeConfirmationRefreshTimer?: ReturnType<typeof setTimeout>;
    private chatRealtimeConfirmationRefreshDeadline?: number;
    private pendingLocalTextEchoes = new Map<string, Array<{nextVersion: number, signature: string, version: number}>>();
    private notify: (events:vscode.FileChangeEvent[])=>void;
    private chatViewProviderItem?: {provider: ChatViewProvider, triggers: vscode.Disposable[]};
    private clientManagerItem?: {manager: ClientManager, triggers: vscode.Disposable[]};
    private scmCollectionItem?: {collection: SCMCollectionProvider, triggers: vscode.Disposable[]};
    private readonly chatSession: ProjectChatSession;
    private readonly diagnosticsStateProviderRegistrations: Array<{dispose: () => void}> = [];
    private disposed = false;

    public readonly origin: vscode.Uri;
    public readonly projectName: string;
    public readonly serverName: string;
    public readonly projectId: string;

    constructor(
        context: vscode.ExtensionContext,
        uri: vscode.Uri,
        notify: (events:vscode.FileChangeEvent[])=>void,
        api: BaseAPI,
        socket: SocketIOAPI,
    ) {
        // define the dispose behavior
        super(() => {
            this.logDiagnostic('filesystem.vfs_disposed', {
                deferredOperationCount: this.deferredSynchronizationQueue.operations.length,
                origin: this.origin.toString(),
            });
            this.disposed = true;
            if (this.pendingDisconnectNotificationTimer) {
                clearTimeout(this.pendingDisconnectNotificationTimer);
                this.pendingDisconnectNotificationTimer = undefined;
            }
            void this.flushOfflineProjectStatePersist();
            if (this.recoveryTimer) {
                clearTimeout(this.recoveryTimer);
                this.recoveryTimer = undefined;
            }
            if (this.deferredSynchronizationRetryTimer) {
                clearTimeout(this.deferredSynchronizationRetryTimer);
                this.deferredSynchronizationRetryTimer = undefined;
                this.deferredSynchronizationRetryDeadline = undefined;
            }
            if (this.queuedChatSynchronizationRetryTimer) {
                clearTimeout(this.queuedChatSynchronizationRetryTimer);
                this.queuedChatSynchronizationRetryTimer = undefined;
                this.queuedChatSynchronizationRetryDeadline = undefined;
            }
            if (this.chatRealtimeConfirmationRefreshTimer) {
                clearTimeout(this.chatRealtimeConfirmationRefreshTimer);
                this.chatRealtimeConfirmationRefreshTimer = undefined;
                this.chatRealtimeConfirmationRefreshDeadline = undefined;
            }
            this.chatSession?.dispose();
            this.disposeDiagnosticsStateProviders();
            this.chatViewProviderItem?.provider.dispose();
            this.chatViewProviderItem?.triggers.forEach((trigger) => trigger.dispose());
            this.chatViewProviderItem = undefined;
            // dispose all triggers of clientManager
            this.clientManagerItem?.triggers.forEach((trigger) => trigger.dispose());
            this.clientManagerItem = undefined;
            // dispose all triggers of scmCollection
            this.scmCollectionItem?.triggers.forEach((trigger) => trigger.dispose());
            this.scmCollectionItem = undefined;
            this.root = undefined;
            this.initializing = undefined;
            this.socket.disconnect();
        });

        const {userId,projectId,serverName,projectName} = parseUri(uri);
        this.serverName = serverName;
        this.projectName = projectName;
        this.origin = uri.with({path: '/'+projectName});
        this.userId = userId;
        this.projectId = projectId;
        this.context = context;
        this.notify = notify;
        this.api = api;
        this.socket = socket;
        this.offlineStore = new ProjectOfflineStore(
            this.context,
            this.origin,
            this.projectId,
            this.projectName,
            this.serverName,
        );
        this.documentSyncJournal = new DocumentSyncJournal(async () => {
            const storageRoot = await this.offlineStore.resolveStorageRoot();
            return DocumentSyncJournal.createStorageResolver(storageRoot)();
        });
        this.chatSession = new ProjectChatSession({
            api: this.api,
            appendDeferredSyncOperation: this.appendDeferredSynchronizationOperation.bind(this),
            canFetchRemoteHistory: () => this.canFetchChatHistory,
            canSendLiveMessages: () => this.canSendLiveChatMessages,
            getActiveChatClientId: () => this.activeChatClientId,
            getAuthenticatedTransportIdentity: this.getAuthenticatedTransportIdentity.bind(this),
            getDeferredSyncOperations: () => [...this.deferredSynchronizationQueue.operations],
            isOfflineMode: () => this.isOfflineMode,
            logDiagnostic: this.logDiagnostic.bind(this),
            onStateChanged: (state, reason, options) => {
                this.chatMessages = state.messages;
                this.chatHistoryLoaded = state.historyComplete;
                this.logDiagnostic('chat.messages_state_changed', {
                    historyComplete: state.historyComplete,
                    messageCount: state.messages.length,
                    reason,
                });
                EventBus.fire('chatMessagesChangedEvent', {
                    message: options?.message,
                    origin: this.origin.toString(),
                    projectId: this.projectId,
                    reason,
                    serverName: this.serverName,
                });
                if (reason!=='initialization_reset') {
                    this.scheduleOfflineProjectStatePersist(reason);
                }
            },
            projectId: this.projectId,
            removeDeferredSyncOperation: this.removeDeferredSynchronizationOperation.bind(this),
            replaceDeferredSyncOperations: this.replaceDeferredSynchronizationOperations.bind(this),
            resolveCurrentProjectMember: this.resolveCurrentProjectMember.bind(this),
            transitionToOffline: this.transitionToOfflineMode.bind(this),
            userId: this.userId,
        });
        this.registerDiagnosticsStateProviders();
    }

    static async create(
        context: vscode.ExtensionContext,
        uri: vscode.Uri,
        notify: (events:vscode.FileChangeEvent[])=>void,
    ) {
        const {projectId, serverName} = parseUri(uri);
        const res = await GlobalStateManager.initSocketIOAPI(context, serverName, projectId);
        if (!res) {
            throw new Error(vscode.l10n.t('Cannot init SocketIOAPI for {serverName}', {serverName}));
        }
        return new VirtualFileSystem(context, uri, notify, res.api, res.socket);
    }

    get isDisposed() {
        return this.disposed;
    }

    get _userId() {
        return this.userId;
    }

    createLocalPendingCommentMessage(
        content: string,
        messageId: string,
        timestamp = new Date().toISOString(),
    ) {
        return this.buildOfflineCommentMessage(content, messageId, timestamp);
    }

    getManagedTextDocumentState(uri: vscode.Uri): ManagedTextDocumentState | undefined {
        return getManagedDocumentState(uri);
    }

    get currentPublicId() {
        return this.publicId;
    }

    private normalizeDocumentSyncRelPath(relPath: string) {
        if (relPath==='' || relPath==='/') {
            return '/';
        }
        return relPath.startsWith('/') ? relPath : `/${relPath}`;
    }

    private toDocumentSyncRelPathFromProjectPath(pathname: string) {
        return this.normalizeDocumentSyncRelPath(pathname);
    }

    public toDocumentSyncRelPath(uri: vscode.Uri) {
        if (uri.scheme===ROOT_NAME) {
            const {pathParts} = parseUri(uri);
            if (pathParts.at(-1)==='') {
                pathParts.pop();
            }
            return this.normalizeDocumentSyncRelPath(pathParts.join('/'));
        }
        return this.normalizeDocumentSyncRelPath(uri.path);
    }

    private createFileSnapshot(content?: Uint8Array) {
        return content===undefined
            ? undefined
            : createLocalReplicaSnapshot('file', content);
    }

    private async updateDocumentSyncState<T>(
        reason: string,
        fields: Record<string, unknown>,
        updater: (state: PersistedDocumentSyncState) => T | Promise<T>,
    ) {
        try {
            return await this.documentSyncJournal.withState(async (state) => updater(state));
        } catch (error) {
            this.logDiagnostic('document_sync.state_update_failed', {
                reason,
                ...fields,
            }, error);
            throw error;
        }
    }

    async getDocumentSyncState() {
        return this.documentSyncJournal.loadState();
    }

    async getDocumentSyncRecord(relPath: string) {
        const state = await this.getDocumentSyncState();
        return state.records[this.normalizeDocumentSyncRelPath(relPath)];
    }

    async persistDocumentSyncRecord(record: DocumentSyncRecord, reason: string) {
        const relPath = this.normalizeDocumentSyncRelPath(record.relPath);
        await this.updateDocumentSyncState(reason, {relPath}, (state) => {
            state.records[relPath] = {
                ...record,
                relPath,
            };
        });
    }

    async removeDocumentSyncRecord(relPath: string, reason: string) {
        const normalizedRelPath = this.normalizeDocumentSyncRelPath(relPath);
        await this.updateDocumentSyncState(reason, {relPath: normalizedRelPath}, (state) => {
            delete state.records[normalizedRelPath];
        });
    }

    private async writeDocumentSyncBlob(content: Uint8Array) {
        return this.documentSyncJournal.writeBlob(content);
    }

    async readDocumentSyncBlob(blobId: string) {
        return this.documentSyncJournal.readBlob(blobId);
    }

    async materializeDocumentSyncConflict(relPath: string, conflict: DocumentSyncConflictState) {
        return this.documentSyncJournal.materializeConflictFiles(
            this.normalizeDocumentSyncRelPath(relPath),
            conflict,
        );
    }

    async markDocumentSyncDirty(arg: {
        baseContent?: Uint8Array,
        baseVersion?: number,
        docId?: string,
        lastKnownRemoteContent?: Uint8Array,
        lastKnownRemoteVersion?: number,
        reason: string,
        relPath: string,
    }) {
        const relPath = this.normalizeDocumentSyncRelPath(arg.relPath);
        const baseSnapshot = this.createFileSnapshot(arg.baseContent);
        const lastKnownRemoteSnapshot = this.createFileSnapshot(arg.lastKnownRemoteContent);
        const baseBlobId = arg.baseContent ? await this.writeDocumentSyncBlob(arg.baseContent) : undefined;
        await this.updateDocumentSyncState(arg.reason, {
            docId: arg.docId ?? '',
            relPath,
        }, (state) => {
            const existing = state.records[relPath];
            state.records[relPath] = {
                baseBlobId: existing?.baseBlobId ?? baseBlobId,
                baseSnapshot: existing?.baseSnapshot ?? baseSnapshot,
                baseVersion: existing?.baseVersion ?? arg.baseVersion,
                conflict: existing?.conflict,
                docId: arg.docId ?? existing?.docId,
                lastKnownRemoteSnapshot: lastKnownRemoteSnapshot ?? existing?.lastKnownRemoteSnapshot ?? baseSnapshot,
                lastKnownRemoteVersion: arg.lastKnownRemoteVersion ?? existing?.lastKnownRemoteVersion ?? arg.baseVersion,
                lastRecoveryRunId: existing?.lastRecoveryRunId,
                localDirty: true,
                relPath,
            };
        });
        this.logDiagnostic('document_sync.marked_dirty', {
            baseHash: baseSnapshot?.hash,
            baseVersion: arg.baseVersion ?? -1,
            docId: arg.docId ?? '',
            lastKnownRemoteHash: lastKnownRemoteSnapshot?.hash,
            lastKnownRemoteVersion: arg.lastKnownRemoteVersion ?? -1,
            localDirty: true,
            relPath,
            reason: arg.reason,
        });
    }

    async recordDocumentSyncRemoteState(arg: {
        content?: Uint8Array,
        docId?: string,
        reason: string,
        relPath: string,
        version?: number,
    }) {
        const relPath = this.normalizeDocumentSyncRelPath(arg.relPath);
        const snapshot = this.createFileSnapshot(arg.content);
        await this.updateDocumentSyncState(arg.reason, {
            docId: arg.docId ?? '',
            relPath,
        }, (state) => {
            const existing = state.records[relPath];
            if (!existing) {
                if (!snapshot) {
                    return;
                }
                state.records[relPath] = {
                    baseSnapshot: snapshot,
                    baseVersion: arg.version,
                    docId: arg.docId,
                    lastKnownRemoteSnapshot: snapshot,
                    lastKnownRemoteVersion: arg.version,
                    localDirty: false,
                    relPath,
                };
                return;
            }
            state.records[relPath] = {
                ...existing,
                docId: arg.docId ?? existing.docId,
                lastKnownRemoteSnapshot: snapshot ?? existing.lastKnownRemoteSnapshot,
                lastKnownRemoteVersion: arg.version ?? existing.lastKnownRemoteVersion,
            };
        });
    }

    async recordDocumentSyncBaseline(arg: {
        content: Uint8Array,
        docId?: string,
        reason: string,
        relPath: string,
        version?: number,
    }) {
        const relPath = this.normalizeDocumentSyncRelPath(arg.relPath);
        const snapshot = createLocalReplicaSnapshot('file', arg.content);
        const blobId = await this.writeDocumentSyncBlob(arg.content);
        await this.updateDocumentSyncState(arg.reason, {
            docId: arg.docId ?? '',
            relPath,
        }, (state) => {
            state.records[relPath] = {
                baseBlobId: blobId,
                baseSnapshot: snapshot,
                baseVersion: arg.version,
                conflict: undefined,
                docId: arg.docId,
                lastKnownRemoteSnapshot: snapshot,
                lastKnownRemoteVersion: arg.version,
                lastRecoveryRunId: undefined,
                localDirty: false,
                relPath,
            };
        });
        this.logDiagnostic('document_sync.baseline_recorded', {
            baseBlobPresent: true,
            baseHash: snapshot.hash,
            baseVersion: arg.version ?? -1,
            docId: arg.docId ?? '',
            localDirty: false,
            relPath,
            reason: arg.reason,
            remoteHash: snapshot.hash,
            remoteVersion: arg.version ?? -1,
        });
    }

    async recordDocumentSyncConflict(arg: {
        baseContent?: Uint8Array,
        baseVersion?: number,
        docId?: string,
        lastKnownRemoteContent?: Uint8Array,
        lastKnownRemoteVersion?: number,
        localContent?: Uint8Array,
        reason: string,
        recoveryRunId?: string,
        relPath: string,
        remoteContent?: Uint8Array,
    }) {
        const relPath = this.normalizeDocumentSyncRelPath(arg.relPath);
        const baseBlobId = arg.baseContent ? await this.writeDocumentSyncBlob(arg.baseContent) : undefined;
        const localBlobId = arg.localContent ? await this.writeDocumentSyncBlob(arg.localContent) : undefined;
        const remoteBlobId = arg.remoteContent ? await this.writeDocumentSyncBlob(arg.remoteContent) : undefined;
        const baseSnapshot = this.createFileSnapshot(arg.baseContent);
        const remoteSnapshot = this.createFileSnapshot(arg.remoteContent ?? arg.lastKnownRemoteContent);
        const conflict: DocumentSyncConflictState = {
            baseBlobId,
            detectedAt: new Date().toISOString(),
            localBlobId,
            reason: arg.reason,
            remoteBlobId,
        };
        await this.updateDocumentSyncState(arg.reason, {
            docId: arg.docId ?? '',
            relPath,
        }, (state) => {
            const existing = state.records[relPath];
            state.records[relPath] = {
                baseBlobId: existing?.baseBlobId ?? baseBlobId,
                baseSnapshot: existing?.baseSnapshot ?? baseSnapshot,
                baseVersion: existing?.baseVersion ?? arg.baseVersion,
                conflict,
                docId: arg.docId ?? existing?.docId,
                lastKnownRemoteSnapshot: remoteSnapshot ?? existing?.lastKnownRemoteSnapshot,
                lastKnownRemoteVersion: arg.lastKnownRemoteVersion ?? existing?.lastKnownRemoteVersion ?? arg.baseVersion,
                lastRecoveryRunId: arg.recoveryRunId ?? existing?.lastRecoveryRunId,
                localDirty: true,
                relPath,
            };
        });
        this.logDiagnostic('document_sync.conflict_recorded', {
            baseBlobPresent: baseBlobId !== undefined,
            baseHash: baseSnapshot?.hash,
            baseVersion: arg.baseVersion ?? -1,
            conflictStatePresent: true,
            docId: arg.docId ?? '',
            localHash: arg.localContent ? createLocalReplicaSnapshot('file', arg.localContent).hash : undefined,
            relPath,
            remoteHash: remoteSnapshot?.hash,
            remoteVersion: arg.lastKnownRemoteVersion ?? -1,
            reason: arg.reason,
            recoveryRunId: arg.recoveryRunId ?? '',
        });
    }

    async clearDocumentSyncConflict(relPath: string, reason: string) {
        const normalizedRelPath = this.normalizeDocumentSyncRelPath(relPath);
        await this.updateDocumentSyncState(reason, {relPath: normalizedRelPath}, (state) => {
            const existing = state.records[normalizedRelPath];
            if (!existing?.conflict) {
                return;
            }
            state.records[normalizedRelPath] = {
                ...existing,
                conflict: undefined,
                lastRecoveryRunId: undefined,
            };
        });
    }

    async init(options?: {
        autoCompileAfterInitialization?: boolean,
    }) : Promise<ProjectEntity> {
        if (this.root) {
            return Promise.resolve(this.root);
        }

        const autoCompileAfterInitialization = options?.autoCompileAfterInitialization ?? false;
        if (!this.initializing) {
            this.initializing = this.createInitializationPromise('initial', {
                allowFallback: true,
                autoCompileAfterInitialization,
                preserveRoot: false,
                showReloadPrompt: true,
            });
        }
        return this.initializing;
    }

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('VirtualFileSystem', event, {
            bootstrapSource: this.bootstrapSource,
            chatQueueLength: this.chatQueueLength,
            connectionPhase: this.connectionPhase,
            publicId: this.publicId ?? '',
            projectId: this.projectId,
            projectName: this.projectName,
            readonlyMode: this.readonlyMode,
            retryConnection: this.retryConnection,
            serverName: this.serverName,
            syncMode: this.deferredSynchronizationMode,
            ...fields,
        }, error);
    }

    private logCommentSyncDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        this.logDiagnostic(event, {
            commentSubsystem: 'comments:sync',
            ...fields,
        }, error);
    }

    private recordCommentStateTransition(kind: CommentStateTransitionKind, fields: Record<string, unknown> = {}) {
        const transitionCount = (this.commentStateTransitionCounts.get(kind) ?? 0) + 1;
        this.commentStateTransitionCounts.set(kind, transitionCount);
        logCommentDiagnostics('VirtualFileSystem', 'sync', 'comments.state_transition_observed', {
            kind,
            transitionCount,
            ...fields,
        });
    }

    private registerDiagnosticsStateProviders() {
        const scopeSuffix = `${this.serverName}/${this.projectId}`;
        this.disposeDiagnosticsStateProviders();
        this.diagnosticsStateProviderRegistrations.push(
            registerDiagnosticStateProvider(`sync:${scopeSuffix}`, () => this.collectSyncDiagnosticsState()),
            registerDiagnosticStateProvider(`chat:${scopeSuffix}`, () => this.collectChatDiagnosticsState()),
            registerDiagnosticStateProvider(`comments:${scopeSuffix}`, () => this.collectCommentDiagnosticsState()),
            registerDiagnosticStateProvider(`filesystem:${scopeSuffix}`, () => this.collectFilesystemDiagnosticsState()),
            registerDiagnosticStateProvider(`network:${scopeSuffix}`, () => this.collectNetworkDiagnosticsState()),
            registerDiagnosticStateProvider(`offline:${scopeSuffix}`, () => this.collectOfflineDiagnosticsState()),
        );
    }

    private disposeDiagnosticsStateProviders() {
        this.diagnosticsStateProviderRegistrations.splice(0).forEach((registration) => registration.dispose());
    }

    private collectSyncDiagnosticsState() {
        return {
            activeRecoveryInFlight: Boolean(this.deferredSynchronizationRecovery),
            connectionPhase: this.connectionPhase,
            connectionPhaseSequence: this.connectionPhaseSequence,
            deferredOperationCount: this.deferredSynchronizationQueue.operations.length,
            deferredOperationCountsByKind: this.summarizeDeferredOperationCountsByKind(),
            deferredRecoveryActive: Boolean(this.deferredSynchronizationRecovery),
            deferredRetryDeadline: this.deferredSynchronizationRetryDeadline
                ? new Date(this.deferredSynchronizationRetryDeadline).toISOString()
                : '',
            deferredRetryScheduled: Boolean(this.deferredSynchronizationRetryTimer),
            hasDeferredOperations: this.hasDeferredSynchronizationOperations,
            hasRecoverableNonChatOperations: this.hasDeferredRecoverableNonChatOperations,
            hasReplicationOperations: this.hasDeferredLocalReplicaOperations,
            pendingRecoveryReason: this.pendingRecoveryReason ?? '',
            queuedChatRecoveryActive: Boolean(this.queuedChatSynchronizationRecovery),
            queuedChatRetryDeadline: this.queuedChatSynchronizationRetryDeadline
                ? new Date(this.queuedChatSynchronizationRetryDeadline).toISOString()
                : '',
            queuedChatRetryScheduled: Boolean(this.queuedChatSynchronizationRetryTimer),
            recoveryTimerScheduled: Boolean(this.recoveryTimer),
            retryConnection: this.retryConnection,
            syncMode: this.deferredSynchronizationMode,
            syncNotificationState: this.syncNotificationState,
        };
    }

    private collectChatDiagnosticsState() {
        return {
            ...this.chatSession.getDiagnosticsState(),
            activeChatClientId: this.activeChatClientId,
            canFetchChatHistory: this.canFetchChatHistory,
            canSendLiveChatMessages: this.canSendLiveChatMessages,
            chatHistoryLoaded: this.chatHistoryLoaded,
            hasQueuedChatSynchronizationOperations: this.hasQueuedChatSynchronizationOperations,
            messageCount: this.chatMessages.length,
        };
    }

    private collectCommentCoverageDiagnostics() {
        const canonicalThreadIdsWithRanges = new Set<string>();
        for (const ranges of this.commentRangesByDocId.values()) {
            ranges.forEach((range) => {
                canonicalThreadIdsWithRanges.add(this.resolveCanonicalCommentThreadId(range.op.t));
            });
        }
        const canonicalThreadIdsWithMessages = new Set<string>(
            Array.from(this.commentThreads.keys()).map((threadId) => this.resolveCanonicalCommentThreadId(threadId)),
        );
        const threadsWithoutRanges = Array.from(canonicalThreadIdsWithMessages)
            .filter((threadId) => !canonicalThreadIdsWithRanges.has(threadId))
            .sort((left, right) => left.localeCompare(right));
        const rangesWithoutThreads = Array.from(canonicalThreadIdsWithRanges)
            .filter((threadId) => !canonicalThreadIdsWithMessages.has(threadId))
            .sort((left, right) => left.localeCompare(right));
        return {
            rangeWithoutThreadCount: rangesWithoutThreads.length,
            sampleAliases: Array.from(this.commentThreadAliases.entries())
                .sort(([left], [right]) => left.localeCompare(right))
                .slice(0, 20)
                .map(([aliasThreadId, canonicalThreadId]) => ({
                    aliasThreadId,
                    canonicalThreadId: this.resolveCanonicalCommentThreadId(canonicalThreadId),
                })),
            sampleRangesWithoutThreads: rangesWithoutThreads.slice(0, 20),
            sampleThreadsWithoutRanges: threadsWithoutRanges.slice(0, 20),
            threadWithoutRangeCount: threadsWithoutRanges.length,
        };
    }

    private collectCommentDiagnosticsState() {
        const totalRangeCount = [...this.commentRangesByDocId.values()]
            .reduce((count, ranges) => count + ranges.length, 0);
        return {
            commentAliasCount: this.commentThreadAliases.size,
            commentDocCount: this.commentRangesByDocId.size,
            commentsChangedEventSequence: this.commentsChangedEventSequence,
            commentThreadsLoaded: this.commentThreadsLoaded,
            commentThreadsLoading: Boolean(this.commentThreadsLoading),
            permissionsLevel: this.permissionsLevel,
            sampleDocCoverage: Array.from(this.commentRangesByDocId.entries())
                .sort(([left], [right]) => left.localeCompare(right))
                .slice(0, 20)
                .map(([docId, ranges]) => ({
                    docId,
                    rangeCount: ranges.length,
                    threadCount: new Set(ranges.map((range) => this.resolveCanonicalCommentThreadId(range.op.t))).size,
                })),
            stateTransitionCounts: Object.fromEntries(
                Array.from(this.commentStateTransitionCounts.entries())
                    .sort(([left], [right]) => left.localeCompare(right)),
            ),
            resolvedThreadCount: [...this.commentThreads.values()].filter((thread) => thread.resolved).length,
            ...this.collectCommentCoverageDiagnostics(),
            threadCount: this.commentThreads.size,
            totalRangeCount,
        };
    }

    private collectFilesystemDiagnosticsState() {
        return {
            bootstrapSource: this.bootstrapSource,
            currentVersion: this.currentVersion,
            documentCount: this.collectProjectDocuments().length,
            isDirty: this.isDirty,
            outputBuildId: this.outputBuildId,
            readonlyMode: this.readonlyMode,
            remoteWatchRegistered: this.remoteWatchRegistered,
            rootLoaded: Boolean(this.root),
            scmCollection: this.scmCollectionItem?.collection.getDiagnosticsState(),
        };
    }

    private collectNetworkDiagnosticsState() {
        return {
            ...this.socket.getDiagnosticsState(),
            publicId: this.publicId ?? '',
        };
    }

    private collectOfflineDiagnosticsState() {
        const queuedOperationKinds = this.deferredSynchronizationQueue.operations
            .map((operation) => operation.kind);
        return {
            deferredOperationCount: queuedOperationKinds.length,
            deferredOperationKinds: Array.from(new Set(queuedOperationKinds)).sort(),
            deferredOperationSummary: this.summarizeDeferredOperationCountsByKind(),
            deferredRetryScheduled: Boolean(this.deferredSynchronizationRetryTimer),
            isOfflineMode: this.isOfflineMode,
            mode: this.deferredSynchronizationMode,
            offlineStatePersistScheduled: Boolean(this.offlineStatePersistTimer),
            queuedChatRetryScheduled: Boolean(this.queuedChatSynchronizationRetryTimer),
        };
    }

    private summarizeDeferredOperationCountsByKind(
        operations: readonly DeferredSyncOperation[] = this.deferredSynchronizationQueue.operations,
    ) {
        const counts = new Map<string, number>();
        operations.forEach((operation) => {
            counts.set(operation.kind, (counts.get(operation.kind) ?? 0) + 1);
        });
        return Object.fromEntries(
            Array.from(counts.entries())
                .sort(([left], [right]) => left.localeCompare(right)),
        );
    }

    private summarizeDiagnosticValueCounts(values: string[]) {
        const counts = new Map<string, number>();
        values.forEach((value) => {
            counts.set(value, (counts.get(value) ?? 0) + 1);
        });
        return Object.fromEntries(
            Array.from(counts.entries())
                .sort(([left], [right]) => left.localeCompare(right)),
        );
    }

    private summarizeDocumentSyncJournalState(state: PersistedDocumentSyncState) {
        const records = Object.values(state.records);
        return {
            conflictCount: records.filter((record) => record.conflict !== undefined).length,
            dirtyRecordCount: records.filter((record) => record.localDirty).length,
            recordCount: records.length,
            sample: records
                .sort((left, right) => left.relPath.localeCompare(right.relPath))
                .slice(0, 20)
                .map((record) => ({
                    conflictReason: record.conflict?.reason ?? '',
                    docId: record.docId ?? '',
                    localDirty: record.localDirty,
                    relPath: record.relPath,
                })),
        };
    }

    private shouldIncludeStateScopeInProjectDiagnostics(scope: string) {
        const projectScopeSuffix = `${this.serverName}/${this.projectId}`;
        return scope==='extension'
            || scope==='eventBus'
            || scope==='documentSessions'
            || scope==='compileManager'
            || scope==='filesystem:provider'
            || scope==='commentsDebug'
            || scope==='inlineComments'
            || scope.endsWith(`:${projectScopeSuffix}`);
    }

    private isDiagnosticRecordForCurrentProject(record: Record<string, unknown>) {
        return (record.projectId===this.projectId && record.serverName===this.serverName)
            || record.origin===this.origin.toString()
            || (record.projectName===this.projectName && record.serverName===this.serverName);
    }

    async collectProjectDiagnosticsSnapshot(options: {recentLimit?: number} = {}) {
        const snapshot = collectDiagnosticSnapshot({
            recentLimit: options.recentLimit ?? 400,
        });
        const [offlineStorage, documentSyncJournalState] = await Promise.all([
            this.offlineStore.describeStorage().catch((error) => ({
                errorMessage: error instanceof Error ? error.message : String(error),
                resolved: false,
            })),
            this.documentSyncJournal.loadState().catch((error) => ({
                errorMessage: error instanceof Error ? error.message : String(error),
                loadFailed: true,
            })),
        ]);

        const projectScopedState = Object.fromEntries(
            Object.entries(snapshot.state)
                .filter(([scope]) => this.shouldIncludeStateScopeInProjectDiagnostics(scope))
                .sort(([left], [right]) => left.localeCompare(right)),
        );
        const projectRecords = snapshot.recentRecords
            .filter((record) => this.isDiagnosticRecordForCurrentProject(record as Record<string, unknown>));

        return {
            documentSyncJournal: 'records' in documentSyncJournalState
                ? this.summarizeDocumentSyncJournalState(documentSyncJournalState)
                : documentSyncJournalState,
            eventBus: EventBus.getDiagnosticsState(),
            generatedAt: new Date().toISOString(),
            offlineStorage,
            project: {
                bootstrapSource: this.bootstrapSource,
                connectionPhase: this.connectionPhase,
                origin: this.origin.toString(),
                projectId: this.projectId,
                projectName: this.projectName,
                serverName: this.serverName,
                syncMode: this.deferredSynchronizationMode,
                userId: this.userId,
            },
            recentRecordSummary: {
                countByCategory: this.summarizeDiagnosticValueCounts(
                    projectRecords
                        .map((record) => typeof record.category === 'string' ? record.category : 'unknown'),
                ),
                countByLevel: this.summarizeDiagnosticValueCounts(
                    projectRecords
                        .map((record) => typeof record.level === 'string' ? record.level : 'unknown'),
                ),
                countByScope: this.summarizeDiagnosticValueCounts(
                    projectRecords
                        .map((record) => typeof record.scope === 'string' ? record.scope : 'unknown'),
                ),
                recordCount: projectRecords.length,
            },
            recentRecords: projectRecords,
            runtimeConfiguration: snapshot.runtimeConfiguration,
            state: projectScopedState,
        };
    }

    get realtimeConnectionPhase() {
        return this.connectionPhase;
    }

    get synchronizationMode() {
        return this.deferredSynchronizationMode;
    }

    get chatQueueLength() {
        return this.chatSession.queueLength;
    }

    get isOfflineMode() {
        return this.deferredSynchronizationMode==='offline';
    }

    // Overleaf chat uses an app-level client identifier that stays stable across
    // socket reconnects, so keep a dedicated UUID instead of reusing the socket
    // public id.
    private get activeChatClientId() {
        return this.chatClientId;
    }

    private get canFetchChatHistory() {
        return !this.isOfflineMode && canFetchRemoteChatHistory({
            activeChatClientId: this.activeChatClientId,
            bootstrapSource: this.bootstrapSource,
        });
    }

    private get canSendLiveChatMessages() {
        return !this.isOfflineMode && canSendLiveChatMessages({
            activeChatClientId: this.activeChatClientId,
            bootstrapSource: this.bootstrapSource,
        });
    }

    private isRecoveryInProgress() {
        return this.connectionPhase==='initializing'
            || this.connectionPhase==='recovering'
            || this.deferredSynchronizationMode==='sync-recovery';
    }

    private isRecoveryReady() {
        return !this.isOfflineMode
            && !this.initializing
            && !this.deferredSynchronizationRecovery
            && !this.isRecoveryInProgress();
    }

    private async waitForRecoveryStateTransition(timeoutMs: number) {
        if (timeoutMs <= 0) {
            return;
        }
        const origin = this.origin.toString();
        await new Promise<void>((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, timeoutMs);
            const cleanup = () => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                realtimeDisposable.dispose();
                offlineDisposable.dispose();
            };
            const realtimeDisposable = EventBus.on('realtimeConnectionStateChangedEvent', (arg) => {
                if (arg.origin!==origin) {
                    return;
                }
                cleanup();
                resolve();
            });
            const offlineDisposable = EventBus.on('offlineSynchronizationStateChangedEvent', (arg) => {
                if (arg.origin!==origin) {
                    return;
                }
                cleanup();
                resolve();
            });
        });
    }

    public async waitForRecoveryReady(reason: string, timeoutMs = 15000) {
        if (this.isRecoveryReady()) {
            return;
        }
        const deadline = Date.now() + timeoutMs;
        this.logDiagnostic('recovery.barrier_wait_started', {
            reason,
            timeoutMs,
        });
        while (!this.isRecoveryReady()) {
            if (this.initializing) {
                try {
                    await this.initializing;
                } catch (error) {
                    if (!isLikelyConnectivityFailure(error)) {
                        throw error;
                    }
                }
                continue;
            }
            if (this.deferredSynchronizationRecovery) {
                try {
                    await this.deferredSynchronizationRecovery;
                } catch (error) {
                    if (!isLikelyConnectivityFailure(error)) {
                        throw error;
                    }
                }
                continue;
            }
            if (this.isOfflineMode && !this.recoveryTimer) {
                this.scheduleRecovery(this.pendingRecoveryReason ?? 'socket_disconnect');
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                this.logDiagnostic('recovery.barrier_wait_timed_out', {
                    reason,
                    timeoutMs,
                });
                throw vscode.FileSystemError.Unavailable(
                    vscode.l10n.t('Overleaf is still reconnecting. Please wait a moment and try again.'),
                );
            }
            await this.waitForRecoveryStateTransition(Math.min(remainingMs, 1000));
        }
        this.logDiagnostic('recovery.online_ready', {
            reason,
        });
    }

    get cachedChatMessages() {
        return this.chatSession.cachedMessages;
    }

    get hasLoadedChatHistory() {
        return this.chatSession.hasLoadedHistory;
    }

    getChatMessageDelivery(messageId: string): ChatMessageDelivery {
        return this.chatSession.getMessageDelivery(messageId);
    }

    get hasDeferredSynchronizationOperations() {
        return hasDeferredSyncOperations(this.deferredSynchronizationQueue);
    }

    get hasQueuedChatSynchronizationOperations() {
        return this.chatSession.hasQueuedOperations;
    }

    get hasDeferredLocalReplicaOperations() {
        return this.deferredSynchronizationQueue.operations.some((operation) => operation.kind==='file.localReplicaChange');
    }

    private get hasDeferredCommentSynchronizationOperations() {
        return this.deferredSynchronizationQueue.operations.some((operation) => operation.kind.startsWith('comment.'));
    }

    private get hasDeferredRecoverableNonChatOperations() {
        return hasDeferredSyncOperationsExcludingKinds(this.deferredSynchronizationQueue, [
            'chat.send',
            'chat.edit',
            'chat.delete',
            'file.localReplicaChange',
        ]);
    }

    private clearPendingDisconnectNotification(reason: string) {
        if (!this.pendingDisconnectNotificationTimer) {
            return;
        }
        clearTimeout(this.pendingDisconnectNotificationTimer);
        this.pendingDisconnectNotificationTimer = undefined;
        this.logDiagnostic('sync_notification.disconnect_cancelled', {
            reason,
        });
    }

    private buildSyncNotificationMessage(kind: SyncNotificationKind) {
        switch (kind) {
            case 'connected':
                return vscode.l10n.t('Connected to Overleaf: {projectName}', {
                    projectName: this.projectName,
                });
            case 'reconnected':
                return vscode.l10n.t('Reconnected to Overleaf: {projectName}', {
                    projectName: this.projectName,
                });
            case 'disconnected':
                if (this.connectionPhase==='fallback') {
                    return vscode.l10n.t(
                        'Opened "{projectName}" in fallback read-only mode because the Overleaf real-time connection failed.',
                        {projectName: this.projectName},
                    );
                }
                return vscode.l10n.t('Disconnected from Overleaf: {projectName}. Reconnecting...', {
                    projectName: this.projectName,
                });
        }
    }

    private showSyncNotification(kind: SyncNotificationKind, reason: string) {
        const currentTimeMs = Date.now();
        if (shouldSuppressSyncNotification({
            currentTimeMs,
            kind,
            lastNotification: this.lastSyncNotification,
        })) {
            this.logDiagnostic('sync_notification.suppressed', {
                kind,
                reason,
            });
            return;
        }
        this.lastSyncNotification = {
            at: currentTimeMs,
            kind,
        };
        const message = this.buildSyncNotificationMessage(kind);
        if (!shouldSurfaceSyncNotification({
            connectionPhase: this.connectionPhase,
            kind,
        })) {
            this.logDiagnostic('sync_notification.ui_suppressed', {
                kind,
                phase: this.connectionPhase,
                reason,
                syncMode: this.deferredSynchronizationMode,
            });
            return;
        }
        this.logDiagnostic('sync_notification.shown', {
            kind,
            phase: this.connectionPhase,
            reason,
            syncMode: this.deferredSynchronizationMode,
        });
        if (kind==='disconnected') {
            void vscode.window.showWarningMessage(message);
            return;
        }
        void vscode.window.showInformationMessage(message);
    }

    private reportBackgroundSyncFailure(message: string, reason: string, fields: Record<string, unknown> = {}) {
        const suppressed = shouldSuppressBackgroundSyncFailureNotification({
            connectionPhase: this.connectionPhase,
            synchronizationMode: this.deferredSynchronizationMode,
        });
        this.logDiagnostic(suppressed
            ? 'background_sync.notification_suppressed'
            : 'background_sync.notification_shown', {
            ...fields,
            message,
            reason,
        });
        if (suppressed) {
            return;
        }
        void vscode.window.showErrorMessage(message);
    }

    /**
     * User-facing sync notifications are derived from coarse lifecycle changes
     * only. Routine file sync stays in diagnostics/status UI, while disconnects
     * are grace-delayed to avoid spam during fast reconnect handshakes.
     */
    private refreshSyncNotificationState(reason: string) {
        if (!this.root) {
            return;
        }
        const nextState = resolveSyncNotificationState({
            connectionPhase: this.connectionPhase,
            synchronizationMode: this.deferredSynchronizationMode,
        });
        const previousState = this.syncNotificationState;
        if (previousState===nextState) {
            return;
        }
        this.syncNotificationState = nextState;
        this.logDiagnostic('sync_notification.state_changed', {
            nextState,
            previousState,
            reason,
        });

        if (nextState==='connected') {
            this.clearPendingDisconnectNotification(`${reason}_connected`);
            const kind = resolveConnectedSyncNotificationKind({
                hasShownConnectedNotification: this.hasShownConnectedNotification,
                hasShownDisconnectNotification: this.hasShownDisconnectNotification,
            });
            if (kind) {
                this.showSyncNotification(kind, reason);
            }
            this.hasShownConnectedNotification = true;
            this.hasShownDisconnectNotification = false;
            return;
        }

        if (shouldScheduleDisconnectNotification({
            nextState,
            previousState,
        })) {
            if (this.pendingDisconnectNotificationTimer || this.hasShownDisconnectNotification) {
                return;
            }
            this.logDiagnostic('sync_notification.disconnect_scheduled', {
                delayMs: SYNC_DISCONNECT_NOTIFICATION_GRACE_MS,
                reason,
            });
            this.pendingDisconnectNotificationTimer = setTimeout(() => {
                this.pendingDisconnectNotificationTimer = undefined;
                if (this.syncNotificationState==='connected' || this.syncNotificationState==='idle' || this.hasShownDisconnectNotification) {
                    return;
                }
                this.hasShownDisconnectNotification = true;
                this.showSyncNotification('disconnected', reason);
            }, SYNC_DISCONNECT_NOTIFICATION_GRACE_MS);
        }
    }

    private setDeferredSynchronizationMode(
        mode: DeferredSynchronizationMode,
        reason: string,
        fields: Record<string, unknown> = {},
    ) {
        if (mode==='online' && this.deferredSynchronizationRetryTimer) {
            clearTimeout(this.deferredSynchronizationRetryTimer);
            this.deferredSynchronizationRetryTimer = undefined;
            this.deferredSynchronizationRetryDeadline = undefined;
        }
        if (mode==='online' && !this.hasQueuedChatSynchronizationOperations) {
            this.chatRateLimitRetryAttempt = 0;
            if (this.queuedChatSynchronizationRetryTimer) {
                clearTimeout(this.queuedChatSynchronizationRetryTimer);
                this.queuedChatSynchronizationRetryTimer = undefined;
                this.queuedChatSynchronizationRetryDeadline = undefined;
            }
        }
        if (this.deferredSynchronizationMode===mode) {
            return;
        }
        this.deferredSynchronizationMode = mode;
        this.logDiagnostic('sync_mode.changed', {
            hasPendingOperations: this.deferredSynchronizationQueue.operations.length,
            mode,
            reason,
            ...fields,
        });
        EventBus.fire('offlineSynchronizationStateChangedEvent', {
            hasPendingOperations: this.deferredSynchronizationQueue.operations.length > 0,
            mode,
            origin: this.origin.toString(),
            projectId: this.projectId,
            reason,
            serverName: this.serverName,
        });
        this.refreshSyncNotificationState(reason);
    }

    private scheduleDeferredSynchronizationRetry(reason: string, delayMs = 60_000) {
        if (this.isOfflineMode || !this.hasDeferredSynchronizationOperations) {
            return;
        }
        const nextDeadline = Date.now() + delayMs;
        if (this.deferredSynchronizationRetryTimer) {
            if ((this.deferredSynchronizationRetryDeadline ?? Number.POSITIVE_INFINITY) <= nextDeadline) {
                return;
            }
            clearTimeout(this.deferredSynchronizationRetryTimer);
            this.deferredSynchronizationRetryTimer = undefined;
            this.deferredSynchronizationRetryDeadline = undefined;
        }
        this.logDiagnostic('sync_recovery.retry_scheduled', {
            delayMs,
            reason,
        });
        this.deferredSynchronizationRetryDeadline = nextDeadline;
        this.deferredSynchronizationRetryTimer = setTimeout(() => {
            this.deferredSynchronizationRetryTimer = undefined;
            this.deferredSynchronizationRetryDeadline = undefined;
            void this.resumeDeferredSynchronizationRecovery(reason);
        }, delayMs);
    }

    private scheduleQueuedChatSynchronizationRetry(reason: string, delayMs: number) {
        if (!this.canSendLiveChatMessages || !this.hasQueuedChatSynchronizationOperations) {
            return;
        }
        const nextDeadline = Date.now() + delayMs;
        if (this.queuedChatSynchronizationRetryTimer) {
            if ((this.queuedChatSynchronizationRetryDeadline ?? Number.POSITIVE_INFINITY) <= nextDeadline) {
                return;
            }
            clearTimeout(this.queuedChatSynchronizationRetryTimer);
            this.queuedChatSynchronizationRetryTimer = undefined;
            this.queuedChatSynchronizationRetryDeadline = undefined;
        }
        this.logDiagnostic('chat.queued_sync_retry_scheduled', {
            delayMs,
            reason,
        });
        this.queuedChatSynchronizationRetryDeadline = nextDeadline;
        this.queuedChatSynchronizationRetryTimer = setTimeout(() => {
            this.queuedChatSynchronizationRetryTimer = undefined;
            this.queuedChatSynchronizationRetryDeadline = undefined;
            void this.resumeQueuedChatSynchronizationRecovery(reason);
        }, delayMs);
    }

    private scheduleChatRateLimitRetry(reason: string) {
        this.chatRateLimitRetryAttempt += 1;
        const delayMs = calculateChatRateLimitRetryDelayMs(this.chatRateLimitRetryAttempt);
        this.logDiagnostic('chat.rate_limit_retry_scheduled', {
            attempt: this.chatRateLimitRetryAttempt,
            delayMs,
            reason,
        });
        this.scheduleQueuedChatSynchronizationRetry(reason, delayMs);
    }

    private async sendChatMessageWithInlineRateLimitRetries(
        publicId: string,
        content: string,
        reason: string,
    ) {
        let attempt = 0;
        while (true) {
            const result = await this.sendChatMessageToServer(publicId, content);
            if (result.ok || result.code!=='rate-limited') {
                return result;
            }
            attempt += 1;
            const retryDelayMs = getChatRateLimitInlineRetryDelayMs(attempt);
            if (retryDelayMs===undefined) {
                return result;
            }
            this.logDiagnostic('chat.inline_rate_limit_retry_scheduled', {
                attempt,
                delayMs: retryDelayMs,
                reason,
            });
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
    }

    private get commentPermissions(): OverleafCommentPermissions {
        return resolveCommentPermissions(
            this.readonlyMode ? 'readOnly' : this.permissionsLevel ?? 'readAndWrite',
            { fallbackReadonly: this.readonlyMode || this.connectionPhase==='fallback' },
        );
    }

    private buildOfflineProjectState(): PersistedOfflineProjectState | undefined {
        if (!this.root) {
            return undefined;
        }
        const chatState = this.chatSession.exportState();
        return {
            bootstrapSource: this.bootstrapSource,
            chatHistoryComplete: chatState.historyComplete,
            chatMessages: chatState.messages,
            commentRangesByDocId: Object.fromEntries(
                [...this.commentRangesByDocId.entries()]
                    .map(([docId, ranges]) => [docId, ranges.map(cloneCommentRange)]),
            ),
            commentThreads: Object.fromEntries(
                [...this.commentThreads.entries()]
                    .map(([threadId, thread]) => [threadId, normalizeCommentThread(thread)]),
            ),
            currentVersion: this.currentVersion,
            outputBuildId: this.outputBuildId,
            permissionsLevel: this.permissionsLevel,
            project: this.root,
            readonlyMode: this.readonlyMode,
            savedAt: new Date().toISOString(),
            version: 1,
        };
    }

    private scheduleOfflineProjectStatePersist(reason: string) {
        if (this.offlineStatePersistTimer) {
            clearTimeout(this.offlineStatePersistTimer);
        }
        this.offlineStatePersistTimer = setTimeout(() => {
            this.offlineStatePersistTimer = undefined;
            const state = this.buildOfflineProjectState();
            if (!state) {
                return;
            }
            this.offlineStatePersistPromise = this.offlineStore.saveProjectState(state)
                .then(() => {
                    this.logDiagnostic('offline.state_persisted', {
                        chatMessageCount: this.chatMessages.length,
                        commentDocCount: this.commentRangesByDocId.size,
                        reason,
                        threadCount: this.commentThreads.size,
                    });
                })
                .catch((error) => {
                    this.logDiagnostic('offline.state_persist_failed', {reason}, error);
                });
        }, 100);
    }

    private async flushOfflineProjectStatePersist() {
        if (this.offlineStatePersistTimer) {
            clearTimeout(this.offlineStatePersistTimer);
            this.offlineStatePersistTimer = undefined;
            const state = this.buildOfflineProjectState();
            if (state) {
                await this.offlineStore.saveProjectState(state)
                    .catch((error) => {
                        this.logDiagnostic('offline.state_flush_failed', {}, error);
                    });
            }
        }
        await this.offlineStatePersistPromise;
    }

    private async loadDeferredSynchronizationQueue() {
        this.deferredSynchronizationQueue = await this.offlineStore.loadOperationQueue();
        this.logDiagnostic('offline.queue_loaded', {
            operationCount: this.deferredSynchronizationQueue.operations.length,
        });
    }

    private async restorePersistedChatStateForInitialization() {
        const snapshot = await this.offlineStore.loadProjectState();
        if (!snapshot || (!snapshot.chatHistoryComplete && snapshot.chatMessages.length===0)) {
            return;
        }
        this.chatSession.restoreState({
            historyComplete: snapshot.chatHistoryComplete,
            messages: snapshot.chatMessages,
            savedAt: snapshot.savedAt,
        }, 'initialization_cached_chat_state_restored');
    }

    private async persistDeferredSynchronizationQueue(reason: string) {
        await this.offlineStore.saveOperationQueue(this.deferredSynchronizationQueue);
        this.logDiagnostic('offline.queue_persisted', {
            operationCount: this.deferredSynchronizationQueue.operations.length,
            reason,
        });
        EventBus.fire('offlineSynchronizationStateChangedEvent', {
            hasPendingOperations: this.deferredSynchronizationQueue.operations.length > 0,
            mode: this.deferredSynchronizationMode,
            origin: this.origin.toString(),
            projectId: this.projectId,
            reason,
            serverName: this.serverName,
        });
    }

    private async appendDeferredSynchronizationOperation(operation: DeferredSyncOperation, reason: string) {
        this.deferredSynchronizationQueue = appendDeferredSyncOperation(this.deferredSynchronizationQueue, operation);
        await this.persistDeferredSynchronizationQueue(reason);
    }

    private async removeDeferredSynchronizationOperation(operationId: string, reason: string) {
        this.deferredSynchronizationQueue = removeDeferredSyncOperation(this.deferredSynchronizationQueue, operationId);
        await this.persistDeferredSynchronizationQueue(reason);
    }

    private async replaceDeferredSynchronizationOperations(
        reason: string,
        updater: (operations: DeferredSyncOperation[]) => DeferredSyncOperation[],
    ) {
        this.deferredSynchronizationQueue = createDeferredSyncQueueState(
            updater([...this.deferredSynchronizationQueue.operations]),
        );
        await this.persistDeferredSynchronizationQueue(reason);
    }

    private async replaceDeferredSynchronizationMessageId(
        threadId: string,
        previousMessageId: string,
        nextMessageId: string,
        reason: string,
    ) {
        this.deferredSynchronizationQueue = replaceDeferredSyncMessageId(
            this.deferredSynchronizationQueue,
            threadId,
            previousMessageId,
            nextMessageId,
        );
        await this.persistDeferredSynchronizationQueue(reason);
    }

    private async foldPendingCommentEditIntoDeferredMessageOperation(
        threadId: string,
        messageId: string,
        content: string,
        reason: string,
    ) {
        if (!this.isLocalPendingCommentMessageId(messageId)) {
            return false;
        }
        const folded = foldPendingCommentMessageContentIntoDeferredOperations(
            this.deferredSynchronizationQueue,
            threadId,
            messageId,
            content,
        );
        if (!folded.merged) {
            return false;
        }
        this.deferredSynchronizationQueue = folded.state;
        await this.persistDeferredSynchronizationQueue(reason);
        this.logDiagnostic('comments.pending_message_edit_folded_into_deferred_message_operation', {
            contentLength: content.length,
            messageId,
            operationCount: this.deferredSynchronizationQueue.operations.length,
            threadId,
        });
        return true;
    }

    private async replaceDeferredSynchronizationThreadId(
        previousThreadId: string,
        nextThreadId: string,
        reason: string,
    ) {
        const canonicalNextThreadId = this.resolveCanonicalCommentThreadId(nextThreadId);
        if (previousThreadId===canonicalNextThreadId) {
            return;
        }
        await this.replaceDeferredSynchronizationOperations(reason, (operations) => {
            return operations.map<DeferredSyncOperation>((operation) => {
                if (operation.kind==='comment.create' || operation.kind==='comment.anchorExistingThread') {
                    if (operation.payload.threadId!==previousThreadId) {
                        return operation;
                    }
                    return {
                        ...operation,
                        payload: {
                            ...operation.payload,
                            threadId: canonicalNextThreadId,
                        },
                    };
                }
                if (operation.kind==='comment.reply') {
                    if (operation.payload.threadId!==previousThreadId) {
                        return operation;
                    }
                    return {
                        ...operation,
                        payload: {
                            ...operation.payload,
                            threadId: canonicalNextThreadId,
                        },
                    };
                }
                if (operation.kind==='comment.edit') {
                    if (operation.payload.threadId!==previousThreadId) {
                        return operation;
                    }
                    return {
                        ...operation,
                        payload: {
                            ...operation.payload,
                            threadId: canonicalNextThreadId,
                        },
                    };
                }
                if (operation.kind==='comment.deleteMessage') {
                    if (operation.payload.threadId!==previousThreadId) {
                        return operation;
                    }
                    return {
                        ...operation,
                        payload: {
                            ...operation.payload,
                            threadId: canonicalNextThreadId,
                        },
                    };
                }
                if (operation.kind==='comment.deleteThread') {
                    if (operation.payload.threadId!==previousThreadId) {
                        return operation;
                    }
                    return {
                        ...operation,
                        payload: {
                            ...operation.payload,
                            threadId: canonicalNextThreadId,
                        },
                    };
                }
                if (operation.kind==='comment.resolveThread') {
                    if (operation.payload.threadId!==previousThreadId) {
                        return operation;
                    }
                    return {
                        ...operation,
                        payload: {
                            ...operation.payload,
                            threadId: canonicalNextThreadId,
                        },
                    };
                }
                return operation;
            });
        });
    }

    private getDeferredCommentCreateOperations(docId?: string) {
        return this.deferredSynchronizationQueue.operations.filter((operation): operation is Extract<DeferredSyncOperation, {kind: 'comment.create' | 'comment.anchorExistingThread'}> => {
            return (operation.kind==='comment.create' || operation.kind==='comment.anchorExistingThread')
                && (docId===undefined || operation.payload.docId===docId);
        });
    }

    private hasDeferredCommentCreateOperationForThreadId(threadId: string) {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        return this.getDeferredCommentCreateOperations().some((operation) => {
            return this.resolveCanonicalCommentThreadId(operation.payload.threadId)===canonicalThreadId;
        });
    }

    private mergeHydratedCommentRangesWithPendingCreates(
        docId: string,
        hydratedRanges: OverleafCommentRange[],
    ) {
        const currentRanges = this.getCommentRanges(docId);
        const currentRangesByThreadId = new Map(
            currentRanges.map((range) => [this.resolveCanonicalCommentThreadId(range.op.t), range] as const),
        );
        const preservedThreadIds = new Set<string>();
        const preservedRanges = this.getDeferredCommentCreateOperations(docId).flatMap((operation) => {
            const canonicalThreadId = this.resolveCanonicalCommentThreadId(operation.payload.threadId);
            if (preservedThreadIds.has(canonicalThreadId)) {
                return [];
            }
            preservedThreadIds.add(canonicalThreadId);
            const existingRange = currentRangesByThreadId.get(canonicalThreadId);
            if (existingRange) {
                return [cloneCommentRange(existingRange)];
            }
            return [{
                id: canonicalThreadId,
                metadata: {
                    ts: operation.createdAt,
                    user_id: this.userId,
                },
                op: {
                    c: operation.payload.selectedText,
                    p: operation.payload.startOffset,
                    t: canonicalThreadId,
                },
                resolved: undefined,
            }];
        });
        if (preservedRanges.length===0) {
            return {
                mergedRanges: hydratedRanges.map(cloneCommentRange),
                preservedThreadIds: [] as string[],
            };
        }
        return {
            mergedRanges: dedupeCommentRangesByThreadId([
                ...preservedRanges,
                ...hydratedRanges.map(cloneCommentRange),
            ]),
            preservedThreadIds: Array.from(preservedThreadIds).sort((left, right) => left.localeCompare(right)),
        };
    }

    private resolveCurrentProjectMember() {
        if (!this.root) {
            return undefined;
        }
        const allMembers = [
            this.root.owner,
            ...this.root.members,
            ...this.root.invites,
        ].filter(Boolean);
        return allMembers.find((member) => member._id===this.userId);
    }

    private buildOfflineCommentAuthor() {
        const member = this.resolveCurrentProjectMember();
        return {
            email: member?.email,
            first_name: member?.first_name,
            id: this.userId,
            last_name: member?.last_name,
            name: [member?.first_name, member?.last_name].filter(Boolean).join(' ') || member?.email || this.userId,
        };
    }

    private buildOfflineChatUser() {
        const member = this.resolveCurrentProjectMember();
        return {
            email: member?.email ?? '',
            first_name: member?.first_name ?? member?.email ?? this.userId,
            id: this.userId,
            last_name: member?.last_name,
        };
    }

    private buildOfflineCommentMessage(
        content: string,
        messageId = `offline-comment-${uuidv4()}`,
        timestamp = new Date().toISOString(),
    ): OverleafCommentMessage {
        return {
            content,
            id: messageId,
            timestamp,
            user: this.buildOfflineCommentAuthor(),
            user_id: this.userId,
        };
    }

    private isLocalPendingCommentMessageId(messageId: string | undefined) {
        if (!messageId) {
            return false;
        }
        return messageId.startsWith('pending-comment-') || messageId.startsWith('offline-comment-');
    }

    private canMutateLocalPendingCommentMessage(message: OverleafCommentMessage) {
        return Boolean(
            this.commentPermissions.comment
            && this.isLocalPendingCommentMessageId(message.id),
        );
    }

    private buildOfflineChatMessage(content: string, messageId = `offline-chat-${uuidv4()}`): ProjectMessageResponseSchema {
        return buildOptimisticChatMessage({
            clientId: this.activeChatClientId ?? 'offline',
            content,
            id: messageId,
            user: this.buildOfflineChatUser(),
            userId: this.userId,
        });
    }

    private buildPendingLiveChatMessage(content: string, publicId: string, messageId = `pending-chat-${uuidv4()}`) {
        return buildOptimisticChatMessage({
            clientId: publicId,
            content,
            id: messageId,
            user: this.buildOfflineChatUser(),
            userId: this.userId,
        });
    }

    private getPendingLocalChatMessages() {
        return this.chatMessages.filter((message) => {
            return this.getChatMessageDelivery(message.id).state==='pending' || isTemporaryChatMessageId(message.id);
        });
    }

    private hasChatMessage(messageId: string) {
        return this.chatMessages.some((message) => message.id===messageId);
    }

    private pruneAwaitingRealtimeChatConfirmations(reason: string) {
        if (this.awaitingRealtimeChatConfirmationMessageIds.size===0) {
            return;
        }

        const activeMessageIds = new Set(this.chatMessages.map((message) => message.id));
        let removedCount = 0;
        for (const messageId of [...this.awaitingRealtimeChatConfirmationMessageIds]) {
            if (activeMessageIds.has(messageId)) {
                continue;
            }
            this.awaitingRealtimeChatConfirmationMessageIds.delete(messageId);
            removedCount += 1;
        }

        if (removedCount > 0) {
            this.logDiagnostic('chat.realtime_confirmation_wait_pruned', {
                pendingConfirmationCount: this.awaitingRealtimeChatConfirmationMessageIds.size,
                prunedCount: removedCount,
                reason,
            });
        }

        if (this.awaitingRealtimeChatConfirmationMessageIds.size===0) {
            this.chatRealtimeConfirmationRefreshAttempt = 0;
            if (this.chatRealtimeConfirmationRefreshTimer) {
                clearTimeout(this.chatRealtimeConfirmationRefreshTimer);
                this.chatRealtimeConfirmationRefreshTimer = undefined;
                this.chatRealtimeConfirmationRefreshDeadline = undefined;
            }
        }
    }

    private scheduleRealtimeChatConfirmationRefresh(reason: string) {
        this.pruneAwaitingRealtimeChatConfirmations(`${reason}_preflight`);
        if (!this.canFetchChatHistory || this.awaitingRealtimeChatConfirmationMessageIds.size===0) {
            return;
        }

        const attempt = this.chatRealtimeConfirmationRefreshAttempt + 1;
        const delayMs = calculateChatRealtimeConfirmationRefreshDelayMs(attempt);
        const nextDeadline = Date.now() + delayMs;
        if (this.chatRealtimeConfirmationRefreshTimer) {
            if ((this.chatRealtimeConfirmationRefreshDeadline ?? Number.POSITIVE_INFINITY) <= nextDeadline) {
                return;
            }
            clearTimeout(this.chatRealtimeConfirmationRefreshTimer);
            this.chatRealtimeConfirmationRefreshTimer = undefined;
            this.chatRealtimeConfirmationRefreshDeadline = undefined;
        }

        this.logDiagnostic('chat.realtime_confirmation_refresh_scheduled', {
            attempt,
            delayMs,
            pendingConfirmationCount: this.awaitingRealtimeChatConfirmationMessageIds.size,
            reason,
        });
        this.chatRealtimeConfirmationRefreshDeadline = nextDeadline;
        this.chatRealtimeConfirmationRefreshTimer = setTimeout(() => {
            this.chatRealtimeConfirmationRefreshTimer = undefined;
            this.chatRealtimeConfirmationRefreshDeadline = undefined;
            void this.refreshAwaitingRealtimeChatConfirmations(reason);
        }, delayMs);
    }

    private noteAwaitingRealtimeChatConfirmation(messageId: string, reason: string) {
        if (!this.hasChatMessage(messageId)) {
            return;
        }
        const previousSize = this.awaitingRealtimeChatConfirmationMessageIds.size;
        this.awaitingRealtimeChatConfirmationMessageIds.add(messageId);
        if (this.awaitingRealtimeChatConfirmationMessageIds.size!==previousSize) {
            this.logDiagnostic('chat.realtime_confirmation_wait_started', {
                messageId,
                pendingConfirmationCount: this.awaitingRealtimeChatConfirmationMessageIds.size,
                reason,
            });
        }
        this.scheduleRealtimeChatConfirmationRefresh(reason);
    }

    private async refreshAwaitingRealtimeChatConfirmations(reason: string) {
        this.pruneAwaitingRealtimeChatConfirmations(`${reason}_started`);
        if (!this.canFetchChatHistory || this.awaitingRealtimeChatConfirmationMessageIds.size===0) {
            return;
        }

        this.chatRealtimeConfirmationRefreshAttempt += 1;
        this.logDiagnostic('chat.realtime_confirmation_refresh_started', {
            attempt: this.chatRealtimeConfirmationRefreshAttempt,
            pendingConfirmationCount: this.awaitingRealtimeChatConfirmationMessageIds.size,
            reason,
        });
        try {
            await this.refreshChatMessagesFromServer(reason);
        } catch (error) {
            if (isLikelyConnectivityFailure(error)) {
                await this.transitionToOfflineMode('chat_realtime_confirmation_refresh_connectivity_failure', error);
                return;
            }
            this.logDiagnostic('chat.realtime_confirmation_refresh_failed', {
                attempt: this.chatRealtimeConfirmationRefreshAttempt,
                pendingConfirmationCount: this.awaitingRealtimeChatConfirmationMessageIds.size,
                reason,
            }, error);
        } finally {
            this.pruneAwaitingRealtimeChatConfirmations(`${reason}_completed`);
            if (this.canFetchChatHistory && this.awaitingRealtimeChatConfirmationMessageIds.size > 0) {
                this.scheduleRealtimeChatConfirmationRefresh(`${reason}_retry`);
            }
        }
    }

    private mergeServerChatMessages(serverMessages: ProjectMessageResponseSchema[]) {
        const pendingLocalMessages = new Map(
            this.getPendingLocalChatMessages().map((message) => [message.id, message] as const),
        );

        serverMessages.forEach((message) => {
            const pendingMessageId = consumeOptimisticChatMessageId(this.pendingOptimisticChatMessages, message);
            if (!pendingMessageId) {
                return;
            }
            pendingLocalMessages.delete(pendingMessageId);
        });

        return [...serverMessages, ...pendingLocalMessages.values()]
            .sort((left, right) => left.timestamp - right.timestamp);
    }

    private applyServerChatMessages(messages: ProjectMessageResponseSchema[], reason: string) {
        // A successful server snapshot means the session now has authoritative
        // chat history. Keep subsequent panel renders cache-driven and let
        // realtime updates maintain freshness instead of re-fetching on every
        // visibility or recovery edge.
        this.chatHistoryLoaded = true;
        this.updateChatMessages(this.mergeServerChatMessages(messages), reason);
    }

    private replaceChatMessage(previousMessageId: string, nextMessage: ProjectMessageResponseSchema, reason: string) {
        const existingIndex = this.chatMessages.findIndex((candidate) => candidate.id===previousMessageId);
        if (existingIndex<0) {
            this.appendChatMessage(nextMessage, `${reason}_missing_local_message`);
            return;
        }
        const nextMessages = this.chatMessages.map((candidate, index) => index===existingIndex ? nextMessage : candidate);
        discardOptimisticChatMessageId(this.pendingOptimisticChatMessages, previousMessageId);
        this.updateChatMessages(nextMessages, reason);
    }

    private removeChatMessage(messageId: string, reason: string) {
        const existingIndex = this.chatMessages.findIndex((candidate) => candidate.id===messageId);
        if (existingIndex<0) {
            return;
        }
        discardOptimisticChatMessageId(this.pendingOptimisticChatMessages, messageId);
        this.updateChatMessages(
            this.chatMessages.filter((candidate) => candidate.id!==messageId),
            reason,
        );
    }

    private async queueChatMessageForDeferredSync(
        content: string,
        reason: string,
        existingLocalMessageId?: string,
    ): Promise<Extract<OverleafChatSendResult, {deliveryState: 'queued', ok: true}>> {
        const message = existingLocalMessageId
            ? this.chatMessages.find((candidate) => candidate.id===existingLocalMessageId) ?? this.buildOfflineChatMessage(content, existingLocalMessageId)
            : this.buildOfflineChatMessage(content);
        if (!existingLocalMessageId) {
            this.appendChatMessage(message, `${reason}_local_message_appended`);
        }
        await this.appendDeferredSynchronizationOperation({
            createdAt: new Date().toISOString(),
            id: `offline-op-${uuidv4()}`,
            kind: 'chat.send',
            payload: {
                content,
                localMessageId: message.id,
            },
        }, `${reason}_queued`);
        return {
            ok: true,
            deliveryState: 'queued',
            mode: 'offline-queued',
            queuedMessageId: message.id,
            transport: 'offline',
        };
    }

    private async getAuthenticatedTransportIdentity(reason: string): Promise<Identity> {
        const persistedIdentity = await GlobalStateManager.authenticate(this.context, this.serverName)
            .catch(() => undefined);
        const liveIdentity = this.socket.currentIdentity;
        const effectiveIdentity = resolvePreferredRealtimeIdentity(liveIdentity, persistedIdentity);
        if (!effectiveIdentity) {
            throw new Error(vscode.l10n.t('Unable to load the Overleaf authentication state.'));
        }

        if (shouldPersistRealtimeIdentity(liveIdentity, persistedIdentity)) {
            await GlobalStateManager.updateServerIdentity(this.context, this.serverName, effectiveIdentity);
            this.logDiagnostic('session.identity_persisted_from_socket', {
                reason,
            });
        }

        this.logDiagnostic('session.identity_resolved', {
            reason,
            source: effectiveIdentity===liveIdentity ? 'socket' : 'persisted',
        });
        return effectiveIdentity;
    }

    private resolveCanonicalCommentThreadId(threadId: string) {
        let canonicalThreadId = threadId;
        const visited = new Set<string>();
        while (!visited.has(canonicalThreadId)) {
            visited.add(canonicalThreadId);
            const nextThreadId = this.commentThreadAliases.get(canonicalThreadId);
            if (!nextThreadId) {
                break;
            }
            canonicalThreadId = nextThreadId;
        }
        if (canonicalThreadId!==threadId) {
            this.commentThreadAliases.set(threadId, canonicalThreadId);
        }
        return canonicalThreadId;
    }

    private getCommentThreadAliasIds(threadId: string) {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        const aliases = new Set<string>([threadId, canonicalThreadId]);
        for (const [aliasThreadId, aliasTargetThreadId] of this.commentThreadAliases.entries()) {
            if (this.resolveCanonicalCommentThreadId(aliasTargetThreadId)===canonicalThreadId) {
                aliases.add(aliasThreadId);
            }
        }
        return aliases;
    }

    private registerCommentThreadAlias(previousThreadId: string, nextThreadId: string, reason: string) {
        const canonicalPreviousThreadId = this.resolveCanonicalCommentThreadId(previousThreadId);
        const canonicalNextThreadId = this.resolveCanonicalCommentThreadId(nextThreadId);
        if (canonicalPreviousThreadId===canonicalNextThreadId) {
            return canonicalNextThreadId;
        }
        const pendingOptimisticMessageIds = [
            ...(this.pendingOptimisticCommentMessages.get(previousThreadId) ?? []),
            ...(this.pendingOptimisticCommentMessages.get(canonicalPreviousThreadId) ?? []),
        ];
        if (pendingOptimisticMessageIds.length > 0) {
            const existingPendingMessageIds = this.pendingOptimisticCommentMessages.get(canonicalNextThreadId) ?? [];
            this.pendingOptimisticCommentMessages.set(
                canonicalNextThreadId,
                Array.from(new Set([
                    ...existingPendingMessageIds,
                    ...pendingOptimisticMessageIds,
                ])),
            );
        }
        this.pendingOptimisticCommentMessages.delete(previousThreadId);
        this.pendingOptimisticCommentMessages.delete(canonicalPreviousThreadId);
        this.commentThreadAliases.set(previousThreadId, canonicalNextThreadId);
        this.commentThreadAliases.set(canonicalPreviousThreadId, canonicalNextThreadId);
        for (const [aliasThreadId, aliasTargetThreadId] of this.commentThreadAliases.entries()) {
            if (aliasTargetThreadId===canonicalPreviousThreadId) {
                this.commentThreadAliases.set(aliasThreadId, canonicalNextThreadId);
            }
        }
        this.recordCommentStateTransition('thread.merged', {
            canonicalNextThreadId,
            canonicalPreviousThreadId,
            reason,
        });
        this.logCommentSyncDiagnostic('comments.thread_alias_registered', {
            canonicalNextThreadId,
            canonicalPreviousThreadId,
            nextThreadId,
            previousThreadId,
            reason,
        });
        return canonicalNextThreadId;
    }

    private getCommentThreadById(threadId: string) {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        return this.commentThreads.get(canonicalThreadId) ?? this.commentThreads.get(threadId);
    }

    private replaceCommentMessageId(threadId: string, previousMessageId: string, nextMessageId: string) {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        const thread = this.getCommentThreadById(canonicalThreadId);
        if (!thread) {
            return;
        }
        const nextThread = normalizeCommentThread({
            ...thread,
            messages: thread.messages.map((message) => message.id===previousMessageId
                ? {...message, id: nextMessageId}
                : message),
        });
        this.commentThreads.set(canonicalThreadId, nextThread);
        if (canonicalThreadId!==threadId) {
            this.commentThreads.delete(threadId);
        }
    }

    private reconcileIncomingCommentThreadIdentityByMessageId(
        incomingThreadId: string,
        messageId: string,
        reason: string,
    ) {
        const canonicalIncomingThreadId = this.resolveCanonicalCommentThreadId(incomingThreadId);
        const matchingThreadIds = findCommentThreadIdsByMessageIdInThreads(this.commentThreads.entries(), messageId)
            .map((threadId) => this.resolveCanonicalCommentThreadId(threadId));
        const previousThreadId = matchingThreadIds.find((threadId) => threadId!==canonicalIncomingThreadId);
        if (!previousThreadId) {
            return canonicalIncomingThreadId;
        }
        const previousThread = this.getCommentThreadById(previousThreadId);
        const canonicalServerThreadId = this.registerCommentThreadAlias(
            previousThreadId,
            canonicalIncomingThreadId,
            reason,
        );
        if (previousThread && !this.commentThreads.has(canonicalServerThreadId)) {
            this.commentThreads.set(canonicalServerThreadId, normalizeCommentThread(previousThread));
        }
        this.commentThreads.delete(previousThreadId);
        void this.replaceDeferredSynchronizationThreadId(
            previousThreadId,
            canonicalServerThreadId,
            `${reason}_queue`,
        );
        this.logDiagnostic('comments.realtime_thread_id_reconciled_from_message', {
            incomingThreadId,
            messageId,
            previousThreadId,
            serverThreadId: canonicalServerThreadId,
        });
        return canonicalServerThreadId;
    }

    private reconcileOptimisticCommentMessage(threadId: string, incomingMessage: OverleafCommentMessage) {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        const pendingMessageId = consumeOptimisticCommentMessageId(this.pendingOptimisticCommentMessages, {
            content: incomingMessage.content,
            threadId: canonicalThreadId,
            userId: incomingMessage.user_id,
        });
        if (!pendingMessageId || pendingMessageId===incomingMessage.id) {
            return undefined;
        }
        this.replaceCommentMessageId(canonicalThreadId, pendingMessageId, incomingMessage.id);
        return pendingMessageId;
    }

    private normalizeDeferredLocalReplicaRelPath(relPath: string) {
        if (relPath==='' || relPath==='/') {
            return '/';
        }
        return relPath.startsWith('/') ? relPath : `/${relPath}`;
    }

    private hasQueuedLocalReplicaChangeForRelPath(relPath: string) {
        const normalizedRelPath = this.normalizeDeferredLocalReplicaRelPath(relPath);
        return this.deferredSynchronizationQueue.operations.some((operation) => {
            return operation.kind==='file.localReplicaChange'
                && this.normalizeDeferredLocalReplicaRelPath(operation.payload.relPath)===normalizedRelPath;
        });
    }

    private resolveCommentReplayDocumentSyncRelPath(payload: {
        docId: string,
        filePath?: string,
    }) {
        const projectPath = this.resolveDocumentPathById(payload.docId) ?? payload.filePath;
        return projectPath
            ? this.toDocumentSyncRelPathFromProjectPath(projectPath)
            : undefined;
    }

    private async resolveCommentReplayRenderUri(payload: {
        docId: string,
        filePath?: string,
    }) {
        const projectPath = this.resolveDocumentPathById(payload.docId) ?? payload.filePath;
        if (!projectPath) {
            return undefined;
        }
        return resolveProjectRenderUriForPath(this.origin, projectPath);
    }

    private async shouldDeferQueuedCommentReplayUntilDocumentRecovery(options: {
        docId: string,
        filePath?: string,
        operationId: string,
        remoteText?: string,
        selectedText: string,
        startOffset: number,
    }) {
        const relPath = this.resolveCommentReplayDocumentSyncRelPath({
            docId: options.docId,
            filePath: options.filePath,
        });
        const evaluation = evaluateCommentReplayAgainstQueuedLocalReplica({
            hasQueuedLocalReplicaChangeForPath: relPath
                ? this.hasQueuedLocalReplicaChangeForRelPath(relPath)
                : false,
            remoteText: options.remoteText,
            selectedText: options.selectedText,
            startOffset: options.startOffset,
        });
        const renderUri = await this.resolveCommentReplayRenderUri({
            docId: options.docId,
            filePath: options.filePath,
        });
        const openDocument = renderUri
            ? vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString()===renderUri.toString())
            : undefined;
        const managedDocumentEvaluation = evaluateCommentReplayAgainstManagedDocument({
            localDocumentText: openDocument?.getText(),
            managedDocumentState: renderUri
                ? this.getManagedTextDocumentState(renderUri)
                : undefined,
            remoteText: options.remoteText,
            selectedText: options.selectedText,
            startOffset: options.startOffset,
        });
        this.logCommentSyncDiagnostic('comments.replay_local_replica_gate_evaluated', {
            docId: options.docId,
            hasOpenManagedDocument: managedDocumentEvaluation.hasOpenManagedDocument,
            localDocumentDiffersFromServer: managedDocumentEvaluation.localDocumentDiffersFromServer,
            managedDocumentState: managedDocumentEvaluation.managedDocumentState ?? '',
            operationId: options.operationId,
            relPath: relPath ?? '',
            remoteSelectedTextLength: evaluation.remoteSelectedText.length,
            selectionMatchesLocalDocument: managedDocumentEvaluation.selectionMatchesLocalDocument,
            selectionMatchesServer: evaluation.selectionMatchesServer,
            selectedTextLength: options.selectedText.length,
            shouldDefer: evaluation.shouldDefer || managedDocumentEvaluation.shouldDefer,
        });
        return evaluation.shouldDefer || managedDocumentEvaluation.shouldDefer;
    }

    private resolveDocumentPathById(docId: string) {
        return this._resolveById(docId)?.path.replace(/^\//, '');
    }

    private async refreshChatMessagesFromServer(reason: string) {
        const identity = await this.getAuthenticatedTransportIdentity(`chat_refresh:${reason}`);
        const response = await this.api.getMessages(identity, this.projectId);
        if (response.type!=='success') {
            throw new Error(response.message ?? 'Unable to load Overleaf chat messages');
        }
        this.applyServerChatMessages(response.messages ?? [], reason);
    }

    private shouldRefreshCommentStateAfterConnectionRestore(reason: string) {
        if (this.hasDeferredCommentSynchronizationOperations) {
            return true;
        }
        if (reason==='socket_connection_accepted') {
            return true;
        }
        return reason.startsWith('initialization:')
            && reason!=='initialization:initial';
    }

    private async waitForCommentReconnectDocumentReady(renderUri: vscode.Uri | undefined, reason: string) {
        if (!renderUri) {
            return;
        }
        const deadline = Date.now() + 5_000;
        while (true) {
            const openDocument = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString()===renderUri.toString());
            if (!openDocument) {
                return;
            }
            const managedDocumentState = this.getManagedTextDocumentState(renderUri);
            if (!managedDocumentState || managedDocumentState==='live') {
                return;
            }
            if (Date.now() >= deadline) {
                this.logDiagnostic('comments.connection_checkpoint_document_wait_timed_out', {
                    managedDocumentState,
                    reason,
                    renderUri: renderUri.toString(),
                });
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    private async refreshLoadedCommentRangesFromServer(docId: string, reason: string) {
        const resolvedPath = this.resolveDocumentPathById(docId);
        const renderUri = await this.resolveCommentReplayRenderUri({
            docId,
            filePath: resolvedPath,
        });
        await this.waitForCommentReconnectDocumentReady(renderUri, reason);
        const joinResponse = await this.socket.joinDoc(docId);
        const mergedHydratedRanges = this.mergeHydratedCommentRangesWithPendingCreates(
            docId,
            normalizeCommentRanges(joinResponse.ranges?.comments),
        );
        const previousRanges = this.getCommentRanges(docId);
        if (JSON.stringify(previousRanges)!==JSON.stringify(mergedHydratedRanges.mergedRanges)) {
            this.setCommentRanges(docId, mergedHydratedRanges.mergedRanges, 'comments_connection_checkpoint_doc_ranges_refreshed');
        }
        this.logDiagnostic('comments.connection_checkpoint_doc_ranges_refreshed', {
            docId,
            path: resolvedPath ?? '',
            preservedPendingCommentCreateCount: mergedHydratedRanges.preservedThreadIds.length,
            reason,
            version: joinResponse.version,
        });
    }

    private async refreshCommentStateAfterConnectionRestored(reason: string) {
        if (!this.root
            || this.isOfflineMode
            || this.readonlyMode
            || !this.shouldRefreshCommentStateAfterConnectionRestore(reason)) {
            return;
        }
        if (this.commentReconnectRefreshPromise) {
            return this.commentReconnectRefreshPromise;
        }
        this.commentReconnectRefreshPromise = (async () => {
            const targetDocIds = new Set<string>([
                ...this.commentRangesByDocId.keys(),
                ...this.getDeferredCommentCreateOperations().map((operation) => operation.payload.docId),
            ]);
            if (!this.commentThreadsLoaded && targetDocIds.size===0 && !this.hasDeferredCommentSynchronizationOperations) {
                return;
            }
            await this.ensureCommentThreadsLoaded(true);
            const refreshedDocIds: string[] = [];
            for (const docId of targetDocIds) {
                try {
                    await this.refreshLoadedCommentRangesFromServer(docId, reason);
                    refreshedDocIds.push(docId);
                } catch (error) {
                    this.logDiagnostic('comments.connection_checkpoint_doc_ranges_refresh_failed', {
                        docId,
                        reason,
                    }, error);
                }
            }
            this.emitCommentsChanged('comments_connection_checkpoint_refreshed', {
                docIds: refreshedDocIds,
                threadIds: Array.from(this.commentThreads.keys()),
            });
        })().finally(() => {
            this.commentReconnectRefreshPromise = undefined;
        });
        return this.commentReconnectRefreshPromise;
    }

    private async resolveDeferredSynchronizedCommentMessageId(
        threadId: string,
        localMessageId: string,
        content: string,
    ) {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        await this.ensureCommentThreadsLoaded(true);
        const thread = this.getCommentThreadById(canonicalThreadId);
        const matchedMessage = thread?.messages
            .filter((message) => {
                if (this.isLocalPendingCommentMessageId(message.id)) {
                    return false;
                }
                if (message.content!==content) {
                    return false;
                }
                if (!this.userId) {
                    return true;
                }
                return message.user_id===this.userId;
            })
            .sort((left, right) => new Date(left.timestamp).valueOf() - new Date(right.timestamp).valueOf())
            .at(-1);
        if (!matchedMessage || matchedMessage.id===localMessageId) {
            return undefined;
        }
        this.replaceCommentMessageId(canonicalThreadId, localMessageId, matchedMessage.id);
        await this.replaceDeferredSynchronizationMessageId(
            canonicalThreadId,
            localMessageId,
            matchedMessage.id,
            'sync_recovery_message_id_replaced_from_thread_snapshot',
        );
        return matchedMessage.id;
    }

    private async transitionToOfflineMode(
        reason: string,
        error?: unknown,
        fields: Record<string, unknown> = {},
    ) {
        this.setDeferredSynchronizationMode('offline', reason, fields);
        this.setConnectionPhase('recovering', reason, fields);
        this.retryConnection = Math.max(this.retryConnection, 1);
        this.scheduleOfflineProjectStatePersist(reason);
        this.logDiagnostic('sync_mode.offline_transitioned', {
            failureClass: 'transient',
            reason,
            ...fields,
        }, error);
        this.scheduleRecovery('socket_disconnect');
    }

    public async recordLocalReplicaChange(
        changeType: 'delete' | 'update',
        relPath: string,
        reason = 'local_replica_change_recorded',
    ) {
        const normalizedRelPath = this.normalizeDeferredLocalReplicaRelPath(relPath);
        await this.markDocumentSyncDirty({
            reason,
            relPath: normalizedRelPath,
        });
        const nextOperations = this.deferredSynchronizationQueue.operations.filter((operation) => {
            return operation.kind!=='file.localReplicaChange'
                || operation.payload.relPath!==normalizedRelPath;
        });
        this.deferredSynchronizationQueue = createDeferredSyncQueueState([
            ...nextOperations,
            {
                createdAt: new Date().toISOString(),
                id: `offline-op-${uuidv4()}`,
                kind: 'file.localReplicaChange',
                payload: {
                    changeType,
                    relPath: normalizedRelPath,
                },
            },
        ]);
        await this.persistDeferredSynchronizationQueue(reason);
    }

    public async acknowledgeLocalReplicaSynchronization(
        reason: string,
        relPaths?: string[],
    ) {
        const journalState = await this.getDocumentSyncState();
        const queuedReplicaPaths = this.deferredSynchronizationQueue.operations
            .filter((operation): operation is Extract<DeferredSyncOperation, {kind: 'file.localReplicaChange'}> => operation.kind==='file.localReplicaChange')
            .map((operation) => this.normalizeDeferredLocalReplicaRelPath(operation.payload.relPath));
        const requestedPaths = relPaths===undefined
            ? queuedReplicaPaths
            : relPaths.map((relPath) => this.normalizeDeferredLocalReplicaRelPath(relPath));
        const acknowledgedPaths = requestedPaths.filter((relPath) => {
            const record = journalState.records[relPath];
            if (!record) {
                return true;
            }
            return record.localDirty!==true && record.conflict===undefined;
        });
        const targetPaths = new Set(acknowledgedPaths);
        this.logDiagnostic('local_replica.acknowledge_requested', {
            acknowledgedPaths,
            conflictStatePresent: requestedPaths.some((relPath) => journalState.records[relPath]?.conflict !== undefined),
            dirtyStatePresent: requestedPaths.some((relPath) => journalState.records[relPath]?.localDirty === true),
            queuedPathCount: queuedReplicaPaths.length,
            reason,
            requestedPaths,
        });
        this.deferredSynchronizationQueue = createDeferredSyncQueueState(
            this.deferredSynchronizationQueue.operations.filter((operation) => {
                if (operation.kind!=='file.localReplicaChange') {
                    return true;
                }
                return !targetPaths.has(this.normalizeDeferredLocalReplicaRelPath(operation.payload.relPath));
            }),
        );
        await this.persistDeferredSynchronizationQueue(reason);
        if (!this.hasDeferredSynchronizationOperations) {
            this.setDeferredSynchronizationMode('online', reason, {
                bootstrapSource: this.bootstrapSource,
            });
            return;
        }
        if (!this.hasDeferredRecoverableNonChatOperations && !this.hasDeferredLocalReplicaOperations && this.hasQueuedChatSynchronizationOperations) {
            this.setDeferredSynchronizationMode('online', reason, {
                bootstrapSource: this.bootstrapSource,
                pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
            });
            await this.resumeQueuedChatSynchronizationRecovery(`${reason}_queued_chat`);
            return;
        }
        if (!this.isOfflineMode) {
            await this.resumeDeferredSynchronizationRecovery(reason);
        }
    }

    public async resumeDeferredSynchronizationRecovery(reason: string) {
        const recoverySpan = startDiagnosticSpan('VirtualFileSystem', 'sync_recovery.resume', {
            hasDeferredSynchronizationOperations: this.hasDeferredSynchronizationOperations,
            isOfflineMode: this.isOfflineMode,
            pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
            reason,
        }, {
            category: 'sync',
            level: 'info',
        });
        if (this.isOfflineMode) {
            recoverySpan.end({
                outcome: 'skipped_offline',
            });
            return;
        }
        if (!this.hasDeferredSynchronizationOperations) {
            this.setDeferredSynchronizationMode('online', reason, {
                bootstrapSource: this.bootstrapSource,
            });
            recoverySpan.end({
                outcome: 'queue_empty',
            });
            return;
        }
        if (!this.hasDeferredRecoverableNonChatOperations) {
            if (this.hasQueuedChatSynchronizationOperations) {
                this.setDeferredSynchronizationMode('online', reason, {
                    bootstrapSource: this.bootstrapSource,
                    pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
                });
                const queuedRecovery = this.resumeQueuedChatSynchronizationRecovery(reason);
                recoverySpan.end({
                    outcome: 'handoff_chat_queue_recovery',
                    pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
                });
                return queuedRecovery;
            }
            recoverySpan.end({
                outcome: 'no_recoverable_non_chat_operations',
            });
            return;
        }
        if (this.deferredSynchronizationRecovery) {
            recoverySpan.end({
                outcome: 'existing_recovery_in_flight',
            });
            return this.deferredSynchronizationRecovery;
        }
        if (this.hasQueuedChatSynchronizationOperations && !this.queuedChatSynchronizationRecovery) {
            void this.resumeQueuedChatSynchronizationRecovery(`${reason}_queued_chat`);
        }
        this.setDeferredSynchronizationMode('sync-recovery', reason, {
            bootstrapSource: this.bootstrapSource,
            pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
        });
        const recoveryPromise = this.recoverDeferredSynchronizationState(reason);
        recoverySpan.end({
            outcome: 'recovery_started',
            pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
        });
        return recoveryPromise;
    }

    private async resumeQueuedChatSynchronizationRecovery(reason: string) {
        if (this.isOfflineMode || !this.hasQueuedChatSynchronizationOperations) {
            return;
        }
        return this.chatSession.replayQueuedOperations(reason);
    }

    private async recoverDeferredSynchronizationState(reason: string) {
        // Replay deferred non-file mutations only after the local replica has had
        // a chance to reconcile file content; file operations are acknowledged by
        // LocalReplicaSCM once its baseline-based recovery finishes.
        if (this.deferredSynchronizationRecovery) {
            return this.deferredSynchronizationRecovery;
        }
        const recoverySpan = startDiagnosticSpan('VirtualFileSystem', 'sync_recovery.replay', {
            pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
            reason,
        }, {
            category: 'sync',
            level: 'info',
        });
        this.deferredSynchronizationRecovery = (async () => {
            try {
                const replayableOperations = [...this.deferredSynchronizationQueue.operations]
                    .filter((operation) => {
                        return operation.kind!=='file.localReplicaChange'
                            && operation.kind!=='chat.send'
                            && operation.kind!=='chat.edit'
                            && operation.kind!=='chat.delete';
                    })
                    .sort((left, right) => {
                        if (left.createdAt===right.createdAt) {
                            return left.id.localeCompare(right.id);
                        }
                        return left.createdAt.localeCompare(right.createdAt);
                    });
                if (replayableOperations.length===0) {
                    if (this.hasQueuedChatSynchronizationOperations) {
                        this.setDeferredSynchronizationMode('online', reason, {
                            bootstrapSource: this.bootstrapSource,
                            pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
                        });
                        void this.resumeQueuedChatSynchronizationRecovery(`${reason}_queued_chat`);
                    } else if (!this.hasDeferredSynchronizationOperations) {
                        this.setDeferredSynchronizationMode('online', reason, {
                            bootstrapSource: this.bootstrapSource,
                        });
                    }
                    return;
                }

                // Deferred REST replays must use the same refreshed auth state as the
                // active socket session, otherwise reconnect can leave receive working
                // while comment/settings replay still uses stale persisted cookies.
                const identity = await this.getAuthenticatedTransportIdentity(`sync_recovery:${reason}`);
                for (const operation of replayableOperations) {
                    try {
                        switch (operation.kind) {
                        case 'comment.create':
                            {
                                const threadId = this.resolveCanonicalCommentThreadId(operation.payload.threadId);
                                this.logCommentSyncDiagnostic('comments.replay_create_started', {
                                    docId: operation.payload.docId,
                                    filePath: operation.payload.filePath,
                                    localMessageId: operation.payload.localMessageId,
                                    operationId: operation.id,
                                    queuedAt: operation.createdAt,
                                    threadId,
                                });
                                const replayDocumentState = await this.ensureCommentReplayDocumentState({
                                    docId: operation.payload.docId,
                                    filePath: operation.payload.filePath,
                                    threadId,
                                });
                                if (await this.shouldDeferQueuedCommentReplayUntilDocumentRecovery({
                                    docId: operation.payload.docId,
                                    filePath: operation.payload.filePath,
                                    operationId: operation.id,
                                    remoteText: replayDocumentState.session.doc.remoteCache,
                                    selectedText: operation.payload.selectedText,
                                    startOffset: operation.payload.startOffset,
                                })) {
                                    this.logDiagnostic('comments.replay_create_deferred_for_local_replica', {
                                        docId: operation.payload.docId,
                                        filePath: operation.payload.filePath,
                                        operationId: operation.id,
                                        threadId,
                                    });
                                    this.scheduleDeferredSynchronizationRetry(`${reason}_comment_create_waiting_for_local_replica`, 2_500);
                                    return;
                                }
                                const replayThreadId = this.ensureCommentReplayRangeFromOperationPayload({
                                    docId: operation.payload.docId,
                                    selectedText: operation.payload.selectedText,
                                    startOffset: operation.payload.startOffset,
                                    threadId,
                                });
                                const replayRange = this.getCommentRanges(operation.payload.docId)
                                    .find((range) => this.resolveCanonicalCommentThreadId(range.op.t)===replayThreadId);
                                this.logCommentSyncDiagnostic('comments.replay_create_rest_call_started', {
                                    docId: operation.payload.docId,
                                    operationId: operation.id,
                                    replayRangeEnd: (replayRange?.op.p ?? operation.payload.startOffset)
                                        + (replayRange?.op.c.length ?? operation.payload.selectedText.length),
                                    replayRangeStart: replayRange?.op.p ?? operation.payload.startOffset,
                                    threadId: replayThreadId,
                                });
                                const response = await this.api.createCommentMessage(
                                    identity,
                                    this.projectId,
                                    replayThreadId,
                                    operation.payload.content,
                                );
                                if (response.type!=='success') {
                                    throw new Error(response.message ?? 'Unable to replay comment creation');
                                }
                                this.logCommentSyncDiagnostic('comments.replay_create_rest_call_completed', {
                                    docId: operation.payload.docId,
                                    operationId: operation.id,
                                    replayedMessageId: response.commentMessage?.id ?? '',
                                    threadId: replayThreadId,
                                });
                                await this.promoteDeferredCommentCreateToAnchorReplayOperation(
                                    operation,
                                    response.commentMessage?.id,
                                );
                                if (response.commentMessage) {
                                    this.replaceCommentMessageId(
                                        replayThreadId,
                                        operation.payload.localMessageId,
                                        response.commentMessage.id,
                                    );
                                    await this.replaceDeferredSynchronizationMessageId(
                                        replayThreadId,
                                        operation.payload.localMessageId,
                                        response.commentMessage.id,
                                        'sync_recovery_create_message_id_replaced',
                                    );
                                    this.upsertCommentThread(
                                        replayThreadId,
                                        mergeCommentMessageIntoThread(this.getCommentThreadById(replayThreadId), response.commentMessage),
                                        'thread_message_replayed',
                                    );
                                }
                                const replayAnchorOperation: ReplayCommentAnchorOperationInput = {
                                    ...operation,
                                    kind: 'comment.anchorExistingThread',
                                    payload: {
                                        ...operation.payload,
                                        serverMessageId: response.commentMessage?.id,
                                    },
                                };
                                const anchoredThreadId = await this.replayCommentCreateAnchorOperation(
                                    replayAnchorOperation,
                                    identity,
                                );
                                if (!anchoredThreadId) {
                                    return;
                                }
                                if (!response.commentMessage) {
                                    await this.resolveDeferredSynchronizedCommentMessageId(
                                        anchoredThreadId,
                                        operation.payload.localMessageId,
                                        operation.payload.content,
                                    );
                                    this.emitCommentsChanged('thread_message_replayed', {
                                        docIds: [operation.payload.docId],
                                        threadIds: [anchoredThreadId],
                                    });
                                }
                                this.logCommentSyncDiagnostic('comments.replay_create_completed', {
                                    docId: operation.payload.docId,
                                    operationId: operation.id,
                                    replayedMessageId: response.commentMessage?.id ?? '',
                                    threadId: anchoredThreadId,
                                });
                                await this.reconcileReplayedCommentThreadIdentity({
                                    docId: operation.payload.docId,
                                    localThreadId: anchoredThreadId,
                                    replayedMessageId: response.commentMessage?.id,
                                });
                            }
                            break;
                        case 'comment.anchorExistingThread':
                            {
                                const threadId = await this.replayCommentCreateAnchorOperation(operation, identity);
                                if (!threadId) {
                                    return;
                                }
                                if (!operation.payload.serverMessageId) {
                                    await this.resolveDeferredSynchronizedCommentMessageId(
                                        threadId,
                                        operation.payload.localMessageId,
                                        operation.payload.content,
                                    );
                                    this.emitCommentsChanged('thread_message_replayed', {
                                        docIds: [operation.payload.docId],
                                        threadIds: [threadId],
                                    });
                                }
                                await this.reconcileReplayedCommentThreadIdentity({
                                    docId: operation.payload.docId,
                                    localThreadId: threadId,
                                    replayedMessageId: operation.payload.serverMessageId,
                                });
                            }
                            break;
                        case 'comment.reply':
                            {
                                const threadId = this.resolveCanonicalCommentThreadId(operation.payload.threadId);
                                const response = await this.api.createCommentMessage(
                                    identity,
                                    this.projectId,
                                    threadId,
                                    operation.payload.content,
                                );
                                if (response.type!=='success') {
                                    throw new Error(response.message ?? 'Unable to replay comment reply');
                                }
                                if (response.commentMessage) {
                                    this.replaceCommentMessageId(
                                        threadId,
                                        operation.payload.localMessageId,
                                        response.commentMessage.id,
                                    );
                                    await this.replaceDeferredSynchronizationMessageId(
                                        threadId,
                                        operation.payload.localMessageId,
                                        response.commentMessage.id,
                                        'sync_recovery_reply_message_id_replaced',
                                    );
                                    this.upsertCommentThread(
                                        threadId,
                                        mergeCommentMessageIntoThread(this.getCommentThreadById(threadId), response.commentMessage),
                                        'thread_reply_replayed',
                                    );
                                } else {
                                    await this.resolveDeferredSynchronizedCommentMessageId(
                                        threadId,
                                        operation.payload.localMessageId,
                                        operation.payload.content,
                                    );
                                    this.emitCommentsChanged('thread_reply_replayed', {
                                        docIds: this.getCommentDocIdsForThreadId(threadId),
                                        threadIds: [threadId],
                                    });
                                }
                            }
                            break;
                        case 'comment.edit':
                            {
                                const threadId = this.resolveCanonicalCommentThreadId(operation.payload.threadId);
                                const response = await this.api.editCommentMessage(
                                    identity,
                                    this.projectId,
                                    threadId,
                                    operation.payload.messageId,
                                    operation.payload.content,
                                );
                                if (response.type!=='success') {
                                    throw new Error(response.message ?? 'Unable to replay comment edit');
                                }
                                this.upsertCommentThread(
                                    threadId,
                                    editCommentMessageInThread(
                                        this.getCommentThreadById(threadId),
                                        operation.payload.messageId,
                                        operation.payload.content,
                                    ),
                                    'thread_edit_replayed',
                                );
                            }
                            break;
                        case 'comment.deleteMessage':
                            {
                                const threadId = this.resolveCanonicalCommentThreadId(operation.payload.threadId);
                                const response = operation.payload.ownOnly
                                    ? await this.api.deleteOwnCommentMessage(identity, this.projectId, threadId, operation.payload.messageId)
                                    : await this.api.deleteCommentMessage(identity, this.projectId, threadId, operation.payload.messageId);
                                if (response.type!=='success') {
                                    throw new Error(response.message ?? 'Unable to replay comment delete');
                                }
                                const nextThread = removeCommentMessageFromThread(
                                    this.getCommentThreadById(threadId),
                                    operation.payload.messageId,
                                );
                                if (nextThread && nextThread.messages.length > 0) {
                                    this.upsertCommentThread(threadId, nextThread, 'thread_delete_replayed');
                                } else {
                                    this.removeCommentThread(threadId, 'thread_deleted_after_replayed_message_delete');
                                }
                            }
                            break;
                        case 'comment.deleteThread':
                            {
                                const threadId = this.resolveCanonicalCommentThreadId(operation.payload.threadId);
                                const response = await this.api.deleteCommentThread(
                                    identity,
                                    this.projectId,
                                    operation.payload.docId,
                                    threadId,
                                );
                                if (response.type!=='success') {
                                    throw new Error(response.message ?? 'Unable to replay thread delete');
                                }
                                this.removeCommentThread(threadId, 'thread_delete_replayed');
                            }
                            break;
                        case 'comment.resolveThread':
                            {
                                const threadId = this.resolveCanonicalCommentThreadId(operation.payload.threadId);
                                const response = operation.payload.resolved
                                    ? await this.api.resolveCommentThread(identity, this.projectId, operation.payload.docId, threadId)
                                    : await this.api.reopenCommentThread(identity, this.projectId, operation.payload.docId, threadId);
                                if (response.type!=='success') {
                                    throw new Error(response.message ?? 'Unable to replay thread resolution');
                                }
                                this.updateCommentThreadResolvedState(
                                    threadId,
                                    operation.payload.resolved,
                                    operation.payload.resolved ? {id: this.userId} : undefined,
                                );
                            }
                            break;
                        case 'settings.update':
                            {
                                const response = await this.api.updateProjectSettings(identity, this.projectId, operation.payload.setting);
                                if (response.type!=='success') {
                                    throw new Error(response.message ?? 'Unable to replay settings update');
                                }
                                const setting = operation.payload.setting;
                                if (this.root) {
                                    if (typeof setting.spellCheckLanguage==='string') {
                                        this.root.spellCheckLanguage = setting.spellCheckLanguage;
                                    }
                                    if (typeof setting.compiler==='string') {
                                        this.root.compiler = setting.compiler;
                                    }
                                    if (typeof setting.rootDocId==='string') {
                                        this.root.rootDoc_id = setting.rootDocId;
                                    }
                                }
                            }
                            break;
                        case 'file.localReplicaChange':
                            break;
                    }
                    await this.removeDeferredSynchronizationOperation(operation.id, 'sync_recovery_operation_replayed');
                    } catch (error) {
                        if (isLikelyConnectivityFailure(error)) {
                            recoverySpan.fail(error, {
                                failedOperationId: operation.id,
                                failedOperationKind: operation.kind,
                                failureClass: 'transient',
                            });
                            await this.transitionToOfflineMode('sync_recovery_connectivity_failure', error, {
                                failedOperationId: operation.id,
                                failedOperationKind: operation.kind,
                            });
                            return;
                        }
                        this.logDiagnostic('sync_recovery.operation_failed', {
                            failedOperationId: operation.id,
                            failedOperationKind: operation.kind,
                            failureClass: 'persistent',
                            reason,
                        }, error);
                        this.scheduleDeferredSynchronizationRetry(`${reason}_operation_failed`, 5_000);
                        recoverySpan.fail(error, {
                            failedOperationId: operation.id,
                            failedOperationKind: operation.kind,
                            failureClass: 'persistent',
                            reason,
                        });
                        this.reportBackgroundSyncFailure(
                            error instanceof Error
                                ? error.message
                                : vscode.l10n.t('Unable to replay queued Overleaf changes.'),
                            'sync_recovery_operation_failed',
                            {
                                failedOperationId: operation.id,
                                failedOperationKind: operation.kind,
                            },
                        );
                        return;
                    }
                }

                await this.flushOfflineProjectStatePersist();
                if (this.hasQueuedChatSynchronizationOperations) {
                    this.setDeferredSynchronizationMode('online', reason, {
                        bootstrapSource: this.bootstrapSource,
                        pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
                    });
                    void this.resumeQueuedChatSynchronizationRecovery(`${reason}_queued_chat`);
                } else if (!this.hasDeferredSynchronizationOperations) {
                    this.setDeferredSynchronizationMode('online', reason, {
                        bootstrapSource: this.bootstrapSource,
                    });
                }
            } catch (error) {
                this.scheduleDeferredSynchronizationRetry(`${reason}_internal_failure`, 15_000);
                recoverySpan.fail(error, {
                    failureClass: 'internal',
                    reason,
                });
                throw error;
            } finally {
                recoverySpan.end({
                    mode: this.deferredSynchronizationMode,
                    pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
                    reason,
                });
            }
        })().finally(() => {
            this.deferredSynchronizationRecovery = undefined;
        });
        return this.deferredSynchronizationRecovery;
    }

    private updateChatMessages(
        messages: ProjectMessageResponseSchema[],
        reason: string,
        options: {message?: ProjectMessageResponseSchema} = {},
    ) {
        this.chatMessages = [...messages].sort((left, right) => left.timestamp - right.timestamp);
        pruneOptimisticChatMessages(
            this.pendingOptimisticChatMessages,
            this.chatMessages.map((message) => message.id),
        );
        this.pruneAwaitingRealtimeChatConfirmations(reason);
        this.logDiagnostic('chat.messages_state_changed', {
            messageCount: this.chatMessages.length,
            reason,
        });
        EventBus.fire('chatMessagesChangedEvent', {
            message: options.message,
            origin: this.origin.toString(),
            projectId: this.projectId,
            reason,
            serverName: this.serverName,
        });
        this.scheduleOfflineProjectStatePersist(reason);
    }

    private appendChatMessage(message: ProjectMessageResponseSchema, reason: string) {
        if (isOwnChatMessageClient(message.clientId, this.activeChatClientId)) {
            const pendingMessageId = consumeOptimisticChatMessageId(this.pendingOptimisticChatMessages, message);
            if (pendingMessageId) {
                // Match Overleaf's own optimistic chat flow: replace the local
                // temporary id with the server-confirmed message instead of
                // waiting for a later full refresh to make the send visible.
                this.replaceChatMessage(pendingMessageId, message, `${reason}_optimistic_confirmed`);
                return;
            }
        }
        const existingIndex = this.chatMessages.findIndex((candidate) => candidate.id===message.id);
        const nextMessages = existingIndex>=0
            ? this.chatMessages.map((candidate, index) => index===existingIndex ? message : candidate)
            : [...this.chatMessages, message];
        this.updateChatMessages(nextMessages, reason, {message});
    }

    private async loadOfflineProjectState(reason: string) {
        const snapshot = await this.offlineStore.loadProjectState();
        if (!snapshot?.project) {
            return undefined;
        }
        const inMemoryCommentDocCountBeforeOfflineLoad = this.commentRangesByDocId.size;
        const inMemoryThreadCountBeforeOfflineLoad = this.commentThreads.size;
        const shouldPreserveInMemoryCommentState = reason==='bootstrap_offline_connectivity_failure'
            && (inMemoryCommentDocCountBeforeOfflineLoad > 0 || inMemoryThreadCountBeforeOfflineLoad > 0);
        const mergedOfflineCommentState = shouldPreserveInMemoryCommentState
            ? mergeOfflineCommentState({
                inMemoryCommentRangesByDocId: this.commentRangesByDocId,
                inMemoryCommentThreads: this.commentThreads,
                persistedCommentRangesByDocId: snapshot.commentRangesByDocId,
                persistedCommentThreads: snapshot.commentThreads,
            })
            : undefined;
        const preservedCommentThreadAliases = shouldPreserveInMemoryCommentState
            ? new Map(this.commentThreadAliases)
            : undefined;
        this.root = snapshot.project;
        this.currentVersion = snapshot.currentVersion;
        this.outputBuildId = snapshot.outputBuildId;
        this.bootstrapSource = 'offline';
        this.permissionsLevel = snapshot.permissionsLevel;
        this.readonlyMode = false;
        this.commentThreadAliases.clear();
        preservedCommentThreadAliases?.forEach((canonicalThreadId, aliasThreadId) => {
            this.commentThreadAliases.set(aliasThreadId, canonicalThreadId);
        });
        this.commentRangesByDocId.clear();
        const nextCommentRangesByDocId = mergedOfflineCommentState?.commentRangesByDocId
            ?? new Map(
                Object.entries(snapshot.commentRangesByDocId)
                    .map(([docId, ranges]) => [docId, ranges.map(cloneCommentRange)] as const),
            );
        nextCommentRangesByDocId.forEach((ranges, docId) => {
            this.commentRangesByDocId.set(docId, ranges.map(cloneCommentRange));
        });
        this.commentThreads.clear();
        const nextCommentThreads = mergedOfflineCommentState?.commentThreads
            ?? new Map(
                Object.entries(snapshot.commentThreads)
                    .map(([threadId, thread]) => [threadId, normalizeCommentThread(thread)] as const),
            );
        nextCommentThreads.forEach((thread, threadId) => {
            this.commentThreads.set(threadId, normalizeCommentThread(thread));
        });
        this.chatSession.restoreState({
            historyComplete: snapshot.chatHistoryComplete,
            messages: snapshot.chatMessages,
            savedAt: snapshot.savedAt,
        }, 'offline_chat_state_restored');
        this.commentThreadsLoaded = true;
        this.setDeferredSynchronizationMode('offline', reason, {
            loadedFrom: 'persisted_snapshot',
            operationCount: this.deferredSynchronizationQueue.operations.length,
        });
        if (shouldPreserveInMemoryCommentState) {
            this.logDiagnostic('offline.comment_state_preserved_from_memory', {
                inMemoryCommentDocCount: inMemoryCommentDocCountBeforeOfflineLoad,
                inMemoryThreadCount: inMemoryThreadCountBeforeOfflineLoad,
                mergedCommentDocCount: this.commentRangesByDocId.size,
                mergedThreadCount: this.commentThreads.size,
                persistedCommentDocCount: Object.keys(snapshot.commentRangesByDocId).length,
                persistedThreadCount: Object.keys(snapshot.commentThreads).length,
                reason,
            });
        }
        this.logDiagnostic('offline.state_loaded', {
            chatMessageCount: this.chatMessages.length,
            commentDocCount: this.commentRangesByDocId.size,
            preservedInMemoryCommentState: shouldPreserveInMemoryCommentState,
            reason,
            threadCount: this.commentThreads.size,
        });
        return snapshot.project;
    }

    private async readOfflineWorkspaceFile(pathname: string) {
        const workspace = await resolveLocalReplicaWorkspaceForOverleafUri(this.origin);
        if (!workspace) {
            return undefined;
        }
        const fileUri = vscode.Uri.joinPath(workspace.workspaceRoot, ...pathname.split('/').filter(Boolean));
        try {
            return await vscode.workspace.fs.readFile(fileUri);
        } catch {
            return undefined;
        }
    }

    private normalizeCommentsChangedFields(fields: {
        docIds?: string[],
        threadIds?: string[],
    }) {
        const normalizedDocIds = fields.docIds
            ?.filter((docId) => typeof docId === 'string' && docId.length > 0);
        const normalizedThreadIds = fields.threadIds
            ?.filter((threadId) => typeof threadId === 'string' && threadId.length > 0)
            .map((threadId) => this.resolveCanonicalCommentThreadId(threadId));
        return {
            docIds: normalizedDocIds && normalizedDocIds.length > 0
                ? Array.from(new Set(normalizedDocIds))
                : undefined,
            threadIds: normalizedThreadIds && normalizedThreadIds.length > 0
                ? Array.from(new Set(normalizedThreadIds))
                : undefined,
        };
    }

    private emitCommentsChanged(reason: string, fields: {
        docIds?: string[],
        threadIds?: string[],
    } = {}) {
        const normalizedFields = this.normalizeCommentsChangedFields(fields);
        const emittedAtMs = Date.now();
        const sequence = ++this.commentsChangedEventSequence;
        this.logCommentSyncDiagnostic('comments.state_changed', {
            docCount: normalizedFields.docIds?.length ?? 0,
            emittedAtMs,
            reason,
            sequence,
            threadCount: normalizedFields.threadIds?.length ?? 0,
            ...normalizedFields,
        });
        EventBus.fire('commentsChangedEvent', {
            docIds: normalizedFields.docIds,
            emittedAtMs,
            origin: this.origin.toString(),
            projectId: this.projectId,
            reason,
            sequence,
            serverName: this.serverName,
            threadIds: normalizedFields.threadIds,
        });
        this.scheduleOfflineProjectStatePersist(reason);
    }

    private getCommentRanges(docId: string) {
        return this.commentRangesByDocId.get(docId)?.map(cloneCommentRange) ?? [];
    }

    private setCommentRanges(docId: string, ranges: OverleafCommentRange[], reason: string) {
        const previousRanges = this.commentRangesByDocId.get(docId) ?? [];
        const canonicalRanges = ranges.map((range) => {
            const canonicalThreadId = this.resolveCanonicalCommentThreadId(range.op.t);
            if (canonicalThreadId===range.op.t) {
                return cloneCommentRange(range);
            }
            const clonedRange = cloneCommentRange(range);
            return {
                ...clonedRange,
                op: {
                    ...clonedRange.op,
                    t: canonicalThreadId,
                },
            };
        });
        const dedupedRanges = dedupeCommentRangesByThreadId(canonicalRanges);

        const previousThreadIds = new Set(previousRanges.map((range) => this.resolveCanonicalCommentThreadId(range.op.t)));
        const nextThreadIds = new Set(dedupedRanges.map((range) => this.resolveCanonicalCommentThreadId(range.op.t)));
        const addedThreadCount = Array.from(nextThreadIds).filter((threadId) => !previousThreadIds.has(threadId)).length;
        const removedThreadCount = Array.from(previousThreadIds).filter((threadId) => !nextThreadIds.has(threadId)).length;
        let transitionKind: CommentStateTransitionKind = 'range.replaced';
        if (previousRanges.length===0 && dedupedRanges.length > 0) {
            transitionKind = 'range.appended';
        } else if (addedThreadCount > 0 && removedThreadCount > 0) {
            transitionKind = 'range.merged';
        }
        this.recordCommentStateTransition(transitionKind, {
            addedThreadCount,
            docId,
            previousRangeCount: previousRanges.length,
            reason,
            removedThreadCount,
            resultingRangeCount: dedupedRanges.length,
        });

        this.commentRangesByDocId.set(docId, dedupedRanges.map(cloneCommentRange));
        this.emitCommentsChanged(reason, {docIds: [docId], threadIds: dedupedRanges.map((range) => range.op.t)});
    }

    private applyCommentOps(docId: string, ops: UpdateSchema['op'], reason: string) {
        const currentRanges = this.getCommentRanges(docId);
        const transformed = applyTextOperationsToCommentRanges(currentRanges, ops);
        if (transformed.contentMismatchCount > 0) {
            this.logDiagnostic('comments.range_transform_mismatch', {
                contentMismatchCount: transformed.contentMismatchCount,
                docId,
                opCount: ops?.length ?? 0,
                reason,
            });
        }
        this.setCommentRanges(docId, transformed.ranges, reason);
    }

    public async applyLocalTextDocumentChangesToCommentRanges(
        uri: vscode.Uri,
        previousText: string,
        nextText: string,
        reason: string,
    ) {
        if (previousText===nextText) {
            return;
        }
        const resolved = await this._resolveUri(uri);
        if (!resolved.fileEntity || resolved.fileType!=='doc') {
            return;
        }
        const doc = resolved.fileEntity as DocumentEntity;
        await this.ensureCommentRangesLoaded(uri, doc);
        const ops = buildTextOperations(previousText, nextText);
        if (ops.length===0) {
            return;
        }
        this.applyCommentOps(doc._id, ops, reason);
    }

    private async ensureCommentReplayDocumentState(payload: {
        docId: string,
        filePath?: string,
        threadId: string,
    }) {
        const currentRanges = this.getCommentRanges(payload.docId);
        const resolvedDocPath = this.resolveDocumentPathById(payload.docId);
        const preferredTargetPath = resolvedDocPath
            ?? payload.filePath
            ?? '';
        let sessionUri = this.pathToUri(...preferredTargetPath.split('/').filter(Boolean));
        const pendingThreadIds = new Set(
            this.deferredSynchronizationQueue.operations
                .filter((operation): operation is Extract<DeferredSyncOperation, {kind: 'comment.create' | 'comment.anchorExistingThread'}> => {
                    return (operation.kind==='comment.create' || operation.kind==='comment.anchorExistingThread')
                        && operation.payload.docId===payload.docId;
                })
                .map((operation) => this.resolveCanonicalCommentThreadId(operation.payload.threadId)),
        );
        pendingThreadIds.add(this.resolveCanonicalCommentThreadId(payload.threadId));
        let session;
        try {
            session = await this.ensureDocumentTextInitialized(sessionUri);
        } catch (error) {
            if (!resolvedDocPath || resolvedDocPath===preferredTargetPath) {
                throw error;
            }
            sessionUri = this.pathToUri(...resolvedDocPath.split('/').filter(Boolean));
            this.logCommentSyncDiagnostic('comments.replay_document_state_path_fallback', {
                attemptedPath: preferredTargetPath,
                docId: payload.docId,
                fallbackPath: resolvedDocPath,
                threadId: payload.threadId,
            }, error);
            session = await this.ensureDocumentTextInitialized(sessionUri);
        }
        const replayJoinResponse = await this.socket.joinDoc(payload.docId);
        const replayContent = replayJoinResponse.docLines.join('\n');
        session.doc.version = replayJoinResponse.version;
        session.doc.lastVersion = undefined;
        session.doc.localCache = replayContent;
        session.doc.remoteCache = replayContent;
        const normalizedServerRanges = normalizeCommentRanges(replayJoinResponse.ranges?.comments);
        const mergedReplayJoinRanges = this.mergeHydratedCommentRangesWithPendingCreates(
            payload.docId,
            normalizedServerRanges,
        );
        this.setCommentRanges(payload.docId, mergedReplayJoinRanges.mergedRanges, 'comments_replay_doc_join_loaded');
        if (mergedReplayJoinRanges.preservedThreadIds.length > 0) {
            this.logDiagnostic('comments.replay_doc_join_preserved_pending_creates', {
                docId: payload.docId,
                preservedThreadIds: mergedReplayJoinRanges.preservedThreadIds,
                resolvedPath: session.resolvedPath,
                threadId: payload.threadId,
            });
        }
        this.logCommentSyncDiagnostic('comments.replay_document_session_rejoined', {
            docId: payload.docId,
            path: session.resolvedPath,
            preservedPendingCommentCreateCount: mergedReplayJoinRanges.preservedThreadIds.length,
            threadId: payload.threadId,
            version: replayJoinResponse.version,
        });
        const joinedRanges = this.getCommentRanges(payload.docId);
        const preservedPendingRanges = currentRanges.filter((range) => {
            return pendingThreadIds.has(this.resolveCanonicalCommentThreadId(range.op.t));
        });
        const shouldRestoreLocalRanges = joinedRanges.length===0 && currentRanges.length > 0;
        const rangesToPreserve = shouldRestoreLocalRanges
            ? currentRanges
            : preservedPendingRanges;
        if (rangesToPreserve.length > 0) {
            const mergedRanges = dedupeCommentRangesByThreadId([
                ...joinedRanges,
                ...rangesToPreserve,
            ]);
            this.commentRangesByDocId.set(payload.docId, mergedRanges.map(cloneCommentRange));
            this.emitCommentsChanged('comments_recovery_ranges_preserved', {
                docIds: [payload.docId],
                threadIds: mergedRanges.map((range) => range.op.t),
            });
            this.logDiagnostic('comments.recovery_pending_ranges_preserved', {
                docId: payload.docId,
                preservedRangeCount: rangesToPreserve.length,
                restoredFromLocalRanges: shouldRestoreLocalRanges,
                threadId: payload.threadId,
            });
        }
        return {
            serverHydratedThreadIds: new Set(
                normalizedServerRanges.map((range) => this.resolveCanonicalCommentThreadId(range.op.t)),
            ),
            session,
        };
    }

    private async promoteDeferredCommentCreateToAnchorReplayOperation(operation: Extract<DeferredSyncOperation, {kind: 'comment.create'}>, serverMessageId?: string) {
        await this.replaceDeferredSynchronizationOperations(
            'sync_recovery_comment_create_promoted_to_anchor',
            (operations) => operations.map<DeferredSyncOperation>((candidate) => {
                if (candidate.id!==operation.id || candidate.kind!=='comment.create') {
                    return candidate;
                }
                return {
                    createdAt: candidate.createdAt,
                    id: candidate.id,
                    kind: 'comment.anchorExistingThread',
                    payload: {
                        content: candidate.payload.content,
                        docId: candidate.payload.docId,
                        filePath: candidate.payload.filePath,
                        localMessageId: candidate.payload.localMessageId,
                        selectedText: candidate.payload.selectedText,
                        serverMessageId,
                        startOffset: candidate.payload.startOffset,
                        threadId: candidate.payload.threadId,
                    },
                };
            }),
        );
    }

    private async resolveServerCommentThreadIdForMessage(options: {
        docId: string,
        identity: Identity,
        localThreadId: string,
        messageId: string,
        operationId: string,
        timeoutMs?: number,
    }) {
        const timeoutMs = options.timeoutMs ?? 5_000;
        const deadline = Date.now() + timeoutMs;
        let attempt = 0;
        while (true) {
            attempt += 1;
            const response = await this.api.getCommentThreads(options.identity, this.projectId);
            if (response.type!=='success' || !response.commentThreads) {
                throw new Error(response.message ?? 'Unable to resolve the replayed Overleaf comment thread.');
            }
            const serverThreadId = findCommentThreadIdByMessageIdInThreads(
                Object.entries(response.commentThreads),
                options.messageId,
            );
            this.logCommentSyncDiagnostic('comments.replay_create_server_thread_lookup_attempt', {
                attempt,
                docId: options.docId,
                localThreadId: options.localThreadId,
                messageId: options.messageId,
                operationId: options.operationId,
                serverThreadId: serverThreadId ?? '',
            });
            if (serverThreadId) {
                return serverThreadId;
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                return undefined;
            }
            await new Promise((resolve) => {
                setTimeout(resolve, Math.min(250, remainingMs));
            });
        }
    }

    private async applyReplayedCommentThreadIdentity(options: {
        docId: string,
        localThreadId: string,
        replayedMessageId?: string,
        reason: string,
        serverThreadId: string,
    }) {
        const canonicalLocalThreadId = this.resolveCanonicalCommentThreadId(options.localThreadId);
        const canonicalResolvedServerThreadId = this.resolveCanonicalCommentThreadId(options.serverThreadId);
        if (!options.serverThreadId || canonicalResolvedServerThreadId===canonicalLocalThreadId) {
            return canonicalLocalThreadId;
        }
        const localThread = this.getCommentThreadById(canonicalLocalThreadId);
        await this.replaceDeferredSynchronizationThreadId(
            canonicalLocalThreadId,
            canonicalResolvedServerThreadId,
            options.reason,
        );
        const canonicalServerThreadId = this.registerCommentThreadAlias(
            canonicalLocalThreadId,
            canonicalResolvedServerThreadId,
            options.reason,
        );
        if (localThread && !this.commentThreads.has(canonicalServerThreadId)) {
            this.commentThreads.set(canonicalServerThreadId, normalizeCommentThread(localThread));
        }
        this.commentThreads.delete(canonicalLocalThreadId);
        const remappedRange = this.reconcileCommentRangeThreadIdentity(
            options.docId,
            canonicalLocalThreadId,
            canonicalServerThreadId,
            options.reason,
        );
        if (!remappedRange) {
            this.emitCommentsChanged(options.reason, {
                docIds: [options.docId],
                threadIds: [canonicalLocalThreadId, canonicalServerThreadId],
            });
        }
        this.logDiagnostic('comments.replay_thread_id_reconciled', {
            docId: options.docId,
            localThreadId: canonicalLocalThreadId,
            replayedMessageId: options.replayedMessageId,
            serverThreadId: canonicalServerThreadId,
        });
        return canonicalServerThreadId;
    }

    private async waitForCommentAnchorPersistedOnServer(options: {
        docId: string,
        filePath?: string,
        localThreadId: string,
        operationId: string,
        threadId: string,
        timeoutMs?: number,
    }) {
        const timeoutMs = options.timeoutMs ?? 5_000;
        const deadline = Date.now() + timeoutMs;
        let attempt = 0;
        const candidateThreadIds = Array.from(new Set([
            this.resolveCanonicalCommentThreadId(options.localThreadId),
            this.resolveCanonicalCommentThreadId(options.threadId),
        ]));
        while (true) {
            attempt += 1;
            const replayDocumentState = await this.ensureCommentReplayDocumentState({
                docId: options.docId,
                filePath: options.filePath,
                threadId: options.threadId,
            });
            const matchedThreadId = candidateThreadIds.find((threadId) => {
                return replayDocumentState.serverHydratedThreadIds.has(this.resolveCanonicalCommentThreadId(threadId));
            });
            this.logCommentSyncDiagnostic('comments.replay_create_anchor_server_confirmation_attempt', {
                attempt,
                docId: options.docId,
                localThreadId: options.localThreadId,
                matchedThreadId: matchedThreadId ?? '',
                operationId: options.operationId,
                serverHydratedThreadCount: replayDocumentState.serverHydratedThreadIds.size,
                threadId: options.threadId,
            });
            if (matchedThreadId) {
                return matchedThreadId;
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                return undefined;
            }
            await new Promise((resolve) => {
                setTimeout(resolve, Math.min(250, remainingMs));
            });
        }
    }

    private async replayCommentCreateAnchorOperation(operation: ReplayCommentAnchorOperationInput, identity?: Identity) {
        const payload = operation.payload;
        let replayThreadId = this.resolveCanonicalCommentThreadId(payload.threadId);
        const replayIdentity = payload.serverMessageId
            ? identity ?? await this.getAuthenticatedTransportIdentity(`sync_recovery_comment_anchor:${operation.id}`)
            : identity;
        if (payload.serverMessageId && replayIdentity) {
            const serverThreadId = await this.resolveServerCommentThreadIdForMessage({
                docId: payload.docId,
                identity: replayIdentity,
                localThreadId: replayThreadId,
                messageId: payload.serverMessageId,
                operationId: operation.id,
            });
            if (serverThreadId) {
                replayThreadId = await this.applyReplayedCommentThreadIdentity({
                    docId: payload.docId,
                    localThreadId: replayThreadId,
                    replayedMessageId: payload.serverMessageId,
                    reason: 'comments_replay_server_thread_id_resolved',
                    serverThreadId,
                });
            }
        }
        const replayDocumentState = await this.ensureCommentReplayDocumentState({
            docId: payload.docId,
            filePath: payload.filePath,
            threadId: replayThreadId,
        });
        if (await this.shouldDeferQueuedCommentReplayUntilDocumentRecovery({
            docId: payload.docId,
            filePath: payload.filePath,
            operationId: operation.id,
            remoteText: replayDocumentState.session.doc.remoteCache,
            selectedText: payload.selectedText,
            startOffset: payload.startOffset,
        })) {
            this.logDiagnostic('comments.replay_create_anchor_deferred_for_local_replica', {
                docId: payload.docId,
                filePath: payload.filePath,
                operationId: operation.id,
                threadId: replayThreadId,
            });
            this.scheduleDeferredSynchronizationRetry('sync_recovery_comment_anchor_waiting_for_local_replica', 2_500);
            return undefined;
        }
        replayThreadId = this.ensureCommentReplayRangeFromOperationPayload({
            docId: payload.docId,
            selectedText: payload.selectedText,
            startOffset: payload.startOffset,
            threadId: replayThreadId,
        });
        if (replayDocumentState.serverHydratedThreadIds.has(replayThreadId)) {
            this.logCommentSyncDiagnostic('comments.replay_create_anchor_already_present_on_server', {
                docId: payload.docId,
                operationId: operation.id,
                threadId: replayThreadId,
            });
            return replayThreadId;
        }
        const replayRange = this.getCommentRanges(payload.docId)
            .find((range) => this.resolveCanonicalCommentThreadId(range.op.t)===replayThreadId);
        const docEntity = this._resolveById(payload.docId)?.fileEntity as DocumentEntity | undefined;
        const currentVersion = docEntity?.version ?? 0;
        const update: UpdateSchema = buildCommentAnchorUpdate({
            docId: payload.docId,
            docVersion: currentVersion,
            lastVersion: docEntity?.lastVersion,
            selectedText: replayRange?.op.c ?? payload.selectedText,
            startOffset: replayRange?.op.p ?? payload.startOffset,
            threadId: replayThreadId,
        });
        this.logCommentSyncDiagnostic('comments.replay_create_anchor_apply_started', {
            currentVersion,
            docId: payload.docId,
            lastKnownVersion: update.lastV ?? null,
            operationId: operation.id,
            threadId: replayThreadId,
        });
        await this.socket.applyOtUpdate(payload.docId, update);
        const confirmedThreadId = await this.waitForCommentAnchorPersistedOnServer({
            docId: payload.docId,
            filePath: payload.filePath,
            localThreadId: payload.threadId,
            operationId: operation.id,
            threadId: replayThreadId,
        });
        if (!confirmedThreadId) {
            this.logDiagnostic('comments.replay_create_anchor_confirmation_timed_out', {
                docId: payload.docId,
                operationId: operation.id,
                threadId: replayThreadId,
            });
            throw new Error('Timed out waiting for the replayed comment anchor to appear in the Overleaf document state.');
        }
        if (docEntity) {
            docEntity.lastVersion = docEntity.version;
        }
        this.logCommentSyncDiagnostic('comments.replay_create_anchor_apply_completed', {
            currentVersion: docEntity?.version ?? currentVersion,
            docId: payload.docId,
            operationId: operation.id,
            threadId: replayThreadId,
        });
        const canonicalConfirmedThreadId = this.resolveCanonicalCommentThreadId(confirmedThreadId);
        this.emitCommentsChanged('comments_replay_thread_reconciled', {
            docIds: [payload.docId],
            threadIds: [canonicalConfirmedThreadId],
        });
        this.logDiagnostic('comments.replay_finalization_emitted', {
            docId: payload.docId,
            finalReason: 'comments_replay_thread_reconciled',
            localThreadId: this.resolveCanonicalCommentThreadId(payload.threadId),
            operationId: operation.id,
            projectWideRefreshRequired: false,
            serverThreadId: canonicalConfirmedThreadId,
        });
        return canonicalConfirmedThreadId;
    }

    private ensureCommentReplayRangeFromOperationPayload(payload: {
        docId: string,
        selectedText: string,
        startOffset: number,
        threadId: string,
    }) {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(payload.threadId);
        const existingRanges = this.getCommentRanges(payload.docId);
        const hasRange = existingRanges.some((range) => {
            return this.resolveCanonicalCommentThreadId(range.op.t)===canonicalThreadId;
        });
        if (hasRange) {
            return canonicalThreadId;
        }

        const nextRanges = upsertCommentRange(existingRanges, {
            c: payload.selectedText,
            p: payload.startOffset,
            t: canonicalThreadId,
        }, {
            ts: new Date().toISOString(),
            user_id: this.userId,
        });
        this.setCommentRanges(payload.docId, nextRanges, 'comments_replay_range_restored_from_operation_payload');
        this.logCommentSyncDiagnostic('comments.replay_range_restored_from_operation_payload', {
            docId: payload.docId,
            selectedTextLength: payload.selectedText.length,
            startOffset: payload.startOffset,
            threadId: canonicalThreadId,
        });
        return canonicalThreadId;
    }

    private getCommentDocIdsForThreadId(threadId: string) {
        const matchingThreadIds = this.getCommentThreadAliasIds(threadId);
        const docIds: string[] = [];
        for (const [docId, ranges] of this.commentRangesByDocId.entries()) {
            if (ranges.some((range) => matchingThreadIds.has(range.op.t))) {
                docIds.push(docId);
            }
        }
        return docIds;
    }

    private getCommentRangeSnapshotsForThreadId(threadId: string) {
        const matchingThreadIds = this.getCommentThreadAliasIds(threadId);
        const snapshots: Array<{
            docId: string,
            range: OverleafCommentRange,
        }> = [];
        for (const [docId, ranges] of this.commentRangesByDocId.entries()) {
            for (const range of ranges) {
                if (!matchingThreadIds.has(range.op.t)) {
                    continue;
                }
                snapshots.push({
                    docId,
                    range: cloneCommentRange(range),
                });
            }
        }
        return snapshots;
    }

    private collectLocalCommentReviewStateForDocIds(docIds?: string[]) {
        if (!docIds || docIds.length===0) {
            return {
                hasCompleteTargetLocalState: false,
                missingDocIds: [] as string[],
                missingThreadIds: [] as string[],
            };
        }

        const missingDocIds: string[] = [];
        const missingThreadIds = new Set<string>();
        docIds.forEach((docId) => {
            if (!this.commentRangesByDocId.has(docId)) {
                missingDocIds.push(docId);
                return;
            }
            this.getCommentRanges(docId).forEach((range) => {
                const canonicalThreadId = this.resolveCanonicalCommentThreadId(range.op.t);
                const thread = this.resolveCommentThreadForRange(range);
                if (!thread || thread.messages.length===0) {
                    missingThreadIds.add(canonicalThreadId);
                }
            });
        });

        return {
            hasCompleteTargetLocalState: missingDocIds.length===0 && missingThreadIds.size===0,
            missingDocIds,
            missingThreadIds: Array.from(missingThreadIds).sort((left, right) => left.localeCompare(right)),
        };
    }

    private restoreCommentRangeSnapshotsForThreadId(
        threadId: string,
        snapshots: Array<{
            docId: string,
            range: OverleafCommentRange,
        }>,
        reason: string,
    ) {
        if (snapshots.length===0) {
            return;
        }
        const snapshotsByDocId = new Map<string, OverleafCommentRange[]>();
        snapshots.forEach(({docId, range}) => {
            const existing = snapshotsByDocId.get(docId) ?? [];
            existing.push(range);
            snapshotsByDocId.set(docId, existing);
        });

        snapshotsByDocId.forEach((docSnapshots, docId) => {
            const merged = dedupeCommentRangesByThreadId([
                ...this.getCommentRanges(docId),
                ...docSnapshots.map(cloneCommentRange),
            ]);
            this.setCommentRanges(docId, merged, reason);
        });
    }

    private upsertCommentThread(threadId: string, thread: OverleafCommentThread, reason: string) {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        const previousThread = this.getCommentThreadById(canonicalThreadId);
        const normalizedThread = normalizeCommentThread(thread);
        this.commentThreads.set(canonicalThreadId, normalizedThread);
        if (canonicalThreadId!==threadId) {
            this.commentThreads.delete(threadId);
        }

        const previousMessageIds = new Set(previousThread?.messages.map((message) => message.id) ?? []);
        const nextMessageIds = new Set(normalizedThread.messages.map((message) => message.id));
        const addedMessageCount = Array.from(nextMessageIds).filter((messageId) => !previousMessageIds.has(messageId)).length;
        const removedMessageCount = Array.from(previousMessageIds).filter((messageId) => !nextMessageIds.has(messageId)).length;
        let transitionKind: CommentStateTransitionKind = 'thread.replaced';
        if (!previousThread) {
            transitionKind = 'thread.appended';
        } else if (addedMessageCount > 0 && removedMessageCount > 0) {
            transitionKind = 'thread.merged';
        } else if (addedMessageCount > 0 && removedMessageCount===0 && nextMessageIds.size > previousMessageIds.size) {
            transitionKind = 'thread.appended';
        }
        this.recordCommentStateTransition(transitionKind, {
            addedMessageCount,
            canonicalThreadId,
            previousMessageCount: previousThread?.messages.length ?? 0,
            reason,
            removedMessageCount,
            resultingMessageCount: normalizedThread.messages.length,
        });

        this.logCommentSyncDiagnostic('comments.thread_upserted', {
            canonicalThreadId,
            previousMessageCount: previousThread?.messages.length ?? 0,
            reason,
            resultingMessageCount: normalizedThread.messages.length,
            threadId,
            transitionKind,
        });

        this.emitCommentsChanged(reason, {
            docIds: this.getCommentDocIdsForThreadId(canonicalThreadId),
            threadIds: canonicalThreadId===threadId ? [canonicalThreadId] : [threadId, canonicalThreadId],
        });
    }

    private removeCommentThread(threadId: string, reason: string) {
        const threadIdsToRemove = this.getCommentThreadAliasIds(threadId);
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        for (const candidateThreadId of threadIdsToRemove) {
            this.commentThreads.delete(candidateThreadId);
            if (candidateThreadId!==canonicalThreadId) {
                this.commentThreadAliases.delete(candidateThreadId);
            }
        }
        this.commentThreadAliases.delete(canonicalThreadId);
        const affectedDocIds: string[] = [];
        for (const [docId, ranges] of this.commentRangesByDocId.entries()) {
            const nextRanges = ranges.filter((range) => !threadIdsToRemove.has(range.op.t));
            if (nextRanges.length!==ranges.length) {
                this.commentRangesByDocId.set(docId, nextRanges);
                affectedDocIds.push(docId);
                this.emitCommentsChanged(reason, {
                    docIds: [docId],
                    threadIds: Array.from(threadIdsToRemove),
                });
            }
        }

        this.recordCommentStateTransition('thread.removed', {
            affectedDocCount: affectedDocIds.length,
            aliasCount: threadIdsToRemove.size,
            canonicalThreadId,
            reason,
            threadId,
        });
        this.logCommentSyncDiagnostic('comments.thread_removed', {
            affectedDocCount: affectedDocIds.length,
            canonicalThreadId,
            reason,
            removedThreadIds: Array.from(threadIdsToRemove).sort((left, right) => left.localeCompare(right)),
            threadId,
        });
    }

    private findCommentThreadIdByMessageId(messageId: string) {
        const threadId = findCommentThreadIdByMessageIdInThreads(this.commentThreads.entries(), messageId);
        return threadId ? this.resolveCanonicalCommentThreadId(threadId) : undefined;
    }

    private reconcileCommentRangeThreadIdentity(
        docId: string,
        previousThreadId: string,
        nextThreadId: string,
        reason: string,
    ) {
        const canonicalPreviousThreadId = this.resolveCanonicalCommentThreadId(previousThreadId);
        const canonicalNextThreadId = this.resolveCanonicalCommentThreadId(nextThreadId);
        if (canonicalPreviousThreadId===canonicalNextThreadId) {
            return false;
        }
        const candidatePreviousThreadIds = this.getCommentThreadAliasIds(canonicalPreviousThreadId);
        candidatePreviousThreadIds.delete(canonicalNextThreadId);
        const currentRanges = this.getCommentRanges(docId);
        if (currentRanges.length===0 || !currentRanges.some((range) => candidatePreviousThreadIds.has(range.op.t))) {
            return false;
        }
        const hasTargetRange = currentRanges.some((range) => range.op.t===canonicalNextThreadId);
        const nextRanges = hasTargetRange
            ? currentRanges.filter((range) => !candidatePreviousThreadIds.has(range.op.t))
            : currentRanges.map((range) => {
                if (!candidatePreviousThreadIds.has(range.op.t)) {
                    return cloneCommentRange(range);
                }
                const clonedRange = cloneCommentRange(range);
                return {
                    ...clonedRange,
                    op: {
                        ...clonedRange.op,
                        t: canonicalNextThreadId,
                    },
                };
            });
        this.setCommentRanges(docId, nextRanges, reason);
        return true;
    }

    private async reconcileReplayedCommentThreadIdentity(options: {
        docId: string,
        localThreadId: string,
        replayedMessageId?: string,
    }) {
        const {docId, localThreadId, replayedMessageId} = options;
        if (!replayedMessageId) {
            return;
        }
        try {
            await this.ensureCommentThreadsLoaded(true);
            const serverThreadId = this.findCommentThreadIdByMessageId(replayedMessageId);
            if (!serverThreadId) {
                return;
            }
            await this.applyReplayedCommentThreadIdentity({
                docId,
                localThreadId,
                replayedMessageId,
                reason: 'comments_replay_thread_id_reconciled',
                serverThreadId,
            });
        } catch (error) {
            this.logDiagnostic('comments.replay_thread_id_reconcile_failed', {
                docId,
                localThreadId,
                replayedMessageId,
            }, error);
        }
    }

    private updateCommentThreadResolvedState(threadId: string, resolved: boolean, resolvedByUser?: OverleafCommentMessage['user']) {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        const existing = normalizeCommentThread(this.getCommentThreadById(canonicalThreadId) ?? {messages: []});
        existing.resolved = resolved || undefined;
        existing.resolved_at = resolved ? new Date().toISOString() : undefined;
        existing.resolved_by_user = resolved ? resolvedByUser : undefined;
        existing.resolved_by_user_id = resolved ? resolvedByUser?.id : undefined;
        this.commentThreads.set(canonicalThreadId, existing);
        const candidateThreadIds = this.getCommentThreadAliasIds(canonicalThreadId);
        const changedDocIds: string[] = [];
        for (const [docId, ranges] of this.commentRangesByDocId.entries()) {
            const nextRanges = Array.from(candidateThreadIds).reduce((acc, candidateThreadId) => {
                return updateCommentRangeResolvedState(acc, candidateThreadId, resolved);
            }, ranges);
            const changed = JSON.stringify(nextRanges)!==JSON.stringify(ranges);
            if (changed) {
                this.commentRangesByDocId.set(docId, nextRanges);
                changedDocIds.push(docId);
            }
        }
        this.emitCommentsChanged(resolved ? 'thread_resolved' : 'thread_reopened', {
            docIds: changedDocIds.length > 0 ? changedDocIds : this.getCommentDocIdsForThreadId(canonicalThreadId),
            threadIds: [canonicalThreadId],
        });
    }

    private async ensureCommentThreadsLoaded(force = false) {
        if (this.isOfflineMode) {
            this.commentThreadsLoaded = true;
            return;
        }
        if (this.commentThreadsLoaded && !force) {
            return;
        }
        if (this.commentThreadsLoading && !force) {
            return this.commentThreadsLoading;
        }
        this.commentThreadsLoading = (async () => {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            this.logDiagnostic('comments.fetch_started');
            const existingThreads = new Map(this.commentThreads);
            const existingThreadCount = existingThreads.size;
            const shouldPreserveLocalThreads = existingThreads.size > 0
                && (this.isRecoveryInProgress()
                    || this.deferredSynchronizationMode!=='online'
                    || this.connectionPhase!=='live'
                    || this.hasDeferredRecoverableNonChatOperations);
            const response = await this.api.getCommentThreads(identity, this.projectId);
            if (response.type!=='success' || !response.commentThreads) {
                this.logDiagnostic('comments.fetch_failed', {
                    responseType: response.type,
                }, response.message);
                throw new Error(response.message ?? 'Unable to fetch comment threads');
            }
            const fetchedThreadIds = Object.keys(response.commentThreads);
            if (fetchedThreadIds.length===0
                && this.commentThreads.size > 0
                && (this.isRecoveryInProgress()
                    || this.deferredSynchronizationMode!=='online'
                    || this.connectionPhase!=='live')) {
                this.commentThreadsLoaded = true;
                this.logDiagnostic('comments.fetch_empty_snapshot_preserved_local', {
                    connectionPhase: this.connectionPhase,
                    deferredSynchronizationMode: this.deferredSynchronizationMode,
                    localThreadCount: this.commentThreads.size,
                });
                return;
            }
            this.commentThreads.clear();
            Object.entries(response.commentThreads).forEach(([threadId, thread]) => {
                this.commentThreads.set(threadId, normalizeCommentThread(thread));
                this.commentThreadAliases.delete(threadId);
            });
            if (shouldPreserveLocalThreads) {
                const preservedThreadIds: string[] = [];
                for (const [threadId, thread] of existingThreads.entries()) {
                    const hasQueuedCreate = this.hasDeferredCommentCreateOperationForThreadId(threadId);
                    if (this.commentThreads.has(threadId)
                        || (!hasQueuedCreate && this.getCommentDocIdsForThreadId(threadId).length===0)) {
                        continue;
                    }
                    this.commentThreads.set(threadId, normalizeCommentThread(thread));
                    preservedThreadIds.push(threadId);
                }
                if (preservedThreadIds.length > 0) {
                    this.logDiagnostic('comments.fetch_preserved_local_threads', {
                        preservedThreadCount: preservedThreadIds.length,
                    });
                }
            }
            this.commentThreadsLoaded = true;
            this.logDiagnostic('comments.fetch_completed', {
                threadCount: this.commentThreads.size,
            });
            if (existingThreadCount===0 && this.commentThreads.size > 0) {
                this.emitCommentsChanged('comments_threads_hydrated', {
                    threadIds: Array.from(this.commentThreads.keys()),
                });
            }
        })().finally(() => {
            this.commentThreadsLoading = undefined;
        });
        return this.commentThreadsLoading;
    }

    private async ensureCommentRangesLoaded(uri: vscode.Uri, doc: DocumentEntity) {
        if (this.commentRangesByDocId.has(doc._id)) {
            return;
        }
        if (this.isOfflineMode) {
            this.commentRangesByDocId.set(doc._id, []);
            return;
        }

        this.logDiagnostic('comments.doc_ranges_load_started', {
            docId: doc._id,
            path: uri.path,
        });
        await vscode.workspace.fs.readFile(uri);
        if (!this.commentRangesByDocId.has(doc._id)) {
            this.logDiagnostic('comments.doc_ranges_load_failed', {
                docId: doc._id,
                path: uri.path,
            });
            throw new Error(vscode.l10n.t('Unable to load Overleaf comments for "{fileName}".', {fileName: doc.name}));
        }
    }

    private resolveCommentThreadForRange(range: OverleafCommentRange) {
        return this.getCommentThreadById(range.op.t);
    }

    private buildCommentPermissionsForThread(thread: OverleafCommentThread | undefined, threadRange: OverleafCommentRange) {
        const permissions = this.commentPermissions;
        const threadAuthorUserId = thread?.messages[0]?.user_id ?? threadRange.metadata?.user_id ?? undefined;
        return {
            ...permissions,
            canDeleteThread: canDeleteThread(permissions, this.userId, threadAuthorUserId),
            threadAuthorUserId,
        };
    }

    private collectProjectDocuments(folder?: FolderEntity, basePath = ''): Array<{
        doc: DocumentEntity,
        filePath: string,
    }> {
        const currentFolder = folder ?? this.root?.rootFolder[0];
        if (!currentFolder) {
            return [];
        }

        const docEntries = currentFolder.docs.map((doc) => ({
            doc,
            filePath: `${basePath}${doc.name}`,
        }));
        const childEntries = currentFolder.folders.flatMap((childFolder) => this.collectProjectDocuments(childFolder, `${basePath}${childFolder.name}/`));
        return [...docEntries, ...childEntries];
    }

    private buildReviewEntriesForDocuments(documents: Array<{
        doc: DocumentEntity,
        filePath: string,
    }>): OverleafReviewThreadEntry[] {
        const entries: OverleafReviewThreadEntry[] = [];
        const palette = getConfiguredCommentUserPalette().palette;

        for (const {doc, filePath} of documents) {
            const ranges = this.getCommentRanges(doc._id).sort((left, right) => left.op.p - right.op.p);
            if (ranges.length===0) {
                continue;
            }

            const docText = doc.localCache ?? doc.remoteCache ?? '';
            const colorsByUser = new Map<string, string>();
            const emittedThreadIds = new Set<string>();
            for (const range of ranges) {
                const canonicalThreadId = this.resolveCanonicalCommentThreadId(range.op.t);
                if (emittedThreadIds.has(canonicalThreadId)) {
                    continue;
                }
                const thread = this.resolveCommentThreadForRange(range);
                const messages = thread?.messages ?? [];
                if (messages.length===0) {
                    continue;
                }
                emittedThreadIds.add(canonicalThreadId);

                const permissions = this.getCommentThreadPermissions(canonicalThreadId);
                const rootMessage = messages[0];
                const canMutateRootPendingMessage = this.canMutateLocalPendingCommentMessage(rootMessage);
                const rangeStart = positionAtOffset(docText, range.op.p);
                const rangeEnd = positionAtOffset(docText, range.op.p + range.op.c.length);
                const lastActivityAt = messages.reduce((latest, message) => {
                    const timestamp = new Date(message.timestamp).valueOf();
                    if (Number.isNaN(timestamp)) {
                        return latest;
                    }
                    return Math.max(latest, timestamp);
                }, 0);

                entries.push({
                    canDeleteRootComment: (permissions.canDeleteComment?.(rootMessage.user_id) ?? false) || canMutateRootPendingMessage,
                    canEditRootComment: (permissions.canEditComment?.(rootMessage.user_id) ?? false) || canMutateRootPendingMessage,
                    canReply: Boolean(permissions.comment),
                    canResolveThread: Boolean(permissions.canResolveThread),
                    docId: doc._id,
                    filePath,
                    headerPreview: formatCommentThreadPreview(range.op.c),
                    lastActivityAt,
                    messages: messages.map((message, index) => ({
                        authorName: describeOverleafCommentAuthor(message),
                        canDelete: (permissions.canDeleteComment?.(message.user_id) ?? false)
                            || this.canMutateLocalPendingCommentMessage(message),
                        canEdit: (permissions.canEditComment?.(message.user_id) ?? false)
                            || this.canMutateLocalPendingCommentMessage(message),
                        content: message.content,
                        deleteOwnOnly: !permissions.resolveAllComments,
                        id: message.id,
                        isRoot: index===0,
                        timestamp: formatOverleafCommentTimestamp(message.timestamp) ?? '',
                        userColor: this.resolveReviewUserColor(colorsByUser, palette, message),
                        userId: message.user_id,
                    })),
                    overleafUri: this.pathToUri(...filePath.split('/').filter(Boolean)).toString(),
                    rangeEnd,
                    rangeStart,
                    resolved: Boolean(thread?.resolved ?? range.resolved),
                    rootCommentId: rootMessage.id,
                    rootCommentUserId: rootMessage.user_id,
                    selectedText: range.op.c,
                    threadId: canonicalThreadId,
                });
            }
        }

        return sortReviewThreadEntries(entries);
    }

    private resolveReviewUserColor(
        colorsByUser: Map<string, string>,
        palette: readonly string[],
        message: OverleafCommentMessage,
    ) {
        const userIdentifier = resolveCommentUserIdentifier(message);
        const existing = colorsByUser.get(userIdentifier);
        if (existing) {
            return existing;
        }
        const color = resolveCommentUserColorByIndex(colorsByUser.size, palette);
        colorsByUser.set(userIdentifier, color);
        return color;
    }

    private async ensureProjectCommentRangesLoaded(options: {
        blocking?: boolean,
        docIds?: string[],
        reason?: string,
        skipThreadHydration?: boolean,
    } = {}) {
        const blocking = options.blocking ?? true;
        const targetDocIds = options.docIds && options.docIds.length > 0
            ? new Set(options.docIds)
            : undefined;
        const reason = options.reason ?? 'review_index';
        const skipThreadHydration = options.skipThreadHydration ?? false;

        if (!blocking) {
            void this.ensureProjectCommentRangesLoaded({
                blocking: true,
                docIds: targetDocIds ? Array.from(targetDocIds) : undefined,
                reason: `${reason}_background`,
                skipThreadHydration,
            });
            return;
        }

        if (this.projectCommentRangesHydrationPromise) {
            return this.projectCommentRangesHydrationPromise;
        }

        this.projectCommentRangesHydrationPromise = (async () => {
            if (!skipThreadHydration) {
                await this.ensureCommentThreadsLoaded();
            }
            const documents = this.collectProjectDocuments();
            const scopedDocuments = targetDocIds
                ? documents.filter(({doc}) => targetDocIds.has(doc._id))
                : documents;
            this.logDiagnostic('comments.review_index_hydration_started', {
                documentCount: scopedDocuments.length,
                loadedDocCount: this.commentRangesByDocId.size,
                reason,
                targetDocCount: targetDocIds?.size ?? 0,
            });
            for (const entry of scopedDocuments) {
                if (this.commentRangesByDocId.has(entry.doc._id)) {
                    continue;
                }
                try {
                    await this.openFile(this.pathToUri(...entry.filePath.split('/').filter(Boolean)));
                } catch (error) {
                    this.logDiagnostic('comments.review_index_doc_hydration_failed', {
                        docId: entry.doc._id,
                        filePath: entry.filePath,
                        reason,
                    }, error);
                }
            }
            this.logDiagnostic('comments.review_index_hydration_completed', {
                documentCount: scopedDocuments.length,
                loadedDocCount: this.commentRangesByDocId.size,
                reason,
                targetDocCount: targetDocIds?.size ?? 0,
            });
        })().finally(() => {
            this.projectCommentRangesHydrationPromise = undefined;
        });

        return this.projectCommentRangesHydrationPromise;
    }

    async warmProjectCommentState(reason = 'project_comment_state_warmup') {
        if (this.projectCommentWarmupPromise) {
            return this.projectCommentWarmupPromise;
        }

        this.projectCommentWarmupPromise = (async () => {
            if (!this.root) {
                this.logDiagnostic('comments.project_state_warm_skipped', {
                    reason,
                    rootReady: false,
                });
                return;
            }

            const projectDocuments = this.collectProjectDocuments();
            const projectDocIds = projectDocuments.map(({doc}) => doc._id);
            const previousThreadCount = this.commentThreads.size;
            const previousLoadedDocIds = new Set(this.commentRangesByDocId.keys());

            this.logDiagnostic('comments.project_state_warm_started', {
                loadedDocCount: this.commentRangesByDocId.size,
                reason,
                targetDocCount: projectDocIds.length,
                threadCount: previousThreadCount,
            });

            await this.ensureCommentThreadsLoaded();
            await this.ensureProjectCommentRangesLoaded({
                blocking: true,
                docIds: projectDocIds,
                reason,
                skipThreadHydration: true,
            });

            const loadedProjectDocIds = projectDocIds.filter((docId) => this.commentRangesByDocId.has(docId));
            const newlyLoadedProjectDocIds = loadedProjectDocIds.filter((docId) => !previousLoadedDocIds.has(docId));
            const nextThreadCount = this.commentThreads.size;

            this.logDiagnostic('comments.project_state_warm_completed', {
                loadedDocCount: loadedProjectDocIds.length,
                newlyLoadedDocCount: newlyLoadedProjectDocIds.length,
                reason,
                targetDocCount: projectDocIds.length,
                threadCount: nextThreadCount,
            });

            if (newlyLoadedProjectDocIds.length > 0 || (previousThreadCount===0 && nextThreadCount > 0)) {
                this.emitCommentsChanged('comments_project_index_hydrated', {
                    docIds: loadedProjectDocIds,
                    threadIds: Array.from(this.commentThreads.keys()),
                });
            }
        })().finally(() => {
            this.projectCommentWarmupPromise = undefined;
        });

        return this.projectCommentWarmupPromise;
    }

    private setConnectionPhase(phase: RealtimeConnectionPhase, reason: string, fields: Record<string, unknown> = {}) {
        if (this.connectionPhase===phase) {
            return;
        }
        this.connectionPhase = phase;
        this.connectionPhaseSequence += 1;
        this.logDiagnostic('connection.phase_changed', {
            phase,
            phaseSequence: this.connectionPhaseSequence,
            reason,
            ...fields,
        });
        EventBus.fire('realtimeConnectionStateChangedEvent', {
            origin: this.origin.toString(),
            phase,
            projectId: this.projectId,
            reason,
            retryConnection: this.retryConnection,
            serverName: this.serverName,
        });
        this.refreshSyncNotificationState(reason);
    }

    private nextMutationAttemptId() {
        this.mutationAttemptId += 1;
        return this.mutationAttemptId;
    }

    private buildTextUpdateHash(nextText: string, doc: DocumentEntity) {
        if (!doc.mtime || Date.now() - doc.mtime > 5000) {
            doc.mtime = Date.now();
            return require('crypto').createHash('sha1').update(
                `blob ${nextText.length}\x00${nextText}`,
            ).digest('hex');
        }
        return undefined;
    }

    private rememberPendingLocalTextEcho(docId: string, version: number, op: UpdateSchema['op']) {
        const nextEchoes = this.pendingLocalTextEchoes.get(docId) ?? [];
        nextEchoes.push({
            nextVersion: version + 1,
            signature: serializeTextOperations(op),
            version,
        });
        this.pendingLocalTextEchoes.set(docId, nextEchoes);
    }

    private discardStalePendingLocalTextEchoes(docId: string, incomingVersion: number) {
        const pendingEchoes = this.pendingLocalTextEchoes.get(docId);
        if (!pendingEchoes || pendingEchoes.length===0) {
            return;
        }
        const nextEchoes = pendingEchoes.filter((entry) => entry.nextVersion > incomingVersion);
        if (nextEchoes.length===0) {
            this.pendingLocalTextEchoes.delete(docId);
            return;
        }
        this.pendingLocalTextEchoes.set(docId, nextEchoes);
    }

    private consumePendingLocalTextEcho(docId: string, version: number, op: UpdateSchema['op']) {
        const pendingEchoes = this.pendingLocalTextEchoes.get(docId);
        if (!pendingEchoes || pendingEchoes.length===0) {
            return false;
        }
        const signature = serializeTextOperations(op);
        const nextEchoes = pendingEchoes.filter((entry) => !(entry.version===version && entry.signature===signature));
        const consumed = nextEchoes.length!==pendingEchoes.length;
        if (nextEchoes.length===0) {
            this.pendingLocalTextEchoes.delete(docId);
        } else {
            this.pendingLocalTextEchoes.set(docId, nextEchoes);
        }
        return consumed;
    }

    private async loadDocumentTextStateFromServer(
        doc: DocumentEntity,
        resolvedPath: string,
        reason: string,
        options: {
            localTextOverride?: string,
            persistState?: boolean,
        } = {},
    ) {
        const joinResponse = await this.socket.joinDoc(doc._id);
        const content = joinResponse.docLines.join('\n');
        doc.version = joinResponse.version;
        doc.lastVersion = undefined;
        doc.localCache = options.localTextOverride ?? content;
        doc.remoteCache = content;
        const mergedHydratedRanges = this.mergeHydratedCommentRangesWithPendingCreates(
            doc._id,
            normalizeCommentRanges(joinResponse.ranges?.comments),
        );
        this.setCommentRanges(doc._id, mergedHydratedRanges.mergedRanges, 'doc_join_loaded');
        if (mergedHydratedRanges.preservedThreadIds.length > 0) {
            this.logDiagnostic('comments.doc_join_preserved_pending_creates', {
                docId: doc._id,
                path: resolvedPath,
                preservedThreadIds: mergedHydratedRanges.preservedThreadIds,
            });
        }
        if (options.persistState) {
            this.scheduleOfflineProjectStatePersist(reason);
        }
        this.logDiagnostic('doc.session_joined', {
            commentCount: joinResponse.ranges?.comments?.length ?? 0,
            docId: doc._id,
            lineCount: joinResponse.docLines.length,
            path: resolvedPath,
            preservedPendingCommentCreateCount: mergedHydratedRanges.preservedThreadIds.length,
            reason,
            version: joinResponse.version,
        });
        return {
            doc,
            resolvedPath,
        };
    }

    private async ensureDocumentTextInitialized(uri: vscode.Uri) {
        const resolved = await this._resolveUri(uri);
        if (resolved.fileType!=='doc' || !resolved.fileEntity) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        const doc = resolved.fileEntity as DocumentEntity;
        const resolvedPath = this._resolveById(doc._id)?.path ?? uri.path;
        if (doc.version!==undefined && doc.localCache!==undefined && doc.remoteCache!==undefined) {
            return {
                doc,
                loadedFromCache: true,
                resolvedPath,
            };
        }
        const initialized = await this.loadDocumentTextStateFromServer(
            doc,
            resolvedPath,
            'doc_session_initialized',
        );
        return {
            ...initialized,
            loadedFromCache: false,
        };
    }

    private async rehydrateDocumentTextState(uri: vscode.Uri, reason: string) {
        this.logDiagnostic('doc.rehydrate_started', {
            path: uri.path,
            reason,
        });
        if (shouldBlockDocumentHydrationDuringRecovery({
            isOfflineMode: this.isOfflineMode,
            phase: this.connectionPhase,
        })) {
            await this.waitForRecoveryReady(`doc_rehydrate:${reason}`);
        }
        try {
            const session = await this.ensureDocumentTextInitialized(uri);
            this.logDiagnostic('doc.rehydrate_completed', {
                docId: session.doc._id,
                path: session.resolvedPath,
                reason,
                version: session.doc.version ?? -1,
            });
            return session;
        } catch (error) {
            this.logDiagnostic('doc.rehydrate_failed', {
                path: uri.path,
                reason,
            }, error);
            throw error;
        }
    }

    public async ensureTextDocumentSession(uri: vscode.Uri): Promise<OverleafTextDocumentSessionState> {
        const {doc, resolvedPath, loadedFromCache} = await this.ensureDocumentTextInitialized(uri);
        return {
            docId: doc._id,
            loadedFromCache,
            localText: doc.localCache ?? '',
            overleafUri: this.pathToUri(resolvedPath),
            remoteText: doc.remoteCache ?? '',
            version: doc.version ?? 0,
        };
    }

    public async refreshTextDocumentSessionFromServer(
        uri: vscode.Uri,
        reason: string,
        options: {
            localTextOverride?: string,
        } = {},
    ): Promise<OverleafTextDocumentSessionState> {
        if (shouldBlockDocumentHydrationDuringRecovery({
            isOfflineMode: this.isOfflineMode,
            phase: this.connectionPhase,
        })) {
            await this.waitForRecoveryReady(`text_session_refresh:${reason}`);
        }
        const resolved = await this._resolveUri(uri);
        if (resolved.fileType!=='doc' || !resolved.fileEntity) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        const doc = resolved.fileEntity as DocumentEntity;
        const resolvedPath = this._resolveById(doc._id)?.path ?? uri.path;
        const refreshed = await this.loadDocumentTextStateFromServer(
            doc,
            resolvedPath,
            reason,
            {
                localTextOverride: options.localTextOverride,
                persistState: true,
            },
        );
        return {
            docId: refreshed.doc._id,
            loadedFromCache: false,
            localText: refreshed.doc.localCache ?? '',
            overleafUri: this.pathToUri(refreshed.resolvedPath),
            remoteText: refreshed.doc.remoteCache ?? '',
            version: refreshed.doc.version ?? 0,
        };
    }

    public async pushTextDocumentChanges(
        uri: vscode.Uri,
        localText: string,
        reason: string,
    ): Promise<LiveTextDocumentSyncResult> {
        const {doc, resolvedPath} = await this.ensureDocumentTextInitialized(uri);
        const remoteText = doc.remoteCache ?? '';
        const remoteTextContent = new TextEncoder().encode(remoteText);
        const localTextContent = new TextEncoder().encode(localText);
        const op = buildTextOperations(remoteText, localText);
        if (op.length===0) {
            doc.localCache = localText;
            await this.recordDocumentSyncBaseline({
                content: localTextContent,
                docId: doc._id,
                reason: `${reason}_noop`,
                relPath: this.toDocumentSyncRelPathFromProjectPath(resolvedPath),
                version: doc.version,
            });
            return {kind: 'noop'};
        }

        const currentVersion = doc.version ?? 0;
        const update: UpdateSchema = {
            doc: doc._id,
            lastV: doc.lastVersion,
            op,
            v: currentVersion,
            hash: this.buildTextUpdateHash(localText, doc) as string,
        };
        try {
            await this.socket.applyOtUpdate(doc._id, update);
        } catch (error) {
            if (isLikelyConnectivityFailure(error)) {
                doc.localCache = localText;
                await this.markDocumentSyncDirty({
                    baseContent: remoteTextContent,
                    baseVersion: currentVersion,
                    docId: doc._id,
                    lastKnownRemoteContent: remoteTextContent,
                    lastKnownRemoteVersion: currentVersion,
                    reason,
                    relPath: this.toDocumentSyncRelPathFromProjectPath(resolvedPath),
                });
                this.scheduleOfflineProjectStatePersist(`${reason}_offline_local_cache_persisted`);
                await this.transitionToOfflineMode('text_document_connectivity_failure', error, {
                    docId: doc._id,
                    path: resolvedPath,
                });
                return {kind: 'offline'};
            }
            this.logDiagnostic('text_document.push_failed', {
                docId: doc._id,
                path: resolvedPath,
                reason,
                version: currentVersion,
            }, error);
            return {kind: 'recovery-required'};
        }

        this.rememberPendingLocalTextEcho(doc._id, currentVersion, op);
        doc.lastVersion = currentVersion;
        doc.version = currentVersion + 1;
        doc.localCache = localText;
        doc.remoteCache = localText;
        this.isDirty = true;
        this.scheduleOfflineProjectStatePersist(reason);
        await this.recordDocumentSyncBaseline({
            content: localTextContent,
            docId: doc._id,
            reason,
            relPath: this.toDocumentSyncRelPathFromProjectPath(resolvedPath),
            version: doc.version,
        });
        this.logDiagnostic('text_document.push_succeeded', {
            docId: doc._id,
            opCount: op.length,
            path: resolvedPath,
            reason,
            version: doc.version,
        });
        return {kind: 'applied'};
    }

    public acceptRemoteTextUpdate(
        docId: string,
        nextRemoteText: string,
        nextLocalText: string,
        nextVersion: number,
        reason: string,
    ) {
        const resolved = this._resolveById(docId);
        if (!resolved || resolved.fileType!=='doc') {
            return;
        }
        const doc = resolved.fileEntity as DocumentEntity;
        doc.localCache = nextLocalText;
        doc.remoteCache = nextRemoteText;
        doc.version = nextVersion;
        this.scheduleOfflineProjectStatePersist(reason);
        const relPath = this.toDocumentSyncRelPathFromProjectPath(resolved.path);
        const remoteContent = new TextEncoder().encode(nextRemoteText);
        if (nextLocalText===nextRemoteText) {
            void this.recordDocumentSyncBaseline({
                content: remoteContent,
                docId,
                reason,
                relPath,
                version: nextVersion,
            }).catch((error) => {
                this.logDiagnostic('document_sync.accept_remote_baseline_failed', {
                    docId,
                    relPath,
                    version: nextVersion,
                }, error);
            });
            return;
        }
        void this.recordDocumentSyncRemoteState({
            content: remoteContent,
            docId,
            reason,
            relPath,
            version: nextVersion,
        }).catch((error) => {
            this.logDiagnostic('document_sync.accept_remote_state_failed', {
                docId,
                relPath,
                version: nextVersion,
            }, error);
        });
    }

    public async requestRealtimeRecovery(reason: InitializationReason = 'document_version_mismatch') {
        this.pendingRecoveryReason = reason;
        this.scheduleRecovery(reason);
    }

    private clearRecoveryTimer() {
        if (!this.recoveryTimer) {
            return;
        }
        clearTimeout(this.recoveryTimer);
        this.recoveryTimer = undefined;
    }

    private createInitializationPromise(reason: InitializationReason, options: {
        allowFallback: boolean,
        autoCompileAfterInitialization: boolean,
        preserveRoot: boolean,
        showReloadPrompt: boolean,
    }): Promise<ProjectEntity> {
        this.bootstrapAttemptId += 1;
        const bootstrapAttemptId = this.bootstrapAttemptId;
        const previousRoot = this.root;
        const previousBootstrapSource = this.bootstrapSource;
        const previousReadonlyMode = this.readonlyMode;
        if (!options.preserveRoot) {
            this.root = undefined;
            this.chatSession.reset('initialization_reset');
        }
        this.outputBuildId = undefined;
        this.publicId = undefined;
        this.fallbackCurrentArchiveVersion = undefined;
        this.fallbackCurrentArchiveFiles = undefined;
        this.fallbackArchiveVersion = undefined;
        this.fallbackArchiveFiles = undefined;
        this.clearRecoveryTimer();
        this.setConnectionPhase(
            resolveInitializationConnectionPhase(reason, options.preserveRoot),
            reason,
            {
                allowFallback: options.allowFallback,
                autoCompileAfterInitialization: options.autoCompileAfterInitialization,
                preserveRoot: options.preserveRoot,
            },
        );
        this.logDiagnostic('init.start', {
            allowFallback: options.allowFallback,
            autoCompileAfterInitialization: options.autoCompileAfterInitialization,
            bootstrapAttemptId,
            preserveRoot: options.preserveRoot,
            reason,
        });

        const initializationPromise = this.loadDeferredSynchronizationQueue()
            .then(async () => {
                if (!options.preserveRoot) {
                    await this.restorePersistedChatStateForInitialization();
                }
            })
            .then(() => this.bootstrapProject(options.allowFallback))
            .then((project) => this.finishInitialization(project, reason, options.autoCompileAfterInitialization))
            .catch((error) => {
                this.logDiagnostic('init.failed', {
                    allowFallback: options.allowFallback,
                    autoCompileAfterInitialization: options.autoCompileAfterInitialization,
                    bootstrapAttemptId,
                    preserveRoot: options.preserveRoot,
                    reason,
                }, error);
                if (options.preserveRoot && previousRoot) {
                    this.root = previousRoot;
                    this.bootstrapSource = previousBootstrapSource;
                    this.readonlyMode = previousReadonlyMode;
                    this.setConnectionPhase('recovering', reason, {
                        bootstrapAttemptId,
                        preservedRootDocId: previousRoot.rootDoc_id,
                    });
                    this.logDiagnostic('recovery.state_preserved', {
                        bootstrapAttemptId,
                        preservedRootDocId: previousRoot.rootDoc_id,
                        reason,
                    });
                } else if (options.showReloadPrompt) {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t('Connection lost: {serverName}', {serverName:this.serverName}),
                        vscode.l10n.t('Reload'),
                    ).then((choice) => {
                        if (choice==='Reload') {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    });
                }
                throw error;
        });
        const trackedPromise = initializationPromise.finally(() => {
            if (this.initializing===trackedPromise) {
                this.initializing = undefined;
            }
            // Offline bootstraps can legitimately finish with the cached project
            // while a follow-up recovery request was queued mid-flight. Once the
            // current attempt is fully released, restart the recovery timer so
            // reconnect detection continues without requiring user action.
            if (this.deferredSynchronizationMode==='offline' && !this.recoveryTimer) {
                const queuedRecoveryReason = this.pendingRecoveryReason ?? 'socket_disconnect';
                this.pendingRecoveryReason = undefined;
                this.logDiagnostic('recovery.rescheduled_after_initialization', {
                    queuedRecoveryReason,
                    reason,
                });
                this.scheduleRecovery(queuedRecoveryReason);
            }
        });
        return trackedPromise;
    }

    private scheduleRecovery(reason: InitializationReason) {
        if (this.recoveryTimer) {
            this.logDiagnostic('recovery.already_scheduled', {
                delayMs: calculateRecoveryDelayMs(this.retryConnection),
                reason,
            });
            return;
        }
        if (this.initializing) {
            this.pendingRecoveryReason = reason;
            this.logDiagnostic('recovery.skipped_inflight', {reason});
            return;
        }

        this.recoveryAttemptId += 1;
        const recoveryAttemptId = this.recoveryAttemptId;
        const delayMs = calculateRecoveryDelayMs(this.retryConnection);
        this.setConnectionPhase('recovering', reason, {
            delayMs,
            recoveryAttemptId,
        });
        this.logDiagnostic('recovery.scheduled', {
            delayMs,
            reason,
            recoveryAttemptId,
        });
        this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = undefined;
            this.logDiagnostic('recovery.started', {
                delayMs,
                reason,
                recoveryAttemptId,
            });
            const recoveryPromise = this.createInitializationPromise(reason, {
                allowFallback: this.readonlyMode,
                autoCompileAfterInitialization: false,
                preserveRoot: true,
                showReloadPrompt: false,
            });
            this.initializing = recoveryPromise;
            void recoveryPromise
                .then((project) => {
                    this.logDiagnostic('recovery.succeeded', {
                        reason,
                        recoveredRootDocId: project.rootDoc_id,
                        recoveryAttemptId,
                    });
                    return project;
                })
                .catch((error) => {
                    this.logDiagnostic('recovery.failed', {
                        reason,
                        recoveryAttemptId,
                    }, error);
                    if (reason==='socket_disconnect') {
                        this.retryConnection += 1;
                    }
                    setTimeout(() => this.scheduleRecovery(reason), 0);
                    // Recovery runs in the background. Keep failures in
                    // diagnostics and reschedule silently instead of surfacing
                    // them as unhandled background errors.
                });
        }, delayMs);
    }

    private ensureRemoteWatchRegistered() {
        if (!this.remoteWatchRegistered) {
            this.remoteWatch();
            this.remoteWatchRegistered = true;
        }
    }

    private async bootstrapProject(allowFallback: boolean = true): Promise<ProjectEntity> {
        this.ensureRemoteWatchRegistered();
        const bootstrapAttemptId = this.bootstrapAttemptId;
        this.logDiagnostic('bootstrap.start', {
            allowFallback,
            bootstrapAttemptId,
        });
        try {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const pageMetadata = await this.api.getProjectPageMetadata(identity, this.projectId);
            this.logDiagnostic('bootstrap.metadata_loaded', {
                bootstrapAttemptId,
                pageProjectName: pageMetadata.projectName,
                settingsCompilerCount: pageMetadata.settings.compilers.length,
                settingsLanguageCount: pageMetadata.settings.languages.length,
                wsUrl: pageMetadata.wsUrl ?? '',
            });

            try {
                const project = await this.tryRealtimeBootstrap(pageMetadata, pageMetadata.wsUrl);
                this.logDiagnostic('bootstrap.realtime_succeeded', {
                    bootstrapAttemptId,
                    projectRootDocId: project.rootDoc_id,
                });
                return project;
            } catch (socketError) {
                this.logDiagnostic('bootstrap.realtime_failed', {bootstrapAttemptId}, socketError);
                if (pageMetadata.wsUrl) {
                    try {
                        this.logDiagnostic('bootstrap.realtime_retry_default_target', {bootstrapAttemptId});
                        const project = await this.tryRealtimeBootstrap(pageMetadata);
                        this.logDiagnostic('bootstrap.realtime_default_target_succeeded', {
                            bootstrapAttemptId,
                            projectRootDocId: project.rootDoc_id,
                        });
                        return project;
                    } catch (defaultSocketError) {
                        this.logDiagnostic('bootstrap.realtime_default_target_failed', {bootstrapAttemptId}, defaultSocketError);
                        if (!allowFallback) {
                            this.logDiagnostic('bootstrap.fallback_skipped', {
                                allowFallback,
                                bootstrapAttemptId,
                                reason: 'realtime_required_for_recovery',
                            });
                            throw defaultSocketError;
                        }
                    }
                }
                if (!allowFallback) {
                    this.logDiagnostic('bootstrap.fallback_skipped', {
                        allowFallback,
                        bootstrapAttemptId,
                        reason: 'realtime_required_for_recovery',
                    });
                    throw socketError;
                }
                return await this.bootstrapProjectFromFallback(identity, pageMetadata);
            }
        } catch (error) {
            this.logDiagnostic('bootstrap.failed', {bootstrapAttemptId}, error);
            const offlineProject = await this.loadOfflineProjectState(
                isLikelyConnectivityFailure(error) ? 'bootstrap_offline_connectivity_failure' : 'bootstrap_offline_snapshot',
            );
            if (offlineProject) {
                return offlineProject;
            }
            throw error;
        }
    }

    private async tryRealtimeBootstrap(pageMetadata: ProjectPageMetadata, wsUrl?: string): Promise<ProjectEntity> {
        this.logDiagnostic('bootstrap.realtime_start', {
            bootstrapAttemptId: this.bootstrapAttemptId,
            wsUrl: wsUrl ?? '',
        });
        this.socket.configureRealtimeConnection(wsUrl);
        await this.socket.prepareForJoin();
        const project = await this.socket.joinProject(this.projectId);
        project.settings = pageMetadata.settings;
        this.bootstrapSource = 'socket';
        this.permissionsLevel = this.socket.permissionsLevel ?? 'readAndWrite';
        this.readonlyMode = false;
        this.retryConnection = 0;
        this.setConnectionPhase(resolveConnectedConnectionPhase({
            readonlyMode: this.readonlyMode,
            usingAlternativeConnectionScheme: this.socket.isUsingAlternativeConnectionScheme,
        }), 'bootstrap_realtime_succeeded', {
            bootstrapAttemptId: this.bootstrapAttemptId,
            wsUrl: wsUrl ?? '',
        });
        return project;
    }

    private async bootstrapProjectFromFallback(identity: Identity, pageMetadata: ProjectPageMetadata): Promise<ProjectEntity> {
        this.logDiagnostic('bootstrap.fallback_start', {bootstrapAttemptId: this.bootstrapAttemptId});
        const entitiesResponse = await this.api.projectEntitiesJson(identity, this.projectId);

        if (entitiesResponse.type!=='success' || entitiesResponse.entities===undefined) {
            this.logDiagnostic('bootstrap.fallback_entities_failed', {
                bootstrapAttemptId: this.bootstrapAttemptId,
                responseType: entitiesResponse.type,
            }, entitiesResponse.message);
            throw new Error(entitiesResponse.message ?? 'Unable to load project entities');
        }

        const project = buildProjectEntityFromFlatEntities(
            this.projectId,
            entitiesResponse.entities,
            pageMetadata,
            true,
        );

        this.bootstrapSource = 'fallback';
        this.permissionsLevel = 'readOnly';
        this.readonlyMode = true;
        this.socket.activateAlternativeConnectionScheme(this.origin.toString(), project);
        this.setConnectionPhase(resolveConnectedConnectionPhase({
            readonlyMode: this.readonlyMode,
            usingAlternativeConnectionScheme: this.socket.isUsingAlternativeConnectionScheme,
        }), 'bootstrap_fallback_initialized', {
            bootstrapAttemptId: this.bootstrapAttemptId,
        });
        await this.socket.prepareForJoin();
        this.logDiagnostic('bootstrap.fallback_initialized', {
            bootstrapAttemptId: this.bootstrapAttemptId,
            entityCount: entitiesResponse.entities.length,
            rootDocId: project.rootDoc_id,
        });
        return project;
    }

    private ensureChatViewProviderRegistered(activeCondition: boolean) {
        if (!activeCondition) {
            return;
        }
        if (this.chatViewProviderItem?.triggers) {
            return this.chatViewProviderItem.provider;
        }
        const provider = new ChatViewProvider(this, this.context.extensionUri);
        this.chatViewProviderItem = {
            provider,
            triggers: provider.triggers,
        };
        return provider;
    }

    private async finishInitialization(
        project: ProjectEntity,
        reason: InitializationReason,
        autoCompileAfterInitialization: boolean,
    ): Promise<ProjectEntity> {
        this.root = project;
        this.refreshPrimaryPdfOutputAlias();
        const activeCondition = await doesVfsMatchActiveWorkspaceProject(this.origin);
        const chatViewer = this.ensureChatViewProviderRegistered(activeCondition);
        // Keep status bar providers stable across offline recovery retries.
        // Recreating them briefly removes their status items, which reads as
        // flicker while the project remains offline.
        if (activeCondition && chatViewer && !this.clientManagerItem?.triggers) {
            const clientManager = new ClientManager(this, this.context, this.publicId||'', this.socket, chatViewer);
            this.clientManagerItem = {
                manager: clientManager,
                triggers: clientManager.triggers,
            };
        }
        // Register: [scm] SCMCollectionProvider in explorer
        if (activeCondition && !this.scmCollectionItem?.triggers) {
            const scmCollection = new SCMCollectionProvider(this, this.context);
            this.scmCollectionItem = {
                collection: scmCollection,
                triggers: scmCollection.triggers,
            };
        }
        if (this.bootstrapSource==='offline') {
            this.setDeferredSynchronizationMode('offline', reason, {
                bootstrapSource: this.bootstrapSource,
            });
            this.retryConnection = Math.max(this.retryConnection, 1);
            this.scheduleRecovery('socket_disconnect');
        } else if (this.deferredSynchronizationQueue.operations.length > 0) {
            if (!this.hasDeferredRecoverableNonChatOperations && !this.hasDeferredLocalReplicaOperations && this.hasQueuedChatSynchronizationOperations) {
                this.setDeferredSynchronizationMode('online', reason, {
                    bootstrapSource: this.bootstrapSource,
                    pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
                });
                void this.resumeQueuedChatSynchronizationRecovery(`${reason}_queued_chat`);
            } else {
                this.setDeferredSynchronizationMode('sync-recovery', reason, {
                    bootstrapSource: this.bootstrapSource,
                    pendingOperationCount: this.deferredSynchronizationQueue.operations.length,
                });
                if (this.hasQueuedChatSynchronizationOperations && !this.queuedChatSynchronizationRecovery) {
                    void this.resumeQueuedChatSynchronizationRecovery(`${reason}_queued_chat`);
                }
                void this.resumeDeferredSynchronizationRecovery(reason);
            }
        } else {
            this.setDeferredSynchronizationMode('online', reason, {
                bootstrapSource: this.bootstrapSource,
            });
        }
        this.refreshSyncNotificationState(`finish_initialization:${reason}`);
        void this.chatSession.handleConnectionRestored(`initialization:${reason}`);
        void this.refreshCommentStateAfterConnectionRestored(`initialization:${reason}`);
        if (autoCompileAfterInitialization && shouldAutoCompileAfterInitialization(reason)) {
            vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compile`);
        } else {
            this.logDiagnostic('compile.auto_trigger_disabled', {
                autoCompileAfterInitialization,
                reason,
            });
        }
        this.scheduleOfflineProjectStatePersist(`init_finished:${reason}`);
        this.logDiagnostic('init.finished', {
            autoCompileAfterInitialization,
            registeredAsActiveProject: activeCondition,
            bootstrapAttemptId: this.bootstrapAttemptId,
            reason,
            rootDocId: project.rootDoc_id,
            rootFolderCount: project.rootFolder.length,
        });
        return project;
    }

    get isInvisibleMode() {
        return this.socket.isUsingAlternativeConnectionScheme;
    }

    get isReadonlyFallbackMode() {
        return this.readonlyMode;
    }

    toggleInvisibleMode() {
        this.pendingRecoveryReason = 'toggle_invisible_mode';
        this.socket.toggleAlternativeConnectionScheme(this.origin.toString(), this.root);
        this.socket.disconnect(); // jump to `onDisconnected` handler
    }

    private ensureWritable() {
        if (!this.readonlyMode) {
            return;
        }

        throw vscode.FileSystemError.NoPermissions(
            vscode.l10n.t('This project is opened in fallback read-only mode because the Overleaf real-time connection failed.'),
        );
    }

    private normalizeFallbackArchivePath(pathname: string): string {
        return pathname.replace(/^\/+|\/+$/g, '');
    }

    private getFallbackOutputsFolder(): FolderEntity | undefined {
        return this.root?.rootFolder[0].folders.find((folder) => folder._id === __OUTPUTS_ID || folder.name === OUTPUT_FOLDER_NAME);
    }

    getCompileOutputs() {
        return this.getFallbackOutputsFolder()?.outputs ?? [];
    }

    private resolveFolderByProjectPath(projectPath: string) {
        if (!this.root) {
            return undefined;
        }
        const pathParts = projectPath.split('/').filter(Boolean);
        let currentFolder = this.root.rootFolder[0];
        for (const part of pathParts) {
            const nextFolder = currentFolder.folders.find((folder) => folder.name===part);
            if (!nextFolder) {
                return undefined;
            }
            currentFolder = nextFolder;
        }
        return currentFolder;
    }

    private folderHasConflictingEntityName(parentFolder: FolderEntity, name: string, excludeId?: string) {
        return Object.values(FolderKeys).some((key) => {
            return parentFolder[key]?.some((entity) => {
                return entity.name===name && entity._id!==excludeId;
            });
        });
    }

    private refreshPrimaryPdfOutputAlias(outputs = this.getCompileOutputs()) {
        if (!this.root) {
            return {createdPath: undefined, deletedPath: undefined, renderPath: undefined};
        }

        const rootDocPath = this.getRootDocName();
        const existingAlias = this._resolveById(__PRIMARY_PDF_OUTPUT_ID);
        const existingAliasPath = existingAlias?.path.replace(/^\/+/, '');
        const nextRenderPath = resolvePrimaryPdfRenderPath(outputs, rootDocPath);
        const primaryArtifact = selectPrimaryPdfArtifact(outputs, rootDocPath);

        if (!nextRenderPath || !primaryArtifact) {
            if (existingAlias) {
                this.removeEntity(existingAlias.parentFolder, existingAlias.fileType, existingAlias.fileEntity);
                return {createdPath: undefined, deletedPath: existingAliasPath, renderPath: undefined};
            }
            return {createdPath: undefined, deletedPath: undefined, renderPath: undefined};
        }

        const pathParts = nextRenderPath.split('/').filter(Boolean);
        const aliasName = pathParts[pathParts.length - 1] ?? '';
        const parentPath = pathParts.slice(0, -1).join('/');
        const parentFolder = this.resolveFolderByProjectPath(parentPath);
        if (!parentFolder || !aliasName) {
            if (existingAlias) {
                this.removeEntity(existingAlias.parentFolder, existingAlias.fileType, existingAlias.fileEntity);
                return {createdPath: undefined, deletedPath: existingAliasPath, renderPath: undefined};
            }
            return {createdPath: undefined, deletedPath: undefined, renderPath: undefined};
        }

        if (this.folderHasConflictingEntityName(parentFolder, aliasName, __PRIMARY_PDF_OUTPUT_ID)) {
            this.logDiagnostic('compile.primary_pdf_alias_conflict', {
                aliasName,
                renderPath: nextRenderPath,
                rootDocPath,
            });
            if (existingAlias) {
                this.removeEntity(existingAlias.parentFolder, existingAlias.fileType, existingAlias.fileEntity);
                return {createdPath: undefined, deletedPath: existingAliasPath, renderPath: undefined};
            }
            return {createdPath: undefined, deletedPath: undefined, renderPath: undefined};
        }

        const aliasEntity = {
            ...primaryArtifact,
            _id: __PRIMARY_PDF_OUTPUT_ID,
            name: aliasName,
            path: nextRenderPath,
            readonly: true,
        } as OutputFileEntity;

        parentFolder.outputs = parentFolder.outputs ?? [];
        if (existingAlias
            && existingAlias.parentFolder===parentFolder
            && existingAlias.fileEntity.name===aliasName) {
            Object.assign(existingAlias.fileEntity, aliasEntity);
            return {createdPath: undefined, deletedPath: undefined, renderPath: nextRenderPath};
        }

        if (existingAlias) {
            this.removeEntity(existingAlias.parentFolder, existingAlias.fileType, existingAlias.fileEntity);
        }
        this.insertEntity(parentFolder, 'outputs', aliasEntity);
        return {
            createdPath: nextRenderPath,
            deletedPath: existingAliasPath && existingAliasPath!==nextRenderPath ? existingAliasPath : undefined,
            renderPath: nextRenderPath,
        };
    }

    public isPrimaryPdfRenderPath(pathname: string) {
        const alias = this._resolveById(__PRIMARY_PDF_OUTPUT_ID);
        if (!alias) {
            return false;
        }
        const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
        return alias.path===normalizedPath;
    }

    getPrimaryPdfOutputPath() {
        const primaryRenderPath = this._resolveById(__PRIMARY_PDF_OUTPUT_ID)?.path.replace(/^\/+/, '');
        if (primaryRenderPath) {
            return primaryRenderPath;
        }
        return resolvePrimaryPdfOutputPath(this.getCompileOutputs(), this.getRootDocName(), OUTPUT_FOLDER_NAME);
    }

    private async ensureFallbackOutputs(): Promise<OutputFileEntity[] | undefined> {
        const existingOutputs = this.getFallbackOutputsFolder()?.outputs;
        if (existingOutputs && existingOutputs.length > 0) {
            return existingOutputs;
        }

        await this.compile();
        return this.getFallbackOutputsFolder()?.outputs;
    }

    private getFallbackCompiledOutputCandidates(pathname: string): string[] {
        const normalizedPath = this.normalizeFallbackArchivePath(pathname);
        const basename = normalizedPath.split('/').pop();
        const candidates = new Set<string>();

        if (normalizedPath.startsWith(`${OUTPUT_FOLDER_NAME}/`)) {
            candidates.add(normalizedPath.slice(OUTPUT_FOLDER_NAME.length + 1));
        }
        if (basename) {
            candidates.add(basename);
        }

        const rootDocId = this.root?.rootDoc_id;
        if (basename && rootDocId) {
            const rootDoc = this._resolveById(rootDocId);
            const rootDocName = rootDoc?.fileEntity.name;
            const rootDocBase = rootDocName?.replace(/\.[^.]+$/, '');
            if (rootDocBase && basename.startsWith(`${rootDocBase}.`)) {
                candidates.add(`output.${basename.slice(rootDocBase.length + 1)}`);
            }
        }

        return Array.from(candidates);
    }

    private async getFallbackCompiledOutput(pathname: string): Promise<Uint8Array | undefined> {
        const outputCandidates = this.getFallbackCompiledOutputCandidates(pathname);
        if (outputCandidates.length===0) {
            this.logDiagnostic('fallback.compiled_output_skipped', {
                pathname,
                reason: 'no_candidates',
            });
            return undefined;
        }

        const outputs = await this.ensureFallbackOutputs();
        if (!outputs || outputs.length===0) {
            this.logDiagnostic('fallback.compiled_output_unavailable', {
                outputCandidates,
                pathname,
                reason: 'no_outputs',
            });
            return undefined;
        }

        const matchedOutput = outputs.find((output) => outputCandidates.includes(output.path) || outputCandidates.includes(output.name));
        if (!matchedOutput) {
            this.logDiagnostic('fallback.compiled_output_unavailable', {
                outputCandidates,
                outputCount: outputs.length,
                pathname,
                reason: 'no_match',
            });
            return undefined;
        }

        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getFileFromClsi(identity, matchedOutput.url, 'standard');
        if (res.type==='success' && res.content) {
            this.logDiagnostic('fallback.compiled_output_resolved', {
                bytes: res.content.length,
                matchedOutputPath: matchedOutput.path,
                pathname,
            });
            return res.content;
        }

        this.logDiagnostic('fallback.compiled_output_fetch_failed', {
            matchedOutputPath: matchedOutput.path,
            pathname,
        });
        return undefined;
    }

    private async getFallbackCurrentArchiveFiles(version: number): Promise<Map<string, Uint8Array>> {
        if (this.fallbackCurrentArchiveFiles && this.fallbackCurrentArchiveVersion===version) {
            return this.fallbackCurrentArchiveFiles;
        }

        const archive = await this.downloadCurrentProjectArchive();
        if (!archive || archive.length===0) {
            throw new Error(`Unable to download current project archive for ${this.projectId}`);
        }

        this.fallbackCurrentArchiveFiles = await loadProjectArchiveEntries(archive, this.projectName);
        this.fallbackCurrentArchiveVersion = version;
        this.logDiagnostic('fallback.current_archive_loaded', {
            fileCount: this.fallbackCurrentArchiveFiles.size,
            version,
        });
        return this.fallbackCurrentArchiveFiles;
    }

    private async getFallbackArchiveFiles(version?: number): Promise<Map<string, Uint8Array>> {
        const currentVersion = await this.getCurrentVersion();
        const resolvedVersion = version ?? currentVersion;

        if (resolvedVersion===currentVersion) {
            try {
                return await this.getFallbackCurrentArchiveFiles(currentVersion);
            } catch (error) {
                this.logDiagnostic('fallback.current_archive_failed', {
                    currentVersion,
                    requestedVersion: resolvedVersion,
                }, error);
            }
        }

        if (this.fallbackArchiveFiles && this.fallbackArchiveVersion === resolvedVersion) {
            return this.fallbackArchiveFiles;
        }

        const archive = await this.downloadProjectArchive(resolvedVersion);
        if (!archive) {
            throw new Error(`Unable to download project archive for version ${resolvedVersion}`);
        }

        this.fallbackArchiveFiles = await loadProjectArchiveEntries(archive, this.projectName);
        this.fallbackArchiveVersion = resolvedVersion;
        this.logDiagnostic('fallback.version_archive_loaded', {
            fileCount: this.fallbackArchiveFiles.size,
            version: resolvedVersion,
        });
        return this.fallbackArchiveFiles;
    }

    async getFallbackArchiveFile(pathname: string, version?: number): Promise<Uint8Array | undefined> {
        const normalizedPath = this.normalizeFallbackArchivePath(pathname);
        if (!normalizedPath) {
            return undefined;
        }

        const archiveFiles = await this.getFallbackArchiveFiles(version);
        const file = archiveFiles.get(normalizedPath);
        if (!file) {
            this.logDiagnostic('fallback.archive_missing_path', {
                normalizedPath,
                version,
            });
        }
        return file;
    }

    async getFallbackArchiveText(pathname: string, version?: number): Promise<string | undefined> {
        const archiveFile = await this.getFallbackArchiveFile(pathname, version);
        return decodeArchiveTextEntry(archiveFile);
    }

    async _resolveUri(uri: vscode.Uri) {
        // resolve path
        const [parentFolder, fileName] = await (async () => {
            const {pathParts} = parseUri(uri);
            const root = await this.init();

            let currentFolder = root.rootFolder[0];
            for (let i = 0; i < pathParts.length-1; i++) {
                const folderName = pathParts[i];
                const folder = currentFolder.folders.find((folder) => folder.name === folderName);
                if (folder) {
                    currentFolder = folder;
                } else {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
            }
            const fileName = pathParts[pathParts.length-1];
            return [currentFolder, fileName];
        })();
        // resolve file
        const [fileEntity, fileType, fileId] = (() => {
            for (const _type of Object.keys(FolderKeys)) {
                let entity = parentFolder[ FolderKeys[_type] ]?.find((entity) => entity.name === fileName);
                if (!fileName && _type==='folder') { entity = parentFolder; }
                if (entity) {
                    return [entity, _type as FileType, entity._id];
                }
            }
            return [];
        })();
        return {parentFolder, fileName, fileEntity, fileType, fileId};
    }

    _resolveById(entityId: string, root?: FolderEntity, path?:string):{
        parentFolder: FolderEntity, fileEntity: FileEntity, fileType:FileType, path:string
    } | undefined {
        if (!this.root) {
            throw vscode.FileSystemError.FileNotFound();
        }
        root = root || this.root.rootFolder[0];
        path = path || '/';

        if (root._id === entityId) {
            return {parentFolder: root, fileType: 'folder', fileEntity: root, path};
        } else {
            // search files in root
            for (const _type of Object.keys(FolderKeys)) {
                const key = FolderKeys[_type];
                if (key==='folders') { continue; }
                const entity = root[key]?.find((entity) => entity._id === entityId);
                if (entity) {
                    return {parentFolder: root, fileType: _type as FileType, fileEntity: entity, path:path+entity.name};
                }
            }
            // recursive search
            for (const folder of root.folders) {
                const res = this._resolveById(entityId, folder, path+folder.name+'/');
                if (res) { return res; }
            }
        }
        return undefined;
    }

    walk(filter:(entity:FileEntity)=>boolean): {entity:FileEntity, path:string}[] {
        const result = [];
        const folders = this.root ? [{entity:this.root.rootFolder[0], path:'/'}] : [];

        // apply filter to root folder
        filter(folders[0].entity) && result.push(folders[0]);
        // walk through all folders
        for (const folder of folders) {
            for (const [key,value] of Object.entries(FolderKeys)) {
                if (value==='folders') {
                    folder.entity[value]?.forEach((entity) => {
                        folders.push({entity, path:folder.path+entity.name+'/'});
                    });
                }
                folder.entity[value]?.forEach((entity) => {
                    entity._type = key as FileType;
                    filter(entity) && result.push({ entity, path:folder.path+entity.name });
                });
            };
        }

        return result;
    }

    private insertEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index===undefined || index<0) {
            parentFolder[key]?.push(entity as any);
        }
    }

    private removeEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index!==undefined && index>=0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private removeEntityById(parentFolder: FolderEntity, fileType:FileType, entityId: string, recursive?:boolean) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entityId);
        if (index!==undefined && index>=0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private remoteWatch(): void {
        this.socket.updateEventHandlers({
            onDisconnected: () => {
                if (this.root===undefined) { return; } // bypass the first initialization
                const recoveryReason = this.pendingRecoveryReason ?? 'socket_disconnect';
                this.pendingRecoveryReason = undefined;
                this.logDiagnostic('socket.disconnected', {
                    publicId: this.publicId ?? '',
                    recoveryReason,
                });
                if (recoveryReason==='socket_disconnect') {
                    this.retryConnection += 1;
                }
                this.setConnectionPhase('recovering', recoveryReason, {
                    publicId: this.publicId ?? '',
                });
                this.scheduleRecovery(recoveryReason);
            },
            onConnectionAccepted: (publicId:string) => {
                this.retryConnection = 0;
                this.publicId = publicId;
                this.logDiagnostic('socket.connection_accepted', {
                    publicId,
                });
                const acceptedPhase = resolveConnectionAcceptedPhase({
                    initializing: Boolean(this.initializing),
                    isOfflineMode: this.isOfflineMode,
                    readonlyMode: this.readonlyMode,
                    usingAlternativeConnectionScheme: this.socket.isUsingAlternativeConnectionScheme,
                });
                if (acceptedPhase) {
                    this.pendingRecoveryReason = undefined;
                    this.clearRecoveryTimer();
                    this.setConnectionPhase(acceptedPhase, 'socket_connection_accepted', {
                        publicId,
                    });
                }
                if (!this.initializing
                    && !this.isOfflineMode
                    && this.hasDeferredRecoverableNonChatOperations) {
                    void this.resumeDeferredSynchronizationRecovery('socket_connection_accepted');
                }
                this.chatSession.handleConnectionRestored('socket_connection_accepted');
                void this.refreshCommentStateAfterConnectionRestored('socket_connection_accepted');
            },
            onFileCreated: (parentFolderId:string, type:FileType, entity:FileEntity) => {
                const res = this._resolveById(parentFolderId);
                if (res) {
                    const {fileEntity,path} = res;
                    const entityPath = path + entity.name;
                    if (this.readonlyMode) {
                        entity.readonly = true;
                    }
                    this.insertEntity(fileEntity as FolderEntity, type, entity);
                    this.notify([
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(entityPath)}
                    ]);
                    this.scheduleOfflineProjectStatePersist('file_created');
                }
            },
            onFileRenamed: (entityId:string, newName:string) => {
                const res = this._resolveById(entityId);
                if (res) {
                    const {fileEntity} = res;
                    const oldName = fileEntity.name;
                    fileEntity.name = newName;
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)},
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(res.path.replace(oldName, newName))}
                    ]);
                    if (res.fileType==='doc') {
                        this.emitCommentsChanged('doc_renamed', {docIds: [entityId]});
                    }
                    this.scheduleOfflineProjectStatePersist('file_renamed');
                }
            },
            onFileRemoved: (entityId:string) => {
                const res = this._resolveById(entityId);
                if (res) {
                    const {parentFolder, fileType, fileEntity} = res;
                    this.removeEntity(parentFolder, fileType, fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)}
                    ]);
                    if (res.fileType==='doc') {
                        this.commentRangesByDocId.delete(entityId);
                        this.emitCommentsChanged('doc_removed', {docIds: [entityId]});
                    }
                    this.scheduleOfflineProjectStatePersist('file_removed');
                }
            },
            onFileMoved: (entityId:string, folderId:string) => {
                const oldPath = this._resolveById(entityId);
                const newPath = this._resolveById(folderId);
                if (oldPath && newPath) {
                    const newParentFolder = newPath.fileEntity as FolderEntity;
                    this.insertEntity(newParentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(oldPath.path)},
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(newPath.path, oldPath.fileEntity.name)}
                    ]);
                    if (oldPath.fileType==='doc') {
                        this.emitCommentsChanged('doc_moved', {docIds: [entityId]});
                    }
                    this.scheduleOfflineProjectStatePersist('file_moved');
                }
            },
            onFileChanged: (update:UpdateSchema) => {
                const res = this._resolveById(update.doc);
                if (res===undefined) { return; }

                const doc = res.fileEntity as DocumentEntity;
                const textOps = extractTextOperations(update.op);
                const commentOps = update.op?.filter((op) => op.c!==undefined);
                this.discardStalePendingLocalTextEchoes(doc._id, update.v ?? 0);
                if ((textOps?.length ?? 0) > 0 && this.consumePendingLocalTextEcho(doc._id, update.v ?? 0, textOps)) {
                    this.logDiagnostic('text_document.echo_consumed', {
                        docId: doc._id,
                        opCount: textOps.length,
                        path: res.path,
                        version: update.v,
                    });
                    if (update.op && ((commentOps?.length ?? 0) > 0)) {
                        this.applyCommentOps(doc._id, update.op, 'ot_update_applied');
                    }
                    return;
                }
                if (update.v===doc.version) {
                    if (update.op && (textOps?.length ?? 0) > 0 && doc.remoteCache!==undefined) {
                        const previousRemoteText = doc.remoteCache;
                        const content = applyTextOperationsToString(previousRemoteText, textOps);
                        const _uri = this.pathToUri(res.path).toString();
                        const _doc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString()===_uri);
                        // if doc dirty, local cache should diverge from remote cache
                        if (_doc && !_doc.isDirty) {doc.localCache = content;}
                        doc.remoteCache = content;
                        doc.version += 1;
                        this.isDirty = true;
                        this.notify([
                            {type: vscode.FileChangeType.Changed, uri: this.pathToUri(res.path)}
                        ]);
                        EventBus.fire('documentRemoteTextUpdatedEvent', {
                            docId: doc._id,
                            nextRemoteText: content,
                            origin: this.origin.toString(),
                            overleafUri: this.pathToUri(res.path).toString(),
                            previousRemoteText,
                            update,
                        });
                        this.scheduleOfflineProjectStatePersist('remote_doc_changed');
                    } else {
                        doc.version += 1;
                    }
                    if (update.op && ((textOps?.length ?? 0) > 0 || (commentOps?.length ?? 0) > 0)) {
                        this.applyCommentOps(doc._id, update.op, 'ot_update_applied');
                    }
                } else {
                    this.logDiagnostic('text_document.version_mismatch', {
                        currentVersion: doc.version ?? -1,
                        docId: doc._id,
                        incomingVersion: update.v ?? -1,
                        path: res.path,
                    });
                    doc.remoteCache = undefined;
                    doc.localCache = undefined;
                    void this.requestRealtimeRecovery('document_version_mismatch');
                }
            },
            onReceivedMessage: (message: ProjectMessageResponseSchema) => {
                this.chatSession.handleIncomingMessage(message, 'chat_message_received');
            },
            onChatMessageEdited: (messageId:string, userId:string, content:string) => {
                this.chatSession.handleIncomingEdit(messageId, userId, content, 'chat_message_edited');
            },
            onChatMessageDeleted: (messageId:string, userId:string) => {
                this.chatSession.handleIncomingDelete(messageId, userId, 'chat_message_deleted');
            },
            onCommentReceived: (threadId:string, message:OverleafCommentMessage) => {
                const reconciledThreadId = this.reconcileIncomingCommentThreadIdentityByMessageId(
                    threadId,
                    message.id,
                    'thread_message_received_thread_reconciled',
                );
                const reconciledMessageId = this.reconcileOptimisticCommentMessage(reconciledThreadId, message);
                if (reconciledMessageId) {
                    this.logDiagnostic('comments.optimistic_message_reconciled', {
                        localMessageId: reconciledMessageId,
                        serverMessageId: message.id,
                        threadId: reconciledThreadId,
                    });
                }
                this.upsertCommentThread(
                    reconciledThreadId,
                    mergeCommentMessageIntoThread(this.getCommentThreadById(reconciledThreadId), message),
                    'thread_message_received',
                );
            },
            onCommentMessageEdited: (threadId:string, messageId:string, content:string) => {
                this.upsertCommentThread(
                    threadId,
                    editCommentMessageInThread(this.getCommentThreadById(threadId), messageId, content),
                    'thread_message_edited',
                );
            },
            onCommentMessageDeleted: (threadId:string, messageId:string) => {
                const thread = removeCommentMessageFromThread(this.getCommentThreadById(threadId), messageId);
                if (!thread) {
                    return;
                }
                if (thread.messages.length===0) {
                    this.removeCommentThread(threadId, 'thread_deleted_after_last_message_removed');
                    return;
                }
                this.upsertCommentThread(threadId, thread, 'thread_message_deleted');
            },
            onCommentThreadResolved: (threadId:string, user) => {
                this.updateCommentThreadResolvedState(threadId, true, user);
            },
            onCommentThreadReopened: (threadId:string) => {
                this.updateCommentThreadResolvedState(threadId, false);
            },
            onCommentThreadDeleted: (threadId:string) => {
                this.removeCommentThread(threadId, 'thread_deleted');
            },
            onCommentThreadsCreated: (threads) => {
                Object.entries(threads).forEach(([threadId, thread]) => {
                    this.upsertCommentThread(threadId, thread, 'threads_created');
                });
            },
            onSpellCheckLanguageUpdated: (language:string) => {
                if (this.root) {
                    this.root.spellCheckLanguage = language;
                    EventBus.fire('spellCheckLanguageUpdateEvent', {language});
                    this.scheduleOfflineProjectStatePersist('spellcheck_language_updated');
                }
            },
            onCompilerUpdated: (compiler:string) => {
                if (this.root) {
                    this.root.compiler = compiler;
                    EventBus.fire('compilerUpdateEvent', {compiler});
                    this.scheduleOfflineProjectStatePersist('compiler_updated');
                }
            },
            onRootDocUpdated: (rootDocId:string) => {
                //NOTE: do not sync rootDocId
                // if (this.root) {
                //     this.root.rootDoc_id = rootDocId;
                //     EventBus.fire('rootDocUpdateEvent', {rootDocId});
                // }
            },
        });
    }

    pathToUri(...path: string[]): vscode.Uri {
        return vscode.Uri.joinPath(this.origin, ...path);
    }

    async resolve(uri: vscode.Uri): Promise<File> {
        const {fileName, fileEntity, fileType} = await this._resolveUri(uri);
        const readonly = (this.readonlyMode || fileEntity?.readonly) ? vscode.FilePermission.Readonly : undefined;
        switch (fileType) {
            case undefined:
                throw vscode.FileSystemError.FileNotFound(uri);
            case 'folder':
                return new File(fileName, vscode.FileType.Directory, undefined, readonly);
            case 'file':
                if ((fileEntity as FileRefEntity).linkedFileData!==null) {
                    return new File(fileName, vscode.FileType.File | vscode.FileType.SymbolicLink, Date.parse((fileEntity as FileRefEntity).created), readonly);
                } else {
                    return new File(fileName, vscode.FileType.File, Date.parse((fileEntity as FileRefEntity).created), readonly);
                }
            default:
                return new File(fileName, vscode.FileType.File, undefined, readonly);
        }
    }

    async list(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const {fileEntity} = await this._resolveUri(uri);
        const folder = fileEntity as FolderEntity;
        let results:[string, vscode.FileType][] = [];
        if (folder) {
            Object.values(FolderKeys).forEach((key) => {
                const _type = key==='folders'? vscode.FileType.Directory : vscode.FileType.File;
                folder[key]?.forEach((entity) => {
                    results.push([entity.name, _type]);
                });
            });
        }
        return results;
    }

    async openFile(uri: vscode.Uri): Promise<Uint8Array> {
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (!fileEntity) {
            throw vscode.FileSystemError.FileNotFound();
        }
        this.fileOpenAttemptId += 1;
        const openAttemptId = this.fileOpenAttemptId;
        const resolvedPath = this._resolveById(fileEntity._id)?.path ?? uri.path;
        this.logDiagnostic('file.open_start', {
            entityId: fileEntity._id,
            fileType,
            openAttemptId,
            path: resolvedPath,
            synthetic: isSyntheticEntityId(fileEntity._id),
        });

        if (fileType==='doc') {
            const doc = fileEntity as DocumentEntity;
            if (doc.localCache!==undefined || doc.remoteCache!==undefined) {
                let content = doc.localCache ?? doc.remoteCache ?? '';
                let cacheSource = doc.localCache===undefined
                    ? 'remote'
                    : doc.remoteCache===undefined
                        ? 'local'
                        : doc.localCache===doc.remoteCache
                            ? 'shared'
                            : 'local_preferred';
                if (!this.readonlyMode && !this.commentRangesByDocId.has(doc._id)) {
                    try {
                        const joinResponse = await this.socket.joinDoc(doc._id);
                        const joinedContent = joinResponse.docLines.join('\n');
                        const joinedState = resolveJoinedDocumentTextState({
                            joinedText: joinedContent,
                            localText: doc.localCache,
                            remoteText: doc.remoteCache,
                        });
                        doc.version = joinResponse.version;
                        doc.lastVersion = undefined;
                        doc.remoteCache = joinedState.nextRemoteText;
                        doc.localCache = joinedState.nextLocalText;
                        content = joinedState.contentToOpen;
                        cacheSource = joinedState.hasLocalDivergence ? 'local_preferred' : 'remote';
                        const mergedHydratedRanges = this.mergeHydratedCommentRangesWithPendingCreates(
                            doc._id,
                            normalizeCommentRanges(joinResponse.ranges?.comments),
                        );
                        this.setCommentRanges(doc._id, mergedHydratedRanges.mergedRanges, 'doc_join_loaded');
                        this.scheduleOfflineProjectStatePersist('file_open_doc_cache_join_refresh');
                        if (mergedHydratedRanges.preservedThreadIds.length > 0) {
                            this.logDiagnostic('comments.doc_ranges_hydrated_preserved_pending_creates', {
                                docId: doc._id,
                                openAttemptId,
                                path: resolvedPath,
                                preservedThreadIds: mergedHydratedRanges.preservedThreadIds,
                            });
                        }
                        this.logDiagnostic('comments.doc_ranges_hydrated_from_cache', {
                            commentCount: joinResponse.ranges?.comments?.length ?? 0,
                            docId: doc._id,
                            joinedVersion: joinResponse.version,
                            keptLocalDivergence: joinedState.hasLocalDivergence,
                            openAttemptId,
                            path: resolvedPath,
                            preservedPendingCommentCreateCount: mergedHydratedRanges.preservedThreadIds.length,
                        });
                    } catch (error) {
                        this.logDiagnostic('comments.doc_ranges_hydration_failed', {
                            docId: doc._id,
                            openAttemptId,
                            path: resolvedPath,
                        }, error);
                    }
                }
                this.logDiagnostic('file.open_doc_cache_hit', {
                    cacheSource,
                    charLength: content.length,
                    openAttemptId,
                    path: resolvedPath,
                    version: doc.version,
                });
                EventBus.fire('fileWillOpenEvent', {uri});
                return new TextEncoder().encode(content);
            } else {
                if (this.readonlyMode && isSyntheticEntityId(doc._id)) {
                    const docPath = this._resolveById(doc._id)?.path.slice(1);
                    const version = await this.getCurrentVersion();
                    const content = docPath ? await this.getFallbackArchiveText(docPath, version) : undefined;
                    if (content !== undefined) {
                        doc.version = version;
                        doc.remoteCache = content;
                        doc.localCache = content;
                        this.logDiagnostic('file.open_doc_fallback_archive_hit', {
                            charLength: content.length,
                            openAttemptId,
                            path: docPath,
                            version,
                        });
                        EventBus.fire('fileWillOpenEvent', {uri});
                        return new TextEncoder().encode(content);
                    }
                    this.logDiagnostic('file.open_doc_fallback_archive_miss', {
                        openAttemptId,
                        path: docPath,
                        version,
                    });
                }

                const {doc: rehydratedDoc} = await this.rehydrateDocumentTextState(uri, 'file_open');
                const content = rehydratedDoc.remoteCache ?? '';
                this.logDiagnostic('file.open_doc_socket_join', {
                    charLength: content.length,
                    commentCount: this.commentRangesByDocId.get(rehydratedDoc._id)?.length ?? 0,
                    lineCount: content.split('\n').length,
                    openAttemptId,
                    path: resolvedPath,
                    version: rehydratedDoc.version,
                });
                EventBus.fire('fileWillOpenEvent', {uri});
                return new TextEncoder().encode(content);
            }
        } else if (fileType==='outputs') {
            return GlobalStateManager.authenticate(this.context, this.serverName)
            .then((identity) => {
                return this.api.getFileFromClsi(identity, (fileEntity as OutputFileEntity).url, 'standard')
                .then((res) => {
                    if (res.type==='success') {
                        this.logDiagnostic('file.open_output_clsi', {
                            bytes: res.content?.length ?? 0,
                            openAttemptId,
                            path: resolvedPath,
                        });
                        EventBus.fire('fileWillOpenEvent', {uri});
                        return res.content;
                    } else {
                        return new Uint8Array(0);
                    }
                });
            });
        } else {
            const fileId = fileEntity._id;
            if (this.readonlyMode && isSyntheticEntityId(fileId)) {
                const filePath = this._resolveById(fileId)?.path.slice(1);
                const fallbackContent = filePath ? await this.getFallbackArchiveFile(filePath) : undefined;
                if (fallbackContent !== undefined) {
                    this.logDiagnostic('file.open_file_fallback_archive_hit', {
                        bytes: fallbackContent.length,
                        openAttemptId,
                        path: filePath,
                    });
                    EventBus.fire('fileWillOpenEvent', {uri});
                    return fallbackContent;
                }
                const compiledOutputContent = filePath ? await this.getFallbackCompiledOutput(filePath) : undefined;
                if (compiledOutputContent !== undefined) {
                    this.logDiagnostic('file.open_file_fallback_output_hit', {
                        bytes: compiledOutputContent.length,
                        openAttemptId,
                        path: filePath,
                    });
                    EventBus.fire('fileWillOpenEvent', {uri});
                    return compiledOutputContent;
                }
                this.logDiagnostic('file.open_file_fallback_failed', {
                    openAttemptId,
                    path: filePath,
                });
                throw vscode.FileSystemError.Unavailable(
                    vscode.l10n.t('Unable to load "{fileName}" from fallback source or compile outputs.', {
                        fileName: fileEntity.name,
                    }),
                );
            }
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.getFile(identity, this.projectId, fileId);
            if (res.type==='success' && res.content) {
                this.logDiagnostic('file.open_file_api', {
                    bytes: res.content.length,
                    openAttemptId,
                    path: resolvedPath,
                });
                EventBus.fire('fileWillOpenEvent', {uri});
                return res.content;
            } else {
                return new Uint8Array(0);
            }
        }
    }

    async createFile(uri: vscode.Uri, content:Uint8Array, overwrite?:boolean): Promise<void> {
        this.ensureWritable();
        const mutationAttemptId = this.nextMutationAttemptId();
        const {parentFolder, fileName, fileEntity, fileType} = await this._resolveUri(uri);
        this.logDiagnostic('mutation.create.start', {
            bytes: content.length,
            fileName,
            mutationAttemptId,
            overwrite: overwrite === true,
            path: uri.path,
        });
        if (fileEntity && !overwrite) {
            this.logDiagnostic('mutation.create.rejected', {
                fileName,
                mutationAttemptId,
                path: uri.path,
                reason: 'file_exists',
            });
            throw vscode.FileSystemError.FileExists(uri);
        }
        if (fileEntity && overwrite) {
            if (fileType === 'doc') {
                this.logDiagnostic('mutation.create.redirect_write', {
                    fileName,
                    mutationAttemptId,
                    path: uri.path,
                });
                return this.writeFile(uri, content, false, true);
            }
            this.logDiagnostic('mutation.create.rejected', {
                fileName,
                fileType,
                mutationAttemptId,
                path: uri.path,
                reason: 'unsafe_overwrite_existing_non_document',
            });
            throw vscode.FileSystemError.NoPermissions(
                vscode.l10n.t('Overwriting existing non-document files is not supported safely.'),
            );
        }

        let res = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);

        if (content.length===0) {
            const _res = await this.api.addDoc(identity, this.projectId, parentFolder._id, fileName);
            if (_res.type==='success') {
                res = _res.entity;
            }
        } else {
            const parentFolderId = parentFolder._id;
            const _res = await this.api.uploadFile(identity, this.projectId, parentFolderId, fileName, content);
            if (_res.type==='success' && _res.entity!==undefined) {
                res = _res.entity;
            } else {
                if (_res.message!==undefined) {
                    vscode.window.showErrorMessage(_res.message);
                }
            }
        }
        if (res && res._type) {
            this.insertEntity(parentFolder, res._type, res);
            this.notify([
                {type: vscode.FileChangeType.Created, uri: uri},
            ]);
            this.logDiagnostic('mutation.create.success', {
                entityId: res._id,
                fileName,
                fileType: res._type,
                mutationAttemptId,
                path: uri.path,
            });
        } else {
            this.logDiagnostic('mutation.create.failed', {
                fileName,
                mutationAttemptId,
                path: uri.path,
            });
        }
    }

    async refreshLinkedFile(uri: vscode.Uri) {
        this.ensureWritable();
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType==='file' && fileEntity) {
            if ((fileEntity as FileRefEntity).linkedFileData===null) { return; }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `${vscode.l10n.t('Refreshing')} ${fileEntity.name}`,
                cancellable: true,
            }, async (progress, token) => {
                token.onCancellationRequested(() => {});
                
                const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
                const res = await (this.api as ExtendedBaseAPI).refreshLinkedFile(identity, this.projectId, fileEntity._id);

                if (res.type==='success' && res.message!==undefined) {
                    // refresh the entity id
                    fileEntity._id = res.message;
                    this.notify([
                        {type: vscode.FileChangeType.Changed, uri: uri},
                    ]);
                    progress.report({message: vscode.l10n.t('Done')});
                } else {
                    if (res.message!==undefined) {
                        throw new Error(res.message);
                    }
                }
            });
        }
    }

    async createLinkedFile(uri: vscode.Uri) {
        this.ensureWritable();
        const res = await this._resolveUri(uri);
        const parentFolder = res.fileType==='folder' ? res.fileEntity as FolderEntity : res.parentFolder;

        const supportedProviders = [
            vscode.l10n.t('From Another Project'),
            vscode.l10n.t('From External URL'),
        ];
        const selection = await vscode.window.showQuickPick(supportedProviders, {
            placeHolder: vscode.l10n.t('Import file from...'),
        });

        let provider = undefined, entityId = undefined, fileName = undefined, data = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        if (selection === vscode.l10n.t('From Another Project')) {
            provider = 'project_file';
            const allTags = (await this.api.getAllTags(identity)).tags || [];
            const projectId = await vscode.window.showQuickPick(
                (await this.api.userProjectsJson(identity)).projects!
                .filter(project => project.id!==this.projectId)
                .map(project => {
                    let detail = '';
                    for (const tag of allTags) {
                        if (tag.project_ids.includes(project.id)) {
                            detail += `$(tag) ${tag.name} `;
                        }
                    }
                    return {label: project.name, id: project.id, detail};
                }),
                {
                    title: vscode.l10n.t('Select a Project'),
                    ignoreFocusOut: true,
                }
            );
            const filePath = projectId && await vscode.window.showQuickPick(
                (await this.api.projectEntitiesJson(identity, projectId!.id)).entities!.map(entity => entity.path),
                {
                    title: vscode.l10n.t('Select a File'),
                    ignoreFocusOut: true,
                }
            );
            fileName = filePath && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: filePath?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {source_entity_path: filePath!, source_project_id: projectId!.id};
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else if (selection === vscode.l10n.t('From External URL')) {
            provider = 'url';
            const url = await vscode.window.showInputBox({
                title: vscode.l10n.t('URL to fetch the file from'),
                placeHolder: 'https://example.com/my-file.png',
                ignoreFocusOut: true,
            });
            fileName = url && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: url?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {url:url!};
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else {
            return;
        }

        // insert entity
        const entity = {
            _id: entityId!, name: fileName!, _type: 'file', readonly: false,
            linkedFileData: { provider, ...data! },
            created: new Date().toISOString(),
        } as FileRefEntity;
        this.insertEntity(parentFolder, 'file', entity);
        const {path} = this._resolveById(entityId!)!;
        this.notify([
            {type: vscode.FileChangeType.Created, uri: uri.with({path:`/${this.projectName}${path}`})},
        ]);
    }

    async writeFile(uri: vscode.Uri, content:Uint8Array, create:boolean, overwrite:boolean): Promise<void> {
        this.ensureWritable();
        const mutationAttemptId = this.nextMutationAttemptId();
        const {fileType, fileEntity} = await this._resolveUri(uri);
        this.logDiagnostic('mutation.write.start', {
            bytes: content.length,
            create,
            fileType,
            mutationAttemptId,
            overwrite,
            path: uri.path,
        });

        const writePlan = classifyWritePlan(fileType, create);
        if (writePlan.kind === 'create-new') {
            return this.createFile(uri, content, true);
        }
        if (writePlan.kind === 'reject') {
            this.logDiagnostic('mutation.write.rejected', {
                create,
                fileType,
                mutationAttemptId,
                overwrite,
                path: uri.path,
                reason: writePlan.reason,
            });
            switch (writePlan.reason) {
                case 'missing-target':
                    throw vscode.FileSystemError.FileNotFound(uri);
                case 'directory-target':
                    throw vscode.FileSystemError.FileIsADirectory(uri);
                case 'existing-non-document-target':
                    throw vscode.FileSystemError.NoPermissions(
                        vscode.l10n.t('Editing existing non-document files is not supported safely.'),
                    );
            }
        }

        // if exists and is doc --> update
        if (fileType==='doc' && fileEntity) {
            let doc = fileEntity as DocumentEntity;
            const _content = new TextDecoder().decode(content);
            const managedDocumentState = this.getManagedTextDocumentState(uri);
            // Open text documents already flush through the live OT session
            // manager, so save only persists local durability and must not
            // re-run the legacy patch/baseline conflict detector.
            if (managedDocumentState) {
                if (managedDocumentState==='recovery-required') {
                    this.logDiagnostic('save.rejected_live_session_recovery_required', {
                        entityId: doc._id,
                        managedState: managedDocumentState,
                        mutationAttemptId,
                        path: uri.path,
                    });
                    throw vscode.FileSystemError.Unavailable(
                        vscode.l10n.t('Unable to safely save "{fileName}" because the live collaboration session needs recovery. Resolve the recovery state and try again.', {
                            fileName: fileEntity.name,
                        }),
                    );
                }
                doc.localCache = _content;
                this.scheduleOfflineProjectStatePersist('save_bypassed_live_session');
                this.logDiagnostic('legacy_conflict_skipped_live_managed', {
                    entityId: doc._id,
                    managedState: managedDocumentState,
                    mutationAttemptId,
                    path: uri.path,
                });
                this.logDiagnostic('save.bypassed_live_session', {
                    entityId: doc._id,
                    managedState: managedDocumentState,
                    mutationAttemptId,
                    path: uri.path,
                });
                return;
            }
            if (doc.version===undefined || doc.localCache===undefined || doc.remoteCache===undefined) {
                if (this.isRecoveryInProgress() || this.isOfflineMode) {
                    this.logDiagnostic('save.delayed_for_recovery', {
                        entityId: doc._id,
                        managedState: managedDocumentState ?? '',
                        mutationAttemptId,
                        path: uri.path,
                    });
                }
                try {
                    const rehydrated = await this.rehydrateDocumentTextState(uri, 'mutation_write');
                    doc = rehydrated.doc;
                    this.logDiagnostic('save.rehydrated_then_completed', {
                        entityId: doc._id,
                        mutationAttemptId,
                        path: uri.path,
                        version: doc.version ?? -1,
                    });
                } catch (error) {
                    this.logDiagnostic('mutation.write.rejected', {
                        entityId: doc._id,
                        hasLocalCache: doc.localCache !== undefined,
                        hasRemoteCache: doc.remoteCache !== undefined,
                        hasVersion: doc.version !== undefined,
                        mutationAttemptId,
                        path: uri.path,
                        reason: 'document_state_uninitialized',
                    }, error);
                    throw vscode.FileSystemError.Unavailable(
                        vscode.l10n.t('Unable to safely save "{fileName}" because Overleaf is still reconnecting. Please wait a moment and try again.', {
                            fileName: fileEntity.name,
                        }),
                    );
                }
            }
            if (doc.version===undefined || doc.localCache===undefined || doc.remoteCache===undefined) {
                this.logDiagnostic('mutation.write.rejected', {
                    entityId: doc._id,
                    hasLocalCache: doc.localCache !== undefined,
                    hasRemoteCache: doc.remoteCache !== undefined,
                    hasVersion: doc.version !== undefined,
                    mutationAttemptId,
                    path: uri.path,
                    reason: 'document_state_uninitialized_after_rehydrate',
                });
                throw vscode.FileSystemError.Unavailable(
                    vscode.l10n.t('Unable to safely save "{fileName}" because Overleaf is still reconnecting. Please wait a moment and try again.', {
                        fileName: fileEntity.name,
                    }),
                );
            }
            const currentLocalCache: string = doc.localCache;
            const currentRemoteCache: string = doc.remoteCache;
            const currentVersion: number = doc.version;
            const dmp = new DiffMatchPatch();
            const patches = dmp.patch_make(currentLocalCache, currentRemoteCache);

            const mergeResArray = dmp.patch_apply(patches, _content);
            const mergeRes = mergeResArray[0] as string;
            const patchResults = mergeResArray[1] as boolean[];
            if (!allPatchApplicationsSucceeded(patchResults)) {
                this.logDiagnostic('mutation.write.rejected', {
                    entityId: doc._id,
                    failedPatchCount: patchResults.filter(result => !result).length,
                    mutationAttemptId,
                    path: uri.path,
                    reason: 'patch_apply_conflict',
                    version: doc.version,
                });
                throw vscode.FileSystemError.Unavailable(
                    vscode.l10n.t('Unable to safely save "{fileName}" because the remote document changed. Reopen the file and try again.', {
                        fileName: fileEntity.name,
                    }),
                );
            }
            const update: UpdateSchema = {
                doc: doc._id,
                lastV: doc.lastVersion,
                v: currentVersion,
                // Reference: services/web/frontend/js/vendor/libs/sharejs.js#L1288
                hash: (()=>{
                    if (!doc.mtime || Date.now()-doc.mtime>5000) {
                        doc.mtime = Date.now();
                        return require('crypto').createHash('sha1').update(
                            "blob " + mergeRes.length + "\x00" + mergeRes
                        ).digest('hex');
                    }
                })() as string,
                op: (()=>{
                    const remoteCacheAscii = Buffer.from(currentRemoteCache, 'utf-8').toString('utf-8');
                    const mergeResAscii = Buffer.from(mergeRes, 'utf-8').toString('utf-8');
                    let currentPos = 0;
                    return dmp.diff_main(remoteCacheAscii, mergeResAscii)
                                .map((part) => {
                                    // part[0] === -1: delete, 0: equal, 1: insert; part[1]: compared content
                                    const incCount = part[0] === -1 ? 0 : part[1].length;
                                    currentPos += incCount;
                                    // add op when content not equal
                                    if (part[0] !== 0) {
                                        return {
                                            p: currentPos - incCount,
                                            i: part[0] ===  1 ?  part[1] : undefined,
                                            d: part[0] === -1 ?  part[1] : undefined,
                                        };
                                    }
                                })
                                .filter(x => x) as any;
                })(),
            };
            if (!update.op || update.op.length===0) {
                doc.localCache = mergeRes;
                this.logDiagnostic('mutation.write.noop', {
                    entityId: doc._id,
                    mutationAttemptId,
                    path: uri.path,
                    version: doc.version,
                });
                return;
            }
            this.isDirty = (update.op && update.op.length) ? true : false;
            await this.socket.applyOtUpdate(doc._id, update);
            doc.localCache = mergeRes;
            doc.remoteCache = mergeRes;
            setTimeout(() => {
                this.notify([
                    {type: vscode.FileChangeType.Changed, uri: uri}
                ]);
            }, 10);
            doc.lastVersion = doc.version;
            this.logDiagnostic('mutation.write.success', {
                entityId: doc._id,
                mutationAttemptId,
                opCount: update.op.length,
                path: uri.path,
                version: doc.version,
            });
        }
    }

    async mkdir(uri: vscode.Uri) {
        this.ensureWritable();
        const mutationAttemptId = this.nextMutationAttemptId();
        const {parentFolder, fileName, fileEntity} = await this._resolveUri(uri);
        this.logDiagnostic('mutation.mkdir.start', {
            mutationAttemptId,
            path: uri.path,
        });
        if (fileEntity) {
            this.logDiagnostic('mutation.mkdir.rejected', {
                mutationAttemptId,
                path: uri.path,
                reason: 'file_exists',
            });
            throw vscode.FileSystemError.FileExists(uri);
        }
        const [folderName, parentFolderId] = [fileName, parentFolder._id];
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.addFolder(identity, this.projectId, folderName, parentFolderId);

        if (res.type==='success' && res.entity!==undefined) {
            this.insertEntity(parentFolder, 'folder', res.entity as FolderEntity);
            this.notify([
                {type: vscode.FileChangeType.Created, uri: uri},
            ]);
            this.logDiagnostic('mutation.mkdir.success', {
                entityId: res.entity._id,
                mutationAttemptId,
                path: uri.path,
            });
        } else {
            this.logDiagnostic('mutation.mkdir.failed', {
                mutationAttemptId,
                path: uri.path,
            }, res.message);
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
        }
    }

    async remove(uri: vscode.Uri, recursive: boolean) {
        this.ensureWritable();
        const mutationAttemptId = this.nextMutationAttemptId();
        const {parentFolder, fileType, fileEntity} = await this._resolveUri(uri);
        this.logDiagnostic('mutation.remove.start', {
            fileType,
            mutationAttemptId,
            path: uri.path,
            recursive,
        });
        if (fileType==='folder' && fileEntity && !recursive && hasFolderChildren(fileEntity as FolderEntity)) {
            this.logDiagnostic('mutation.remove.rejected', {
                entityId: fileEntity._id,
                mutationAttemptId,
                path: uri.path,
                reason: 'non_recursive_non_empty_folder',
            });
            throw vscode.FileSystemError.NoPermissions(
                vscode.l10n.t('Cannot delete a non-empty folder without the recursive option.'),
            );
        }
        if (fileType && fileEntity) {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.deleteEntity(identity, this.projectId, fileType, fileEntity._id);
            if (res.type==='success') {
                this.removeEntityById(parentFolder, fileType, fileEntity._id, recursive);
                this.notify([
                    {type: vscode.FileChangeType.Deleted, uri: uri},
                ]);
                this.logDiagnostic('mutation.remove.success', {
                    entityId: fileEntity._id,
                    fileType,
                    mutationAttemptId,
                    path: uri.path,
                    recursive,
                });
            } else {
                this.logDiagnostic('mutation.remove.failed', {
                    entityId: fileEntity._id,
                    fileType,
                    mutationAttemptId,
                    path: uri.path,
                    recursive,
                }, res.message);
                if (res.message!==undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
            }
        } else {
            this.logDiagnostic('mutation.remove.rejected', {
                mutationAttemptId,
                path: uri.path,
                reason: 'file_not_found',
            });
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, force: boolean) {
        this.ensureWritable();
        const mutationAttemptId = this.nextMutationAttemptId();
        const oldPath = await this._resolveUri(oldUri);
        const newPath = await this._resolveUri(newUri);
        this.logDiagnostic('mutation.rename.start', {
            force,
            mutationAttemptId,
            newPath: newUri.path,
            oldPath: oldUri.path,
        });

        if (!oldPath.fileType || !oldPath.fileEntity) {
            this.logDiagnostic('mutation.rename.rejected', {
                mutationAttemptId,
                newPath: newUri.path,
                oldPath: oldUri.path,
                reason: 'source_not_found',
            });
            throw vscode.FileSystemError.FileNotFound(oldUri);
        }
        if (oldUri.toString()===newUri.toString()) {
            this.logDiagnostic('mutation.rename.noop', {
                entityId: oldPath.fileEntity._id,
                mutationAttemptId,
                path: oldUri.path,
            });
            return;
        }

        // delete existence firstly
        if (newPath.fileType && newPath.fileEntity) {
            if (!force) {
                this.logDiagnostic('mutation.rename.rejected', {
                    existingTargetId: newPath.fileEntity._id,
                    mutationAttemptId,
                    newPath: newUri.path,
                    oldPath: oldUri.path,
                    reason: 'target_exists',
                });
                throw vscode.FileSystemError.FileExists(newUri);
            }
            await this.remove(newUri, true);
        }
        // rename or move
        let res = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        if (oldPath.parentFolder===newPath.parentFolder) {
            const [entityType, entityId, newName] = [oldPath.fileType, oldPath.fileEntity._id, newPath.fileName];
            res = await this.api.renameEntity(identity, this.projectId, entityType, entityId, newName);
        } else {
            const [entityType, entityId, newParentFolderId] = [oldPath.fileType, oldPath.fileEntity._id, newPath.parentFolder._id];
            res = await this.api.moveEntity(identity, this.projectId, entityType, entityId, newParentFolderId);
        }
        // update local cache
        if (res?.type==='success') {
            const newEntity = Object.assign(oldPath.fileEntity);
            newEntity.name = newPath.fileName;
            this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
            this.insertEntity(newPath.parentFolder, oldPath.fileType, newEntity);
            this.notify([
                {type: vscode.FileChangeType.Deleted, uri: oldUri},
                {type: vscode.FileChangeType.Created, uri: newUri},
            ]);
            this.logDiagnostic('mutation.rename.success', {
                entityId: oldPath.fileEntity._id,
                entityType: oldPath.fileType,
                force,
                mutationAttemptId,
                newPath: newUri.path,
                oldPath: oldUri.path,
            });
        } else {
            this.logDiagnostic('mutation.rename.failed', {
                entityId: oldPath.fileEntity._id,
                entityType: oldPath.fileType,
                force,
                mutationAttemptId,
                newPath: newUri.path,
                oldPath: oldUri.path,
            }, res?.message);
            if (res?.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
        }
    }

    async compile(force:boolean=false, draft:boolean=false, stopOnFirstError:boolean=false, rootDocId?:string) {
        if (force || (this.root && this.isDirty)) {
            this.isDirty = false;
            const shouldClearAuxFilesFirst = shouldClearAuxFilesBeforeCompile({
                outputBuildId: this.outputBuildId,
                outputs: this.getFallbackOutputsFolder()?.outputs,
            });
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            // clear cache if needed
            if (shouldClearAuxFilesFirst) {
                await this.api.deleteAuxFiles(identity, this.projectId);
            }
            // compile project
            const resolvedRootDocId = rootDocId ?? this.root?.rootDoc_id ?? null;
            let rootResourcePath: string | null = null;
            if (resolvedRootDocId) {
                const rootEntry = this._resolveById(resolvedRootDocId);
                if (rootEntry?.path) {
                    rootResourcePath = rootEntry.path.replace(/^\//, '');
                } else {
                    this.logDiagnostic('compile.root_doc_unresolved', {
                        resolvedRootDocId,
                    });
                }
            }
            this.logDiagnostic('compile.start', {
                draft,
                force,
                needCacheClearFirst: shouldClearAuxFilesFirst,
                resolvedRootDocId,
                rootResourcePath,
                stopOnFirstError,
            });
            try {
                const res = await this.api.compile(identity, this.projectId, rootResourcePath, draft, stopOnFirstError);
                if (res.type==='success' && res.compile?.status==='success') {
                    const outputFiles = res.compile.outputFiles ?? [];
                    const outputsUpdated = await this.updateOutputs(outputFiles);
                    const primaryPdfPath = this.getPrimaryPdfOutputPath() ?? '';
                    if (!outputsUpdated) {
                        this.logDiagnostic('compile.outputs_missing', {
                            primaryPdfPath,
                            rootResourcePath,
                        });
                    }
                    this.logDiagnostic('compile.success', {
                        outputCount: outputFiles.length,
                        outputsUpdated,
                        primaryPdfPath,
                        rootResourcePath,
                    });
                    return true;
                } else {
                    this.logDiagnostic('compile.failed', {
                        rootResourcePath,
                        type: res.type,
                    }, res.message);
                    return false;
                }
            } catch (error) {
                this.logDiagnostic('compile.failed', {
                    rootResourcePath,
                    type: 'exception',
                }, error);
                return false;
            }
        }
        return Promise.resolve(undefined);
    }

    async stopCompile() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        this.logDiagnostic('compile.stop_requested');
        const res = await this.api.stopCompile(identity, this.projectId);
        if (res.type==='success') {
            this.logDiagnostic('compile.stop_succeeded');
            return true;
        } else {
            this.logDiagnostic('compile.stop_failed', {}, res.message);
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return false;
        }
    }

    async updateOutputs(outputs: Array<OutputFileEntity>) {
        if (this.root) {
            if (!hasCompileOutputs(outputs)) {
                this.outputBuildId = undefined;
                this.logDiagnostic('compile.outputs_skipped', {
                    reason: 'empty_outputs',
                });
                return false;
            }

            this.outputBuildId = extractOutputBuildId(outputs);
            const primaryPdfPath = resolvePrimaryPdfOutputPath(outputs, this.getRootDocName(), OUTPUT_FOLDER_NAME) ?? '';
            const existingAliasPath = this._resolveById(__PRIMARY_PDF_OUTPUT_ID)?.path.replace(/^\/+/, '');

            const rootFolder = this.root.rootFolder[0];
            if (this.removeEntityById(rootFolder, 'folder', __OUTPUTS_ID)) {
                this.notify([
                    {type:vscode.FileChangeType.Deleted, uri:this.pathToUri(OUTPUT_FOLDER_NAME)}
                ]);
            }

            this.insertEntity(rootFolder, 'folder', {
                _id: __OUTPUTS_ID,
                name: OUTPUT_FOLDER_NAME,
                readonly: true,
                docs: [], fileRefs: [], folders:[],
                outputs: outputs.map((file) => {
                    file._id = __OUTPUTS_ID;
                    file.name=file.path;
                    file.readonly=true;
                    return file;
                })
            } as FolderEntity);
            this.notify([
                {type:vscode.FileChangeType.Created, uri:this.pathToUri(OUTPUT_FOLDER_NAME)},
                ...(outputs.map((file) => {
                    return {type:vscode.FileChangeType.Changed, uri:this.pathToUri(OUTPUT_FOLDER_NAME, file.path)};
                }))
            ]);
            const aliasUpdate = this.refreshPrimaryPdfOutputAlias(outputs);
            if (aliasUpdate.deletedPath) {
                this.notify([
                    {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(aliasUpdate.deletedPath)}
                ]);
            }
            if (aliasUpdate.renderPath) {
                const aliasChangeType = existingAliasPath===aliasUpdate.renderPath && !aliasUpdate.createdPath
                    ? vscode.FileChangeType.Changed
                    : vscode.FileChangeType.Created;
                this.notify([
                    {type: aliasChangeType, uri: this.pathToUri(aliasUpdate.renderPath)}
                ]);
            }
            this.logDiagnostic('compile.outputs_updated', {
                buildId: this.outputBuildId ?? '',
                outputCount: outputs.length,
                pdfOutputCount: outputs.filter((output) => output.type==='pdf' || output.path.toLowerCase().endsWith('.pdf')).length,
                primaryPdfRenderPath: aliasUpdate.renderPath ?? '',
                primaryPdfPath,
            });
            return true;
        }
        return false;
    }

    private async ensureCompiledOutputsAvailable(reason: 'syncCode' | 'syncPdf') {
        if (this.outputBuildId) {
            return true;
        }

        this.logDiagnostic('compile.outputs_recovery_started', {
            reason,
        });
        const compileResult = await this.compile(true);
        const recovered = compileResult===true && this.outputBuildId!==undefined;
        this.logDiagnostic(recovered ? 'compile.outputs_recovery_succeeded' : 'compile.outputs_recovery_failed', {
            compileResult: compileResult ?? 'undefined',
            reason,
        });
        return recovered;
    }

    async syncCode(filePath: string, line:number, column:number) {
        const outputsReady = await this.ensureCompiledOutputsAvailable('syncCode');
        if (!outputsReady) {
            this.logDiagnostic('sync_code.skipped_missing_outputs', {
                buildId: this.outputBuildId ?? '',
                column,
                filePath,
                line,
            });
            return undefined;
        }
        this.logDiagnostic('sync_code.request_started', {
            buildId: this.outputBuildId ?? '',
            column,
            filePath,
            line,
        });
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncCode(identity, this.projectId, filePath, line, column, this.outputBuildId ?? '');
        if (res.type==='success') {
            this.logDiagnostic('sync_code.request_succeeded', {
                buildId: this.outputBuildId ?? '',
                column,
                filePath,
                highlightCount: res.syncCode?.pdf?.length ?? 0,
                line,
            });
            return res.syncCode;
        } else {
            this.logDiagnostic('sync_code.request_failed', {
                buildId: this.outputBuildId ?? '',
                column,
                filePath,
                line,
                responseType: res.type,
            }, res.message);
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    async syncPdf(page:number, h:number, v:number) {
        const outputsReady = await this.ensureCompiledOutputsAvailable('syncPdf');
        if (!outputsReady) {
            this.logDiagnostic('sync_pdf.skipped_missing_outputs', {
                buildId: this.outputBuildId ?? '',
                h,
                page,
                v,
            });
            return undefined;
        }
        this.logDiagnostic('sync_pdf.request_started', {
            buildId: this.outputBuildId ?? '',
            h,
            page,
            v,
        });
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncPdf(identity, this.projectId, page, h, v, this.outputBuildId ?? '');
        if (res.type==='success') {
            this.logDiagnostic('sync_pdf.request_succeeded', {
                buildId: this.outputBuildId ?? '',
                file: res.syncPdf?.file ?? '',
                h,
                line: res.syncPdf?.line ?? -1,
                page,
                v,
            });
            return res.syncPdf;
        } else {
            this.logDiagnostic('sync_pdf.request_failed', {
                buildId: this.outputBuildId ?? '',
                h,
                page,
                responseType: res.type,
                v,
            }, res.message);
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    async spellCheck(uri: vscode.Uri, words: string[]) {
        if (this.root?.spellCheckLanguage==='') { return []; }

        const {fileType} = await this._resolveUri(uri);
        if (fileType==='doc' || fileType==='file') {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = this.root && await this.api.proxyRequestToSpellingApi(identity, this.root.spellCheckLanguage, this.userId, words);
            if (res?.type==='success') {
                return res.misspellings;
            }
        }
    }

    async spellLearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerLearn(identity, this.userId, word);
        if (res.type==='success') {
            this.root?.settings.learnedWords.push(word);
            return true;
        } else {
            return false;
        }
    }

    async spellUnlearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerUnlearn(identity, word);
        if (res.type==='success') {
            const index = this.root?.settings.learnedWords.findIndex((w) => w===word);
            if (index!==undefined && index>=0) {
                this.root?.settings.learnedWords.splice(index, 1);
            }
            return true;
        } else {
            return false;
        }
    }

    getSpellCheckLanguage() {
        const language = this.root?.spellCheckLanguage;
        if (language==='') {
            return {name:'Off', code:''};
        } else {
            return this.root?.settings.languages.find(item => item.code===language);
        }
    }

    getAllSpellCheckLanguages() {
        return this.root?.settings.languages;
    }

    getCompiler() {
        const compiler = this.root?.compiler;
        const compilerItem = this.root?.settings.compilers.find(item => item.code===compiler);
        return compilerItem;
    }

    getAllCompilers() {
        return this.root?.settings.compilers;
    }

    getDictionary() {
        return this.root?.settings.learnedWords;
    }

    getRootDocName() {
        return this._resolveById(this.root?.rootDoc_id!)?.path ?? '';
    }

    getValidMainDocs() {
        return this.walk((entity) => {
            return entity._type==='doc' && entity.name.match(/\.tex$/g)!==null;
        });
    }

    getProjectSCMPersist(scmKey: string) {
        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, this.serverName, this.projectId);
        return scmPersists[scmKey];
    }

    setProjectSCMPersist(scmKey: string, persist: any) {
        GlobalStateManager.updateServerProjectSCMPersist(this.context, this.serverName, this.projectId, scmKey, persist);
    }

    async updateSettings(setting: any): Promise<boolean> {
        this.ensureWritable();
        if (this.isOfflineMode) {
            if (this.root) {
                const keys = Object.keys(setting);
                if (keys.includes('spellCheckLanguage')) {
                    this.root.spellCheckLanguage = setting.spellCheckLanguage;
                }
                if (keys.includes('compiler')) {
                    this.root.compiler = setting.compiler;
                }
                if (keys.includes('rootDocId')) {
                    this.root.rootDoc_id = setting.rootDocId;
                    this.refreshPrimaryPdfOutputAlias();
                }
                this.scheduleOfflineProjectStatePersist('settings_updated_offline');
            }
            await this.appendDeferredSynchronizationOperation({
                createdAt: new Date().toISOString(),
                id: `offline-op-${uuidv4()}`,
                kind: 'settings.update',
                payload: {setting},
            }, 'settings_update_queued');
            return true;
        }
        try {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.updateProjectSettings(identity, this.projectId, setting);
            if (res.type==='success') {
                const keys = Object.keys(setting);
                if (keys.includes('spellCheckLanguage')) {
                    this.root!.spellCheckLanguage = setting.spellCheckLanguage;
                }
                if (keys.includes('compiler')) {
                    this.root!.compiler = setting.compiler;
                }
                if (keys.includes('rootDocId')) {
                    this.root!.rootDoc_id = setting.rootDocId;
                    this.refreshPrimaryPdfOutputAlias();
                }
                this.scheduleOfflineProjectStatePersist('settings_updated');
            }
            return res.type==='success'? true : false;
        } catch (error) {
            if (!isLikelyConnectivityFailure(error)) {
                throw error;
            }
            await this.transitionToOfflineMode('settings_update_connectivity_failure', error);
            return this.updateSettings(setting);
        }
    }

    async metadata() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getMetadata(identity, this.projectId);
        if (res.type==='success') {
            return res.meta?.projectMeta;
        } else {
            return undefined;
        }
    }

    async getUpdates(before?: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetUpdates(identity, this.projectId, before);
        if (res.type==='success') {
            return res.updates;
        } else {
            return undefined;
        }
    }

    async getFileDiff(pathname:string, from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileDiff(identity, this.projectId, pathname, from, to);
        if (res.type==='success') {
            return res.diff;
        } else {
            return undefined;
        }
    }

    async getFileTreeDiff(from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileTreeDiff(identity, this.projectId, from, to);
        if (res.type==='success') {
            return res.treeDiff;
        } else {
            return undefined;
        }
    }

    async getCurrentVersion() {
        const base = this.currentVersion ?? 0;
        let lb = base;
        let rb = base+2**4;
        // firstly try: a) no update `+1`, b) one update `+2`
        const res = await this.getFileTreeDiff(base+1, base+1);
        if (res===undefined) {
            this.currentVersion = base;
            return base;
        }
        const res2 = await this.getFileTreeDiff(base+2, base+2);
        if (res2===undefined) {
            this.currentVersion = base+1;
            return this.currentVersion;
        }
        // locate the actual upper bound
        do {
            const res = await this.getFileTreeDiff(rb, rb);
            if (res!==undefined) {
                rb = lb + (rb-lb)*2;
            } else {
                break;
            }
        } while (true);
        // binary search the current version
        while (lb<rb) {
            const mid = Math.floor((lb+rb)/2);
            const res = await this.getFileTreeDiff(mid, mid);
            if (res!==undefined) {
                lb = mid+1;
            } else {
                rb = mid;
            }
        }
        // update current version
        this.currentVersion = rb-1;
        return this.currentVersion;
    }

    async createLabel(comment: string, version: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.createLabel(identity, this.projectId, comment, version);
        if (res.type==='success') {
            return res.labels?.at(0);
        } else {
            return undefined;
        }
    }

    async deleteLabel(labelId: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.deleteLabel(identity, this.projectId, labelId);
        if (res.type==='success') {
            return true;
        } else {
            return false;
        }
    }

    async downloadProjectArchive(version: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.downloadZipOfVersion(identity, this.projectId, version);
        return res.content;
    }

    async downloadCurrentProjectArchive() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.downloadCurrentProjectZip(identity, this.projectId);
        return res.content;
    }

    async ensureChatHistoryLoaded(reason: string, options: {force?: boolean} = {}) {
        await this.chatSession.ensureHistoryLoaded(reason, options);
    }

    async getMessages(options: {
        force?: boolean,
        reason?: string,
    } = {}): Promise<ChatMessagesLoadResult> {
        return this.chatSession.ensureHistoryLoaded(
            options.reason ?? 'chat_messages_requested',
            {force: options.force},
        );
    }

    private buildChatSendFailureFromApiResponse(response: ChatSendApiResponseSchema): OverleafChatSendResult {
        return buildOverleafChatSendFailure({
            code: response.chatSendErrorCode,
            message: response.message,
            responseBody: response.responseBody,
            route: response.route,
            statusCode: response.statusCode,
            translator: (message) => vscode.l10n.t(message),
        });
    }

    // Chat receive remains socket-driven, but outbound sends go through
    // Overleaf's authenticated REST endpoint with an app-level `client_id`
    // generated by the client session, matching Overleaf's web editor.
    private async sendChatMessageToServer(clientId: string, content: string): Promise<OverleafChatSendResult> {
        const effectiveClientId = this.activeChatClientId?.trim() || clientId.trim();
        if (!effectiveClientId) {
            return buildOverleafChatSendFailure({
                code: 'missing-client-id',
                translator: (message) => vscode.l10n.t(message),
            });
        }

        try {
            const identity = await this.getAuthenticatedTransportIdentity('chat_sendMessage');
            const response = await this.api.sendMessage(identity, this.projectId, effectiveClientId, content);
            if (response.type==='success') {
                return {
                    ok: true,
                    deliveryState: 'delivered',
                    mode: 'online',
                    transport: 'rest',
                };
            }
            return this.buildChatSendFailureFromApiResponse(response);
        } catch (error) {
            if (isLikelyConnectivityFailure(error)) {
                throw error;
            }
            return buildOverleafChatSendFailure({
                message: error instanceof Error ? error.message : String(error),
                translator: (message) => vscode.l10n.t(message),
            });
        }
    }

    async sendMessage(publicId:string, content: string): Promise<OverleafChatSendResult> {
        return this.chatSession.sendMessage(publicId, content);
    }

    async editChatMessage(messageId: string, content: string) {
        await this.chatSession.editMessage(messageId, content);
    }

    async deleteChatMessage(messageId: string) {
        await this.chatSession.deleteMessage(messageId);
    }

    async getCommentSnapshot(uri: vscode.Uri): Promise<OverleafDocumentCommentSnapshot | undefined> {
        const resolved = await this._resolveUri(uri);
        if (!resolved.fileEntity || resolved.fileType!=='doc') {
            return undefined;
        }

        const doc = resolved.fileEntity as DocumentEntity;
        await this.ensureCommentRangesLoaded(uri, doc);
        await this.ensureCommentThreadsLoaded();
        return this.buildCommentSnapshotFromLoadedState(doc);
    }

    async getCommentSnapshotFromLocalState(uri: vscode.Uri): Promise<OverleafDocumentCommentSnapshot | undefined> {
        const resolved = await this._resolveUri(uri);
        if (!resolved.fileEntity || resolved.fileType!=='doc') {
            return undefined;
        }

        const doc = resolved.fileEntity as DocumentEntity;
        if (!this.commentRangesByDocId.has(doc._id)) {
            return undefined;
        }
        return this.buildCommentSnapshotFromLoadedState(doc);
    }

    private buildCommentSnapshotFromLoadedState(doc: DocumentEntity): OverleafDocumentCommentSnapshot {
        const permissions = this.commentPermissions;
        const ranges = this.getCommentRanges(doc._id);
        const seenThreadIds = new Set<string>();
        const threads = [...ranges]
            .sort((left, right) => left.op.p - right.op.p)
            .flatMap((range) => {
                const canonicalThreadId = this.resolveCanonicalCommentThreadId(range.op.t);
                if (seenThreadIds.has(canonicalThreadId)) {
                    return [];
                }
                seenThreadIds.add(canonicalThreadId);
                const normalizedRange = canonicalThreadId===range.op.t
                    ? range
                    : {
                        ...range,
                        op: {
                            ...range.op,
                            t: canonicalThreadId,
                        },
                    };
                return [{
                    range: normalizedRange,
                    thread: this.resolveCommentThreadForRange(normalizedRange),
                }];
            });

        return {
            docId: doc._id,
            permissions,
            threads,
        };
    }

    async getProjectCommentReviewEntries(options: {
        blockingHydration?: boolean,
        docIds?: string[],
        preferLocalState?: boolean,
        reason?: string,
    } = {}): Promise<OverleafReviewThreadEntry[]> {
        const reason = options.reason ?? 'review_index';
        const preferLocalState = options.preferLocalState ?? false;
        const requestedDocIds = options.docIds
            ?.filter((docId) => typeof docId === 'string' && docId.length > 0);
        const targetDocIds = requestedDocIds && requestedDocIds.length > 0
            ? Array.from(new Set(requestedDocIds))
            : undefined;
        const targetDocIdSet = targetDocIds ? new Set(targetDocIds) : undefined;
        const documents = this.collectProjectDocuments();
        const hasScopedDocumentMatch = targetDocIdSet
            ? documents.some(({doc}) => targetDocIdSet.has(doc._id))
            : false;
        const effectiveTargetDocIds = hasScopedDocumentMatch ? targetDocIds : undefined;
        const effectiveTargetDocIdSet = effectiveTargetDocIds ? new Set(effectiveTargetDocIds) : undefined;
        const scopedDocuments = effectiveTargetDocIdSet
            ? documents.filter(({doc}) => effectiveTargetDocIdSet.has(doc._id))
            : documents;
        const requestedBlockingHydration = options.blockingHydration ?? true;
        const hasLocalCommentState = this.commentThreads.size > 0
            || Array.from(this.commentRangesByDocId.values()).some((ranges) => ranges.length > 0);
        const loadedChangedDocCount = effectiveTargetDocIds
            ? effectiveTargetDocIds.filter((docId) => this.commentRangesByDocId.has(docId)).length
            : this.commentRangesByDocId.size;
        const localTargetState = this.collectLocalCommentReviewStateForDocIds(effectiveTargetDocIds);
        const shouldUseLocalState = shouldUseLocalCommentReviewState({
            commentThreadsLoaded: this.commentThreadsLoaded,
            connectionPhase: this.connectionPhase,
            deferredSynchronizationMode: this.deferredSynchronizationMode,
            hasLocalCommentState,
            hasCompleteTargetLocalState: localTargetState.hasCompleteTargetLocalState,
            isOfflineMode: this.isOfflineMode,
            preferLocalState,
        });
        if (!shouldUseLocalState) {
            await this.ensureCommentThreadsLoaded();
        } else if (this.commentThreads.size > 0 && !localTargetState.hasCompleteTargetLocalState) {
            this.commentThreadsLoaded = true;
        }
        const shouldBlockHydration = shouldBlockReviewCommentHydration({
            changedDocIdsCount: effectiveTargetDocIds?.length ?? 0,
            loadedChangedDocCount,
            loadedCommentDocCount: this.commentRangesByDocId.size,
            preferLocalState,
            projectDocumentCount: documents.length,
            requestedBlockingHydration,
        });
        await this.ensureProjectCommentRangesLoaded({
            blocking: shouldBlockHydration,
            docIds: effectiveTargetDocIds,
            reason,
            skipThreadHydration: shouldUseLocalState,
        });
        this.logDiagnostic('comments.review_index_sync_policy', {
            blockingHydration: shouldBlockHydration,
            connectionPhase: this.connectionPhase,
            deferredSynchronizationMode: this.deferredSynchronizationMode,
            effectiveTargetDocCount: effectiveTargetDocIds?.length ?? 0,
            hasLocalCommentState,
            loadedChangedDocCount,
            loadedCommentDocCount: this.commentRangesByDocId.size,
            locallyCompleteTargetDocCount: effectiveTargetDocIds?.length ?? 0,
            locallyIncompleteTargetDocCount: localTargetState.missingDocIds.length,
            locallyIncompleteTargetThreadCount: localTargetState.missingThreadIds.length,
            preferLocalState,
            projectDocumentCount: documents.length,
            requestedDocCount: targetDocIds?.length ?? 0,
            requestedBlockingHydration,
            scopedDocumentCount: scopedDocuments.length,
            hasCompleteTargetLocalState: localTargetState.hasCompleteTargetLocalState,
            incompleteTargetDocIds: localTargetState.missingDocIds,
            shouldUseLocalState,
            threadLoaded: this.commentThreadsLoaded,
            incompleteTargetThreadIds: localTargetState.missingThreadIds,
        });
        const sortedEntries = this.buildReviewEntriesForDocuments(scopedDocuments);
        this.logDiagnostic('comments.review_index_built', {
            documentCount: documents.length,
            loadedDocCount: this.commentRangesByDocId.size,
            threadCount: sortedEntries.length,
        });
        return sortedEntries;
    }

    async getLocalCommentReviewEntry(
        uri: vscode.Uri,
        options: {
            messageId?: string,
            threadId?: string,
        } = {},
    ): Promise<OverleafReviewThreadEntry | undefined> {
        const resolved = await this._resolveUri(uri);
        if (!resolved.fileEntity || resolved.fileType!=='doc') {
            return undefined;
        }

        const doc = resolved.fileEntity as DocumentEntity;
        if (!this.commentRangesByDocId.has(doc._id)) {
            return undefined;
        }

        const filePath = this.resolveDocumentPathById(doc._id) ?? uri.path.replace(/^\//, '');
        const entries = this.buildReviewEntriesForDocuments([{doc, filePath}]);
        const canonicalThreadId = options.threadId
            ? this.resolveCanonicalCommentThreadId(options.threadId)
            : undefined;
        return entries.find((entry) => {
            if (canonicalThreadId && this.resolveCanonicalCommentThreadId(entry.threadId)===canonicalThreadId) {
                return true;
            }
            if (options.messageId && entry.messages.some((message) => message.id===options.messageId)) {
                return true;
            }
            return false;
        });
    }

    async createComment(
        uri: vscode.Uri,
        range: vscode.Range,
        content: string,
        options?: {
            diagnosticTraceContext?: {
                operationId: string,
                traceId: string,
            },
            endOffset?: number,
            localMessage?: OverleafCommentMessage,
            localMessageId?: string,
            localMessageTimestamp?: string,
            selectedText?: string,
            startOffset?: number,
            threadId?: string,
        },
    ): Promise<string> {
        const resolved = await this._resolveUri(uri);
        if (!resolved.fileEntity || resolved.fileType!=='doc') {
            throw new Error(vscode.l10n.t('Comments can only be created on Overleaf documents.'));
        }
        if (range.isEmpty) {
            throw new Error(vscode.l10n.t('Select text before creating an Overleaf comment.'));
        }
        const permissions = this.commentPermissions;
        if (!permissions.comment) {
            throw new Error(vscode.l10n.t('The current Overleaf session is read-only, so comments cannot be created.'));
        }

        const doc = resolved.fileEntity as DocumentEntity;
        await this.ensureCommentRangesLoaded(uri, doc);
        const editorDocument = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString()===uri.toString());
        const selectedText = options?.selectedText
            ?? editorDocument?.getText(range)
            ?? doc.localCache?.slice(
                options?.startOffset ?? editorDocument?.offsetAt(range.start) ?? 0,
                options?.endOffset ?? editorDocument?.offsetAt(range.end) ?? 0,
            )
            ?? '';
        if (selectedText.length===0) {
            throw new Error(vscode.l10n.t('The selected Overleaf comment range is empty.'));
        }

        const startOffset = options?.startOffset
            ?? (editorDocument
                ? editorDocument.offsetAt(range.start)
                : 0);
        const threadId = options?.threadId ?? generateCommentThreadId();
        const commentCreateSpan = startDiagnosticSpan('VirtualFileSystem', 'comments.lifecycle.create', {
            docId: doc._id,
            path: uri.path,
            selectedTextLength: selectedText.length,
            startOffset,
            threadId,
        }, {
            category: 'comments',
            level: 'info',
            operationId: options?.diagnosticTraceContext?.operationId,
            traceId: options?.diagnosticTraceContext?.traceId,
        });
        const filePath = this.resolveDocumentPathById(doc._id) ?? uri.path.replace(/^\//, '');
        this.logDiagnostic('comments.create_started', {
            docId: doc._id,
            operationId: commentCreateSpan.traceContext.operationId,
            path: uri.path,
            rangeEnd: options?.endOffset ?? editorDocument?.offsetAt(range.end) ?? startOffset + selectedText.length,
            rangeStart: startOffset,
            selectedTextLength: selectedText.length,
            traceId: commentCreateSpan.traceContext.traceId,
            threadId,
        });

        const nextRanges = upsertCommentRange(this.getCommentRanges(doc._id), {
            c: selectedText,
            p: startOffset,
            t: threadId,
        }, {
            ts: new Date().toISOString(),
            user_id: this.userId,
        });
        const localMessage = options?.localMessage
            ?? this.buildOfflineCommentMessage(
                content,
                options?.localMessageId ?? `pending-comment-${uuidv4()}`,
                options?.localMessageTimestamp,
            );

        // Local-first state mutation keeps editor threads and review panel entries
        // synchronized immediately while remote persistence is in-flight.
        this.upsertCommentThread(
            threadId,
            mergeCommentMessageIntoThread(undefined, localMessage),
            this.isOfflineMode ? 'thread_message_created_offline' : 'thread_message_created',
        );
        this.setCommentRanges(doc._id, nextRanges, this.isOfflineMode ? 'thread_created_offline' : 'thread_created');
        this.logDiagnostic('comments.create_local_state_mutated', {
            docId: doc._id,
            isOfflineModeAtMutation: this.isOfflineMode,
            localMessageId: localMessage.id,
            operationId: commentCreateSpan.traceContext.operationId,
            path: uri.path,
            rangeCount: this.getCommentRanges(doc._id).length,
            syncModeAtMutation: this.deferredSynchronizationMode,
            threadId,
            threadMessageCount: this.getCommentThreadById(threadId)?.messages.length ?? 0,
            traceId: commentCreateSpan.traceContext.traceId,
        });

        if (this.isOfflineMode) {
            await this.appendDeferredSynchronizationOperation({
                createdAt: new Date().toISOString(),
                id: `offline-op-${uuidv4()}`,
                kind: 'comment.create',
                payload: {
                    content,
                    docId: doc._id,
                    filePath,
                    localMessageId: localMessage.id,
                    selectedText,
                    startOffset,
                    threadId,
                },
            }, 'comment_create_queued');
            this.logDiagnostic('comments.create_completed', {
                docId: doc._id,
                messageId: localMessage.id,
                operationId: commentCreateSpan.traceContext.operationId,
                path: uri.path,
                traceId: commentCreateSpan.traceContext.traceId,
                threadId,
            });
            commentCreateSpan.end({
                mode: 'offline-queued',
                outcome: 'queued',
            });
            return threadId;
        }

        recordOptimisticCommentMessage(this.pendingOptimisticCommentMessages, {
            content: localMessage.content,
            id: localMessage.id,
            threadId,
            userId: localMessage.user_id,
        });

        try {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const messageResponse = await this.api.createCommentMessage(identity, this.projectId, threadId, content);
            if (messageResponse.type!=='success') {
                this.logDiagnostic('comments.create_failed', {
                    docId: doc._id,
                    failureClass: 'persistent',
                    operationId: commentCreateSpan.traceContext.operationId,
                    path: uri.path,
                    traceId: commentCreateSpan.traceContext.traceId,
                    threadId,
                }, messageResponse.message);
                throw new Error(messageResponse.message ?? vscode.l10n.t('Unable to create the Overleaf comment thread.'));
            }

            try {
                const update: UpdateSchema = buildCommentAnchorUpdate({
                    docId: doc._id,
                    docVersion: doc.version ?? 0,
                    lastVersion: doc.lastVersion,
                    selectedText,
                    startOffset,
                    threadId,
                });
                this.logDiagnostic('comments.create_anchor_apply_started', {
                    docId: doc._id,
                    docVersion: doc.version ?? -1,
                    lastVersion: update.lastV ?? null,
                    operationId: commentCreateSpan.traceContext.operationId,
                    traceId: commentCreateSpan.traceContext.traceId,
                    threadId,
                });
                await this.socket.applyOtUpdate(doc._id, update);
                doc.lastVersion = doc.version;
                this.logDiagnostic('comments.create_anchor_apply_completed', {
                    docId: doc._id,
                    docVersion: doc.version ?? -1,
                    operationId: commentCreateSpan.traceContext.operationId,
                    traceId: commentCreateSpan.traceContext.traceId,
                    threadId,
                });
            } catch (error) {
                const rollbackResponse = await this.api.deleteCommentThread(identity, this.projectId, doc._id, threadId)
                    .catch((rollbackError) => {
                        this.logDiagnostic('comments.create_rollback_failed', {
                            docId: doc._id,
                            failureClass: 'internal',
                            operationId: commentCreateSpan.traceContext.operationId,
                            path: uri.path,
                            traceId: commentCreateSpan.traceContext.traceId,
                            threadId,
                        }, rollbackError);
                        return {type: 'error'} as const;
                    });
                this.logDiagnostic('comments.create_anchor_failed', {
                    docId: doc._id,
                    failureClass: 'internal',
                    operationId: commentCreateSpan.traceContext.operationId,
                    path: uri.path,
                    rollbackType: rollbackResponse.type,
                    traceId: commentCreateSpan.traceContext.traceId,
                    threadId,
                }, error);
                throw error;
            }

            if (messageResponse.commentMessage) {
                this.replaceCommentMessageId(threadId, localMessage.id, messageResponse.commentMessage.id);
                this.upsertCommentThread(
                    threadId,
                    mergeCommentMessageIntoThread(this.getCommentThreadById(threadId), messageResponse.commentMessage),
                    'thread_message_received',
                );
            } else {
                this.logDiagnostic('comments.create_message_missing_payload', {
                    docId: doc._id,
                    operationId: commentCreateSpan.traceContext.operationId,
                    path: uri.path,
                    traceId: commentCreateSpan.traceContext.traceId,
                    threadId,
                });
                await this.ensureCommentThreadsLoaded(true);
                await this.resolveDeferredSynchronizedCommentMessageId(threadId, localMessage.id, content);
                this.emitCommentsChanged('thread_message_received', {
                    docIds: [doc._id],
                    threadIds: [threadId],
                });
            }
            this.logDiagnostic('comments.create_completed', {
                docId: doc._id,
                messageId: messageResponse.commentMessage?.id ?? '',
                operationId: commentCreateSpan.traceContext.operationId,
                path: uri.path,
                traceId: commentCreateSpan.traceContext.traceId,
                threadId,
            });
            commentCreateSpan.end({
                mode: 'online',
                outcome: 'created',
            });
            return threadId;
        } catch (error) {
            if (shouldTreatCommentMutationFailureAsTransient(error)) {
                await this.transitionToOfflineMode('comment_create_connectivity_failure', error, {
                    docId: doc._id,
                    threadId,
                });
                await this.appendDeferredSynchronizationOperation({
                    createdAt: new Date().toISOString(),
                    id: `offline-op-${uuidv4()}`,
                    kind: 'comment.create',
                    payload: {
                        content,
                        docId: doc._id,
                        filePath,
                        localMessageId: localMessage.id,
                        selectedText,
                        startOffset,
                        threadId,
                    },
                }, 'comment_create_queued_after_connectivity_failure');
                this.logDiagnostic('comments.create_transient_failure_queued', {
                    docId: doc._id,
                    localRangeCount: this.getCommentRanges(doc._id).length,
                    operationId: commentCreateSpan.traceContext.operationId,
                    queuedOperationCount: this.deferredSynchronizationQueue.operations.length,
                    syncModeAfterQueue: this.deferredSynchronizationMode,
                    threadId,
                    threadMessageCount: this.getCommentThreadById(threadId)?.messages.length ?? 0,
                    traceId: commentCreateSpan.traceContext.traceId,
                }, error);
                this.emitCommentsChanged('thread_created_queued_after_connectivity_failure', {
                    docIds: [doc._id],
                    threadIds: [threadId],
                });
                commentCreateSpan.end({
                    failureClass: 'transient',
                    mode: 'offline-queued',
                    outcome: 'queued_after_connectivity_failure',
                });
                return threadId;
            }
            this.removeCommentThread(threadId, 'thread_created_rolled_back');
            commentCreateSpan.fail(error, {
                failureClass: 'internal',
                mode: 'online',
                outcome: 'rolled_back_after_failure',
            });
            throw error;
        } finally {
            discardOptimisticCommentMessageId(this.pendingOptimisticCommentMessages, localMessage.id);
        }
    }

    async replyToComment(threadId: string, content: string): Promise<void> {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        const permissions = this.commentPermissions;
        if (!permissions.comment) {
            throw new Error(vscode.l10n.t('The current Overleaf session is read-only, so replies cannot be added.'));
        }
        const commentReplySpan = startDiagnosticSpan('VirtualFileSystem', 'comments.lifecycle.reply', {
            contentLength: content.trim().length,
            threadId: canonicalThreadId,
        }, {
            category: 'comments',
            level: 'info',
        });
        const previousThread = this.getCommentThreadById(canonicalThreadId);
        const previousThreadSnapshot = previousThread ? normalizeCommentThread(previousThread) : undefined;
        const localMessage = this.buildOfflineCommentMessage(content, `pending-comment-${uuidv4()}`);

        this.upsertCommentThread(
            canonicalThreadId,
            mergeCommentMessageIntoThread(this.getCommentThreadById(canonicalThreadId), localMessage),
            this.isOfflineMode ? 'thread_reply_created_offline' : 'thread_reply_created',
        );

        if (this.isOfflineMode) {
            await this.appendDeferredSynchronizationOperation({
                createdAt: new Date().toISOString(),
                id: `offline-op-${uuidv4()}`,
                kind: 'comment.reply',
                payload: {
                    content,
                    localMessageId: localMessage.id,
                    threadId: canonicalThreadId,
                },
            }, 'comment_reply_queued');
            commentReplySpan.end({
                mode: 'offline-queued',
                outcome: 'queued',
            });
            return;
        }

        recordOptimisticCommentMessage(this.pendingOptimisticCommentMessages, {
            content: localMessage.content,
            id: localMessage.id,
            threadId: canonicalThreadId,
            userId: localMessage.user_id,
        });

        try {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const response = await this.api.createCommentMessage(identity, this.projectId, canonicalThreadId, content);
            if (response.type!=='success') {
                throw new Error(response.message ?? vscode.l10n.t('Unable to reply to the Overleaf comment thread.'));
            }
            if (response.commentMessage) {
                this.replaceCommentMessageId(canonicalThreadId, localMessage.id, response.commentMessage.id);
                this.upsertCommentThread(
                    canonicalThreadId,
                    mergeCommentMessageIntoThread(this.getCommentThreadById(canonicalThreadId), response.commentMessage),
                    'thread_message_received',
                );
            } else {
                this.logDiagnostic('comments.reply_missing_payload', {
                    threadId: canonicalThreadId,
                });
                await this.ensureCommentThreadsLoaded(true);
                await this.resolveDeferredSynchronizedCommentMessageId(canonicalThreadId, localMessage.id, content);
                this.emitCommentsChanged('thread_message_received', {
                    docIds: this.getCommentDocIdsForThreadId(canonicalThreadId),
                    threadIds: [canonicalThreadId],
                });
            }
            commentReplySpan.end({
                mode: 'online',
                outcome: 'replied',
            });
        } catch (error) {
            if (shouldTreatCommentMutationFailureAsTransient(error)) {
                await this.transitionToOfflineMode('comment_reply_connectivity_failure', error, {
                    threadId: canonicalThreadId,
                });
                await this.appendDeferredSynchronizationOperation({
                    createdAt: new Date().toISOString(),
                    id: `offline-op-${uuidv4()}`,
                    kind: 'comment.reply',
                    payload: {
                        content,
                        localMessageId: localMessage.id,
                        threadId: canonicalThreadId,
                    },
                }, 'comment_reply_queued_after_connectivity_failure');
                commentReplySpan.end({
                    failureClass: 'transient',
                    mode: 'offline-queued',
                    outcome: 'queued_after_connectivity_failure',
                });
                return;
            }
            if (previousThreadSnapshot) {
                this.upsertCommentThread(canonicalThreadId, previousThreadSnapshot, 'thread_reply_rolled_back');
            } else {
                this.removeCommentThread(canonicalThreadId, 'thread_reply_rolled_back');
            }
            commentReplySpan.fail(error, {
                failureClass: 'internal',
                mode: 'online',
                outcome: 'rolled_back_after_failure',
            });
            throw error;
        } finally {
            discardOptimisticCommentMessageId(this.pendingOptimisticCommentMessages, localMessage.id);
        }
    }

    async editComment(threadId: string, messageId: string, content: string): Promise<void> {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        const commentEditSpan = startDiagnosticSpan('VirtualFileSystem', 'comments.lifecycle.edit', {
            contentLength: content.trim().length,
            messageId,
            threadId: canonicalThreadId,
        }, {
            category: 'comments',
            level: 'info',
        });
        const previousThread = this.getCommentThreadById(canonicalThreadId);
        const previousThreadSnapshot = previousThread ? normalizeCommentThread(previousThread) : undefined;

        this.upsertCommentThread(
            canonicalThreadId,
            editCommentMessageInThread(this.getCommentThreadById(canonicalThreadId), messageId, content),
            this.isOfflineMode ? 'thread_message_edited_offline' : 'thread_message_edited',
        );

        if (this.isOfflineMode) {
            const foldedIntoPendingMessage = await this.foldPendingCommentEditIntoDeferredMessageOperation(
                canonicalThreadId,
                messageId,
                content,
                'comment_edit_folded_into_pending_message',
            );
            if (!foldedIntoPendingMessage) {
                await this.appendDeferredSynchronizationOperation({
                    createdAt: new Date().toISOString(),
                    id: `offline-op-${uuidv4()}`,
                    kind: 'comment.edit',
                    payload: {
                        content,
                        messageId,
                        threadId: canonicalThreadId,
                    },
                }, 'comment_edit_queued');
            }
            commentEditSpan.end({
                mode: 'offline-queued',
                outcome: foldedIntoPendingMessage ? 'folded_into_pending_message' : 'queued',
            });
            return;
        }
        try {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const response = await this.api.editCommentMessage(identity, this.projectId, canonicalThreadId, messageId, content);
            if (response.type!=='success') {
                throw new Error(response.message ?? vscode.l10n.t('Unable to edit the Overleaf comment.'));
            }
            commentEditSpan.end({
                mode: 'online',
                outcome: 'edited',
            });
        } catch (error) {
            if (shouldTreatCommentMutationFailureAsTransient(error)) {
                await this.transitionToOfflineMode('comment_edit_connectivity_failure', error, {
                    messageId,
                    threadId: canonicalThreadId,
                });
                const foldedIntoPendingMessage = await this.foldPendingCommentEditIntoDeferredMessageOperation(
                    canonicalThreadId,
                    messageId,
                    content,
                    'comment_edit_folded_into_pending_message_after_connectivity_failure',
                );
                if (!foldedIntoPendingMessage) {
                    await this.appendDeferredSynchronizationOperation({
                        createdAt: new Date().toISOString(),
                        id: `offline-op-${uuidv4()}`,
                        kind: 'comment.edit',
                        payload: {
                            content,
                            messageId,
                            threadId: canonicalThreadId,
                        },
                    }, 'comment_edit_queued_after_connectivity_failure');
                }
                commentEditSpan.end({
                    failureClass: 'transient',
                    mode: 'offline-queued',
                    outcome: foldedIntoPendingMessage ? 'folded_into_pending_message_after_connectivity_failure' : 'queued_after_connectivity_failure',
                });
                return;
            }
            if (previousThreadSnapshot) {
                this.upsertCommentThread(canonicalThreadId, previousThreadSnapshot, 'thread_message_edit_rolled_back');
            } else {
                this.removeCommentThread(canonicalThreadId, 'thread_message_edit_rolled_back');
            }
            commentEditSpan.fail(error, {
                failureClass: 'internal',
                mode: 'online',
                outcome: 'rolled_back_after_failure',
            });
            throw error;
        }
    }

    async deleteComment(threadId: string, messageId: string, ownOnly: boolean): Promise<void> {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        const commentDeleteSpan = startDiagnosticSpan('VirtualFileSystem', 'comments.lifecycle.delete_message', {
            messageId,
            ownOnly,
            threadId: canonicalThreadId,
        }, {
            category: 'comments',
            level: 'info',
        });
        const previousThread = this.getCommentThreadById(canonicalThreadId);
        const previousThreadSnapshot = previousThread ? normalizeCommentThread(previousThread) : undefined;
        const previousThreadRangeSnapshots = this.getCommentRangeSnapshotsForThreadId(canonicalThreadId);
        const thread = removeCommentMessageFromThread(this.getCommentThreadById(canonicalThreadId), messageId);

        if (thread && thread.messages.length > 0) {
            this.upsertCommentThread(
                canonicalThreadId,
                thread,
                this.isOfflineMode ? 'thread_message_deleted_offline' : 'thread_message_deleted',
            );
        } else {
            this.removeCommentThread(
                canonicalThreadId,
                this.isOfflineMode ? 'thread_deleted_after_last_message_removed_offline' : 'thread_deleted_after_last_message_removed',
            );
        }

        if (this.isOfflineMode) {
            await this.appendDeferredSynchronizationOperation({
                createdAt: new Date().toISOString(),
                id: `offline-op-${uuidv4()}`,
                kind: 'comment.deleteMessage',
                payload: {
                    messageId,
                    ownOnly,
                    threadId: canonicalThreadId,
                },
            }, 'comment_delete_queued');
            commentDeleteSpan.end({
                mode: 'offline-queued',
                outcome: 'queued',
            });
            return;
        }
        try {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const response = ownOnly
                ? await this.api.deleteOwnCommentMessage(identity, this.projectId, canonicalThreadId, messageId)
                : await this.api.deleteCommentMessage(identity, this.projectId, canonicalThreadId, messageId);
            if (response.type!=='success') {
                throw new Error(response.message ?? vscode.l10n.t('Unable to delete the Overleaf comment.'));
            }
            commentDeleteSpan.end({
                mode: 'online',
                outcome: 'deleted',
            });
        } catch (error) {
            if (shouldTreatCommentMutationFailureAsTransient(error)) {
                await this.transitionToOfflineMode('comment_delete_connectivity_failure', error, {
                    messageId,
                    threadId: canonicalThreadId,
                });
                await this.appendDeferredSynchronizationOperation({
                    createdAt: new Date().toISOString(),
                    id: `offline-op-${uuidv4()}`,
                    kind: 'comment.deleteMessage',
                    payload: {
                        messageId,
                        ownOnly,
                        threadId: canonicalThreadId,
                    },
                }, 'comment_delete_queued_after_connectivity_failure');
                commentDeleteSpan.end({
                    failureClass: 'transient',
                    mode: 'offline-queued',
                    outcome: 'queued_after_connectivity_failure',
                });
                return;
            }
            if (previousThreadSnapshot) {
                this.upsertCommentThread(canonicalThreadId, previousThreadSnapshot, 'thread_message_delete_rolled_back');
                this.restoreCommentRangeSnapshotsForThreadId(
                    canonicalThreadId,
                    previousThreadRangeSnapshots,
                    'thread_message_delete_rolled_back',
                );
            } else {
                this.removeCommentThread(canonicalThreadId, 'thread_message_delete_rolled_back');
            }
            commentDeleteSpan.fail(error, {
                failureClass: 'internal',
                mode: 'online',
                outcome: 'rolled_back_after_failure',
            });
            throw error;
        }
    }

    async resolveCommentThread(uri: vscode.Uri, threadId: string, resolved: boolean): Promise<void> {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        const resolvedUri = await this._resolveUri(uri);
        if (!resolvedUri.fileEntity || resolvedUri.fileType!=='doc') {
            throw new Error(vscode.l10n.t('Comment thread actions require an Overleaf document.'));
        }
        const doc = resolvedUri.fileEntity as DocumentEntity;
        const commentResolveSpan = startDiagnosticSpan('VirtualFileSystem', 'comments.lifecycle.resolve_thread', {
            docId: doc._id,
            resolved,
            threadId: canonicalThreadId,
            uri: uri.toString(),
        }, {
            category: 'comments',
            level: 'info',
        });
        const previousThread = this.getCommentThreadById(canonicalThreadId);
        const previousThreadSnapshot = previousThread ? normalizeCommentThread(previousThread) : undefined;

        this.updateCommentThreadResolvedState(canonicalThreadId, resolved, resolved ? {id: this.userId} : undefined);

        if (this.isOfflineMode) {
            await this.appendDeferredSynchronizationOperation({
                createdAt: new Date().toISOString(),
                id: `offline-op-${uuidv4()}`,
                kind: 'comment.resolveThread',
                payload: {
                    docId: doc._id,
                    resolved,
                    threadId: canonicalThreadId,
                },
            }, 'comment_resolve_queued');
            commentResolveSpan.end({
                mode: 'offline-queued',
                outcome: resolved ? 'queued_resolve' : 'queued_reopen',
            });
            return;
        }
        try {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const response = resolved
                ? await this.api.resolveCommentThread(identity, this.projectId, doc._id, canonicalThreadId)
                : await this.api.reopenCommentThread(identity, this.projectId, doc._id, canonicalThreadId);
            if (response.type!=='success') {
                throw new Error(response.message ?? (resolved
                    ? vscode.l10n.t('Unable to resolve the Overleaf comment thread.')
                    : vscode.l10n.t('Unable to reopen the Overleaf comment thread.')));
            }
            commentResolveSpan.end({
                mode: 'online',
                outcome: resolved ? 'resolved' : 'reopened',
            });
        } catch (error) {
            if (shouldTreatCommentMutationFailureAsTransient(error)) {
                await this.transitionToOfflineMode('comment_resolve_connectivity_failure', error, {
                    docId: doc._id,
                    resolved,
                    threadId: canonicalThreadId,
                });
                await this.appendDeferredSynchronizationOperation({
                    createdAt: new Date().toISOString(),
                    id: `offline-op-${uuidv4()}`,
                    kind: 'comment.resolveThread',
                    payload: {
                        docId: doc._id,
                        resolved,
                        threadId: canonicalThreadId,
                    },
                }, 'comment_resolve_queued_after_connectivity_failure');
                commentResolveSpan.end({
                    failureClass: 'transient',
                    mode: 'offline-queued',
                    outcome: resolved ? 'queued_resolve_after_connectivity_failure' : 'queued_reopen_after_connectivity_failure',
                });
                return;
            }
            this.updateCommentThreadResolvedState(
                canonicalThreadId,
                Boolean(previousThreadSnapshot?.resolved),
                previousThreadSnapshot?.resolved ? previousThreadSnapshot.resolved_by_user : undefined,
            );
            commentResolveSpan.fail(error, {
                failureClass: 'internal',
                mode: 'online',
                outcome: 'rolled_back_after_failure',
            });
            throw error;
        }
    }

    async deleteCommentThread(uri: vscode.Uri, threadId: string): Promise<void> {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        const resolvedUri = await this._resolveUri(uri);
        if (!resolvedUri.fileEntity || resolvedUri.fileType!=='doc') {
            throw new Error(vscode.l10n.t('Comment thread actions require an Overleaf document.'));
        }
        const doc = resolvedUri.fileEntity as DocumentEntity;
        const commentDeleteThreadSpan = startDiagnosticSpan('VirtualFileSystem', 'comments.lifecycle.delete_thread', {
            docId: doc._id,
            threadId: canonicalThreadId,
            uri: uri.toString(),
        }, {
            category: 'comments',
            level: 'info',
        });
        const previousThread = this.getCommentThreadById(canonicalThreadId);
        const previousThreadSnapshot = previousThread ? normalizeCommentThread(previousThread) : undefined;
        const previousThreadRangeSnapshots = this.getCommentRangeSnapshotsForThreadId(canonicalThreadId);

        this.removeCommentThread(canonicalThreadId, this.isOfflineMode ? 'thread_deleted_offline' : 'thread_deleted');

        if (this.isOfflineMode) {
            await this.appendDeferredSynchronizationOperation({
                createdAt: new Date().toISOString(),
                id: `offline-op-${uuidv4()}`,
                kind: 'comment.deleteThread',
                payload: {
                    docId: doc._id,
                    threadId: canonicalThreadId,
                },
            }, 'comment_thread_delete_queued');
            commentDeleteThreadSpan.end({
                mode: 'offline-queued',
                outcome: 'queued',
            });
            return;
        }
        try {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const response = await this.api.deleteCommentThread(identity, this.projectId, doc._id, canonicalThreadId);
            if (response.type!=='success') {
                throw new Error(response.message ?? vscode.l10n.t('Unable to delete the Overleaf comment thread.'));
            }
            commentDeleteThreadSpan.end({
                mode: 'online',
                outcome: 'deleted',
            });
        } catch (error) {
            if (shouldTreatCommentMutationFailureAsTransient(error)) {
                await this.transitionToOfflineMode('comment_thread_delete_connectivity_failure', error, {
                    docId: doc._id,
                    threadId: canonicalThreadId,
                });
                await this.appendDeferredSynchronizationOperation({
                    createdAt: new Date().toISOString(),
                    id: `offline-op-${uuidv4()}`,
                    kind: 'comment.deleteThread',
                    payload: {
                        docId: doc._id,
                        threadId: canonicalThreadId,
                    },
                }, 'comment_thread_delete_queued_after_connectivity_failure');
                commentDeleteThreadSpan.end({
                    failureClass: 'transient',
                    mode: 'offline-queued',
                    outcome: 'queued_after_connectivity_failure',
                });
                return;
            }
            if (previousThreadSnapshot) {
                this.upsertCommentThread(canonicalThreadId, previousThreadSnapshot, 'thread_delete_rolled_back');
                this.restoreCommentRangeSnapshotsForThreadId(
                    canonicalThreadId,
                    previousThreadRangeSnapshots,
                    'thread_delete_rolled_back',
                );
            }
            commentDeleteThreadSpan.fail(error, {
                failureClass: 'internal',
                mode: 'online',
                outcome: 'rolled_back_after_failure',
            });
            throw error;
        }
    }

    getCommentThreadPermissions(threadId: string) {
        const canonicalThreadId = this.resolveCanonicalCommentThreadId(threadId);
        const thread = this.getCommentThreadById(canonicalThreadId);
        const candidateThreadIds = this.getCommentThreadAliasIds(canonicalThreadId);
        const range = Array.from(this.commentRangesByDocId.values())
            .flat()
            .find((candidate) => candidateThreadIds.has(candidate.op.t));
        if (!range) {
            const permissions = this.commentPermissions;
            return {
                ...permissions,
                canDeleteComment: () => false,
                canDeleteThread: false,
                canEditComment: () => false,
                canResolveThread: false,
            };
        }
        const permissions = this.buildCommentPermissionsForThread(thread, range);
        const canResolveThread = canDeleteThread(
            permissions,
            this.userId,
            thread?.messages[0]?.user_id ?? range.metadata?.user_id ?? undefined,
        );
        return {
            ...permissions,
            canEditComment: (messageUserId: string | undefined) => canEditOwnComment(permissions, this.userId, messageUserId),
            canDeleteComment: (messageUserId: string | undefined) => canDeleteCommentMessage(permissions, this.userId, messageUserId),
            canResolveThread,
            canDeleteThread: canResolveThread,
        };
    }
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private readonly vfss = new Map<string, VirtualFileSystem>();

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
    }

    private resolveVfsScopeKey(uri: vscode.Uri) {
        try {
            const {projectId, serverName, userId} = parseUri(uri);
            if (projectId && serverName && userId) {
                return `${serverName}\u0000${userId}\u0000${projectId}`;
            }
        } catch {
            // Fall back to a URI-derived key when parsing fails.
        }
        return `${uri.scheme}\u0000${uri.authority}\u0000${uri.query}`;
    }

    private compactDisposedVfsEntries() {
        for (const [key, vfs] of this.vfss.entries()) {
            if (!vfs.isDisposed) {
                continue;
            }
            this.vfss.delete(key);
        }
    }

    private collectProviderDiagnosticsState() {
        this.compactDisposedVfsEntries();
        const projects = Array.from(this.vfss.values())
            .filter((vfs) => !vfs.isDisposed)
            .sort((left, right) => {
                if (left.serverName!==right.serverName) {
                    return left.serverName.localeCompare(right.serverName);
                }
                return left.projectId.localeCompare(right.projectId);
            })
            .map((vfs) => ({
                chatQueueLength: vfs.chatQueueLength,
                connectionPhase: vfs.realtimeConnectionPhase,
                hasDeferredOperations: vfs.hasDeferredSynchronizationOperations,
                origin: vfs.origin.toString(),
                projectId: vfs.projectId,
                projectName: vfs.projectName,
                serverName: vfs.serverName,
                syncMode: vfs.synchronizationMode,
            }));
        return {
            activeProjectCount: projects.length,
            activeScopeCount: this.vfss.size,
            projects,
        };
    }

    private async resolveDiagnosticsTargetVfs(uri?: vscode.Uri) {
        this.compactDisposedVfsEntries();

        if (uri?.scheme===ROOT_NAME) {
            return this.prefetch(uri);
        }

        const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
        if (activeEditorUri?.scheme===ROOT_NAME) {
            return this.prefetch(activeEditorUri);
        }

        const activeVfss = Array.from(this.vfss.values())
            .filter((vfs) => !vfs.isDisposed);

        if (activeVfss.length===1) {
            return activeVfss[0];
        }

        if (activeVfss.length===0) {
            return undefined;
        }

        const selected = await vscode.window.showQuickPick(
            activeVfss.map((vfs) => ({
                description: vfs.serverName,
                detail: vfs.origin.toString(),
                label: vfs.projectName,
                vfs,
            })),
            {
                placeHolder: 'Select an Overleaf project for diagnostics',
                title: 'Overleaf Workshop: Active Project Diagnostics',
            },
        );

        return selected?.vfs;
    }

    private async showDiagnosticsDocument(_title: string, payload: unknown) {
        const serialized = JSON.stringify(sanitizeDiagnosticPayload(payload), null, 2);
        const document = await vscode.workspace.openTextDocument({
            content: serialized,
            language: 'json',
        });
        await vscode.window.showTextDocument(document, {
            preview: false,
            viewColumn: vscode.ViewColumn.Beside,
        });
        return serialized.length;
    }

    private async dumpActiveProjectDiagnostics(uri?: vscode.Uri) {
        const vfs = await this.resolveDiagnosticsTargetVfs(uri);
        if (!vfs) {
            void vscode.window.showWarningMessage('No active Overleaf project is available for diagnostics.');
            return;
        }

        const snapshot = await vfs.collectProjectDiagnosticsSnapshot({
            recentLimit: 400,
        });
        const bytes = await this.showDiagnosticsDocument('active-project-diagnostics', snapshot);
        logDiagnostic('Diagnostics', 'diagnostics.active_project_snapshot_requested', {
            bytes,
            projectId: vfs.projectId,
            projectName: vfs.projectName,
            serverName: vfs.serverName,
        }, undefined, {
            category: 'core',
            level: 'info',
        });
    }

    private async retryActiveProjectSynchronization(uri?: vscode.Uri) {
        const vfs = await this.resolveDiagnosticsTargetVfs(uri);
        if (!vfs) {
            void vscode.window.showWarningMessage('No active Overleaf project is available for sync retry.');
            return;
        }

        logDiagnostic('Diagnostics', 'diagnostics.active_project_sync_retry_requested', {
            connectionPhase: vfs.realtimeConnectionPhase,
            hasPendingOperations: vfs.hasDeferredSynchronizationOperations,
            isOfflineMode: vfs.isOfflineMode,
            projectId: vfs.projectId,
            projectName: vfs.projectName,
            serverName: vfs.serverName,
            syncMode: vfs.synchronizationMode,
        }, undefined, {
            category: 'sync',
            level: 'info',
        });

        if (vfs.isOfflineMode || vfs.realtimeConnectionPhase==='recovering' || vfs.realtimeConnectionPhase==='initializing') {
            await vfs.requestRealtimeRecovery('socket_disconnect');
        }
        await vfs.resumeDeferredSynchronizationRecovery('diagnostics_manual_retry');
        await Promise.allSettled([
            vscode.commands.executeCommand(`${ROOT_NAME}.comments.refresh`),
            vscode.commands.executeCommand(`${ROOT_NAME}.review.refresh`),
        ]);
    }

    private async getVFS(uri: vscode.Uri): Promise<VirtualFileSystem> {
        this.compactDisposedVfsEntries();
        const scopeKey = this.resolveVfsScopeKey(uri);
        const vfs = this.vfss.get(scopeKey);
        if (vfs) {
            return Promise.resolve(vfs);
        }
        const nextVfs = await VirtualFileSystem.create(this.context, uri, this.notify.bind(this));
        this.vfss.set(scopeKey, nextVfs);
        logDiagnostic('RemoteFileSystemProvider', 'filesystem.vfs_created', {
            projectId: nextVfs.projectId,
            projectName: nextVfs.projectName,
            scopeKey,
            serverName: nextVfs.serverName,
            uri: uri.toString(),
        }, undefined, {
            category: 'filesystem',
            level: 'info',
        });
        return nextVfs;
    }

    prefetch(uri: vscode.Uri): Promise<VirtualFileSystem> {
        return this.getVFS(uri).then((vfs) => {return vfs;});
    }

    notify(events :vscode.FileChangeEvent[]) {
        this._emitter.fire(events);
    }

    stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
        return this.getVFS(uri).then( vfs => vfs.resolve(uri) );
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
        return this.getVFS(uri).then( vfs => vfs.list(uri) );
    }

    createDirectory(uri: vscode.Uri): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.mkdir(uri) );
    }

    readFile(uri: vscode.Uri): Thenable<Uint8Array> {
        return this.getVFS(uri).then( vfs => vfs.openFile(uri) );
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.writeFile(uri, content, options.create, options.overwrite) );
    }

    delete(uri: vscode.Uri, options: { recursive: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.remove(uri, options.recursive) );
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }) {
        if (oldUri.authority !== newUri.authority) {
            vscode.window.showErrorMessage( vscode.l10n.t('Cannot rename across servers') );
            return;
        } else {
            return this.getVFS(oldUri).then( vfs => vfs.rename(oldUri, newUri, options.overwrite) );
        }
    }

    get triggers() {
        return [
            // register file system provider
            vscode.workspace.registerFileSystemProvider(ROOT_NAME, this, { isCaseSensitive: true }),
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.refreshLinkedFile`, (uri: vscode.Uri) => {
                return this.prefetch(uri).then((vfs) => vfs.refreshLinkedFile(uri));
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.createLinkedFile`, (uri?: vscode.Uri) => {
                uri = uri || vscode.workspace.workspaceFolders?.[0].uri;
                if (uri) {
                    return this.prefetch(uri).then((vfs) => vfs.createLinkedFile(uri!));
                }                
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.diagnostics.dumpActiveProjectState`, async (uri?: vscode.Uri) => {
                await this.dumpActiveProjectDiagnostics(uri);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.diagnostics.retryActiveProjectSync`, async (uri?: vscode.Uri) => {
                await this.retryActiveProjectSynchronization(uri);
            }),
            registerDiagnosticStateProvider('filesystem:provider', () => this.collectProviderDiagnosticsState()),
            vscode.commands.registerCommand('remoteFileSystem.prefetch', (uri: vscode.Uri) => {
                return this.prefetch(uri);
            }),
        ];
    }
}
