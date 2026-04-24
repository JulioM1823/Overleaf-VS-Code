import * as vscode from 'vscode';
import { UpdateSchema } from '../api/socketio';
import { RemoteFileSystemProvider, VirtualFileSystem } from './remoteFileSystemProvider';
import {
    mergeRemoteTextIntoLocalText,
} from './documentSessionText';
import {
    createLocalReplicaSnapshot,
    localReplicaSnapshotsEqual,
} from '../scm/localReplicaSyncState';
import {
    clearManagedDocumentSession,
    clearManagedDocumentUri,
    linkManagedDocumentUri,
    markManagedDocumentPending,
    setManagedDocumentSessionState,
    type ManagedTextDocumentState,
} from './liveTextDocumentRegistry';
import {
    isPotentialProjectWorkspaceUri,
    resolveProjectDocumentBinding,
} from './projectWorkspaceBinding';
import { EventBus } from '../utils/eventBus';
import { logDiagnostic, registerDiagnosticStateProvider } from '../utils/diagnostics';

type DocumentSessionStatus = Exclude<ManagedTextDocumentState, 'pending'>;
export type RemoteOperationPreparationResult = 'blocked' | 'ready';

export interface ProjectSessionCoordinator {
    prepareProjectForRemoteOperation(projectUri: vscode.Uri, reason: string): Promise<RemoteOperationPreparationResult>,
}

interface ManagedDocumentSession {
    docId: string,
    flushPromise?: Promise<void>,
    flushQueued: boolean,
    flushTimer?: ReturnType<typeof setTimeout>,
    key: string,
    localText: string,
    localVersion: number,
    openDocumentUris: Set<string>,
    origin: string,
    overleafUri: vscode.Uri,
    recoveryPromise?: Promise<void>,
    remoteText: string,
    status: DocumentSessionStatus,
    usesLocalReplica: boolean,
    vfs: VirtualFileSystem,
}

interface DocumentSessionBinding {
    docId: string,
    loadedFromCache: boolean,
    localText: string,
    overleafUri: vscode.Uri,
    remoteText: string,
    sessionKey: string,
    status: DocumentSessionStatus,
    usesLocalReplica: boolean,
    vfs: VirtualFileSystem,
}

interface SuppressedDocumentChange {
    expectedText?: string,
}

function toSessionKey(origin: string, docId: string) {
    return `${origin}::${docId}`;
}

const DOCUMENT_SYNC_FLUSH_DELAY_MS = 100;

function isFileNotFoundError(error: unknown): boolean {
    const maybeError = error as Error & {code?: string};
    const code = maybeError?.code;
    const name = maybeError?.name ?? '';
    return code==='ENOENT'
        || code==='FileNotFound'
        || name.includes('FileNotFound')
        || name.includes('EntryNotFound');
}

function shouldSkipProjectWorkspaceRelPath(relPath: string) {
    const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    const firstSegment = normalized.split('/')[0] ?? '';
    return firstSegment==='.vscode'
        || firstSegment==='.overleaf'
        || firstSegment==='.output';
}

export class DocumentSessionManager {
    private initialAttachTimer?: ReturnType<typeof setTimeout>;
    private readonly diagnosticsStateRegistration = registerDiagnosticStateProvider(
        'documentSessions',
        () => this.collectDiagnosticsState(),
    );
    private readonly sessionKeyByDocumentUri = new Map<string, string>();
    private readonly sessions = new Map<string, ManagedDocumentSession>();
    private readonly suppressedDocumentChanges = new Map<string, SuppressedDocumentChange[]>();

    constructor(
        private readonly vfsm: RemoteFileSystemProvider,
    ) {}

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('DocumentSessions', event, fields, error);
    }

    private summarizeCounts(values: string[]) {
        const counts = new Map<string, number>();
        values.forEach((value) => {
            counts.set(value, (counts.get(value) ?? 0) + 1);
        });
        return Object.fromEntries(
            Array.from(counts.entries())
                .sort(([left], [right]) => left.localeCompare(right)),
        );
    }

    private collectDiagnosticsState() {
        const sessions = Array.from(this.sessions.values())
            .sort((left, right) => left.key.localeCompare(right.key));
        const suppressedChangeCount = Array.from(this.suppressedDocumentChanges.values())
            .reduce((count, changes) => count + changes.length, 0);
        return {
            countsByOrigin: this.summarizeCounts(sessions.map((session) => session.origin)),
            countsByStatus: this.summarizeCounts(sessions.map((session) => session.status)),
            initialAttachScheduled: Boolean(this.initialAttachTimer),
            openDocumentCount: this.sessionKeyByDocumentUri.size,
            sessionCount: sessions.length,
            sessions: sessions.slice(0, 50).map((session) => ({
                docId: session.docId,
                flushQueued: session.flushQueued,
                hasFlushPromise: Boolean(session.flushPromise),
                hasFlushTimer: Boolean(session.flushTimer),
                hasLocalDelta: session.localText!==session.remoteText,
                hasRecoveryPromise: Boolean(session.recoveryPromise),
                localLength: session.localText.length,
                localVersion: session.localVersion,
                openDocumentCount: session.openDocumentUris.size,
                origin: session.origin,
                remoteLength: session.remoteText.length,
                status: session.status,
                usesLocalReplica: session.usesLocalReplica,
            })),
            suppressedChangeCount,
            suppressedChangeDocumentCount: this.suppressedDocumentChanges.size,
        };
    }

    private isManagedDocument(document: vscode.TextDocument) {
        return isPotentialProjectWorkspaceUri(document.uri);
    }

    private consumeSuppressedDocumentChange(uri: vscode.Uri, currentText: string) {
        const uriKey = uri.toString();
        const pendingChanges = this.suppressedDocumentChanges.get(uriKey);
        if (!pendingChanges || pendingChanges.length===0) {
            this.suppressedDocumentChanges.delete(uriKey);
            return false;
        }

        const matchingChangeIndex = pendingChanges.findIndex((pendingChange) => (
            pendingChange.expectedText===undefined
            || pendingChange.expectedText===currentText
        ));
        if (matchingChangeIndex<0) {
            return false;
        }

        pendingChanges.splice(matchingChangeIndex, 1);
        if (pendingChanges.length===0) {
            this.suppressedDocumentChanges.delete(uriKey);
        }
        return true;
    }

    private suppressNextDocumentChange(uri: vscode.Uri, expectedText?: string) {
        const uriKey = uri.toString();
        const pendingChanges = this.suppressedDocumentChanges.get(uriKey) ?? [];
        pendingChanges.push({expectedText});
        this.suppressedDocumentChanges.set(uriKey, pendingChanges);
    }

    private readCurrentSessionText(session: ManagedDocumentSession) {
        for (const uriKey of session.openDocumentUris) {
            const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString()===uriKey);
            if (document) {
                return document.getText();
            }
        }
        return session.localText;
    }

    private async shouldPreferRemoteTextForLocalReplicaCheckpoint(
        session: ManagedDocumentSession,
        localText: string,
    ) {
        if (!session.usesLocalReplica) {
            return false;
        }
        const relPath = session.vfs.toDocumentSyncRelPath(session.overleafUri);
        try {
            const record = await session.vfs.getDocumentSyncRecord(relPath);
            if (!record || record.localDirty) {
                return false;
            }
            const localSnapshot = createLocalReplicaSnapshot(
                'file',
                new TextEncoder().encode(localText),
            );
            return localReplicaSnapshotsEqual(localSnapshot, record.baseSnapshot);
        } catch (error) {
            this.logDiagnostic('session.local_replica_checkpoint_record_failed', {
                docId: session.docId,
                origin: session.origin,
                relPath,
            }, error);
            return false;
        }
    }

    private async resolveBinding(document: vscode.TextDocument): Promise<DocumentSessionBinding | undefined> {
        if (!this.isManagedDocument(document)) {
            return undefined;
        }

        const documentBinding = await resolveProjectDocumentBinding(document.uri);
        if (!documentBinding) {
            return undefined;
        }
        if (shouldSkipProjectWorkspaceRelPath(documentBinding.relPath)) {
            this.logDiagnostic('session.binding_skipped_workspace_metadata', {
                relPath: documentBinding.relPath,
                renderUri: document.uri.toString(),
            });
            return undefined;
        }

        const overleafUri = documentBinding.overleafUri;
        const vfs = await this.vfsm.prefetch(overleafUri);
        let sessionState;
        try {
            sessionState = await vfs.ensureTextDocumentSession(overleafUri);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                this.logDiagnostic('session.binding_skipped_missing_remote_document', {
                    overleafUri: overleafUri.toString(),
                    renderUri: document.uri.toString(),
                });
                return undefined;
            }
            throw error;
        }
        return {
            docId: sessionState.docId,
            loadedFromCache: sessionState.loadedFromCache,
            localText: document.getText(),
            overleafUri,
            remoteText: sessionState.remoteText,
            sessionKey: toSessionKey(vfs.origin.toString(), sessionState.docId),
            status: vfs.isOfflineMode || vfs.realtimeConnectionPhase==='recovering'
                ? 'offline-queued'
                : 'live',
            usesLocalReplica: documentBinding.mode==='localReplica',
            vfs,
        };
    }

    private setSessionStatus(session: ManagedDocumentSession, status: DocumentSessionStatus) {
        const previousStatus = session.status;
        session.status = status;
        setManagedDocumentSessionState(session.key, status);
        if (previousStatus!==status) {
            this.logDiagnostic('session.status_changed', {
                docId: session.docId,
                nextStatus: status,
                origin: session.origin,
                previousStatus,
            });
        }
    }

    private async attachDocument(document: vscode.TextDocument, reason: string) {
        markManagedDocumentPending(document.uri);
        const binding = await this.resolveBinding(document);
        if (!binding) {
            clearManagedDocumentUri(document.uri);
            return undefined;
        }

        let session = this.sessions.get(binding.sessionKey);
        const isNewSession = !session;
        if (!session) {
            session = {
                docId: binding.docId,
                flushQueued: false,
                key: binding.sessionKey,
                localText: binding.localText,
                localVersion: 0,
                openDocumentUris: new Set<string>(),
                origin: binding.vfs.origin.toString(),
                overleafUri: binding.overleafUri,
                remoteText: binding.remoteText,
                status: binding.status,
                usesLocalReplica: binding.usesLocalReplica,
                vfs: binding.vfs,
            };
            this.sessions.set(binding.sessionKey, session);
            this.logDiagnostic('session.created', {
                docId: binding.docId,
                origin: session.origin,
                overleafUri: binding.overleafUri.toString(),
                reason,
            });
        }

        session.overleafUri = binding.overleafUri;
        const shouldPreserveRecoveryBase = session.localText!==session.remoteText
            || session.status==='offline-queued'
            || session.status==='syncing';
        session.vfs = binding.vfs;
        session.localText = binding.localText;
        if (!shouldPreserveRecoveryBase) {
            session.remoteText = binding.remoteText;
        }
        session.usesLocalReplica = session.usesLocalReplica || binding.usesLocalReplica;
        if (session.status!=='recovery-required' && session.status!=='syncing') {
            this.setSessionStatus(session, binding.status);
        }
        session.openDocumentUris.add(document.uri.toString());
        this.sessionKeyByDocumentUri.set(document.uri.toString(), session.key);
        linkManagedDocumentUri(session.key, document.uri, session.status);
        linkManagedDocumentUri(session.key, binding.overleafUri, session.status);

        const shouldRunAuthoritativeCheckpoint = isNewSession
            && binding.status==='live'
            && (
                binding.loadedFromCache
                || (binding.usesLocalReplica && binding.localText!==binding.remoteText)
            );
        if (shouldRunAuthoritativeCheckpoint) {
            this.setSessionStatus(session, 'syncing');
            void this.startRecovery(
                session,
                binding.usesLocalReplica
                    ? 'document_attached_local_replica_checkpoint'
                    : 'document_attached_cached_checkpoint',
                {
                    forceAuthoritativeRemoteCheckpoint: true,
                },
            );
        }
        if (binding.localText!==binding.remoteText && binding.status==='live') {
            if (!shouldRunAuthoritativeCheckpoint) {
                this.scheduleFlush(session, 'document_attached_out_of_sync');
            }
        }
        return session;
    }

    private clearSessionIfUnused(session: ManagedDocumentSession) {
        if (session.openDocumentUris.size!==0 || session.flushTimer || session.flushPromise || session.recoveryPromise) {
            return;
        }
        if (session.status==='syncing'
            || session.status==='offline-queued'
            || session.status==='recovery-required'
            || session.localText!==session.remoteText) {
            this.logDiagnostic('session.retained_for_recovery', {
                docId: session.docId,
                hasPendingTextDelta: session.localText!==session.remoteText,
                origin: session.origin,
                status: session.status,
            });
            return;
        }
        clearManagedDocumentSession(session.key);
        this.sessions.delete(session.key);
        this.logDiagnostic('session.disposed', {
            docId: session.docId,
            origin: session.origin,
        });
    }

    private detachDocument(document: vscode.TextDocument) {
        const uriKey = document.uri.toString();
        const sessionKey = this.sessionKeyByDocumentUri.get(uriKey);
        if (!sessionKey) {
            return;
        }
        this.sessionKeyByDocumentUri.delete(uriKey);
        clearManagedDocumentUri(document.uri);
        const session = this.sessions.get(sessionKey);
        if (!session) {
            return;
        }
        session.openDocumentUris.delete(uriKey);
        if (session.openDocumentUris.size===0) {
            clearManagedDocumentUri(session.overleafUri);
        }
        this.clearSessionIfUnused(session);
    }

    private scheduleFlush(session: ManagedDocumentSession, reason: string) {
        if (session.flushPromise) {
            if (!session.flushQueued) {
                this.logDiagnostic('session.flush_queued_behind_active', {
                    docId: session.docId,
                    origin: session.origin,
                    reason,
                });
            }
            session.flushQueued = true;
            return;
        }
        if (session.flushTimer) {
            this.logDiagnostic('session.flush_already_scheduled', {
                docId: session.docId,
                origin: session.origin,
                reason,
            });
            return;
        }
        session.flushTimer = setTimeout(() => {
            session.flushTimer = undefined;
            void this.flushSession(session, reason);
        }, DOCUMENT_SYNC_FLUSH_DELAY_MS);
    }

    private startRecovery(
        session: ManagedDocumentSession,
        reason: string,
        options: {
            forceAuthoritativeRemoteCheckpoint?: boolean,
        } = {},
    ) {
        if (session.recoveryPromise) {
            this.logDiagnostic('session.recovery_reused', {
                docId: session.docId,
                origin: session.origin,
                reason,
                status: session.status,
            });
            return session.recoveryPromise;
        }
        this.logDiagnostic('session.recovery_started', {
            docId: session.docId,
            forceAuthoritativeRemoteCheckpoint: options.forceAuthoritativeRemoteCheckpoint===true,
            origin: session.origin,
            reason,
            status: session.status,
        });
        const recoveryPromise = (async () => {
            try {
                await this.recoverSession(session, reason, options);
                this.logDiagnostic('session.recovery_completed', {
                    docId: session.docId,
                    origin: session.origin,
                    reason,
                    status: session.status,
                });
            } catch (error) {
                this.setSessionStatus(session, 'recovery-required');
                this.logDiagnostic('session.recovery_failed', {
                    docId: session.docId,
                    origin: session.origin,
                    reason,
                }, error);
                await session.vfs.requestRealtimeRecovery('document_version_mismatch');
            }
        })().finally(() => {
            if (session.recoveryPromise===recoveryPromise) {
                session.recoveryPromise = undefined;
            }
            this.clearSessionIfUnused(session);
        });
        session.recoveryPromise = recoveryPromise;
        return recoveryPromise;
    }

    private async flushSession(session: ManagedDocumentSession, reason: string) {
        if (session.flushPromise) {
            if (!session.flushQueued) {
                this.logDiagnostic('session.flush_queued_behind_active', {
                    docId: session.docId,
                    origin: session.origin,
                    reason,
                });
            }
            session.flushQueued = true;
            return;
        }
        session.flushPromise = (async () => {
            const localText = this.readCurrentSessionText(session);
            session.localText = localText;
            if (session.status==='syncing') {
                this.logDiagnostic('session.flush_skipped_syncing', {
                    docId: session.docId,
                    origin: session.origin,
                    reason,
                });
                return;
            }
            if (session.status==='recovery-required') {
                this.logDiagnostic('session.flush_skipped_recovery_required', {
                    docId: session.docId,
                    origin: session.origin,
                    reason,
                });
                return;
            }
            if (session.vfs.isOfflineMode
                || session.vfs.realtimeConnectionPhase==='initializing'
                || session.vfs.realtimeConnectionPhase==='recovering') {
                this.setSessionStatus(session, 'offline-queued');
                await this.queueOfflineLocalReplicaChange(session, `${reason}_deferred_until_reconnected`);
                this.logDiagnostic('session.flush_deferred_until_reconnected', {
                    connectionPhase: session.vfs.realtimeConnectionPhase,
                    docId: session.docId,
                    isOfflineMode: session.vfs.isOfflineMode,
                    origin: session.origin,
                    reason,
                });
                return;
            }
            try {
                // Open text documents sync through OT directly instead of waiting
                // for filesystem saves, which keeps local and non-local modes aligned.
                const result = await session.vfs.pushTextDocumentChanges(
                    session.overleafUri,
                    localText,
                    reason,
                );
                switch (result.kind) {
                    case 'applied':
                    case 'noop':
                        session.remoteText = localText;
                        this.setSessionStatus(session, 'live');
                        break;
                    case 'offline':
                        this.setSessionStatus(session, 'offline-queued');
                        break;
                    case 'recovery-required':
                        this.setSessionStatus(session, 'recovery-required');
                        break;
                }
                this.logDiagnostic('session.flush_completed', {
                    docId: session.docId,
                    kind: result.kind,
                    origin: session.origin,
                    reason,
                });
            } catch (error) {
                this.setSessionStatus(session, 'recovery-required');
                this.logDiagnostic('session.flush_failed', {
                    docId: session.docId,
                    origin: session.origin,
                    reason,
                }, error);
                await session.vfs.requestRealtimeRecovery('document_version_mismatch');
            }
        })().finally(() => {
            session.flushPromise = undefined;
            if (session.flushQueued) {
                session.flushQueued = false;
                this.scheduleFlush(session, 'queued_document_change');
            } else {
                this.clearSessionIfUnused(session);
            }
        });
        await session.flushPromise;
    }

    private async applyRemoteTextToOpenDocuments(session: ManagedDocumentSession, nextText: string, options: {
        expectedLocalText?: string,
        expectedLocalVersion?: number,
    } = {}) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            if (options.expectedLocalVersion!==undefined && session.localVersion!==options.expectedLocalVersion) {
                this.logDiagnostic('session.remote_apply_stale_local_version', {
                    attempt: attempt + 1,
                    currentLocalVersion: session.localVersion,
                    docId: session.docId,
                    expectedLocalVersion: options.expectedLocalVersion,
                    origin: session.origin,
                });
                return 'stale-local-state' as const;
            }
            if (options.expectedLocalText!==undefined) {
                const currentLocalText = this.readCurrentSessionText(session);
                if (currentLocalText!==options.expectedLocalText) {
                    this.logDiagnostic('session.remote_apply_stale_local_state', {
                        attempt: attempt + 1,
                        docId: session.docId,
                        expectedLength: options.expectedLocalText.length,
                        origin: session.origin,
                        currentLength: currentLocalText.length,
                    });
                    return 'stale-local-state' as const;
                }
            }
            const targetDocuments = Array.from(session.openDocumentUris)
                .map((uriKey) => vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString()===uriKey))
                .filter((document): document is vscode.TextDocument => document!==undefined)
                .filter((document) => document.getText()!==nextText);

            if (targetDocuments.length===0) {
                return 'applied' as const;
            }

            const workspaceEdit = new vscode.WorkspaceEdit();
            targetDocuments.forEach((document) => {
                this.suppressNextDocumentChange(document.uri, nextText);
                const fullRange = new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length),
                );
                workspaceEdit.replace(document.uri, fullRange, nextText);
            });

            const applied = await vscode.workspace.applyEdit(workspaceEdit);
            const pendingUris = targetDocuments
                .filter((document) => document.getText()!==nextText)
                .map((document) => document.uri.toString());
            if (pendingUris.length===0) {
                if (options.expectedLocalVersion!==undefined && session.localVersion!==options.expectedLocalVersion) {
                    this.logDiagnostic('session.remote_apply_stale_local_version_after_apply', {
                        attempt: attempt + 1,
                        currentLocalVersion: session.localVersion,
                        docId: session.docId,
                        expectedLocalVersion: options.expectedLocalVersion,
                        origin: session.origin,
                    });
                    return 'stale-local-state' as const;
                }
                return 'applied' as const;
            }

            this.logDiagnostic('session.remote_apply_retry', {
                applied,
                attempt: attempt + 1,
                docId: session.docId,
                origin: session.origin,
                pendingDocumentCount: pendingUris.length,
            });
        }

        const unresolvedUris = Array.from(session.openDocumentUris)
            .map((uriKey) => vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString()===uriKey))
            .filter((document): document is vscode.TextDocument => document!==undefined)
            .filter((document) => document.getText()!==nextText)
            .map((document) => document.uri.toString());
        this.logDiagnostic('session.remote_apply_failed', {
            docId: session.docId,
            origin: session.origin,
            unresolvedDocumentCount: unresolvedUris.length,
            unresolvedDocumentUris: unresolvedUris,
        });
        return 'failed' as const;
    }

    private async handleRemoteApplyFailure(session: ManagedDocumentSession, options: {
        baseText: string,
        localText: string,
        reason: string,
        remoteText: string,
        version: number,
    }) {
        this.setSessionStatus(session, 'recovery-required');
        await session.vfs.recordDocumentSyncConflict({
            baseContent: new TextEncoder().encode(options.baseText),
            docId: session.docId,
            lastKnownRemoteContent: new TextEncoder().encode(options.remoteText),
            lastKnownRemoteVersion: options.version,
            localContent: new TextEncoder().encode(options.localText),
            reason: options.reason,
            relPath: session.vfs.toDocumentSyncRelPath(session.overleafUri),
            remoteContent: new TextEncoder().encode(options.remoteText),
        });
        this.logDiagnostic('session.remote_apply_failed_recovery_requested', {
            docId: session.docId,
            origin: session.origin,
            reason: options.reason,
            version: options.version,
        });
        await session.vfs.requestRealtimeRecovery('document_version_mismatch');
    }

    private async queueOfflineLocalReplicaChange(session: ManagedDocumentSession, reason: string) {
        if (!session.usesLocalReplica) {
            return;
        }
        const relPath = session.vfs.toDocumentSyncRelPath(session.overleafUri);
        const baseContent = new TextEncoder().encode(session.remoteText);
        await session.vfs.markDocumentSyncDirty({
            baseContent,
            docId: session.docId,
            lastKnownRemoteContent: baseContent,
            reason,
            relPath,
        });
        await session.vfs.recordLocalReplicaChange('update', relPath, reason);
    }

    private async recoverSession(
        session: ManagedDocumentSession,
        reason: string,
        options: {
            forceAuthoritativeRemoteCheckpoint?: boolean,
        } = {},
    ) {
        const checkpointLocalText = this.readCurrentSessionText(session);
        session.localText = checkpointLocalText;

        let remoteSession;
        if (session.usesLocalReplica || options.forceAuthoritativeRemoteCheckpoint===true) {
            try {
                remoteSession = await session.vfs.refreshTextDocumentSessionFromServer(
                    session.overleafUri,
                    `${reason}_authoritative_checkpoint`,
                    {
                        localTextOverride: checkpointLocalText,
                    },
                );
            } catch (error) {
                this.logDiagnostic('session.recovery_authoritative_checkpoint_failed', {
                    docId: session.docId,
                    origin: session.origin,
                    reason,
                }, error);
                remoteSession = await session.vfs.ensureTextDocumentSession(session.overleafUri);
            }
        } else {
            remoteSession = await session.vfs.ensureTextDocumentSession(session.overleafUri);
        }
        const latestRemoteText = remoteSession.remoteText;
        const previousRemoteText = session.remoteText;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const currentLocalText = this.readCurrentSessionText(session);
            const currentLocalVersion = session.localVersion;
            session.localText = currentLocalText;

            if (currentLocalText===previousRemoteText) {
                const applied = await this.applyRemoteTextToOpenDocuments(session, latestRemoteText, {
                    expectedLocalText: currentLocalText,
                    expectedLocalVersion: currentLocalVersion,
                });
                if (applied==='stale-local-state') {
                    continue;
                }
                if (applied==='failed') {
                    await this.handleRemoteApplyFailure(session, {
                        baseText: previousRemoteText,
                        localText: currentLocalText,
                        reason: 'document_recovery_remote_apply_failed',
                        remoteText: latestRemoteText,
                        version: remoteSession.version,
                    });
                    return;
                }
                session.remoteText = latestRemoteText;
                session.localText = latestRemoteText;
                session.vfs.acceptRemoteTextUpdate(
                    session.docId,
                    latestRemoteText,
                    latestRemoteText,
                    remoteSession.version,
                    'document_recovery_remote_only',
                );
                this.setSessionStatus(session, session.vfs.isOfflineMode ? 'offline-queued' : 'live');
                this.logDiagnostic('session.recovered_remote_only', {
                    docId: session.docId,
                    origin: session.origin,
                    reason,
                    version: remoteSession.version,
                });
                return;
            }

            if (latestRemoteText===previousRemoteText) {
                if (await this.shouldPreferRemoteTextForLocalReplicaCheckpoint(session, currentLocalText)) {
                    const applied = await this.applyRemoteTextToOpenDocuments(session, latestRemoteText, {
                        expectedLocalText: currentLocalText,
                        expectedLocalVersion: currentLocalVersion,
                    });
                    if (applied==='stale-local-state') {
                        continue;
                    }
                    if (applied==='failed') {
                        await this.handleRemoteApplyFailure(session, {
                            baseText: previousRemoteText,
                            localText: currentLocalText,
                            reason: 'document_recovery_local_replica_stale_apply_failed',
                            remoteText: latestRemoteText,
                            version: remoteSession.version,
                        });
                        return;
                    }
                    session.remoteText = latestRemoteText;
                    session.localText = latestRemoteText;
                    session.vfs.acceptRemoteTextUpdate(
                        session.docId,
                        latestRemoteText,
                        latestRemoteText,
                        remoteSession.version,
                        'document_recovery_local_replica_stale_baseline',
                    );
                    this.setSessionStatus(session, session.vfs.isOfflineMode ? 'offline-queued' : 'live');
                    this.logDiagnostic('session.recovered_remote_only_local_replica_stale_baseline', {
                        docId: session.docId,
                        origin: session.origin,
                        reason,
                        version: remoteSession.version,
                    });
                    return;
                }
                this.setSessionStatus(session, session.vfs.isOfflineMode ? 'offline-queued' : 'live');
                this.logDiagnostic('session.recovered_local_only', {
                    docId: session.docId,
                    origin: session.origin,
                    reason,
                    version: remoteSession.version,
                });
                await this.flushSession(session, reason);
                return;
            }

            const merged = mergeRemoteTextIntoLocalText(
                previousRemoteText,
                latestRemoteText,
                currentLocalText,
            );
            if (merged.kind==='conflict') {
                this.setSessionStatus(session, 'recovery-required');
                await session.vfs.recordDocumentSyncConflict({
                    baseContent: new TextEncoder().encode(previousRemoteText),
                    docId: session.docId,
                    lastKnownRemoteContent: new TextEncoder().encode(latestRemoteText),
                    lastKnownRemoteVersion: remoteSession.version,
                    localContent: new TextEncoder().encode(currentLocalText),
                    reason: 'document_recovery_conflict',
                    relPath: session.vfs.toDocumentSyncRelPath(session.overleafUri),
                    remoteContent: new TextEncoder().encode(latestRemoteText),
                });
                this.logDiagnostic('session.recovery_required_true_divergence', {
                    docId: session.docId,
                    failedPatchCount: merged.failedPatchCount ?? 0,
                    origin: session.origin,
                    reason,
                });
                await session.vfs.requestRealtimeRecovery('document_version_mismatch');
                return;
            }

            const applied = await this.applyRemoteTextToOpenDocuments(session, merged.mergedText, {
                expectedLocalText: currentLocalText,
                expectedLocalVersion: currentLocalVersion,
            });
            if (applied==='stale-local-state') {
                continue;
            }
            if (applied==='failed') {
                await this.handleRemoteApplyFailure(session, {
                    baseText: previousRemoteText,
                    localText: currentLocalText,
                    reason: 'document_recovery_merged_apply_failed',
                    remoteText: latestRemoteText,
                    version: remoteSession.version,
                });
                return;
            }

            session.remoteText = latestRemoteText;
            session.localText = merged.mergedText;
            session.vfs.acceptRemoteTextUpdate(
                session.docId,
                latestRemoteText,
                merged.mergedText,
                remoteSession.version,
                'document_recovery_merged',
            );

            if (merged.mergedText===latestRemoteText) {
                this.setSessionStatus(session, session.vfs.isOfflineMode ? 'offline-queued' : 'live');
                this.logDiagnostic('session.recovered_no_local_replay_needed', {
                    docId: session.docId,
                    origin: session.origin,
                    reason,
                    version: remoteSession.version,
                });
                return;
            }

            this.setSessionStatus(session, session.vfs.isOfflineMode ? 'offline-queued' : 'live');
            this.logDiagnostic('session.recovered_with_local_replay', {
                docId: session.docId,
                origin: session.origin,
                reason,
                version: remoteSession.version,
            });
            await this.flushSession(session, `${reason}_merged_replay`);
            return;
        }

        this.logDiagnostic('session.recovery_retry_exhausted', {
            docId: session.docId,
            origin: session.origin,
            reason,
            version: remoteSession.version,
        });
    }

    private async handleRemoteTextUpdate(arg: {
        docId: string,
        nextRemoteText: string,
        origin: string,
        overleafUri: string,
        previousRemoteText: string,
        update: UpdateSchema,
    }) {
        const session = this.sessions.get(toSessionKey(arg.origin, arg.docId));
        if (!session) {
            return;
        }
        const steadyStateStatus = session.status==='syncing'
            ? 'syncing'
            : session.vfs.isOfflineMode
                ? 'offline-queued'
                : 'live';
        const textOps = arg.update.op?.filter((op) => typeof op.i === 'string' || typeof op.d === 'string');
        if (!textOps || textOps.length===0) {
            return;
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const currentLocalText = this.readCurrentSessionText(session);
            const currentLocalVersion = session.localVersion;
            if (arg.nextRemoteText===currentLocalText) {
                session.localText = arg.nextRemoteText;
                session.vfs.acceptRemoteTextUpdate(
                    session.docId,
                    arg.nextRemoteText,
                    arg.nextRemoteText,
                    (arg.update.v ?? 0) + 1,
                    'document_remote_text_noop',
                );
                session.remoteText = arg.nextRemoteText;
                this.setSessionStatus(session, steadyStateStatus);
                this.logDiagnostic('session.remote_update_noop', {
                    docId: session.docId,
                    origin: session.origin,
                    version: arg.update.v ?? -1,
                });
                return;
            }
            const merged = mergeRemoteTextIntoLocalText(
                arg.previousRemoteText,
                arg.nextRemoteText,
                currentLocalText,
            );
            if (merged.kind==='conflict') {
                this.setSessionStatus(session, 'recovery-required');
                await session.vfs.recordDocumentSyncConflict({
                    baseContent: new TextEncoder().encode(arg.previousRemoteText),
                    docId: session.docId,
                    lastKnownRemoteContent: new TextEncoder().encode(arg.nextRemoteText),
                    lastKnownRemoteVersion: (arg.update.v ?? 0) + 1,
                    localContent: new TextEncoder().encode(currentLocalText),
                    reason: 'document_remote_update_conflict',
                    relPath: session.vfs.toDocumentSyncRelPath(session.overleafUri),
                    remoteContent: new TextEncoder().encode(arg.nextRemoteText),
                });
                this.logDiagnostic('session.recovery_required_true_divergence', {
                    docId: session.docId,
                    failedPatchCount: merged.failedPatchCount ?? 0,
                    origin: session.origin,
                });
                await session.vfs.requestRealtimeRecovery('document_version_mismatch');
                return;
            }

            // Apply remote edits into the open editor before the local replica watcher
            // sees the same path, so live sessions do not bounce through reconcile.
            const applied = await this.applyRemoteTextToOpenDocuments(session, merged.mergedText, {
                expectedLocalText: currentLocalText,
                expectedLocalVersion: currentLocalVersion,
            });
            if (applied==='stale-local-state') {
                continue;
            }
            if (applied==='failed') {
                await this.handleRemoteApplyFailure(session, {
                    baseText: arg.previousRemoteText,
                    localText: currentLocalText,
                    reason: 'document_remote_update_apply_failed',
                    remoteText: arg.nextRemoteText,
                    version: (arg.update.v ?? 0) + 1,
                });
                return;
            }

            session.remoteText = arg.nextRemoteText;
            session.localText = merged.mergedText;
            session.vfs.acceptRemoteTextUpdate(
                session.docId,
                arg.nextRemoteText,
                merged.mergedText,
                (arg.update.v ?? 0) + 1,
                'document_remote_text_merged',
            );
            this.setSessionStatus(session, steadyStateStatus);
            if (merged.mergedText!==arg.nextRemoteText) {
                this.logDiagnostic('session.remote_update_replaying_local_merge', {
                    docId: session.docId,
                    origin: session.origin,
                    version: arg.update.v ?? -1,
                });
                await this.flushSession(session, 'document_remote_update_merged_replay');
            }
            return;
        }

        this.logDiagnostic('session.remote_update_stale_local_retry_exhausted', {
            docId: session.docId,
            origin: session.origin,
            version: arg.update.v ?? -1,
        });
    }

    private async handleDocumentChanged(document: vscode.TextDocument) {
        const nextLocalText = document.getText();
        const existingSession = this.sessions.get(this.sessionKeyByDocumentUri.get(document.uri.toString()) ?? '');
        if (existingSession) {
            if (this.consumeSuppressedDocumentChange(document.uri, nextLocalText)) {
                existingSession.localText = nextLocalText;
                return;
            }
            await this.processSessionDocumentChange(existingSession, nextLocalText);
            return;
        }

        const session = await this.attachDocument(document, 'document_changed');
        if (!session) {
            return;
        }
        if (this.consumeSuppressedDocumentChange(document.uri, nextLocalText)) {
            session.localText = nextLocalText;
            return;
        }
        await this.processSessionDocumentChange(session, nextLocalText);
    }

    private async processSessionDocumentChange(
        session: ManagedDocumentSession,
        nextLocalText: string,
    ) {
        const previousLocalText = session.localText;
        if (session.usesLocalReplica && previousLocalText!==nextLocalText) {
            await session.vfs.applyLocalTextDocumentChangesToCommentRanges(
                session.overleafUri,
                previousLocalText,
                nextLocalText,
                'document_changed_local_replica_comment_ranges',
            );
        }
        session.localText = nextLocalText;
        session.localVersion += 1;
        if (session.status==='syncing') {
            this.logDiagnostic('session.local_change_buffered_during_sync', {
                docId: session.docId,
                localVersion: session.localVersion,
                origin: session.origin,
            });
            return;
        }
        if (session.status==='recovery-required') {
            await this.queueOfflineLocalReplicaChange(session, 'document_changed_recovery_required');
            return;
        }
        if (session.vfs.isOfflineMode || session.vfs.realtimeConnectionPhase==='recovering') {
            this.setSessionStatus(session, 'offline-queued');
            await this.queueOfflineLocalReplicaChange(session, 'document_changed_offline_queued');
            return;
        }
        this.scheduleFlush(session, 'document_changed');
    }

    private async resynchronizeProjectSessions(origin: string, reason: string) {
        const candidateSessions = [...this.sessions.values()].filter((session) => session.origin===origin);
        for (const session of candidateSessions) {
            const replacementVfs = await this.vfsm.prefetch(session.overleafUri);
            session.vfs = replacementVfs;
            const previousStatus = session.status;
            const replacementStatus = replacementVfs.isOfflineMode || replacementVfs.realtimeConnectionPhase==='recovering'
                ? 'offline-queued'
                : 'live';
            if (replacementStatus==='offline-queued') {
                if (session.status!=='recovery-required') {
                    this.setSessionStatus(session, replacementStatus);
                }
                continue;
            }
            if (session.status==='syncing' && session.recoveryPromise) {
                continue;
            }
            this.setSessionStatus(session, replacementStatus);

            if (previousStatus==='syncing') {
                void this.startRecovery(session, reason, {
                    forceAuthoritativeRemoteCheckpoint: true,
                });
                continue;
            }
            if (previousStatus==='offline-queued' || session.localText!==session.remoteText) {
                void this.startRecovery(session, reason);
                continue;
            }
            this.scheduleFlush(session, reason);
        }
    }

    private async documentMatchesOrigin(document: vscode.TextDocument, origin: string) {
        const sessionKey = this.sessionKeyByDocumentUri.get(document.uri.toString());
        if (sessionKey?.startsWith(`${origin}::`)) {
            return true;
        }
        if (!this.isManagedDocument(document)) {
            return false;
        }
        const binding = await resolveProjectDocumentBinding(document.uri);
        if (!binding) {
            return false;
        }
        const vfs = await this.vfsm.prefetch(binding.overleafUri);
        return vfs.origin.toString()===origin;
    }

    private async attachOpenDocumentsForOrigin(origin: string, reason: string) {
        if (this.initialAttachTimer) {
            clearTimeout(this.initialAttachTimer);
            this.initialAttachTimer = undefined;
        }
        for (const document of vscode.workspace.textDocuments) {
            const existingSessionKey = this.sessionKeyByDocumentUri.get(document.uri.toString());
            if (existingSessionKey?.startsWith(`${origin}::`) && this.sessions.has(existingSessionKey)) {
                continue;
            }
            if (!await this.documentMatchesOrigin(document, origin)) {
                continue;
            }
            await this.attachDocument(document, reason);
        }
    }

    private async drainSessionForRemoteOperation(session: ManagedDocumentSession, reason: string) {
        for (let attempt = 0; attempt < 6; attempt += 1) {
            session.vfs = await this.vfsm.prefetch(session.overleafUri);
            if (session.recoveryPromise) {
                await session.recoveryPromise;
                continue;
            }
            if (session.flushPromise) {
                await session.flushPromise;
                continue;
            }
            if (session.status==='syncing') {
                await this.startRecovery(session, `${reason}_syncing_checkpoint`, {
                    forceAuthoritativeRemoteCheckpoint: true,
                });
                continue;
            }
            if (session.status==='offline-queued'
                && !session.vfs.isOfflineMode
                && session.vfs.realtimeConnectionPhase!=='initializing'
                && session.vfs.realtimeConnectionPhase!=='recovering') {
                await this.startRecovery(session, `${reason}_offline_recovery`);
                continue;
            }
            if (session.flushTimer) {
                clearTimeout(session.flushTimer);
                session.flushTimer = undefined;
                await this.flushSession(session, `${reason}_forced_flush`);
                continue;
            }
            if (session.status==='live' && session.localText!==session.remoteText) {
                await this.flushSession(session, `${reason}_drain_local_delta`);
                continue;
            }
            break;
        }
    }

    public async prepareProjectForRemoteOperation(projectUri: vscode.Uri, reason: string): Promise<RemoteOperationPreparationResult> {
        const projectVfs = await this.vfsm.prefetch(projectUri);
        const origin = projectVfs.origin.toString();
        this.logDiagnostic('remote_operation.prepare_started', {
            origin,
            projectUri: projectUri.toString(),
            reason,
        });

        await this.attachOpenDocumentsForOrigin(origin, `${reason}_attach_open_documents`);
        const candidateSessions = [...this.sessions.values()].filter((session) => session.origin===origin);
        for (const session of candidateSessions) {
            await this.drainSessionForRemoteOperation(session, reason);
        }

        const refreshedProjectVfs = await this.vfsm.prefetch(projectUri);
        const blockedSessions = [];
        for (const session of candidateSessions) {
            session.vfs = await this.vfsm.prefetch(session.overleafUri);
            if (session.recoveryPromise
                || session.flushPromise
                || session.flushTimer
                || session.status==='syncing'
                || session.status==='offline-queued'
                || session.status==='recovery-required'
                || session.vfs.isOfflineMode
                || session.vfs.realtimeConnectionPhase==='initializing'
                || session.vfs.realtimeConnectionPhase==='recovering') {
                blockedSessions.push({
                    docId: session.docId,
                    hasFlushPromise: Boolean(session.flushPromise),
                    hasFlushTimer: Boolean(session.flushTimer),
                    hasRecoveryPromise: Boolean(session.recoveryPromise),
                    phase: session.vfs.realtimeConnectionPhase,
                    status: session.status,
                });
            }
        }

        const blocked = refreshedProjectVfs.isOfflineMode
            || refreshedProjectVfs.realtimeConnectionPhase==='initializing'
            || refreshedProjectVfs.realtimeConnectionPhase==='recovering'
            || blockedSessions.length > 0;
        this.logDiagnostic(blocked
            ? 'remote_operation.prepare_blocked'
            : 'remote_operation.prepare_ready', {
            blockedSessions,
            origin,
            projectPhase: refreshedProjectVfs.realtimeConnectionPhase,
            projectUri: projectUri.toString(),
            reason,
            sessionCount: candidateSessions.length,
        });
        return blocked ? 'blocked' : 'ready';
    }

    get triggers() {
        this.initialAttachTimer = setTimeout(() => {
            this.initialAttachTimer = undefined;
            for (const document of vscode.workspace.textDocuments) {
                void this.attachDocument(document, 'initial_attach');
            }
        }, 100);
        return [
            vscode.workspace.onDidOpenTextDocument((document) => {
                if (this.isManagedDocument(document)) {
                    markManagedDocumentPending(document.uri);
                }
                void this.attachDocument(document, 'document_opened');
            }),
            vscode.workspace.onDidCloseTextDocument((document) => {
                this.detachDocument(document);
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.contentChanges.length===0) {
                    return;
                }
                void this.handleDocumentChanged(event.document);
            }),
            EventBus.on('documentRemoteTextUpdatedEvent', (arg) => {
                void this.handleRemoteTextUpdate(arg);
            }),
            EventBus.on('realtimeConnectionStateChangedEvent', (arg) => {
                if (arg.phase==='live' || arg.phase==='invisible') {
                    void this.resynchronizeProjectSessions(arg.origin, `realtime_phase_${arg.phase}`);
                    return;
                }
                if (arg.phase==='recovering') {
                    for (const session of this.sessions.values()) {
                        if (session.origin===arg.origin && session.status!=='recovery-required') {
                            this.setSessionStatus(session, 'offline-queued');
                        }
                    }
                }
            }),
            EventBus.on('offlineSynchronizationStateChangedEvent', (arg) => {
                if (arg.mode==='online' || arg.mode==='sync-recovery') {
                    void this.resynchronizeProjectSessions(arg.origin, `offline_mode_${arg.mode}`);
                    return;
                }
                for (const session of this.sessions.values()) {
                    if (session.origin===arg.origin && session.status!=='recovery-required') {
                        this.setSessionStatus(session, 'offline-queued');
                    }
                }
            }),
            new vscode.Disposable(() => {
                if (this.initialAttachTimer) {
                    clearTimeout(this.initialAttachTimer);
                    this.initialAttachTimer = undefined;
                }
                this.diagnosticsStateRegistration.dispose();
            }),
        ];
    }
}
