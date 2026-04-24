/* eslint-disable @typescript-eslint/naming-convention */
import {
    BaseAPI,
    Identity,
    ProjectCommentThreadMessageSchema,
    ProjectCommentThreadsResponseSchema,
    ProjectMessageResponseSchema,
} from './base';
import { OverleafCommentAuthor, OverleafPermissionsLevel } from '../comments/types';
import { FileEntity, DocumentEntity, FileRefEntity, FileType, FolderEntity, ProjectEntity } from '../core/remoteFileSystemProvider';
import { logDiagnostic } from '../utils/diagnostics';
import { EventBus } from '../utils/eventBus';
import { SocketIOAlt } from './socketioAlt';
import {
    buildRealtimeHandshakeQuery,
    ConnectionScheme,
    getSocketTransportOptions,
    getJoinProjectStrategy,
    getPreferredConnectionScheme,
    getSocketEmitTimeoutMs,
    nextConnectionSchemeOnJoinFailure,
    resolveSocketConnectionTarget,
    SocketConnectionTarget,
} from './socketioHelpers';

function decodePackedUtf8(text: string): string {
    return Buffer.from(text, 'latin1').toString('utf-8');
}

export interface UpdateUserSchema {
    id: string,
    user_id: string,
    name: string,
    email: string,
    doc_id: string,
    row: number,
    column: number,
    last_updated_at?: number, //unix timestamp
}

export interface OnlineUserSchema {
    client_age: number,
    client_id: string,
    connected: boolean,
    cursorData?: {
        column: number,
        doc_id: string,
        row: number,
    },
    email: string,
    first_name: string,
    last_name?: string,
    last_updated_at: string, //unix timestamp
    user_id: string,
}

export interface UpdateSchema {
    doc: string, //doc id
    op?: {
        c?: string, //comment anchor content
        commentIds?: string[],
        p: number, //position
        i?: string, //insert
        d?: string, //delete
        resolved?: boolean,
        t?: string, //comment thread id
        u?: boolean, //isUndo
    }[],
    v: number, //doc version number
    lastV?: number, //last version number
    hash?: string, //(not needed if lastV is provided)
    meta?: {
        source: string, //socketio client id
        ts: number, //unix timestamp
        user_id: string,
    }
}

export interface EventsHandler {
    onFileCreated?: (parentFolderId:string, type:FileType, entity:FileEntity) => void,
    onFileRenamed?: (entityId:string, newName:string) => void,
    onFileRemoved?: (entityId:string) => void,
    onFileMoved?: (entityId:string, newParentFolderId:string) => void,
    onFileChanged?: (update:UpdateSchema) => void,
    //
    onDisconnected?: () => void,
    onConnectionAccepted?: (publicId:string) => void,
    onClientUpdated?: (user:UpdateUserSchema) => void,
    onClientDisconnected?: (id:string) => void,
    //
    onReceivedMessage?: (message:ProjectMessageResponseSchema) => void,
    onChatMessageEdited?: (messageId:string, userId:string, content:string) => void,
    onChatMessageDeleted?: (messageId:string, userId:string) => void,
    onCommentReceived?: (threadId:string, message:ProjectCommentThreadMessageSchema) => void,
    onCommentMessageEdited?: (threadId:string, messageId:string, content:string) => void,
    onCommentMessageDeleted?: (threadId:string, messageId:string) => void,
    onCommentThreadResolved?: (threadId:string, user:OverleafCommentAuthor) => void,
    onCommentThreadReopened?: (threadId:string) => void,
    onCommentThreadDeleted?: (threadId:string) => void,
    onCommentThreadsCreated?: (threads:ProjectCommentThreadsResponseSchema) => void,
    //
    onSpellCheckLanguageUpdated?: (language:string) => void,
    onCompilerUpdated?: (compiler:string) => void,
    onRootDocUpdated?: (rootDocId:string) => void,
}

export class SocketIOAPI {
    private scheme: ConnectionScheme;
    private record?: Promise<ProjectEntity>;
    private _handlers: Array<EventsHandler> = [];
    private registeredHandlerObjects = new WeakSet<EventsHandler>();
    private eventBusDisposables: Array<{dispose(): void}> = [];
    private socketConnectionTarget: SocketConnectionTarget;
    private altProjectUrl?: string;
    private socketSessionId = 0;
    private joinAttemptId = 0;
    private websocketFailureCount = 0;
    private _permissionsLevel?: OverleafPermissionsLevel;

    private socket?: any;
    private emit: any;
    private lastConnectingTransport = '';

    constructor(private readonly siteUrl:string,
                private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string)
    {
        this.scheme = getPreferredConnectionScheme(this.siteUrl);
        this.socketConnectionTarget = resolveSocketConnectionTarget(this.siteUrl);
        this.init(false);
    }

    private get defaultSocketOptions() {
        return getSocketTransportOptions(this.siteUrl, this.websocketFailureCount);
    }

    private debugLog(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('SocketIOAPI', event, {
            projectId: this.projectId,
            ...fields,
        }, error);
    }

    private getSocketErrorMessage(error: any): string {
        if (typeof error === 'string') {
            return error;
        }
        if (error instanceof Error) {
            return error.message;
        }
        if (error?.message) {
            return String(error.message);
        }
        return String(error);
    }

    private disposeEventBusDisposables() {
        this.eventBusDisposables.forEach((disposable) => disposable.dispose());
        this.eventBusDisposables = [];
    }

    private get currentTransportName(): string {
        return this.socket?.socket?.transport?.name ?? this.socket?.transport?.name ?? this.lastConnectingTransport;
    }

    private noteTransportFailure() {
        if (this.currentTransportName === 'websocket') {
            this.websocketFailureCount += 1;
            this.debugLog('socket.transport_failure_recorded', {
                scheme: this.scheme,
                sessionId: this.socketSessionId,
                transport: this.currentTransportName,
                websocketFailureCount: this.websocketFailureCount,
            });
        }
    }

    init(connect = true) {
        this.disposeEventBusDisposables();
        const previousSocket = this.socket;
        previousSocket?.removeAllListeners?.();
        previousSocket?.disconnect?.();
        this.socketSessionId += 1;
        const sessionId = this.socketSessionId;
        let handshakeQuery = '';
        // connect
        switch(this.scheme) {
            case 'Alt':
                this.socket = new SocketIOAlt(this.altProjectUrl ?? this.siteUrl, this.api, this.identity, this.projectId, this.record!);
                break;
            case 'v1':
                this.record = undefined;
                handshakeQuery = buildRealtimeHandshakeQuery(this.projectId);
                this.socket = this.api._initSocketV0(
                    this.identity,
                    this.socketConnectionTarget,
                    handshakeQuery,
                    this.defaultSocketOptions,
                );
                break;
            case 'v2':
                this.record = undefined;
                handshakeQuery = buildRealtimeHandshakeQuery(this.projectId);
                this.socket = this.api._initSocketV0(this.identity, this.socketConnectionTarget, handshakeQuery, {
                    ...this.defaultSocketOptions,
                });
                break;
        }
        this.debugLog('socket.init', {
            autoConnectRequested: connect,
            connectUrl: this.socketConnectionTarget.connectUrl,
            forcedPolling: this.defaultSocketOptions.transports.length===1 && this.defaultSocketOptions.transports[0]==='xhr-polling',
            handshakeQuery,
            resource: this.socketConnectionTarget.resource,
            scheme: this.scheme,
            sessionId,
            socketScriptUrl: this.socketConnectionTarget.socketScriptUrl,
            targetQuery: this.socketConnectionTarget.query,
            transportOptions: this.defaultSocketOptions,
            websocketFailureCount: this.websocketFailureCount,
        });
        // create emit
        (this.socket.emit)[require('util').promisify.custom] = (event:string, ...args:any[]) => {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => {
                    reject('timeout');
                }, getSocketEmitTimeoutMs('default'));
            });
            const waitPromise = new Promise((resolve, reject) => {
                this.socket.emit(event, ...args, (err:any, ...data:any[]) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                });
            });
            return Promise.race([waitPromise, timeoutPromise]);
        };
        this.emit = require('util').promisify(this.socket.emit).bind(this.socket);
        // resume handlers
        this.initInternalHandlers();
        this.resumeEventHandlers(this._handlers);

        const rootSocket = this.socket?.socket ?? this.socket;
        if (rootSocket) {
            rootSocket.options = rootSocket.options || {};
            rootSocket.options.transports = [...this.defaultSocketOptions.transports];
            rootSocket.options['try multiple transports'] = this.defaultSocketOptions['try multiple transports'];
            rootSocket.transports = [...this.defaultSocketOptions.transports];
            rootSocket.origTransports = [...this.defaultSocketOptions.transports];
        }

        if (connect && rootSocket?.options?.['auto connect'] === false && typeof rootSocket.connect === 'function') {
            this.debugLog('socket.connect_requested', {
                scheme: this.scheme,
                sessionId,
                transports: this.defaultSocketOptions.transports,
                websocketFailureCount: this.websocketFailureCount,
            });
            rootSocket.connect();
        }
    }

    private emitWithTimeout<T>(event:string, timeoutMs:number, ...args:any[]): Promise<T> {
        const timeoutPromise = new Promise<T>((_, reject) => {
            setTimeout(() => {
                reject('timeout');
            }, timeoutMs);
        });
        const waitPromise = new Promise<T>((resolve, reject) => {
            this.socket.emit(event, ...args, (err:any, ...data:any[]) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(data as T);
                }
            });
        });
        return Promise.race([waitPromise, timeoutPromise]);
    }

    private initInternalHandlers() {
        const schemeAtRegistration = this.scheme;
        const sessionId = this.socketSessionId;
        this.socket.on('connecting', (transport:string) => {
            this.lastConnectingTransport = transport;
            this.debugLog('socket.connecting', {scheme: schemeAtRegistration, sessionId, transport});
        });
        this.socket.on('connect', () => {
            this.lastConnectingTransport = this.currentTransportName || this.lastConnectingTransport;
            this.debugLog('socket.connected', {scheme: schemeAtRegistration, sessionId});
        });
        this.socket.on('connect_failed', () => {
            this.debugLog('socket.connect_failed', {scheme: schemeAtRegistration, sessionId});
        });
        this.socket.on('forceDisconnect', (message:string, delay=10) => {
            this.debugLog('socket.force_disconnect', {delay, message, scheme: schemeAtRegistration, sessionId});
        });
        this.socket.on('connectionRejected', (err:any) => {
            this.debugLog('socket.connection_rejected', {scheme: schemeAtRegistration, sessionId}, err?.message ?? err);
        });
        this.socket.on('error', (err:any) => {
            this.debugLog('socket.error', {scheme: schemeAtRegistration, sessionId}, err);
        });

        if (this.scheme==='v1' || this.scheme==='v2') {
            this.record = new Promise(resolve => {
                this.socket.on('joinProjectResponse', (res:any) => {
                    const publicId = res.publicId as string;
                    const project = res.project as ProjectEntity;
                    this.websocketFailureCount = 0;
                    this.debugLog('join_project.response', {
                        projectName: project?.name,
                        publicId,
                        rootDocId: project?.rootDoc_id,
                        scheme: schemeAtRegistration,
                        sessionId,
                    });
                    EventBus.fire('socketioConnectedEvent', {publicId});
                    resolve(project);
                });
            });
        }
    }

    disconnect() {
        this.disposeEventBusDisposables();
        this.socket.disconnect();
    }

    getDiagnosticsState() {
        const rootSocket = this.socket?.socket ?? this.socket;
        const connected = Boolean(rootSocket?.connected);
        return {
            altProjectUrl: this.altProjectUrl,
            connected,
            currentTransport: this.currentTransportName,
            hasActiveSocket: Boolean(this.socket),
            hasRecordPromise: Boolean(this.record),
            joinAttemptId: this.joinAttemptId,
            permissionsLevel: this._permissionsLevel,
            scheme: this.scheme,
            sessionId: this.socketSessionId,
            websocketFailureCount: this.websocketFailureCount,
        };
    }

    async prepareForJoin() {
        if (this.scheme!=='Alt') {
            await this.api.updateCookies(this.identity, this.socketConnectionTarget.socketScriptUrl);
            const handshakeProbe = await this.api.probeRealtimeHandshake(
                this.identity,
                this.socketConnectionTarget,
                buildRealtimeHandshakeQuery(this.projectId),
            );
            this.identity.cookies = handshakeProbe.cookies;
            this.debugLog('socket.handshake_probe', {
                scheme: this.scheme,
                sessionId: this.socketSessionId + 1,
                status: handshakeProbe.status,
                setCookieCount: handshakeProbe.setCookieHeaders.length,
                transportOptions: handshakeProbe.metadata?.transports ?? [],
                url: handshakeProbe.url,
            });
        }
        this.debugLog('socket.prepare_for_join', {
            scheme: this.scheme,
            sessionId: this.socketSessionId + 1,
            socketScriptUrl: this.socketConnectionTarget.socketScriptUrl,
            transports: this.defaultSocketOptions.transports,
            websocketFailureCount: this.websocketFailureCount,
        });
        this.init(true);
    }

    configureRealtimeConnection(wsUrl?: string) {
        if (this.scheme==='Alt') {
            return;
        }

        this.socketConnectionTarget = resolveSocketConnectionTarget(this.siteUrl, wsUrl);
        this.debugLog('socket.target_configured', {
            connectUrl: this.socketConnectionTarget.connectUrl,
            resource: this.socketConnectionTarget.resource,
            scheme: this.scheme,
            socketScriptUrl: this.socketConnectionTarget.socketScriptUrl,
            targetQuery: this.socketConnectionTarget.query,
            wsUrl,
        });
    }

    get handlers() {
        return this._handlers;
    }

    get isUsingAlternativeConnectionScheme() {
        return this.scheme==='Alt';
    }

    get isConnected() {
        const rootSocket = this.socket?.socket ?? this.socket;
        return Boolean(rootSocket?.connected);
    }

    get permissionsLevel() {
        return this._permissionsLevel;
    }

    get currentIdentity(): Identity {
        return this.identity;
    }

    activateAlternativeConnectionScheme(url: string, updatedRecord: ProjectEntity) {
        this.scheme = 'Alt';
        this.altProjectUrl = url;
        this.record = Promise.resolve(updatedRecord);
    }

    toggleAlternativeConnectionScheme(url: string, updatedRecord?: ProjectEntity) {
        this.scheme = this.scheme==='Alt' ? 'v1' : 'Alt';
        if (updatedRecord) {
            this.altProjectUrl = url;
            this.record = Promise.resolve(updatedRecord);
        }
    }

    resumeEventHandlers(handlers: Array<EventsHandler>) {
        this.disposeEventBusDisposables();
        this._handlers = [...handlers];
        this.registeredHandlerObjects = new WeakSet<EventsHandler>();
        handlers.forEach((handler) => {
            this.registeredHandlerObjects.add(handler);
            this.attachEventHandlers(handler);
        });
    }

    updateEventHandlers(handlers: EventsHandler) {
        if (this.registeredHandlerObjects.has(handlers)) {
            this.debugLog('socket.handlers_duplicate_skipped', {
                handlerCount: this._handlers.length,
            });
            return;
        }
        this.registeredHandlerObjects.add(handlers);
        this._handlers.push(handlers);
        this.attachEventHandlers(handlers);
    }

    private attachEventHandlers(handlers: EventsHandler) {
        Object.values(handlers).forEach((handler) => {
            switch (handler) {
                case handlers.onFileCreated:
                    this.socket.on('reciveNewDoc', (parentFolderId:string, doc:DocumentEntity) => {
                        handler(parentFolderId, 'doc', doc);
                    });
                    this.socket.on('reciveNewFile', (parentFolderId:string, file:FileRefEntity) => {
                        handler(parentFolderId, 'file', file);
                    });
                    this.socket.on('reciveNewFolder', (parentFolderId:string, folder:FolderEntity) => {
                        handler(parentFolderId, 'folder', folder);
                    });
                    break;
                case handlers.onFileRenamed:
                    this.socket.on('reciveEntityRename', (entityId:string, newName:string) => {
                        handler(entityId, newName);
                    });
                    break;
                case handlers.onFileRemoved:
                    this.socket.on('removeEntity', (entityId:string) => {
                        handler(entityId);
                    });
                    break;
                case handlers.onFileMoved:
                    this.socket.on('reciveEntityMove', (entityId:string, folderId:string) => {
                        handler(entityId, folderId);
                    });
                    break;
                case handlers.onFileChanged:
                    this.socket.on('otUpdateApplied', (update: UpdateSchema) => {
                        handler(update);
                    });
                    break;
                case handlers.onDisconnected:
                    this.socket.on('disconnect', () => {
                        handler();
                    });
                    break;
                case handlers.onConnectionAccepted:
                    this.socket.on('connectionAccepted', (_:any, publicId:any) => {
                        handler(publicId);
                    });
                    this.eventBusDisposables.push(EventBus.on('socketioConnectedEvent', (arg:{publicId:string}) => {
                        handler(arg.publicId);
                    }));
                    break;
                case handlers.onClientUpdated:
                    this.socket.on('clientTracking.clientUpdated', (user:UpdateUserSchema) => {
                        handler(user);
                    });
                    break;
                case handlers.onClientDisconnected:
                    this.socket.on('clientTracking.clientDisconnected', (id:string) => {
                        handler(id);
                    });
                    break;
                case handlers.onReceivedMessage:
                    this.socket.on('new-chat-message', (message:ProjectMessageResponseSchema) => {
                        handler(message);
                    });
                    break;
                case handlers.onChatMessageEdited:
                    this.socket.on('edit-global-message', (message:{messageId:string, userId:string, content:string}) => {
                        handler(message.messageId, message.userId, message.content);
                    });
                    break;
                case handlers.onChatMessageDeleted:
                    this.socket.on('delete-global-message', (message:{messageId:string, userId:string}) => {
                        handler(message.messageId, message.userId);
                    });
                    break;
                case handlers.onCommentReceived:
                    this.socket.on('new-comment', (threadId:string, message:ProjectCommentThreadMessageSchema) => {
                        handler(threadId, message);
                    });
                    break;
                case handlers.onCommentMessageEdited:
                    this.socket.on('edit-message', (threadId:string, messageId:string, content:string) => {
                        handler(threadId, messageId, content);
                    });
                    break;
                case handlers.onCommentMessageDeleted:
                    this.socket.on('delete-message', (threadId:string, messageId:string) => {
                        handler(threadId, messageId);
                    });
                    break;
                case handlers.onCommentThreadResolved:
                    this.socket.on('resolve-thread', (threadId:string, user:OverleafCommentAuthor) => {
                        handler(threadId, user);
                    });
                    break;
                case handlers.onCommentThreadReopened:
                    this.socket.on('reopen-thread', (threadId:string) => {
                        handler(threadId);
                    });
                    break;
                case handlers.onCommentThreadDeleted:
                    this.socket.on('delete-thread', (threadId:string) => {
                        handler(threadId);
                    });
                    break;
                case handlers.onCommentThreadsCreated:
                    this.socket.on('new-comment-threads', (threads:ProjectCommentThreadsResponseSchema) => {
                        handler(threads);
                    });
                    break;
                case handlers.onSpellCheckLanguageUpdated:
                    this.socket.on('spellCheckLanguageUpdated', (language:string) => {
                        handler(language);
                    });
                    break;
                case handlers.onCompilerUpdated:
                    this.socket.on('compilerUpdated', (compiler:string) => {
                        handler(compiler);
                    });
                    break;
                case handlers.onRootDocUpdated:
                    this.socket.on('rootDocUpdated', (rootDocId:string) => {
                        handler(rootDocId);
                    });
                    break;
                default:
                    break;
            }
        });
    }

    get unSyncFileChanges(): number {
        if (this.socket instanceof SocketIOAlt) {
            return this.socket.unSyncedChanges;
        }
        return 0;
    }

    async syncFileChanges() {
        if (this.socket instanceof SocketIOAlt) {
            return await this.socket.uploadToVFS();
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/connection/ConnectionManager.js#L427
     * @param {string} projectId - The project id.
     * @returns {Promise}
     */
    async joinProject(project_id:string): Promise<ProjectEntity> {
        this.joinAttemptId += 1;
        const joinAttemptId = this.joinAttemptId;
        const joinStrategy = getJoinProjectStrategy(this.scheme);
        this.debugLog('join_project.start', {
            joinAttemptId,
            projectId: project_id,
            joinStrategy,
            scheme: this.scheme,
            sessionId: this.socketSessionId,
            timeoutMs: getSocketEmitTimeoutMs('joinProject'),
            transports: this.defaultSocketOptions.transports,
            websocketFailureCount: this.websocketFailureCount,
        });

        switch(this.scheme) {
            case 'Alt':
                const timeoutPromise: Promise<ProjectEntity> = new Promise((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(`joinProject timeout after ${getSocketEmitTimeoutMs('joinProject')}ms (scheme=${this.scheme}, projectId=${project_id})`));
                    }, getSocketEmitTimeoutMs('joinProject'));
                });
                const altJoinPromise = this.emitWithTimeout<[ProjectEntity, string, number]>('joinProject', getSocketEmitTimeoutMs('joinProject'), {project_id})
                .then((returns:[ProjectEntity, string, number]) => {
                    const [project, permissionsLevel, protocolVersion] = returns;
                    this._permissionsLevel = permissionsLevel as OverleafPermissionsLevel;
                    this.debugLog('join_project.callback_resolved', {
                        joinAttemptId,
                        permissionsLevel,
                        projectName: project?.name,
                        protocolVersion,
                        scheme: this.scheme,
                        sessionId: this.socketSessionId,
                    });
                    this.record = Promise.resolve(project);
                    return project;
                }).catch((error) => {
                    if (error==='timeout') {
                        throw new Error(`joinProject callback timeout after ${getSocketEmitTimeoutMs('joinProject')}ms (scheme=${this.scheme}, projectId=${project_id})`);
                    }
                    throw error;
                });
                return Promise.race([altJoinPromise, timeoutPromise]);
            case 'v1':
            case 'v2':
                return this.joinProjectViaHandshakeAutoJoin(project_id, joinAttemptId, joinStrategy);
        }
    }

    private async joinProjectViaHandshakeAutoJoin(
        projectId: string,
        joinAttemptId: number,
        joinStrategy: ReturnType<typeof getJoinProjectStrategy>,
    ): Promise<ProjectEntity> {
        let lastError: unknown;
        const maxAttempts = 5;

        for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
            if (attemptIndex > 0) {
                const delayMs = Math.min(1000 * attemptIndex, 3000);
                this.debugLog('join_project.retrying', {
                    attemptIndex: attemptIndex + 1,
                    delayMs,
                    joinAttemptId,
                    transports: this.defaultSocketOptions.transports,
                    websocketFailureCount: this.websocketFailureCount,
                });
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                await this.prepareForJoin();
            }

            try {
                const timeoutPromise: Promise<ProjectEntity> = new Promise((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(`joinProject timeout after ${getSocketEmitTimeoutMs('joinProject')}ms (scheme=${this.scheme}, projectId=${projectId})`));
                    }, getSocketEmitTimeoutMs('joinProject'));
                });
                const eventJoinPromise = this.record!;
                const eventRejectPromise: Promise<ProjectEntity> = new Promise((_, reject) => {
            const cleanup = () => {
                        this.socket?.removeListener?.('connectionRejected', onConnectionRejected);
                        this.socket?.removeListener?.('connect_failed', onConnectFailed);
                        this.socket?.removeListener?.('error', onError);
                    };
                    const rejectWithFailure = (reason: 'connectionRejected' | 'connect_failed' | 'error', message?: string) => {
                        if (reason==='connectionRejected' || reason==='connect_failed') {
                            this.scheme = nextConnectionSchemeOnJoinFailure(this.scheme, reason);
                        }
                        this.debugLog('join_project.rejected', {
                            attemptIndex: attemptIndex + 1,
                            joinAttemptId,
                            joinStrategy,
                            nextScheme: this.scheme,
                            reason,
                            sessionId: this.socketSessionId,
                            transport: this.currentTransportName,
                            websocketFailureCount: this.websocketFailureCount,
                        }, message);
                        cleanup();
                        reject(message ?? reason);
                    };
                    const onConnectionRejected = (err:any) => {
                        rejectWithFailure('connectionRejected', err?.message);
                    };
                    const onConnectFailed = () => {
                        rejectWithFailure('connect_failed', 'connect_failed');
                    };
                    const onError = (error:any) => {
                        rejectWithFailure('error', this.getSocketErrorMessage(error));
                    };

                    this.socket.on('connectionRejected', onConnectionRejected);
                    this.socket.on('connect_failed', onConnectFailed);
                    this.socket.on('error', onError);
                    eventJoinPromise.finally(cleanup);
                });
                return await Promise.race([eventJoinPromise, eventRejectPromise, timeoutPromise]);
            } catch (error) {
                lastError = error;
                this.noteTransportFailure();
                this.debugLog('join_project.attempt_failed', {
                    attemptIndex: attemptIndex + 1,
                    joinAttemptId,
                    transport: this.currentTransportName,
                    websocketFailureCount: this.websocketFailureCount,
                }, error);
            }
        }

        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L500
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async joinDoc(docId:string) {
        return this.emit('joinDoc', docId, { encodeRanges: true })
            .then((returns: [Array<string>, number, Array<any>, any]) => {
                const [docLinesAscii, version, updates, ranges] = returns;
                const docLines = docLinesAscii.map((line) => decodePackedUtf8(line));
                return {docLines, version, updates, ranges};
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L591
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async leaveDoc(docId:string) {
        return this.emit('leaveDoc', docId)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/ShareJsDocs.js#L78
     * @param {string} docId - The document id.
     * @param {any} update - The changes.
     * @returns {Promise}
     */
    async applyOtUpdate(docId:string, update:UpdateSchema) {
        return this.emit('applyOtUpdate', docId, update)
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L42
     * @returns {Promise}
     */
    async getConnectedUsers(): Promise<OnlineUserSchema[]> {
        return this.emit('clientTracking.getConnectedUsers')
            .then((returns:[OnlineUserSchema[]]) => {
                const [connectedUsers] = returns;
                return connectedUsers;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L150
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async updatePosition(doc_id:string, row:number, column:number) {
        return this.emit('clientTracking.updatePosition', {row, column, doc_id})
            .then(() => {
                return;
            });
    }
}
