import * as path from 'path';
import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem, StatusInfo } from '.';
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { logDiagnostic, registerDiagnosticStateProvider } from '../utils/diagnostics';
import { EventBus } from '../utils/eventBus';
import {
    classifyLocalReplicaReconcile,
    classifyLocalReplicaRuntimeSync,
    createLocalReplicaSnapshot,
    LocalReplicaPathState,
    LocalReplicaSnapshot,
    localReplicaSnapshotsEqual,
    mergeLocalReplicaText,
    parsePersistedLocalReplicaSyncState,
    recordLocalReplicaBaseline,
    recordLocalReplicaConflict,
    serializePersistedLocalReplicaSyncState,
} from './localReplicaSyncState';
import {
    ensureLocalReplicaCompileWorkspaceDefaults,
    LocalReplicaWorkspaceSettings,
    mapOverleafPathToLocalReplicaFileUri,
    readLocalReplicaSettingsFromWorkspaceRoot,
    sanitizeLocalReplicaProjectFolderName,
    writeLocalReplicaSettingsToWorkspaceRoot,
} from './localReplicaWorkspace';
import { shouldDeferLocalReplicaFileSyncToManagedSession } from './localReplicaManagedSessionPolicy';
import { shouldSuppressRemoteWatcherPullForManagedDocument } from './localReplicaWatcherPolicy';
import {
    isLocalReplicaMetadataPath,
    shouldRehydrateEmptyLocalReplicaFromRemote,
} from './localReplicaDeletionPolicy';

const IGNORE_SETTING_KEY = 'ignore-patterns';
const SETTINGS_DIR_NAME = '.overleaf';
const SETTINGS_FILE_NAME = 'settings.json';
const STATE_FILE_NAME = 'local-replica-state.json';
const LOCAL_REPLICA_DELETE_SETTLE_MS = 1_000;

type SyncAction = 'push' | 'pull';
type SyncChangeType = 'update' | 'delete';
type ReplicaEndpoint = 'local' | 'remote';

interface ReplicaPathEntry {
    content?: Uint8Array,
    relPath: string,
    snapshot: LocalReplicaSnapshot,
    uri: vscode.Uri,
}

interface ReplicaTreeScan {
    directories: number,
    files: number,
    paths: Map<string, ReplicaPathEntry>,
}

interface LocalReplicaRecoveryResult {
    cancelled: boolean,
    conflictedPaths: string[],
    failedPaths: string[],
    mergedPaths: string[],
    pulledPaths: string[],
    pushedPaths: string[],
    recoveryRunId: string,
    syncedPaths: string[],
}

type LocalReplicaPathOutcomeKind = 'conflict' | 'deferred' | 'merged' | 'pulled' | 'pushed' | 'synced';

interface LocalReplicaPathOutcome {
    kind: LocalReplicaPathOutcomeKind,
    reason: string,
    relPath: string,
}

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private readonly baselineContentCache = new Map<string, Uint8Array>();
    private readonly conflictPaths = new Map<string, string>();
    private readonly syncState = new Map<string, LocalReplicaPathState>();
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
    private syncQueue: Promise<void> = Promise.resolve();
    private syncTaskCounter = 0;
    private reconcileAttemptCounter = 0;
    private recoveryRunCounter = 0;
    private deferredRecoveryInProgress = false;
    private replicaDetached = false;
    private pendingLocalDeleteRelPaths = new Set<string>();
    private pendingLocalDeleteFlushTimer?: NodeJS.Timeout;
    private lastStatusKey = '';
    private stateDirty = false;
    private ignorePatterns: string[] = [
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/__latexindent*',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
        '**/main.pdf',
        '**/output.pdf',
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    private get settingsDirUri() {
        return vscode.Uri.joinPath(this.baseUri, SETTINGS_DIR_NAME);
    }

    private get settingUri() {
        return vscode.Uri.joinPath(this.settingsDirUri, SETTINGS_FILE_NAME);
    }

    private get syncStateUri() {
        return vscode.Uri.joinPath(this.settingsDirUri, STATE_FILE_NAME);
    }

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('LocalReplicaSCM', event, {
            baseUri: this.baseUri.toString(),
            projectId: this.vfs.projectId,
            projectName: this.vfs.projectName,
            serverName: this.vfs.serverName,
            ...fields,
        }, error);
    }

    private setProviderStatus(status: StatusInfo) {
        const statusKey = `${status.status}:${status.message ?? ''}`;
        if (statusKey===this.lastStatusKey) {
            return;
        }
        this.lastStatusKey = statusKey;
        this.status = status;
        this.logDiagnostic('status.updated', {
            status: status.status,
            message: status.message ?? '',
        });
    }

    private refreshStatus() {
        if (this.conflictPaths.size!==0) {
            const conflictCount = this.conflictPaths.size;
            const message = conflictCount===1
                ? vscode.l10n.t('1 local replica conflict requires attention.')
                : vscode.l10n.t('{count} local replica conflicts require attention.', {count: conflictCount});
            this.setProviderStatus({status: 'need-attention', message});
            return;
        }
        this.setProviderStatus({status: 'idle', message: ''});
    }

    getDiagnosticsState() {
        const baselineKindCounts = new Map<string, number>();
        const pathStateSample = Array.from(this.syncState.entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, 20)
            .map(([relPath, state]) => {
                const baselineKind = state.baseline?.kind ?? 'unknown';
                baselineKindCounts.set(baselineKind, (baselineKindCounts.get(baselineKind) ?? 0) + 1);
                return {
                    baselineKind,
                    conflictReason: state.conflict?.reason ?? '',
                    hasConflict: Boolean(state.conflict),
                    lastSynchronizedAt: state.lastSynchronizedAt
                        ? new Date(state.lastSynchronizedAt).toISOString()
                        : '',
                    relPath,
                };
            });

        Array.from(this.syncState.values())
            .slice(pathStateSample.length)
            .forEach((state) => {
                const baselineKind = state.baseline?.kind ?? 'unknown';
                baselineKindCounts.set(baselineKind, (baselineKindCounts.get(baselineKind) ?? 0) + 1);
            });

        return {
            baseUri: this.baseUri.toString(),
            baselineKindCounts: Object.fromEntries(
                Array.from(baselineKindCounts.entries())
                    .sort(([left], [right]) => left.localeCompare(right)),
            ),
            conflictCount: this.conflictPaths.size,
            conflictSample: Array.from(this.conflictPaths.entries())
                .sort(([left], [right]) => left.localeCompare(right))
                .slice(0, 20)
                .map(([relPath, reason]) => ({
                    reason,
                    relPath,
                })),
            deferredRecoveryInProgress: this.deferredRecoveryInProgress,
            ignorePatternCount: this.ignorePatterns.length,
            localWatcherReady: this.localWatcher!==undefined,
            pathStateSample,
            projectId: this.vfs.projectId,
            reconcileAttemptCounter: this.reconcileAttemptCounter,
            recoveryRunCounter: this.recoveryRunCounter,
            replicaDetached: this.replicaDetached,
            stateDirty: this.stateDirty,
            status: this.status.status,
            statusMessage: this.status.message ?? '',
            syncTaskCounter: this.syncTaskCounter,
            trackedPathCount: this.syncState.size,
            vfsWatcherReady: this.vfsWatcher!==undefined,
        };
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : sanitizeLocalReplicaProjectFolderName(projectName);
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage(vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.'));
            return Promise.reject(error);
        }
    }

    public static async pathToUri(pathname: string, workspaceRoot?: vscode.Uri): Promise<vscode.Uri | undefined> {
        return mapOverleafPathToLocalReplicaFileUri(pathname, workspaceRoot);
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme==='file')?.uri;
        if (workspaceRoot===undefined || workspaceRoot.scheme!=='file') {
            return undefined;
        }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, `${SETTINGS_DIR_NAME}/${SETTINGS_FILE_NAME}`);
        try {
            await vscode.workspace.fs.stat(settingUri);
            return uri.path.slice(workspaceRoot.path.length);
        } catch {
            return undefined;
        }
    }

    public static async readSettings(workspaceRoot?: vscode.Uri): Promise<LocalReplicaWorkspaceSettings | undefined> {
        const resolvedWorkspaceRoot = workspaceRoot
            ?? vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme==='file')?.uri;
        if (resolvedWorkspaceRoot?.scheme!=='file') {
            return undefined;
        }
        return readLocalReplicaSettingsFromWorkspaceRoot(resolvedWorkspaceRoot);
    }

    private static isFileNotFoundError(error: unknown): boolean {
        const maybeError = error as Error & {code?: string};
        const code = maybeError?.code;
        const name = maybeError?.name ?? '';
        return code==='ENOENT'
            || code==='FileNotFound'
            || name.includes('FileNotFound')
            || name.includes('EntryNotFound');
    }

    private normalizeRelPath(relPath: string): string {
        if (relPath==='' || relPath==='/') {
            return '/';
        }
        return relPath.startsWith('/') ? relPath : `/${relPath}`;
    }

    private localUriForRelPath(relPath: string): vscode.Uri {
        const normalizedRelPath = this.normalizeRelPath(relPath);
        if (normalizedRelPath==='/') {
            return this.baseUri;
        }
        return this.baseUri.with({path: `${this.baseUri.path}${normalizedRelPath}`});
    }

    private relPathFromLocalUri(localUri: vscode.Uri): string {
        const basePath = this.baseUri.path;
        const relPath = localUri.path.slice(basePath.length) || '/';
        return this.normalizeRelPath(relPath);
    }

    private relPathFromRemoteUri(vfsUri: vscode.Uri): string {
        const {pathParts} = parseUri(vfsUri);
        if (pathParts.at(-1)==='') {
            pathParts.pop();
        }
        return this.normalizeRelPath(pathParts.join('/'));
    }

    private getReplicaUri(endpoint: ReplicaEndpoint, relPath: string): vscode.Uri {
        return endpoint==='local'
            ? this.localUriForRelPath(relPath)
            : this.vfs.pathToUri(this.normalizeRelPath(relPath));
    }

    private matchIgnorePatterns(relPath: string): boolean {
        const ignorePatterns = this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of ignorePatterns) {
            if (minimatch(relPath, pattern, {dot:true})) {
                return true;
            }
        }
        return false;
    }

    private getPathState(relPath: string): LocalReplicaPathState | undefined {
        return this.syncState.get(relPath);
    }

    private getManagedDocumentStateForRelPath(relPath: string) {
        return this.vfs.getManagedTextDocumentState(this.localUriForRelPath(relPath))
            ?? this.vfs.getManagedTextDocumentState(this.vfs.pathToUri(this.normalizeRelPath(relPath)));
    }

    private async refreshPathStateFromJournal(relPath: string) {
        const normalizedRelPath = this.normalizeRelPath(relPath);
        const existingState = this.syncState.get(normalizedRelPath);
        const record = await this.vfs.getDocumentSyncRecord(normalizedRelPath);
        if (!record) {
            return existingState;
        }
        const nextState: LocalReplicaPathState = {
            baseline: record.baseSnapshot ?? existingState?.baseline,
            conflict: record.conflict
                ? {
                    detectedAt: Date.parse(record.conflict.detectedAt) || Date.now(),
                    reason: record.conflict.reason,
                }
                : undefined,
            lastSynchronizedAt: existingState?.lastSynchronizedAt,
        };
        if (nextState.baseline!==undefined || nextState.conflict!==undefined) {
            this.syncState.set(normalizedRelPath, nextState);
        } else {
            this.syncState.delete(normalizedRelPath);
        }
        if (record.baseBlobId) {
            const blob = await this.vfs.readDocumentSyncBlob(record.baseBlobId);
            if (blob) {
                this.baselineContentCache.set(normalizedRelPath, blob);
            } else {
                this.baselineContentCache.delete(normalizedRelPath);
            }
        } else {
            this.baselineContentCache.delete(normalizedRelPath);
        }
        if (record.conflict) {
            this.conflictPaths.set(normalizedRelPath, record.conflict.reason);
        } else {
            this.conflictPaths.delete(normalizedRelPath);
        }
        return this.syncState.get(normalizedRelPath);
    }

    private nextRecoveryRunId() {
        this.recoveryRunCounter += 1;
        return `local-recovery-${Date.now()}-${this.recoveryRunCounter}`;
    }

    private async revealConflict(relPath: string, reason: string) {
        const record = await this.vfs.getDocumentSyncRecord(relPath);
        if (!record?.conflict) {
            return;
        }
        try {
            const materialized = await this.vfs.materializeDocumentSyncConflict(relPath, record.conflict);
            const title = vscode.l10n.t('Resolve Overleaf Conflict: {path}', {path: relPath.replace(/^\//, '') || '/'});
            const workingUri = this.localUriForRelPath(relPath);
            const localInputUri = materialized.local ?? workingUri;
            const commands = await vscode.commands.getCommands(true);
            if (materialized.base && materialized.remote && commands.includes('_open.mergeEditor')) {
                await vscode.commands.executeCommand('_open.mergeEditor', {
                    base: materialized.base,
                    input1: {
                        title: vscode.l10n.t('Local'),
                        uri: localInputUri,
                    },
                    input2: {
                        title: vscode.l10n.t('Remote'),
                        uri: materialized.remote,
                    },
                    output: workingUri,
                    title,
                });
                return;
            }
            if (materialized.remote) {
                await vscode.commands.executeCommand('vscode.diff', localInputUri, materialized.remote, title);
                if (materialized.base) {
                    await vscode.commands.executeCommand('vscode.open', materialized.base);
                }
            }
        } catch (error) {
            this.logDiagnostic('conflict.reveal_failed', {
                reason,
                relPath,
            }, error);
        }
    }

    private async setBaseline(relPath: string, snapshot: LocalReplicaSnapshot, content?: Uint8Array, synchronizedAt = Date.now()) {
        const nextState = recordLocalReplicaBaseline(this.getPathState(relPath), snapshot, synchronizedAt);
        this.syncState.set(relPath, nextState);
        if (snapshot.kind==='file' && content!==undefined) {
            this.baselineContentCache.set(relPath, content);
        } else {
            this.baselineContentCache.delete(relPath);
        }
        if (this.conflictPaths.delete(relPath)) {
            this.logDiagnostic('conflict.cleared', {
                relPath,
                resolution: 'baseline_updated',
            });
        }
        this.stateDirty = true;
        const existingRecord = await this.vfs.getDocumentSyncRecord(relPath);
        if (snapshot.kind==='file' && content!==undefined) {
            await this.vfs.recordDocumentSyncBaseline({
                content,
                docId: existingRecord?.docId,
                reason: 'local_replica_baseline_recorded',
                relPath,
                version: existingRecord?.lastKnownRemoteVersion ?? existingRecord?.baseVersion,
            });
        } else {
            await this.vfs.persistDocumentSyncRecord({
                baseBlobId: undefined,
                baseSnapshot: snapshot,
                baseVersion: existingRecord?.baseVersion,
                conflict: undefined,
                docId: existingRecord?.docId,
                lastKnownRemoteSnapshot: snapshot,
                lastKnownRemoteVersion: existingRecord?.lastKnownRemoteVersion,
                lastRecoveryRunId: undefined,
                localDirty: false,
                relPath,
            }, 'local_replica_baseline_recorded');
        }
        this.logDiagnostic('state.baseline_recorded', {
            contentCached: snapshot.kind==='file' && content!==undefined,
            kind: snapshot.kind,
            relPath,
            size: snapshot.size,
            synchronizedAt,
        });
    }

    private async setMissingBaselineForSubtree(relPath: string, synchronizedAt = Date.now()) {
        const normalizedRelPath = this.normalizeRelPath(relPath);
        const affectedPaths = new Set<string>([normalizedRelPath]);
        for (const existingPath of this.syncState.keys()) {
            if (existingPath.startsWith(`${normalizedRelPath}/`)) {
                affectedPaths.add(existingPath);
            }
        }
        const missingSnapshot = createLocalReplicaSnapshot('missing');
        for (const affectedPath of affectedPaths) {
            const nextState = recordLocalReplicaBaseline(this.getPathState(affectedPath), missingSnapshot, synchronizedAt);
            this.syncState.set(affectedPath, nextState);
            this.baselineContentCache.delete(affectedPath);
            this.conflictPaths.delete(affectedPath);
            const existingRecord = await this.vfs.getDocumentSyncRecord(affectedPath);
            await this.vfs.persistDocumentSyncRecord({
                baseBlobId: undefined,
                baseSnapshot: missingSnapshot,
                baseVersion: existingRecord?.baseVersion,
                conflict: undefined,
                docId: existingRecord?.docId,
                lastKnownRemoteSnapshot: missingSnapshot,
                lastKnownRemoteVersion: existingRecord?.lastKnownRemoteVersion,
                lastRecoveryRunId: undefined,
                localDirty: false,
                relPath: affectedPath,
            }, 'local_replica_subtree_marked_missing');
        }
        this.stateDirty = true;
        this.logDiagnostic('state.subtree_marked_missing', {
            affectedPathCount: affectedPaths.size,
            relPath: normalizedRelPath,
            synchronizedAt,
        });
    }

    private async recordConflict(relPath: string, reason: string, fields: Record<string, unknown> = {}) {
        const nextState = recordLocalReplicaConflict(this.getPathState(relPath), reason);
        this.syncState.set(relPath, nextState);
        this.conflictPaths.set(relPath, reason);
        const existingRecord = await this.vfs.getDocumentSyncRecord(relPath);
        await this.vfs.persistDocumentSyncRecord({
            baseBlobId: existingRecord?.baseBlobId,
            baseSnapshot: nextState.baseline,
            baseVersion: existingRecord?.baseVersion,
            conflict: existingRecord?.conflict ?? {
                detectedAt: new Date().toISOString(),
                reason,
            },
            docId: existingRecord?.docId,
            lastKnownRemoteSnapshot: existingRecord?.lastKnownRemoteSnapshot ?? nextState.baseline,
            lastKnownRemoteVersion: existingRecord?.lastKnownRemoteVersion,
            lastRecoveryRunId: existingRecord?.lastRecoveryRunId,
            localDirty: true,
            relPath,
        }, 'local_replica_conflict_recorded');
        this.logDiagnostic('conflict.recorded', {
            relPath,
            reason,
            ...fields,
        });
        this.refreshStatus();
    }

    private async ensureSettingsFiles() {
        this.logDiagnostic('settings.ensure_started', {
            settingsUri: this.settingUri.toString(),
            syncStateUri: this.syncStateUri.toString(),
        });
        await vscode.workspace.fs.createDirectory(this.settingsDirUri);
        try {
            await vscode.workspace.fs.stat(this.settingUri);
        } catch (error) {
            await writeLocalReplicaSettingsToWorkspaceRoot(this.baseUri, {
                uri: this.vfs.origin.toString(),
                serverName: this.vfs.serverName,
                enableCompileNPreview: true,
                projectName: this.vfs.projectName,
            });
            this.logDiagnostic('settings.created', {
                settingsUri: this.settingUri.toString(),
            });
        }
        await ensureLocalReplicaCompileWorkspaceDefaults(this.baseUri);
        this.logDiagnostic('settings.ensure_completed');
    }

    private async localReplicaRootExists() {
        try {
            const stat = await vscode.workspace.fs.stat(this.baseUri);
            return stat.type===vscode.FileType.Directory;
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return false;
            }
            throw error;
        }
    }

    private clearPendingLocalDeleteBatch() {
        if (this.pendingLocalDeleteFlushTimer) {
            clearTimeout(this.pendingLocalDeleteFlushTimer);
            this.pendingLocalDeleteFlushTimer = undefined;
        }
        this.pendingLocalDeleteRelPaths.clear();
    }

    private async detachLocalReplicaPreservingRemote(reason: string, fields: Record<string, unknown> = {}) {
        if (this.replicaDetached) {
            return;
        }
        this.replicaDetached = true;
        this.clearPendingLocalDeleteBatch();
        // A deleted local replica means "stop mirroring this folder", not
        // "delete the Overleaf project". Disable the replica locally and clear
        // queued file replay so remote content remains untouched.
        this.vfsWatcher?.dispose();
        this.localWatcher?.dispose();
        const persist = this.vfs.getProjectSCMPersist(this.scmKey);
        if (persist) {
            this.vfs.setProjectSCMPersist(this.scmKey, {
                ...persist,
                enabled: false,
            });
        }
        await this.vfs.acknowledgeLocalReplicaSynchronization(`local_replica_detached:${reason}`);
        this.setProviderStatus({
            status: 'need-attention',
            message: vscode.l10n.t('Local replica was removed locally. The Overleaf project was left unchanged.'),
        });
        this.logDiagnostic('local_replica.detached_preserving_remote', {
            ...fields,
            reason,
        });
    }

    private async suppressReplicaRootDeletionPropagation(
        relPath: string,
        syncTaskId: number,
        reason: string,
        waitForSettling: boolean,
    ) {
        if (this.replicaDetached) {
            this.logDiagnostic('sync.local_delete_suppressed_replica_detached', {
                reason,
                relPath,
                syncTaskId,
            });
            return true;
        }
        if (waitForSettling) {
            // Folder deletions arrive as a burst of child delete events. Give the
            // file system a brief moment to settle so a removed replica root is
            // treated as a local detach instead of a sequence of remote deletes.
            await new Promise(resolve => setTimeout(resolve, LOCAL_REPLICA_DELETE_SETTLE_MS));
        }
        const rootExists = await this.localReplicaRootExists();
        if (rootExists) {
            return false;
        }
        await this.detachLocalReplicaPreservingRemote(reason, {
            relPath,
            syncTaskId,
        });
        return true;
    }

    public getConflictPaths() {
        return [...this.conflictPaths.keys()].sort((left, right) => left.localeCompare(right));
    }

    private async loadSyncState() {
        this.syncState.clear();
        this.conflictPaths.clear();
        this.baselineContentCache.clear();
        this.stateDirty = false;
        this.logDiagnostic('state.load_started', {
            syncStateUri: this.syncStateUri.toString(),
        });
        try {
            const raw = await vscode.workspace.fs.readFile(this.syncStateUri);
            const parsed = parsePersistedLocalReplicaSyncState(new TextDecoder().decode(raw));
            for (const [relPath, pathState] of Object.entries(parsed.paths)) {
                if (pathState.baseline!==undefined) {
                    this.syncState.set(relPath, {baseline: pathState.baseline});
                }
            }
            this.logDiagnostic('state.load_completed', {
                pathCount: this.syncState.size,
                syncStateUri: this.syncStateUri.toString(),
                version: parsed.version,
            });
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                this.logDiagnostic('state.load_completed', {
                    pathCount: 0,
                    reason: 'missing_state_file',
                    syncStateUri: this.syncStateUri.toString(),
                    version: 1,
                });
            } else {
                this.logDiagnostic('state.load_failed', {
                    syncStateUri: this.syncStateUri.toString(),
                }, error);
                throw error;
            }
        }
        const journalState = await this.vfs.getDocumentSyncState();
        for (const [relPath, record] of Object.entries(journalState.records)) {
            const nextState: LocalReplicaPathState = {
                baseline: record.baseSnapshot,
                conflict: record.conflict
                    ? {
                        detectedAt: Date.parse(record.conflict.detectedAt) || Date.now(),
                        reason: record.conflict.reason,
                    }
                    : undefined,
                lastSynchronizedAt: undefined,
            };
            if (nextState.baseline !== undefined || nextState.conflict !== undefined) {
                this.syncState.set(relPath, nextState);
            }
            if (record.baseBlobId) {
                const blob = await this.vfs.readDocumentSyncBlob(record.baseBlobId);
                if (blob) {
                    this.baselineContentCache.set(relPath, blob);
                }
            }
            if (record.conflict) {
                this.conflictPaths.set(relPath, record.conflict.reason);
            }
        }
        const migratedLegacyPaths: string[] = [];
        for (const [relPath, state] of this.syncState.entries()) {
            if (journalState.records[relPath] || state.baseline===undefined) {
                continue;
            }
            await this.vfs.persistDocumentSyncRecord({
                baseBlobId: undefined,
                baseSnapshot: state.baseline,
                baseVersion: undefined,
                conflict: undefined,
                docId: undefined,
                lastKnownRemoteSnapshot: state.baseline,
                lastKnownRemoteVersion: undefined,
                lastRecoveryRunId: undefined,
                localDirty: false,
                relPath,
            }, 'local_replica_legacy_state_migrated');
            migratedLegacyPaths.push(relPath);
        }
        this.logDiagnostic('state.journal_loaded', {
            baselineBlobCount: this.baselineContentCache.size,
            conflictCount: this.conflictPaths.size,
            journalPathCount: Object.keys(journalState.records).length,
            migratedLegacyPathCount: migratedLegacyPaths.length,
        });
    }

    private async persistSyncState(reason: string, relPaths: string[] = []) {
        if (!this.stateDirty) {
            this.logDiagnostic('state.persist_skipped', {
                pathCount: this.syncState.size,
                reason,
                touchedPathCount: relPaths.length,
            });
            return;
        }
        const raw = serializePersistedLocalReplicaSyncState({
            paths: Object.fromEntries(
                [...this.syncState.entries()].map(([relPath, state]) => [relPath, {baseline: state.baseline}]),
            ),
            version: 1,
        });
        await vscode.workspace.fs.createDirectory(this.settingsDirUri);
        await vscode.workspace.fs.writeFile(this.syncStateUri, Buffer.from(raw));
        this.stateDirty = false;
        this.logDiagnostic('state.persist_completed', {
            pathCount: this.syncState.size,
            reason,
            touchedPathCount: relPaths.length,
        });
    }

    private async snapshotPath(endpoint: ReplicaEndpoint, relPath: string): Promise<ReplicaPathEntry> {
        const uri = this.getReplicaUri(endpoint, relPath);
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type===vscode.FileType.Directory) {
                return {
                    relPath,
                    snapshot: createLocalReplicaSnapshot('directory'),
                    uri,
                };
            }
            if (stat.type===vscode.FileType.File) {
                const content = await vscode.workspace.fs.readFile(uri);
                return {
                    content,
                    relPath,
                    snapshot: createLocalReplicaSnapshot('file', content),
                    uri,
                };
            }
            this.logDiagnostic('snapshot.unsupported_type', {
                endpoint,
                relPath,
                statType: stat.type,
            });
            return {
                relPath,
                snapshot: createLocalReplicaSnapshot('missing'),
                uri,
            };
        } catch (error) {
            if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                return {
                    relPath,
                    snapshot: createLocalReplicaSnapshot('missing'),
                    uri,
                };
            }
            this.logDiagnostic('snapshot.failed', {
                endpoint,
                relPath,
                uri: uri.toString(),
            }, error);
            throw error;
        }
    }

    private async collectReplicaTree(endpoint: ReplicaEndpoint, root = '/'): Promise<ReplicaTreeScan> {
        const normalizedRoot = this.normalizeRelPath(root);
        const attemptId = ++this.reconcileAttemptCounter;
        const paths = new Map<string, ReplicaPathEntry>();
        const queue: string[] = [normalizedRoot];
        let directoryCount = 0;
        let fileCount = 0;
        this.logDiagnostic('scan.started', {
            attemptId,
            endpoint,
            root: normalizedRoot,
        });

        while (queue.length!==0) {
            const nextRoot = queue.shift()!;
            const rootUri = this.getReplicaUri(endpoint, nextRoot);
            let items: [string, vscode.FileType][];
            try {
                items = await vscode.workspace.fs.readDirectory(rootUri);
            } catch (error) {
                if (LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                    this.logDiagnostic('scan.directory_missing', {
                        attemptId,
                        endpoint,
                        relPath: nextRoot,
                    });
                    continue;
                }
                this.logDiagnostic('scan.failed', {
                    attemptId,
                    endpoint,
                    relPath: nextRoot,
                    uri: rootUri.toString(),
                }, error);
                throw error;
            }

            for (const [name, type] of items) {
                const relPath = nextRoot==='/' ? `/${name}` : `${nextRoot}/${name}`;
                if (this.matchIgnorePatterns(relPath) || this.vfs.isPrimaryPdfRenderPath(relPath)) {
                    this.logDiagnostic('scan.ignored', {
                        attemptId,
                        endpoint,
                        relPath,
                    });
                    continue;
                }

                const uri = this.getReplicaUri(endpoint, relPath);
                if (type===vscode.FileType.Directory) {
                    paths.set(relPath, {
                        relPath,
                        snapshot: createLocalReplicaSnapshot('directory'),
                        uri,
                    });
                    directoryCount += 1;
                    queue.push(relPath);
                } else if (type===vscode.FileType.File) {
                    const content = await vscode.workspace.fs.readFile(uri);
                    paths.set(relPath, {
                        content,
                        relPath,
                        snapshot: createLocalReplicaSnapshot('file', content),
                        uri,
                    });
                    fileCount += 1;
                } else {
                    this.logDiagnostic('scan.unsupported_type', {
                        attemptId,
                        endpoint,
                        relPath,
                        statType: type,
                    });
                }
            }
        }

        this.logDiagnostic('scan.completed', {
            attemptId,
            directoryCount,
            endpoint,
            fileCount,
            root: normalizedRoot,
        });
        return {
            directories: directoryCount,
            files: fileCount,
            paths,
        };
    }

    private async ensureParentDirectory(uri: vscode.Uri) {
        const parentPath = path.posix.dirname(uri.path);
        if (parentPath==='' || parentPath==='.' || parentPath===uri.path) {
            return;
        }
        await vscode.workspace.fs.createDirectory(uri.with({path: parentPath}));
    }

    private async writeReplicaFileContent(
        action: SyncAction,
        relPath: string,
        content: Uint8Array,
        targetEntry: ReplicaPathEntry,
        reason: string,
        syncTaskId: number,
    ): Promise<'written' | 'offline' | 'recovery-required'> {
        if (action==='push') {
            try {
                const resolved = await this.vfs._resolveUri(targetEntry.uri);
                if (resolved.fileType==='doc' && resolved.fileEntity) {
                    // Local-replica recovery can push into docs that are still
                    // open in local editors. Those paths must go through the OT
                    // sync API instead of the generic remote writeFile path,
                    // which intentionally bypasses managed documents.
                    const syncResult = await this.vfs.pushTextDocumentChanges(
                        targetEntry.uri,
                        new TextDecoder().decode(content),
                        `${reason}:local_replica_push`,
                    );
                    this.logDiagnostic('sync.remote_doc_push_completed', {
                        reason,
                        relPath,
                        result: syncResult.kind,
                        syncTaskId,
                    });
                    if (syncResult.kind==='applied' || syncResult.kind==='noop') {
                        return 'written';
                    }
                    return syncResult.kind;
                }
            } catch (error) {
                if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                    this.logDiagnostic('sync.remote_doc_resolution_failed', {
                        reason,
                        relPath,
                        syncTaskId,
                        targetUri: targetEntry.uri.toString(),
                    }, error);
                    throw error;
                }
            }
        }
        await this.ensureParentDirectory(targetEntry.uri);
        await vscode.workspace.fs.writeFile(targetEntry.uri, content);
        return 'written';
    }

    private async applyEntryToReplica(
        action: SyncAction,
        relPath: string,
        sourceEntry: ReplicaPathEntry,
        targetEntry: ReplicaPathEntry,
        reason: string,
        syncTaskId: number,
        recoveryRunId?: string,
    ): Promise<LocalReplicaPathOutcome> {
        this.logDiagnostic('sync.apply_started', {
            action,
            reason,
            relPath,
            sourceKind: sourceEntry.snapshot.kind,
            syncTaskId,
            targetKind: targetEntry.snapshot.kind,
        });
        if (action==='pull') {
            const record = await this.vfs.getDocumentSyncRecord(relPath);
            const localDirty = record?.localDirty === true;
            this.logDiagnostic('sync.prewrite_guard', {
                action,
                baseBlobPresent: record?.baseBlobId !== undefined,
                conflictStatePresent: record?.conflict !== undefined,
                dirtyStatePresent: localDirty,
                localDirty,
                relPath,
                syncTaskId,
            });
            if (localDirty) {
                await this.recordConflict(relPath, `${reason}:local_dirty_prevents_pull`, {
                    action,
                    relPath,
                    syncTaskId,
                });
                await this.vfs.recordDocumentSyncConflict({
                    baseContent: record?.baseBlobId ? await this.vfs.readDocumentSyncBlob(record.baseBlobId) : this.baselineContentCache.get(relPath),
                    baseVersion: record?.baseVersion,
                    docId: record?.docId,
                    lastKnownRemoteContent: sourceEntry.content,
                    lastKnownRemoteVersion: record?.lastKnownRemoteVersion,
                    localContent: targetEntry.content,
                    reason: `${reason}:local_dirty_prevents_pull`,
                    recoveryRunId,
                    relPath,
                    remoteContent: sourceEntry.content,
                });
                if (recoveryRunId) {
                    await this.revealConflict(relPath, `${reason}:local_dirty_prevents_pull`);
                }
                return {kind: 'conflict', reason: `${reason}:local_dirty_prevents_pull`, relPath};
            }
        }

        if (sourceEntry.snapshot.kind==='missing') {
            if (targetEntry.snapshot.kind==='directory') {
                const deleteCheck = await this.validateDirectoryDeletion(relPath, action, syncTaskId);
                if (!deleteCheck.safe) {
                    await this.recordConflict(relPath, deleteCheck.reason, {
                        action,
                        blockingPathCount: deleteCheck.blockingPathCount,
                        relPath,
                        syncTaskId,
                    });
                    return {kind: 'conflict', reason: deleteCheck.reason, relPath};
                }
            }
            try {
                await vscode.workspace.fs.delete(targetEntry.uri, {recursive: true});
            } catch (error) {
                if (!LocalReplicaSCMProvider.isFileNotFoundError(error)) {
                    throw error;
                }
                this.logDiagnostic('sync.delete_missing_target', {
                    action,
                    relPath,
                    syncTaskId,
                    targetUri: targetEntry.uri.toString(),
                });
            }
            await this.setMissingBaselineForSubtree(relPath);
            this.logDiagnostic('sync.apply_completed', {
                action,
                reason,
                relPath,
                result: 'deleted',
                syncTaskId,
            });
            return {kind: action==='pull' ? 'pulled' : 'pushed', reason, relPath};
        }

        if (sourceEntry.snapshot.kind==='directory') {
            await vscode.workspace.fs.createDirectory(targetEntry.uri);
            await this.setBaseline(relPath, sourceEntry.snapshot);
            this.logDiagnostic('sync.apply_completed', {
                action,
                reason,
                relPath,
                result: 'directory_created',
                syncTaskId,
            });
            return {kind: action==='pull' ? 'pulled' : 'pushed', reason, relPath};
        }

        const writeResult = await this.writeReplicaFileContent(
            action,
            relPath,
            sourceEntry.content!,
            targetEntry,
            reason,
            syncTaskId,
        );
        if (writeResult!=='written') {
            const record = await this.vfs.getDocumentSyncRecord(relPath);
            const failureReason = `${reason}:${writeResult}`;
            await this.recordConflict(relPath, failureReason, {
                action,
                relPath,
                syncTaskId,
                writeResult,
            });
            await this.vfs.recordDocumentSyncConflict({
                baseContent: record?.baseBlobId ? await this.vfs.readDocumentSyncBlob(record.baseBlobId) : this.baselineContentCache.get(relPath),
                baseVersion: record?.baseVersion,
                docId: record?.docId,
                lastKnownRemoteContent: action==='push' ? targetEntry.content : sourceEntry.content,
                lastKnownRemoteVersion: record?.lastKnownRemoteVersion,
                localContent: action==='push' ? sourceEntry.content : targetEntry.content,
                reason: failureReason,
                recoveryRunId,
                relPath,
                remoteContent: action==='push' ? targetEntry.content : sourceEntry.content,
            });
            if (recoveryRunId) {
                await this.revealConflict(relPath, failureReason);
            }
            return {kind: 'conflict', reason: failureReason, relPath};
        }
        await this.setBaseline(relPath, sourceEntry.snapshot, sourceEntry.content);
        this.logDiagnostic('sync.apply_completed', {
            action,
            bytes: sourceEntry.content?.length ?? 0,
            reason,
            relPath,
            result: 'file_written',
            syncTaskId,
        });
        return {kind: action==='pull' ? 'pulled' : 'pushed', reason, relPath};
    }

    private async validateDirectoryDeletion(relPath: string, action: SyncAction, syncTaskId: number) {
        const targetEndpoint: ReplicaEndpoint = action==='push' ? 'remote' : 'local';
        const targetTree = await this.collectReplicaTree(targetEndpoint, relPath);
        let blockingPathCount = 0;
        for (const [childRelPath, childEntry] of targetTree.paths) {
            const childState = await this.refreshPathStateFromJournal(childRelPath) ?? this.getPathState(childRelPath);
            if (childState?.conflict) {
                blockingPathCount += 1;
                continue;
            }
            if (childState?.baseline===undefined) {
                blockingPathCount += 1;
                continue;
            }
            if (!localReplicaSnapshotsEqual(childState.baseline, childEntry.snapshot)) {
                blockingPathCount += 1;
            }
        }
        const safe = blockingPathCount===0;
        this.logDiagnostic('sync.delete_directory_validated', {
            action,
            blockingPathCount,
            relPath,
            safe,
            syncTaskId,
            targetEndpoint,
            targetPathCount: targetTree.paths.size,
        });
        return {
            blockingPathCount,
            reason: safe ? 'subtree_matches_baseline' : 'directory_subtree_diverged',
            safe,
        };
    }

    private async resolveConflict(
        action: SyncAction,
        relPath: string,
        sourceEntry: ReplicaPathEntry,
        targetEntry: ReplicaPathEntry,
        reason: string,
        syncTaskId: number,
        recoveryRunId?: string,
    ): Promise<LocalReplicaPathOutcome> {
        await this.refreshPathStateFromJournal(relPath);
        const localEntry = action==='push' ? sourceEntry : targetEntry;
        const remoteEntry = action==='push' ? targetEntry : sourceEntry;
        const baselineContent = this.baselineContentCache.get(relPath);
        const record = await this.vfs.getDocumentSyncRecord(relPath);

        if (action==='push' && localEntry.snapshot.kind==='file' && record?.conflict?.localBlobId && record.lastKnownRemoteSnapshot) {
            const conflictedLocalContent = await this.vfs.readDocumentSyncBlob(record.conflict.localBlobId);
            const conflictedLocalSnapshot = conflictedLocalContent
                ? createLocalReplicaSnapshot('file', conflictedLocalContent)
                : undefined;
            const remoteMatchesConflict = localReplicaSnapshotsEqual(remoteEntry.snapshot, record.lastKnownRemoteSnapshot);
            const localChangedSinceConflict = conflictedLocalSnapshot===undefined
                ? true
                : !localReplicaSnapshotsEqual(localEntry.snapshot, conflictedLocalSnapshot);
            if (remoteMatchesConflict && localChangedSinceConflict) {
                this.logDiagnostic('conflict.manual_resolution_detected', {
                    action,
                    reason,
                    relPath,
                    remoteHash: remoteEntry.snapshot.hash,
                    syncTaskId,
                });
                return this.applyEntryToReplica(
                    'push',
                    relPath,
                    localEntry,
                    remoteEntry,
                    `${reason}:manual_resolution`,
                    syncTaskId,
                    recoveryRunId,
                );
            }
        }

        if (localEntry.snapshot.kind==='file' && remoteEntry.snapshot.kind==='file') {
            const mergeResult = mergeLocalReplicaText(baselineContent, localEntry.content!, remoteEntry.content!);
            if (mergeResult.kind==='merged') {
                await this.ensureParentDirectory(localEntry.uri);
                await vscode.workspace.fs.writeFile(localEntry.uri, mergeResult.mergedContent);
                const writeResult = await this.writeReplicaFileContent(
                    'push',
                    relPath,
                    mergeResult.mergedContent,
                    remoteEntry,
                    `${reason}:merged`,
                    syncTaskId,
                );
                if (writeResult!=='written') {
                    const failureReason = `${reason}:merged:${writeResult}`;
                    await this.recordConflict(relPath, failureReason, {
                        action,
                        relPath,
                        syncTaskId,
                        writeResult,
                    });
                    await this.vfs.recordDocumentSyncConflict({
                        baseContent: baselineContent,
                        baseVersion: record?.baseVersion,
                        docId: record?.docId,
                        lastKnownRemoteContent: remoteEntry.content,
                        lastKnownRemoteVersion: record?.lastKnownRemoteVersion,
                        localContent: mergeResult.mergedContent,
                        reason: failureReason,
                        recoveryRunId,
                        relPath,
                        remoteContent: remoteEntry.content,
                    });
                    if (recoveryRunId) {
                        await this.revealConflict(relPath, failureReason);
                    }
                    return {kind: 'conflict', reason: failureReason, relPath};
                }
                await this.setBaseline(
                    relPath,
                    createLocalReplicaSnapshot('file', mergeResult.mergedContent),
                    mergeResult.mergedContent,
                );
                this.logDiagnostic('sync.merge_completed', {
                    action,
                    bytes: mergeResult.mergedContent.length,
                    reason,
                    relPath,
                    syncTaskId,
            });
            return {kind: 'merged', reason, relPath};
        }
        await this.recordConflict(relPath, `${reason}:${mergeResult.reason}`, {
            action,
                failedPatchCount: mergeResult.failedPatchCount,
                relPath,
                syncTaskId,
            });
            await this.vfs.recordDocumentSyncConflict({
                baseContent: baselineContent,
                docId: record?.docId,
                lastKnownRemoteContent: remoteEntry.content,
                localContent: localEntry.content,
                reason: `${reason}:${mergeResult.reason}`,
                recoveryRunId,
                relPath,
                remoteContent: remoteEntry.content,
            });
            if (recoveryRunId) {
                await this.revealConflict(relPath, `${reason}:${mergeResult.reason}`);
            }
            return {kind: 'conflict', reason: `${reason}:${mergeResult.reason}`, relPath};
        }

        await this.recordConflict(relPath, reason, {
            action,
            localKind: localEntry.snapshot.kind,
            relPath,
            remoteKind: remoteEntry.snapshot.kind,
            syncTaskId,
        });
        await this.vfs.recordDocumentSyncConflict({
            baseContent: baselineContent,
            docId: record?.docId,
            lastKnownRemoteContent: remoteEntry.content,
            localContent: localEntry.content,
            reason,
            recoveryRunId,
            relPath,
            remoteContent: remoteEntry.content,
        });
        if (recoveryRunId) {
            await this.revealConflict(relPath, reason);
        }
        return {kind: 'conflict', reason, relPath};
    }

    private async reconcilePath(
        attemptId: number,
        relPath: string,
        localEntry: ReplicaPathEntry,
        remoteEntry: ReplicaPathEntry,
        recoveryRunId: string,
    ): Promise<LocalReplicaPathOutcome> {
        const managedDocumentState = this.getManagedDocumentStateForRelPath(relPath);
        if (shouldDeferLocalReplicaFileSyncToManagedSession({
            localSnapshotKind: localEntry.snapshot.kind,
            managedDocumentState,
            remoteSnapshotKind: remoteEntry.snapshot.kind,
        })) {
            this.logDiagnostic('reconcile.deferred_managed_document_session', {
                attemptId,
                managedState: managedDocumentState,
                recoveryRunId,
                relPath,
            });
            return {kind: 'deferred', reason: 'managed_document_session', relPath};
        }

        const state = await this.refreshPathStateFromJournal(relPath) ?? this.getPathState(relPath);
        const decision = classifyLocalReplicaReconcile(state, localEntry.snapshot, remoteEntry.snapshot);
        this.logDiagnostic('reconcile.decision', {
            attemptId,
            decision: decision.kind,
            localKind: localEntry.snapshot.kind,
            reason: decision.reason,
            relPath,
            remoteKind: remoteEntry.snapshot.kind,
        });

        if (decision.kind==='skip') {
            if (localReplicaSnapshotsEqual(localEntry.snapshot, remoteEntry.snapshot) && localEntry.snapshot.kind!=='missing') {
                await this.setBaseline(relPath, localEntry.snapshot, localEntry.content ?? remoteEntry.content);
            } else if (localEntry.snapshot.kind==='missing' && remoteEntry.snapshot.kind==='missing') {
                await this.setMissingBaselineForSubtree(relPath);
            }
            return {kind: 'synced', reason: decision.reason, relPath};
        }

        if (decision.kind==='sync_remote_to_local') {
            return this.applyEntryToReplica('pull', relPath, remoteEntry, localEntry, decision.reason, attemptId, recoveryRunId);
        }

        if (decision.kind==='sync_local_to_remote') {
            return this.applyEntryToReplica('push', relPath, localEntry, remoteEntry, decision.reason, attemptId, recoveryRunId);
        }

        return this.resolveConflict('pull', relPath, remoteEntry, localEntry, decision.reason, attemptId, recoveryRunId);
    }

    private async overwrite(root: string = '/'): Promise<LocalReplicaRecoveryResult | undefined> {
        const attemptId = ++this.reconcileAttemptCounter;
        const normalizedRoot = this.normalizeRelPath(root);
        const recoveryRunId = this.nextRecoveryRunId();
        this.logDiagnostic('reconcile.started', {
            attemptId,
            recoveryRunId,
            root: normalizedRoot,
        });

        return vscode.window.withProgress({
            // Background replica reconciliation can run during normal sync and
            // recovery cycles. Keep it off the notification surface so only
            // connection-state transitions produce user-facing popups.
            location: vscode.ProgressLocation.Window,
            title: vscode.l10n.t('Sync Files'),
            cancellable: true,
        }, async (progress, token) => {
            const result: LocalReplicaRecoveryResult = {
                cancelled: false,
                conflictedPaths: [],
                failedPaths: [],
                mergedPaths: [],
                pulledPaths: [],
                pushedPaths: [],
                recoveryRunId,
                syncedPaths: [],
            };
            const [localTree, remoteTree] = await Promise.all([
                this.collectReplicaTree('local', normalizedRoot),
                this.collectReplicaTree('remote', normalizedRoot),
            ]);
            const relPaths = [...new Set([
                ...localTree.paths.keys(),
                ...remoteTree.paths.keys(),
            ])].sort((left, right) => left.localeCompare(right));
            const rehydrateEmptyLocalReplica = shouldRehydrateEmptyLocalReplicaFromRemote({
                isRootReconcile: normalizedRoot==='/',
                localPathCount: localTree.paths.size,
                pathStates: this.syncState.values(),
                remotePathCount: remoteTree.paths.size,
            });

            this.logDiagnostic('reconcile.scan_completed', {
                attemptId,
                emptyLocalReplicaRehydrate: rehydrateEmptyLocalReplica,
                localDirectoryCount: localTree.directories,
                localFileCount: localTree.files,
                pathCount: relPaths.length,
                remoteDirectoryCount: remoteTree.directories,
                remoteFileCount: remoteTree.files,
                root: normalizedRoot,
            });
            if (rehydrateEmptyLocalReplica) {
                this.logDiagnostic('reconcile.empty_local_replica_rehydrate_started', {
                    attemptId,
                    recoveryRunId,
                    remotePathCount: remoteTree.paths.size,
                    root: normalizedRoot,
                    trackedPathCount: this.syncState.size,
                });
            }

            const total = relPaths.length;
            for (let index = 0; index < total; index += 1) {
                if (token.isCancellationRequested) {
                    this.logDiagnostic('reconcile.cancelled', {
                        attemptId,
                        processedPathCount: index,
                        recoveryRunId,
                        root: normalizedRoot,
                        totalPathCount: total,
                    });
                    result.cancelled = true;
                    return result;
                }
                const relPath = relPaths[index];
                progress.report({
                    increment: total===0 ? 100 : 100/total,
                    message: relPath,
                });
                const localEntry = localTree.paths.get(relPath) ?? await this.snapshotPath('local', relPath);
                const remoteEntry = remoteTree.paths.get(relPath) ?? await this.snapshotPath('remote', relPath);
                const pathOutcome = rehydrateEmptyLocalReplica
                    && localEntry.snapshot.kind==='missing'
                    && remoteEntry.snapshot.kind!=='missing'
                    ? await this.applyEntryToReplica(
                        'pull',
                        relPath,
                        remoteEntry,
                        localEntry,
                        'empty_local_replica_rehydrated_from_remote',
                        attemptId,
                        recoveryRunId,
                    )
                    : await this.reconcilePath(attemptId, relPath, localEntry, remoteEntry, recoveryRunId);
                switch (pathOutcome.kind) {
                    case 'conflict':
                        result.conflictedPaths.push(relPath);
                        break;
                    case 'deferred':
                        break;
                    case 'merged':
                        result.mergedPaths.push(relPath);
                        result.syncedPaths.push(relPath);
                        break;
                    case 'pulled':
                        result.pulledPaths.push(relPath);
                        result.syncedPaths.push(relPath);
                        break;
                    case 'pushed':
                        result.pushedPaths.push(relPath);
                        result.syncedPaths.push(relPath);
                        break;
                    case 'synced':
                        result.syncedPaths.push(relPath);
                        break;
                }
            }

            await this.persistSyncState('reconcile', relPaths);
            this.refreshStatus();
            this.logDiagnostic('reconcile.completed', {
                conflictedPaths: result.conflictedPaths,
                attemptId,
                conflictCount: this.conflictPaths.size,
                pathCount: total,
                pulledPaths: result.pulledPaths,
                pushedPaths: result.pushedPaths,
                recoveryRunId,
                root: normalizedRoot,
                syncedPaths: result.syncedPaths,
            });
            return result;
        });
    }

    private enqueueSync(
        action: SyncAction,
        type: SyncChangeType,
        relPath: string,
    ) {
        const syncTaskId = ++this.syncTaskCounter;
        const normalizedRelPath = this.normalizeRelPath(relPath);
        this.logDiagnostic('sync.task_enqueued', {
            action,
            relPath: normalizedRelPath,
            syncTaskId,
            type,
        });
        this.syncQueue = this.syncQueue.then(async () => {
            try {
                await this.processSyncTask(syncTaskId, action, type, normalizedRelPath);
            } catch (error) {
                this.logDiagnostic('sync.task_failed', {
                    action,
                    relPath: normalizedRelPath,
                    syncTaskId,
                    type,
                }, error);
            }
        });
    }

    private async processSyncTask(
        syncTaskId: number,
        action: SyncAction,
        type: SyncChangeType,
        relPath: string,
    ) {
        if (this.replicaDetached) {
            this.logDiagnostic('sync.task_skipped_replica_detached', {
                action,
                relPath,
                syncTaskId,
                type,
            });
            return;
        }
        this.setProviderStatus({status: action, message: `${type}: ${relPath}`});
        this.logDiagnostic('sync.task_started', {
            action,
            relPath,
            syncTaskId,
            type,
        });

        if (action==='push' && type==='delete') {
            const suppressed = await this.suppressReplicaRootDeletionPropagation(
                relPath,
                syncTaskId,
                'local_replica_root_deleted_before_push',
                false,
            );
            if (suppressed) {
                return;
            }
        }

        const sourceEndpoint: ReplicaEndpoint = action==='push' ? 'local' : 'remote';
        const targetEndpoint: ReplicaEndpoint = action==='push' ? 'remote' : 'local';
        const [sourceEntry, targetEntry] = await Promise.all([
            this.snapshotPath(sourceEndpoint, relPath),
            this.snapshotPath(targetEndpoint, relPath),
        ]);
        try {
            const managedDocumentState = this.getManagedDocumentStateForRelPath(relPath);
            if (shouldDeferLocalReplicaFileSyncToManagedSession({
                localSnapshotKind: action==='push' ? sourceEntry.snapshot.kind : targetEntry.snapshot.kind,
                managedDocumentState,
                remoteSnapshotKind: action==='push' ? targetEntry.snapshot.kind : sourceEntry.snapshot.kind,
            })) {
                this.logDiagnostic('sync.deferred_managed_document_session', {
                    action,
                    managedState: managedDocumentState,
                    relPath,
                    syncTaskId,
                    type,
                });
                return;
            }
            const state = await this.refreshPathStateFromJournal(relPath) ?? this.getPathState(relPath);
            const decision = classifyLocalReplicaRuntimeSync(state, sourceEntry.snapshot, targetEntry.snapshot);
            this.logDiagnostic('sync.decision', {
                action,
                decision: decision.kind,
                reason: decision.reason,
                relPath,
                sourceEndpoint,
                sourceKind: sourceEntry.snapshot.kind,
                syncTaskId,
                targetEndpoint,
                targetKind: targetEntry.snapshot.kind,
                type,
            });

            if (decision.kind==='skip') {
                if (localReplicaSnapshotsEqual(sourceEntry.snapshot, targetEntry.snapshot)) {
                    if (sourceEntry.snapshot.kind==='missing') {
                        await this.setMissingBaselineForSubtree(relPath);
                    } else {
                        await this.setBaseline(relPath, sourceEntry.snapshot, sourceEntry.content ?? targetEntry.content);
                    }
                    await this.persistSyncState('sync_skip_in_sync', [relPath]);
                }
                return;
            }

            if (decision.kind==='apply') {
                await this.applyEntryToReplica(action, relPath, sourceEntry, targetEntry, decision.reason, syncTaskId);
                await this.persistSyncState('sync_apply', [relPath]);
                return;
            }

            await this.resolveConflict(action, relPath, sourceEntry, targetEntry, decision.reason, syncTaskId);
            await this.persistSyncState('sync_conflict', [relPath]);
        } finally {
            this.refreshStatus();
            this.logDiagnostic('sync.task_completed', {
                action,
                conflictCount: this.conflictPaths.size,
                relPath,
                syncTaskId,
                type,
            });
        }
    }

    private async recoverDeferredLocalReplicaChanges(reason: string) {
        if (this.deferredRecoveryInProgress || this.vfs.isOfflineMode || !this.vfs.hasDeferredLocalReplicaOperations) {
            return;
        }
        this.deferredRecoveryInProgress = true;
        this.logDiagnostic('offline_recovery.started', {
            reason,
        });
        try {
            let overwriteResult: LocalReplicaRecoveryResult | undefined;
            this.syncQueue = this.syncQueue.then(async () => {
                overwriteResult = await this.overwrite();
            });
            await this.syncQueue;
            this.logDiagnostic('offline_recovery.completed', {
                acknowledgedPaths: overwriteResult?.syncedPaths ?? [],
                conflictedPaths: overwriteResult?.conflictedPaths ?? [],
                mergedPaths: overwriteResult?.mergedPaths ?? [],
                overwriteResult: overwriteResult===undefined
                    ? 'cancelled'
                    : overwriteResult.cancelled
                        ? 'cancelled'
                        : 'completed',
                pulledPaths: overwriteResult?.pulledPaths ?? [],
                pushedPaths: overwriteResult?.pushedPaths ?? [],
                reason,
            });
            if (overwriteResult && !overwriteResult.cancelled && overwriteResult.syncedPaths.length > 0) {
                await this.vfs.acknowledgeLocalReplicaSynchronization(
                    `local_replica_recovered:${reason}`,
                    overwriteResult.syncedPaths,
                );
            }
            if (overwriteResult && !overwriteResult.cancelled && !this.vfs.isOfflineMode) {
                await this.vfs.resumeDeferredSynchronizationRecovery(`local_replica_recovered:${reason}`);
            }
        } catch (error) {
            this.logDiagnostic('offline_recovery.failed', {reason}, error);
        } finally {
            this.deferredRecoveryInProgress = false;
            this.refreshStatus();
        }
    }

    private queueLocalDelete(relPath: string, localUri: vscode.Uri) {
        this.pendingLocalDeleteRelPaths.add(relPath);
        if (this.pendingLocalDeleteFlushTimer) {
            clearTimeout(this.pendingLocalDeleteFlushTimer);
        }
        this.logDiagnostic('watch.local_delete_batched', {
            pendingDeleteCount: this.pendingLocalDeleteRelPaths.size,
            relPath,
            settleMs: LOCAL_REPLICA_DELETE_SETTLE_MS,
            uri: localUri.toString(),
        });
        this.pendingLocalDeleteFlushTimer = setTimeout(() => {
            this.pendingLocalDeleteFlushTimer = undefined;
            void this.flushPendingLocalDeletes('local_delete_batch_settled');
        }, LOCAL_REPLICA_DELETE_SETTLE_MS);
    }

    private async flushPendingLocalDeletes(reason: string) {
        if (this.pendingLocalDeleteFlushTimer) {
            clearTimeout(this.pendingLocalDeleteFlushTimer);
            this.pendingLocalDeleteFlushTimer = undefined;
        }
        const relPaths = Array.from(this.pendingLocalDeleteRelPaths)
            .sort((left, right) => left.localeCompare(right));
        this.pendingLocalDeleteRelPaths.clear();
        if (relPaths.length===0) {
            return;
        }
        if (this.replicaDetached) {
            this.logDiagnostic('watch.local_delete_batch_suppressed_replica_detached', {
                pendingDeleteCount: relPaths.length,
                reason,
            });
            return;
        }
        if (relPaths.some(isLocalReplicaMetadataPath)) {
            await this.detachLocalReplicaPreservingRemote('local_replica_metadata_deleted', {
                pendingDeleteCount: relPaths.length,
                reason,
            });
            this.logDiagnostic('watch.local_delete_batch_suppressed_metadata_deleted', {
                pendingDeleteCount: relPaths.length,
                reason,
            });
            return;
        }
        const suppressed = await this.suppressReplicaRootDeletionPropagation(
            '/',
            0,
            reason,
            false,
        );
        if (suppressed) {
            this.logDiagnostic('watch.local_delete_batch_suppressed_project_removed', {
                pendingDeleteCount: relPaths.length,
                reason,
            });
            return;
        }
        this.logDiagnostic('watch.local_delete_batch_flushed', {
            pendingDeleteCount: relPaths.length,
            reason,
        });
        for (const relPath of relPaths) {
            if (this.matchIgnorePatterns(relPath) || this.vfs.isPrimaryPdfRenderPath(relPath)) {
                this.logDiagnostic('watch.event_ignored', {
                    endpoint: 'local',
                    relPath,
                    type: 'delete',
                });
                continue;
            }
            const localEntry = await this.snapshotPath('local', relPath);
            if (localEntry.snapshot.kind!=='missing') {
                this.logDiagnostic('watch.local_delete_stale_ignored', {
                    localKind: localEntry.snapshot.kind,
                    reason,
                    relPath,
                });
                continue;
            }
            if (this.vfs.isOfflineMode) {
                await this.vfs.recordLocalReplicaChange('delete', relPath, 'local_replica_delete_queued');
                this.setProviderStatus({
                    status: 'need-attention',
                    message: vscode.l10n.t('Offline local changes are queued for sync.'),
                });
                continue;
            }
            this.enqueueSync('push', 'delete', relPath);
        }
    }

    private syncFromVFS(vfsUri: vscode.Uri, type: SyncChangeType) {
        if (this.replicaDetached) {
            this.logDiagnostic('watch.event_suppressed_replica_detached', {
                endpoint: 'remote',
                type,
                uri: vfsUri.toString(),
            });
            return;
        }
        const relPath = this.relPathFromRemoteUri(vfsUri);
        const managedDocumentState = this.vfs.getManagedTextDocumentState(vfsUri);
        this.logDiagnostic('watch.event_received', {
            endpoint: 'remote',
            managedState: managedDocumentState ?? '',
            relPath,
            type,
            uri: vfsUri.toString(),
        });
        // Open managed documents reconcile through the live session manager.
        // Letting remote watcher pulls write onto those files can overwrite
        // in-flight local edits during reconnect churn.
        const suppressForManagedSession = shouldSuppressRemoteWatcherPullForManagedDocument(managedDocumentState);
        if (type==='update' && suppressForManagedSession) {
            this.logDiagnostic(managedDocumentState==='pending'
                ? 'watch.event_suppressed_pending_session'
                : managedDocumentState==='syncing'
                    ? 'watch.event_suppressed_syncing_session'
                : managedDocumentState==='live'
                    ? 'watch.event_suppressed_active_session'
                    : 'watch.event_suppressed_managed_session', {
                endpoint: 'remote',
                managedState: managedDocumentState,
                relPath,
                type,
            });
            return;
        }
        const isPrimaryPdfRenderPath = this.vfs.isPrimaryPdfRenderPath(relPath);
        if (this.matchIgnorePatterns(relPath) && !isPrimaryPdfRenderPath) {
            this.logDiagnostic('watch.event_ignored', {
                endpoint: 'remote',
                relPath,
                type,
            });
            return;
        }
        this.enqueueSync('pull', type, relPath);
    }

    private async syncToVFS(localUri: vscode.Uri, type: SyncChangeType) {
        if (this.replicaDetached) {
            this.logDiagnostic('watch.event_suppressed_replica_detached', {
                endpoint: 'local',
                type,
                uri: localUri.toString(),
            });
            return;
        }
        const relPath = this.relPathFromLocalUri(localUri);
        const managedDocumentState = this.vfs.getManagedTextDocumentState(localUri);
        this.logDiagnostic('watch.event_received', {
            endpoint: 'local',
            managedState: managedDocumentState ?? '',
            relPath,
            type,
            uri: localUri.toString(),
        });
        if (type==='delete') {
            this.queueLocalDelete(relPath, localUri);
            return;
        }
        // Open text documents already flushed through the OT session manager, so
        // watcher-driven pushes here would duplicate the same change.
        if (type==='update' && managedDocumentState) {
            this.logDiagnostic(managedDocumentState==='pending'
                ? 'watch.event_suppressed_pending_session'
                : 'watch.event_suppressed_active_session', {
                endpoint: 'local',
                managedState: managedDocumentState,
                relPath,
                type,
            });
            return;
        }
        if (this.matchIgnorePatterns(relPath) || this.vfs.isPrimaryPdfRenderPath(relPath)) {
            this.logDiagnostic('watch.event_ignored', {
                endpoint: 'local',
                relPath,
                type,
            });
            return;
        }
        if (this.vfs.isOfflineMode) {
            // File content remains durable on disk while offline; we record the
            // changed path in the deferred queue and let the baseline reconcile
            // engine push/merge it once connectivity returns.
            void this.vfs.recordLocalReplicaChange(type, relPath, 'local_replica_change_queued');
            this.setProviderStatus({
                status: 'need-attention',
                message: vscode.l10n.t('Offline local changes are queued for sync.'),
            });
            return;
        }
        this.enqueueSync('push', type, relPath);
    }

    private isLocalDocument(uri: vscode.Uri) {
        return uri.scheme===this.baseUri.scheme && uri.path.startsWith(this.baseUri.path);
    }

    private async initWatch() {
        this.logDiagnostic('watch.init_started');
        await this.ensureSettingsFiles();
        await this.loadSyncState();

        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.vfs.origin, '**/*'),
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.baseUri.path, '**/*'),
        );

        const overwriteResult = await this.overwrite();
        this.logDiagnostic('watch.initial_sync_completed', {
            conflictCount: overwriteResult?.conflictedPaths.length ?? 0,
            overwriteResult: overwriteResult===undefined
                ? 'cancelled'
                : overwriteResult.cancelled
                    ? 'cancelled'
                    : 'completed',
            syncedPathCount: overwriteResult?.syncedPaths.length ?? 0,
        });
        if (!this.vfs.isOfflineMode && this.vfs.hasDeferredLocalReplicaOperations) {
            void this.recoverDeferredLocalReplicaChanges('watch_initialized');
        }

        return [
            this.vfsWatcher.onDidChange(uri => this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidCreate(uri => this.syncFromVFS(uri, 'update')),
            this.vfsWatcher.onDidDelete(uri => this.syncFromVFS(uri, 'delete')),
            this.localWatcher.onDidChange(uri => { void this.syncToVFS(uri, 'update'); }),
            this.localWatcher.onDidCreate(uri => { void this.syncToVFS(uri, 'update'); }),
            this.localWatcher.onDidDelete(uri => { void this.syncToVFS(uri, 'delete'); }),
            new vscode.Disposable(() => this.clearPendingLocalDeleteBatch()),
            EventBus.on('offlineSynchronizationStateChangedEvent', ({origin, mode, reason}) => {
                if (origin!==this.vfs.origin.toString()) {
                    return;
                }
                if (mode==='offline') {
                    this.setProviderStatus({
                        status: 'need-attention',
                        message: vscode.l10n.t('Offline local changes are queued for sync.'),
                    });
                    return;
                }
                if (this.vfs.hasDeferredLocalReplicaOperations) {
                    void this.recoverDeferredLocalReplicaChanges(reason);
                    return;
                }
                this.refreshStatus();
            }),
            vscode.workspace.onDidSaveTextDocument(document => {
                if (!this.isLocalDocument(document.uri)) {
                    return;
                }
                this.logDiagnostic('document.saved', {
                    isDirty: document.isDirty,
                    languageId: document.languageId,
                    lineCount: document.lineCount,
                    managedState: this.vfs.getManagedTextDocumentState(document.uri) ?? '',
                    relPath: this.relPathFromLocalUri(document.uri),
                    uri: document.uri.toString(),
                });
            }),
        ];
    }

    writeFile(relPath: string, content: Uint8Array): Thenable<void> {
        const uri = this.localUriForRelPath(relPath);
        return this.ensureParentDirectory(uri)
            .then(() => vscode.workspace.fs.writeFile(uri, content));
    }

    readFile(relPath: string): Thenable<Uint8Array | undefined> {
        const uri = this.localUriForRelPath(relPath);
        return new Promise(async (resolve) => {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                resolve(content);
            } catch {
                resolve(undefined);
            }
        });
    }

    get triggers(): Promise<vscode.Disposable[]> {
        return this.initWatch()
            .then((watches) => {
                const diagnosticsStateRegistration = registerDiagnosticStateProvider(
                    `localReplica:${this.vfs.serverName}/${this.vfs.projectId}`,
                    () => this.getDiagnosticsState(),
                );
                const disposables = this.vfsWatcher!==undefined && this.localWatcher!==undefined
                    ? [
                        diagnosticsStateRegistration,
                        this.vfsWatcher,
                        this.localWatcher,
                        ...watches,
                    ]
                    : [diagnosticsStateRegistration];
                this.logDiagnostic('watch.init_completed', {
                    localWatcherReady: this.localWatcher!==undefined,
                    triggerCount: disposables.length,
                    vfsWatcherReady: this.vfsWatcher!==undefined,
                });
                return disposables;
            })
            .catch(error => {
                this.logDiagnostic('watch.init_failed', {}, error);
                throw error;
            });
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = path.sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = require('os').homedir()+sep;
        inputBox.onDidChangeValue(async value => {
            try {
                inputBox.busy = true;
                const basePath = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory(vscode.Uri.file(basePath));
                const subDirs = items.filter(([, type]) => type===vscode.FileType.Directory)
                    .filter(([name]) => `${basePath}${sep}${name}`.startsWith(value));
                inputBox.busy = false;
                if (subDirs.length!==0) {
                    const candidates = subDirs.map(([name]) => ({label:name, alwaysShow:true, picked:false}));
                    if (basePath!=='') {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                }
            } finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const currentPath = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label==='..' ? currentPath : `${currentPath}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        this.logDiagnostic('ignore_patterns.updated', {
                            action: 'remove',
                            pattern: item.label,
                            patternCount: ignorePatterns.length,
                        });
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                this.logDiagnostic('ignore_patterns.updated', {
                                    action: 'add',
                                    pattern,
                                    patternCount: ignorePatterns.length,
                                });
                                quickPick.items = ignorePatterns.map(itemPattern => ({
                                    label: itemPattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
