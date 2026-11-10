/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { mergeTextFromCommonBase } from '../core/threeWayMerge';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { BaseAPI, Identity, ProjectMessageResponseSchema, ProjectSettingsSchema } from './base';
import { reconstructDocumentFromDiff } from './docDiff';
import { DocumentEntity, FileEntity, ProjectEntity, VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { UpdateSchema, UpdateUserSchema } from './socketio';
import { ROOT_NAME } from '../consts';
import { logDiagnostic } from '../utils/diagnostics';

const keyHistoryRefreshInterval = `${ROOT_NAME}.invisibleMode.historyRefreshInterval`;
const keyChatMessageRefreshInterval = `${ROOT_NAME}.invisibleMode.chatMessageRefreshInterval`;
const keyInactiveTimeout = `${ROOT_NAME}.invisibleMode.inactiveTimeout`;

type EmitCallbackType = (err: Error|undefined, ...data:any[]) => void;
type EmitEventsSupport = {
    'joinProject': [{project_id: string}],
    'joinDoc': [string, {encodeRanges: true}], //docId
    'leaveDoc': [string], //docId
    'applyOtUpdate': [string, UpdateSchema],
    'clientTracking.getConnectedUsers': [],
    'clientTracking.updatePosition': [{doc_id:string,row:number,column:number}],
};
type ListenEventsSupport = {
    // initially triggered
    'connect': {},
    'connectionAccepted': {_:any, publicId:string},
    'joinProjectResponse': {publicId:string,project:ProjectEntity},
    // manually triggered
    'disconnect': {},
    // not triggered
    'connect_failed': {},
    'forceDisconnect': {message:string, delay:number},
    'connectionRejected': {err:{message:string}},
    'error': {err:{message:string}},
    'spellCheckLanguageUpdated': {language:string},
    'compilerUpdated': {compiler:string},

    // (periodically) via FileTree diff
    'reciveNewDoc': {parentFolderId:string, doc:DocumentEntity},
    'reciveNewFile': {parentFolderId:string, file:FileEntity},
    //'reciveNewFolder': {parentFolderId:string, folder:FolderEntity},
    'reciveEntityRename': {entityId:string, newName:string},
    'reciveEntityMove': {entityId:string, folderId:string},
    'removeEntity': {entityId:string},
    'otUpdateApplied': {update:UpdateSchema},
    // (periodically) via FileTree diff
    'clientTracking.clientUpdated': {user:UpdateUserSchema},
    'clientTracking.clientDisconnected': {publicId:string},
    // (periodically) via `getMessages`
    'new-chat-message': {message:ProjectMessageResponseSchema},    
};

export class SyncTimer {
    private timer?: NodeJS.Timeout;
    private stopped = false;
    constructor(private _interval: number, private readonly _callback: () => Promise<void>) {
        void this.run();
    }
    private async run() {
        if (this.stopped) { return; }
        try { await this._callback(); }
        catch (error) { logDiagnostic('SocketIOAlt', 'poll.failed', {}, error); }
        finally {
            if (!this.stopped) { this.timer = setTimeout(() => void this.run(), Math.max(1000, this._interval)); }
        }
    }
    set interval(value: number) { if (Number.isFinite(value) && value > 0) { this._interval = value; } }
    stop() { this.stopped = true; clearTimeout(this.timer); }
}

export class SocketIOAlt {
    private _vfs?: VirtualFileSystem;
    private _eventEmitter = new EventEmitter();
    private watchConfigurationsDisposable;

    private vfsRefreshTask: SyncTimer;
    private vfsLocalVersion?: number;
    private localChangesPath: { [path:string] : {parentFolderId:string,filename:string} } = {};
    private connectedUsers: UpdateUserSchema[] = [];

    private snapshotAttemptId = 0;
    private disconnected = false;
    private bootstrapTimer?: NodeJS.Timeout;
    private refreshPromise?: Promise<void>;
    private uploadPromise?: Promise<void>;
    private uploading = false;

    constructor(
                private readonly url:string,
                private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string,
                private readonly record: Promise<ProjectEntity>,
    ) {
        // Attach a rejection handler immediately, even if shutdown happens
        // before the timer. Announce a connection only with a valid project.
        const bootstrap = this.record.then(project => ({project}), error => ({error}));
        this.bootstrapTimer = setTimeout(() => {
            this.bootstrapTimer = undefined;
            void bootstrap.then(result => {
                if (this.disconnected) { return; }
                if ('error' in result) {
                    logDiagnostic('SocketIOAlt', 'bootstrap.failed', {}, result.error);
                    this.emitEvent('connect_failed');
                    return;
                }
                this.emitEvent('connect');
                this.emitEvent('connectionAccepted', undefined, '');
                this.emitEvent('joinProjectResponse', '', result.project);
            });
        }, 10);

        this.vfsRefreshTask = new SyncTimer(this.historyRefreshInterval, this.refreshVFS.bind(this));
        this.watchConfigurationsDisposable = this.watchConfigurations();
    }

    private emitEvent(event: string, ...args: any[]) {
        if (!this.disconnected) { this._eventEmitter.emit(event, ...args); }
    }

    private get randomEntityId(): string {
        return [...Array(24)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    }

    private get vfs(): Thenable<VirtualFileSystem> {
        if (this._vfs) {
            return Promise.resolve(this._vfs);
        } else {
            return vscode.commands.executeCommand('remoteFileSystem.prefetch', vscode.Uri.parse(this.url))
                .then(async (vfsPromise) => {
                    this._vfs = await (vfsPromise as Promise<VirtualFileSystem>);
                    return this._vfs;
                });
        }
    }

    private get historyRefreshInterval(): number {
        return vscode.workspace.getConfiguration(ROOT_NAME).get<number>(keyHistoryRefreshInterval, 3) * 1000;//ms
    }

    private get messageRefreshInterval(): number {
        return vscode.workspace.getConfiguration(ROOT_NAME).get<number>(keyChatMessageRefreshInterval, 3) * 1000;//ms
    }

    private watchConfigurations() {
        return vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration(`${ROOT_NAME}.invisibleMode.historyRefreshInterval`)) {
                    this.vfsRefreshTask.interval = this.historyRefreshInterval;
                }

                void e;
            });
    }

    private async readDocSnapshot(vfs: VirtualFileSystem, pathname: string, version: number): Promise<string | undefined> {
        this.snapshotAttemptId += 1;
        const snapshotAttemptId = this.snapshotAttemptId;
        const sameVersionDiff = await vfs.getFileDiff(pathname, version, version);
        const sameVersionContent = reconstructDocumentFromDiff(sameVersionDiff?.diff);
        if (sameVersionContent !== undefined) {
            logDiagnostic('SocketIOAlt', 'doc_snapshot.resolved', {
                pathname,
                snapshotAttemptId,
                source: 'same_version_diff',
                version,
            });
            return sameVersionContent;
        }

        if (version > 0) {
            const historicalDiff = await vfs.getFileDiff(pathname, 0, version);
            const historicalContent = reconstructDocumentFromDiff(historicalDiff?.diff);
            if (historicalContent !== undefined) {
                logDiagnostic('SocketIOAlt', 'doc_snapshot.resolved', {
                    pathname,
                    snapshotAttemptId,
                    source: 'historical_diff',
                    version,
                });
                return historicalContent;
            }
        }

        const archiveContent = await vfs.getFallbackArchiveText(pathname, version);
        if (archiveContent !== undefined) {
            logDiagnostic('SocketIOAlt', 'doc_snapshot.resolved', {
                pathname,
                snapshotAttemptId,
                source: 'archive',
                version,
            });
            return archiveContent;
        }

        logDiagnostic('SocketIOAlt', 'doc_snapshot.unavailable', {
            pathname,
            snapshotAttemptId,
            version,
        });
        return undefined;
    }

    private refreshVFS(): Promise<void> {
        if (this.disconnected) { return Promise.resolve(); }
        if (this.uploading && this.uploadPromise) {
            // A full-file upload changes entity IDs and history. Poll only
            // after those mutations settle; preflight already shared a poll.
            return this.uploadPromise.then(() => this.refreshVFS(), () => this.refreshVFS());
        }
        if (!this.refreshPromise) {
            this.refreshPromise = this.refreshVFSOnce().finally(() => { this.refreshPromise = undefined; });
        }
        return this.refreshPromise;
    }

    private async refreshVFSOnce() {
        const vfs = await this.vfs;
        if (this.disconnected) { return; }
        const latestVersion = await vfs.getCurrentVersion();
        if (this.disconnected) { return; }
        if (!Number.isSafeInteger(latestVersion) || latestVersion<0 || this.vfsLocalVersion!==undefined && latestVersion<this.vfsLocalVersion) {
            throw new Error('Invalid or stale project history version');
        }
        if (this.vfsLocalVersion===undefined) { this.vfsLocalVersion = latestVersion; }
        if (latestVersion===this.vfsLocalVersion) { return; }

        const activeUsers = [];
        const diffs = (await vfs.getFileTreeDiff(this.vfsLocalVersion, latestVersion))?.diff;
        if (!Array.isArray(diffs)) { throw new Error('Project history unavailable; checkpoint retained for retry'); }
        for (const diff of diffs) {
            if (this.disconnected) { return; }
            if (diff.operation===undefined) { continue; }

            // resolve entityId
            let entityId:string|undefined, entity:any;
            try {
                const vfsUri = vfs.pathToUri(diff.pathname);
                const {fileType, fileEntity, fileId} = await vfs._resolveUri(vfsUri);
                [entityId, entity] = [fileId, fileEntity];
            } catch (error) {
                logDiagnostic('SocketIOAlt', 'refresh_vfs.resolve_entity_failed', {
                    pathname: diff.pathname,
                }, error);
            }

            // handle vfs update
            switch (diff.operation) {
                case 'added':
                    if (entityId!==undefined) { break; }
                    const pathParts = diff.pathname.split('/');
                    const [parentFolder, name] = [
                        pathParts.slice(0, pathParts.length-1).join('/'),
                        pathParts[pathParts.length-1] ];
                    const parentFolderId = (await vfs._resolveUri(vfs.pathToUri(parentFolder))).fileId;
                    this.emitEvent('reciveNewDoc', parentFolderId, {
                        _id: this.randomEntityId,
                        name,
                        type: 'doc',
                        version: latestVersion,
                    } as DocumentEntity);
                    break;
                case 'removed':
                    if (entityId===undefined) { break; }
                    this.emitEvent('removeEntity', entityId);
                    break;
                case 'renamed':
                    if (entityId===undefined) { break; }
                    const oldPathParts = diff.pathname.split('/');
                    const [oldParentPath, oldName] = [
                        oldPathParts.slice(0, oldPathParts.length-1).join('/'),
                        oldPathParts[oldPathParts.length-1] ];
                    const newPathParts = diff.newPathname!.split('/');
                    const [newParentPath, newName] = [
                        newPathParts.slice(0, newPathParts.length-1).join('/'),
                        newPathParts[newPathParts.length-1] ];
                    // notify rename or move
                    if (oldParentPath!==newParentPath) {
                        const newParentFolderId = (await vfs._resolveUri(vfs.pathToUri(newParentPath))).fileId;
                        this.emitEvent('reciveEntityMove', entityId, newParentFolderId);
                    } else {
                        this.emitEvent('reciveEntityRename', entityId, newName);
                    }
                    break;
                case 'edited':
                    if (entityId===undefined) { break; }
                    const pathname = diff.pathname;
                    // save doc if dirty
                    const _uri = vfs.pathToUri(pathname);
                    const _doc = vscode.workspace.textDocuments.find(doc => doc.uri.toString()===_uri.toString());
                    if (_doc && _doc.isDirty) { await _doc.save(); }
                    // generate patch and apply locally
                    const vfsLocalVersion = this.vfsLocalVersion!;
                    const localContent = new TextDecoder().decode( await vfs.openFile(_uri) );
                    const baseRemoteContent = await this.readDocSnapshot(vfs, pathname, vfsLocalVersion);
                    const latestRemoteContent = await this.readDocSnapshot(vfs, pathname, latestVersion);
                    if (baseRemoteContent!==undefined && latestRemoteContent!==undefined) {
                        const merged = mergeTextFromCommonBase(baseRemoteContent, localContent, latestRemoteContent);
                        if (merged.kind==='conflict') {
                            await vfs.recordDocumentSyncConflict({
                                baseContent: Buffer.from(baseRemoteContent), localContent: Buffer.from(localContent),
                                remoteContent: Buffer.from(latestRemoteContent), relPath: pathname,
                                docId: entityId, reason: 'alternative_connection_concurrent_changes',
                            });
                            throw new Error('Alternative connection has conflicting document edits; recovery required');
                        }
                        this.emitEvent('otUpdateApplied', {
                            doc: entityId,
                            v: (entity as DocumentEntity).version, //bypass update check
                            op: [
                                {p:0, d:(entity as DocumentEntity).remoteCache ?? baseRemoteContent},
                                {p:0, i:latestRemoteContent},
                            ],
                        });
                    } else { throw new Error('Document history unavailable; checkpoint retained for retry'); }
                    // fetch active users
                    let row = 0, column = 0;
                    const remoteDiffs = (await vfs.getFileDiff(pathname, vfsLocalVersion, latestVersion))?.diff;
                    for (const diff of remoteDiffs || []) {
                        const end_ts = diff.meta?.end_ts || Date.now();
                        const diffText = (diff?.i || diff?.u || '').split('\n');
                        row += diffText.length;
                        column = diffText.slice(-1)[0].length;
                        for (const user of diff.meta?.users || []) {
                            const index = this.connectedUsers.findIndex(u => u.user_id===user.id);
                            if (index===-1) {
                                const userUpdate = {
                                    id:user.id, user_id:user.id, email:user.email,
                                    name:`${user.first_name} ${user.last_name||''}`,
                                    doc_id:entityId, row, column,
                                    last_updated_at: end_ts,
                                };
                                this.connectedUsers.push( userUpdate );
                                activeUsers.push( userUpdate );
                            } else {
                                this.connectedUsers[index].last_updated_at = end_ts;
                                activeUsers.push( this.connectedUsers[index] );
                            }
                        }
                    }
                    break;
                default:
                    break;
            }
        }
        // notify user update/disconnected
        activeUsers.forEach(user => {
            this.emitEvent('clientTracking.clientUpdated', user);
        });
        this.connectedUsers = this.connectedUsers.filter(user => {
            const DisconnectionTimeout = vscode.workspace.getConfiguration(ROOT_NAME).get<number>(keyInactiveTimeout, 180) * 1000;//ms
            const isDisconnected = Date.now() - (user.last_updated_at||Date.now()) > DisconnectionTimeout;
            if (isDisconnected) {
                this.emitEvent('clientTracking.clientDisconnected', user.id);
            }
            return !isDisconnected;
        });
        // update local version
        if (!this.disconnected) { this.vfsLocalVersion = latestVersion; }
    }

    get unSyncedChanges(): number {
        return Object.keys(this.localChangesPath).length;
    }

    uploadToVFS(): Promise<void> {
        if (this.disconnected) { return Promise.reject(new Error('Connection closed; pending changes are retained')); }
        if (!this.uploadPromise) {
            this.uploadPromise = this.uploadToVFSOnce().finally(() => { this.uploading = false; this.uploadPromise = undefined; });
        }
        return this.uploadPromise;
    }

    private async uploadToVFSOnce() {
        if (!this.unSyncedChanges) { return; }
        const copies = vscode.l10n.t('Upload recovery copies');
        const upload = vscode.l10n.t('Upload changes');
        const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t('Overleaf cannot atomically check revisions for alternative-mode uploads. Recovery copies create new files and leave the originals and pending drafts unchanged. Upload changes replaces the originals and can overwrite concurrent edits; use it only after collaborators have stopped editing.'),
            {modal: true}, copies, upload,
        );
        if (choice!==upload && choice!==copies) { throw new Error('Upload cancelled; pending changes are retained'); }
        const recoveryCopies = choice===copies;
        const vfs = await this.vfs;
        // Replacement needs authoritative history. A new recovery copy does
        // not modify the original, so unavailable history must not block it.
        // Still let an already-running poll settle before mutating the tree.
        if (!recoveryCopies) {
            await this.refreshVFS();
        } else if (this.refreshPromise) {
            await this.refreshPromise.catch(error => {
                logDiagnostic('SocketIOAlt', 'copy.history_refresh_failed', {}, error);
            });
        }
        if (this.disconnected) { throw new Error('Connection closed; pending changes are retained'); }
        this.uploading = true;
        // upload local changes
        return vscode.window.withProgress({
            // Alternative-socket uploads are part of the background sync path;
            // keep progress out of popup notifications to avoid routine spam.
            location: vscode.ProgressLocation.Window,
            title: vscode.l10n.t('Uploading Changes'),
            cancellable: true,
        }, async (progress, token) => {
            const failures: string[] = [];
            const uploadedCopies: string[] = [];
            // do the upload
            const totalChanges = Object.keys(this.localChangesPath).length;
            let increment = 0;
            for (const [path,{parentFolderId,filename}] of Object.entries(this.localChangesPath)) {
                if (token.isCancellationRequested || this.disconnected) { throw new Error('Upload cancelled; pending changes are retained'); }
                try {
                    const fileContent = Buffer.from(await vfs.openFile( vfs.pathToUri(path) ));
                    progress.report({increment, message:`${path}`});
                    // Keep the extension for Overleaf's file-type detection. A
                    // fresh unpredictable name prevents a retry replacing a
                    // previously uploaded copy after an uncertain response.
                    const dot = filename.lastIndexOf('.');
                    const hasExtension = dot>0 && filename.length - dot<=20;
                    const extension = hasExtension ? filename.slice(dot) : '';
                    const stem = hasExtension ? filename.slice(0, dot) : filename;
                    const suffix = `.recovery-${randomUUID()}${extension}`;
                    let boundedStem = '';
                    if (recoveryCopies) {
                        for (const character of stem) {
                            if (boundedStem.length + character.length > 150 - suffix.length) { break; }
                            boundedStem += character;
                        }
                    }
                    const uploadName = recoveryCopies ? boundedStem + suffix : filename;
                    const uploaded = await this.api.uploadFile(this.identity, this.projectId, parentFolderId, uploadName, fileContent);
                    if (uploaded.type!=='success' || !uploaded.entity) { throw new Error('Upload was not confirmed'); }
                    if (recoveryCopies && uploaded.entity.name!==uploadName) { throw new Error('Recovery copy name was not confirmed'); }
                    const currentContent = recoveryCopies ? undefined : Buffer.from(await vfs.openFile(vfs.pathToUri(path)));
                    if (currentContent) {
                        // Persist edits before publishing a replacement entity.
                        await vfs.persistTextDocumentDraft(vfs.pathToUri(path), currentContent.toString('utf8'), fileContent.toString('utf8'));
                    }
                    const fileEntity = uploaded.entity;
                    // update local entityId
                    if (fileEntity._type==='doc') {
                        this.emitEvent('reciveNewDoc', parentFolderId, fileEntity);
                    } else if (fileEntity._type==='file') {
                        this.emitEvent('reciveNewFile', parentFolderId, fileEntity);
                    }
                    if (recoveryCopies) {
                        uploadedCopies.push(uploadName);
                        // This copy is not a commit of the original document.
                        // Preserve its base, journal and pending path.
                        continue;
                    }
                    if (currentContent?.equals(fileContent)) { delete this.localChangesPath[path]; }
                } catch (error) {
                    failures.push(path);
                    logDiagnostic('SocketIOAlt', 'upload.failed', {path}, error);
                } finally {
                    increment += 100 * (1 / totalChanges);
                }
            }
            if (failures.length > 0) { throw new Error(`${failures.length} uploads failed; pending changes are retained`); }
            if (recoveryCopies) {
                void vscode.window.showInformationMessage(vscode.l10n.t('{count} recovery copies uploaded. Original files and pending drafts are unchanged.', {count: uploadedCopies.length}));
                return;
            }
            // update local version
            await vfs.requestRealtimeRecovery('document_version_mismatch');
            return Promise.resolve();
        });
    }

    disconnect() {
        if (this.disconnected) { return; }
        this.disconnected = true;
        clearTimeout(this.bootstrapTimer);
        this.bootstrapTimer = undefined;
        this.watchConfigurationsDisposable.dispose();
        this.vfsRefreshTask.stop();
        this._eventEmitter.emit('disconnect');
    }

    removeAllListeners(event?: string) {
        this._eventEmitter.removeAllListeners(event);
    }

    async stageDocument(docId: string) {
        const vfs = await this.vfs;
        const resolved = vfs._resolveById(docId);
        if (!resolved) { throw new Error('Cannot buffer changes to a missing document'); }
        const {parentFolder, path} = resolved;
        this.localChangesPath[path.slice(1)] = {parentFolderId: parentFolder._id, filename: path.slice(path.lastIndexOf('/')+1)};
    }

    emit(event: string, ...parameters: any): void {
        const args = parameters.slice(0, parameters.length - 1);
        const callback: EmitCallbackType = parameters[parameters.length - 1];

        switch (event as keyof EmitEventsSupport) {
            case 'joinProject':
                this.record.then((project) => {
                    callback(undefined, project);
                }).catch(callback);
                break;
            case 'joinDoc':
                const rDocId = args[0] as string;
                Promise.resolve(this.vfs).then(async (vfs) => {
                    await vfs.init();
                    const {path} = await vfs._resolveById(rDocId)!;
                    const version = this.vfsLocalVersion ?? await vfs.getCurrentVersion();
                    this.vfsLocalVersion = version;
                    const content = await this.readDocSnapshot(vfs, path.slice(1), version);
                    if (content===undefined) { throw new Error('Document snapshot unavailable'); }
                    const docLines = content.split('\n');
                    const updates:any[]=[], ranges:any[]=[];
                    callback(undefined, docLines, version, updates, ranges);
                }).catch(callback);
                break;
            case 'applyOtUpdate':
                const uDocId = args[0];
                const update = args[1] as UpdateSchema;
                if (update.op?.length) {
                    this.stageDocument(uDocId).then(() => {
                        callback(undefined, undefined);
                    }).catch(callback);
                } else {
                    callback(undefined, undefined);
                }
                break;
            case 'leaveDoc':
                // Closing an editor must not overwrite remote files implicitly.
                callback(undefined, undefined);
                break;
            case 'clientTracking.getConnectedUsers':
                    callback(undefined, []);
                    break;
            case 'clientTracking.updatePosition':
            default:
                callback(undefined, undefined);
                break;
        }
    }

    on<T extends keyof ListenEventsSupport>(event: T, handler: (arg: ListenEventsSupport[T]) => void): void {
        this._eventEmitter.on(event, handler);
    }
}
