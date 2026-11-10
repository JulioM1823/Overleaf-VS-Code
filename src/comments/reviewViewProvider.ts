import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { resolveProjectRenderUriForPath } from '../core/projectWorkspaceBinding';
import { EventBus } from '../utils/eventBus';
import { logDiagnostic, registerDiagnosticStateProvider } from '../utils/diagnostics';
import { OverleafReviewThreadEntry, sortReviewThreadEntries } from './reviewIndex';
import { didCommentUserPaletteChange } from './commentColorConfiguration';
import { shouldDeferThreadOnlyCommentCreateChange } from './commentChangeEmissionPolicy';
import { mergeScopedReviewThreadEntries } from './reviewEntryRefresh';
import {
    applyPendingReviewLocalMutations,
    applyReviewMessageDeleteLocally,
    applyReviewMessageEditLocally,
    ReviewLocalMutation,
    resolveReviewEntryByThreadOrMessage,
} from './reviewLocalMutation';
import {
    shouldPreferLocalCommentReviewStateForReason,
    shouldPreserveLocalReviewEntriesOnEmptyRefresh,
    shouldTreatCommentsChangedRefreshAsProjectWide,
} from './reviewSyncPolicy';

function createNonce() {
    return crypto.randomBytes(16).toString('base64');
}

type ReviewWebviewMessage =
    | {type: 'ready'}
    | {type: 'refresh'}
    | {type: 'toggle-show-resolved', showResolved: boolean}
    | {type: 'navigate-thread', threadId: string}
    | {type: 'resolve-thread', threadId: string}
    | {type: 'reopen-thread', threadId: string}
    | {type: 'edit-comment', messageId: string, threadId: string}
    | {type: 'delete-comment', messageId: string, threadId: string}
    | {type: 'delete-thread', threadId: string}
    | {type: 'reply-comment', content: string, threadId: string};

const MAX_REVIEW_WEBVIEW_ID_LENGTH = 1_024;
const MAX_REVIEW_REPLY_LENGTH = 100_000;

function normalizeWebviewString(value: unknown, maxLength: number): string | undefined {
    return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function normalizeReviewWebviewMessage(message: unknown): ReviewWebviewMessage | undefined {
    if (message === null || typeof message !== 'object') {
        return undefined;
    }

    const candidate = message as Record<string, unknown>;
    const threadId = () => normalizeWebviewString(candidate.threadId, MAX_REVIEW_WEBVIEW_ID_LENGTH);
    const messageId = () => normalizeWebviewString(candidate.messageId, MAX_REVIEW_WEBVIEW_ID_LENGTH);

    switch (candidate.type) {
        case 'ready':
        case 'refresh':
            return {type: candidate.type};
        case 'toggle-show-resolved':
            return {type: 'toggle-show-resolved', showResolved: candidate.showResolved === true};
        case 'navigate-thread':
        case 'resolve-thread':
        case 'reopen-thread':
        case 'delete-thread': {
            const normalizedThreadId = threadId();
            return normalizedThreadId === undefined ? undefined : {type: candidate.type, threadId: normalizedThreadId};
        }
        case 'edit-comment':
        case 'delete-comment': {
            const normalizedThreadId = threadId();
            const normalizedMessageId = messageId();
            return normalizedThreadId === undefined || normalizedMessageId === undefined
                ? undefined
                : {type: candidate.type, threadId: normalizedThreadId, messageId: normalizedMessageId};
        }
        case 'reply-comment': {
            const normalizedThreadId = threadId();
            const content = normalizeWebviewString(candidate.content, MAX_REVIEW_REPLY_LENGTH);
            return normalizedThreadId === undefined || content === undefined
                ? undefined
                : {type: 'reply-comment', threadId: normalizedThreadId, content};
        }
        default:
            return undefined;
    }
}

export class ReviewViewProvider implements vscode.WebviewViewProvider {
    private static readonly resolvedProvidersByOrigin = new Map<string, ReviewViewProvider>();
    private static readonly showResolvedStateKey = `${ROOT_NAME}.review.showResolved`;
    private static readonly immediateRefreshReasons = new Set([
        'delete_comment',
        'delete_thread',
        'edit_comment',
        'reopen_thread',
        'resolve_thread',
        'thread_created',
        'thread_created_offline',
        'thread_created_queued_after_connectivity_failure',
        'thread_deleted',
        'thread_deleted_after_last_message_removed',
        'thread_deleted_after_last_message_removed_offline',
        'thread_deleted_offline',
        'thread_message_created',
        'thread_message_created_offline',
        'comments_recovery_ranges_preserved',
        'comments_replay_server_thread_id_resolved',
        'thread_message_replayed',
        'thread_reply_replayed',
        'thread_edit_replayed',
        'comments_replay_thread_id_reconciled',
        'comments_replay_thread_reconciled',
        'comments_replay_range_restored_from_operation_payload',
        'comments_threads_hydrated',
        'thread_message_received',
        'thread_reply_created',
        'thread_reply_created_offline',
        'thread_message_deleted',
        'thread_message_deleted_offline',
        'thread_message_edited',
        'thread_message_edited_offline',
        'thread_reopened',
        'thread_resolved',
    ]);
    private entriesByThreadId = new Map<string, OverleafReviewThreadEntry>();
    private needsRefresh = true;
    private pendingCommentsChangedLatencySamples: Array<{
        docCount: number,
        emittedAtMs: number,
        reason: string,
        receivedAtMs: number,
        sequence: number,
        threadCount: number,
    }> = [];
    private pendingCommentsChangedDocIds = new Set<string>();
    private pendingCommentsChangedProjectWide = false;
    private pendingLocalMutationsByMessageId = new Map<string, ReviewLocalMutation>();
    private pendingRefreshReason?: string;
    private recentRefreshEvents: Array<Record<string, unknown>> = [];
    private refreshSequence = 0;
    private refreshTimer?: ReturnType<typeof setTimeout>;
    private ready = false;
    private showResolved: boolean;
    private webviewView?: vscode.WebviewView;
    private readonly reviewDiagnosticsStateRegistration: {dispose: () => void};

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly context: vscode.ExtensionContext,
    ) {
        this.showResolved = this.context.workspaceState.get<boolean>(ReviewViewProvider.showResolvedStateKey, false);
        this.reviewDiagnosticsStateRegistration = registerDiagnosticStateProvider(
            `reviewPanel:${this.vfs.serverName}/${this.vfs.projectId}`,
            () => this.collectReviewDiagnosticsState(),
        );
    }

    private get originKey() {
        return this.vfs.origin.toString();
    }

    static notifyLocalMutationForOrigin(
        origin: string,
        mutation: {
            content?: string,
            kind: string,
            messageId: string,
            threadId: string,
        },
    ) {
        const provider = ReviewViewProvider.resolvedProvidersByOrigin.get(origin);
        if (!provider) {
            return false;
        }
        provider.applyLocalMutation(mutation);
        provider.logDiagnostic('local_mutation_applied_via_resolved_provider_bridge', {
            kind: mutation.kind,
            messageId: mutation.messageId,
            threadId: mutation.threadId,
        });
        return true;
    }

    static notifyProjectedThreadEntryForOrigin(
        origin: string,
        projection: {
            entry?: OverleafReviewThreadEntry,
            messageId?: string,
            threadId: string,
        },
    ) {
        const provider = ReviewViewProvider.resolvedProvidersByOrigin.get(origin);
        if (!provider) {
            return false;
        }
        provider.applyProjectedThreadEntry(projection);
        provider.logDiagnostic('local_projection_applied_via_resolved_provider_bridge', {
            messageId: projection.messageId ?? '',
            projectedThreadId: projection.entry?.threadId ?? '',
            threadId: projection.threadId,
        });
        return true;
    }

    private static resolveResolvedProvider(options: {
        origin?: string,
        projectId?: string,
    }) {
        if (options.origin) {
            const byOrigin = ReviewViewProvider.resolvedProvidersByOrigin.get(options.origin);
            if (byOrigin) {
                return byOrigin;
            }
        }
        if (options.projectId) {
            for (const provider of ReviewViewProvider.resolvedProvidersByOrigin.values()) {
                if (provider.vfs.projectId===options.projectId) {
                    return provider;
                }
            }
        }
        return undefined;
    }

    static renderAuthoritativeLocalEntriesForProject(options: {
        docIds?: string[],
        entries: OverleafReviewThreadEntry[],
        origin?: string,
        projectId?: string,
        reason: string,
    }) {
        const provider = ReviewViewProvider.resolveResolvedProvider({
            origin: options.origin,
            projectId: options.projectId,
        });
        if (!provider) {
            return false;
        }
        provider.applyAuthoritativeLocalEntries(options.entries, options.reason, options.docIds);
        provider.logDiagnostic('authoritative_local_entries_applied_via_bridge', {
            docCount: options.docIds?.length ?? 0,
            entryCount: options.entries.length,
            reason: options.reason,
        });
        return true;
    }

    static getDebugSnapshotForProject(options: {
        origin?: string,
        projectId?: string,
    }) {
        return ReviewViewProvider.resolveResolvedProvider(options)?.collectReviewDebugSnapshot();
    }

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('ReviewView', event, {
            commentSubsystem: 'comments:panel',
            entryCount: this.entriesByThreadId.size,
            projectId: this.vfs.projectId,
            projectName: this.vfs.projectName,
            serverName: this.vfs.serverName,
            showResolved: this.showResolved,
            viewVisible: this.webviewView?.visible ?? false,
            ...fields,
        }, error);
    }

    private collectReviewDiagnosticsState() {
        return {
            entryCount: this.entriesByThreadId.size,
            needsRefresh: this.needsRefresh,
            pendingCommentsChangedDocIdCount: this.pendingCommentsChangedDocIds.size,
            pendingCommentsChangedProjectWide: this.pendingCommentsChangedProjectWide,
            pendingCommentsChangedSampleCount: this.pendingCommentsChangedLatencySamples.length,
            pendingLocalMutationCount: this.pendingLocalMutationsByMessageId.size,
            pendingRefreshReason: this.pendingRefreshReason ?? '',
            ready: this.ready,
            recentRefreshEventCount: this.recentRefreshEvents.length,
            recentRefreshEvents: this.recentRefreshEvents,
            refreshSequence: this.refreshSequence,
            showResolved: this.showResolved,
            viewVisible: this.webviewView?.visible ?? false,
        };
    }

    private recordReviewDebugEvent(event: string, fields: Record<string, unknown> = {}) {
        this.recentRefreshEvents.push({
            event,
            recordedAt: new Date().toISOString(),
            ...fields,
        });
        if (this.recentRefreshEvents.length > 60) {
            this.recentRefreshEvents.splice(0, this.recentRefreshEvents.length - 60);
        }
    }

    private summarizeEntriesForDiagnostics(entries: Iterable<OverleafReviewThreadEntry>) {
        return sortReviewThreadEntries(entries)
            .slice(0, 80)
            .map((entry) => ({
                docId: entry.docId,
                messageCount: entry.messages.length,
                messageIds: entry.messages.map((message) => message.id),
                resolved: entry.resolved,
                selectedText: entry.selectedText,
                threadId: entry.threadId,
            }));
    }

    private collectReviewDebugSnapshot() {
        return {
            entries: this.summarizeEntriesForDiagnostics(this.entriesByThreadId.values()),
            entryCount: this.entriesByThreadId.size,
            needsRefresh: this.needsRefresh,
            pendingRefreshReason: this.pendingRefreshReason ?? '',
            ready: this.ready,
            recentRefreshEvents: this.recentRefreshEvents,
            showResolved: this.showResolved,
            viewVisible: this.webviewView?.visible ?? false,
        };
    }

    private getRenderableEntries() {
        return this.showResolved
            ? sortReviewThreadEntries(this.entriesByThreadId.values())
            : sortReviewThreadEntries(
                Array.from(this.entriesByThreadId.values())
                    .filter((entry) => !entry.resolved),
            );
    }

    private postToWebview(message: Record<string, unknown>) {
        if (!this.webviewView) {
            return false;
        }
        this.webviewView.webview.postMessage(message);
        return true;
    }

    private shouldRefreshImmediately(reason: string) {
        const normalizedReason = reason.startsWith('comments_changed:')
            ? reason.slice('comments_changed:'.length)
            : reason;
        return ReviewViewProvider.immediateRefreshReasons.has(normalizedReason);
    }

    private isLifecycleHydrationRefresh(reason: string) {
        return reason.startsWith('realtime_state_changed:')
            || reason.startsWith('offline_state_changed:');
    }

    private scheduleRefresh(reason: string, options: {
        docIds?: string[],
        immediate?: boolean,
    } = {}) {
        this.needsRefresh = true;
        this.pendingRefreshReason = reason;
        let discardedStaleScopedDocCount = 0;
        if (reason.startsWith('comments_changed:')) {
            if (shouldTreatCommentsChangedRefreshAsProjectWide({docIds: options.docIds, reason})) {
                // Empty doc-id payloads represent project-wide state changes.
                // Clear stale scoped ids so reconnect churn cannot pin refreshes to
                // an unrelated subset and leave edited threads stale in review.
                discardedStaleScopedDocCount = this.pendingCommentsChangedDocIds.size;
                this.pendingCommentsChangedDocIds.clear();
                this.pendingCommentsChangedProjectWide = true;
            } else if (!this.pendingCommentsChangedProjectWide && options.docIds && options.docIds.length > 0) {
                options.docIds
                    .filter((docId) => typeof docId === 'string' && docId.length > 0)
                    .forEach((docId) => {
                        this.pendingCommentsChangedDocIds.add(docId);
                    });
            }
        }
        const immediate = options.immediate ?? this.shouldRefreshImmediately(reason);
        this.recordReviewDebugEvent('refresh_scheduled', {
            docCount: options.docIds?.length ?? 0,
            immediate,
            pendingCommentsChangedProjectWide: this.pendingCommentsChangedProjectWide,
            reason,
            scopedDocCount: this.pendingCommentsChangedDocIds.size,
        });
        this.logDiagnostic('refresh_scheduled', {
            discardedStaleScopedDocCount,
            immediate,
            incomingDocIds: options.docIds ?? [],
            pendingCommentsChangedProjectWide: this.pendingCommentsChangedProjectWide,
            reason,
            scopedDocCount: this.pendingCommentsChangedDocIds.size,
        });
        if (!this.webviewView?.visible || !this.ready) {
            return;
        }
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        // Direct user comment mutations should re-render the review panel
        // synchronously from the already-updated local VFS state.
        if (immediate) {
            void this.refresh(reason);
            return;
        }
        this.refreshTimer = setTimeout(() => {
            void this.refresh(reason);
        }, 120);
    }

    private normalizeRefreshCommandOptions(input: unknown) {
        if (!input || typeof input!=='object') {
            return {
                docIds: undefined as string[] | undefined,
                immediate: undefined as boolean | undefined,
                origin: undefined as string | undefined,
                reason: 'manual_refresh',
            };
        }
        const candidate = input as {
            docIds?: unknown,
            immediate?: unknown,
            origin?: unknown,
            reason?: unknown,
        };
        const docIds = Array.isArray(candidate.docIds)
            ? candidate.docIds.filter((docId): docId is string => typeof docId === 'string' && docId.length > 0)
            : undefined;
        return {
            docIds: docIds && docIds.length > 0 ? docIds : undefined,
            immediate: typeof candidate.immediate === 'boolean' ? candidate.immediate : undefined,
            origin: typeof candidate.origin === 'string' && candidate.origin.length > 0
                ? candidate.origin
                : undefined,
            reason: typeof candidate.reason === 'string' && candidate.reason.length > 0
                ? candidate.reason
                : 'manual_refresh',
        };
    }

    private normalizeLocalMutationCommandOptions(input: unknown) {
        if (!input || typeof input!=='object') {
            return undefined;
        }
        const candidate = input as {
            content?: unknown,
            kind?: unknown,
            messageId?: unknown,
            origin?: unknown,
            threadId?: unknown,
        };
        const kind = typeof candidate.kind==='string' ? candidate.kind : undefined;
        const threadId = typeof candidate.threadId==='string' && candidate.threadId.length > 0
            ? candidate.threadId
            : undefined;
        const messageId = typeof candidate.messageId==='string' && candidate.messageId.length > 0
            ? candidate.messageId
            : undefined;
        const origin = typeof candidate.origin==='string' && candidate.origin.length > 0
            ? candidate.origin
            : undefined;
        const content = typeof candidate.content==='string' ? candidate.content : undefined;
        if (!kind || !threadId || !messageId) {
            return undefined;
        }
        return {
            content,
            kind,
            messageId,
            origin,
            threadId,
        };
    }

    private bufferLocalMutation(mutation: ReviewLocalMutation) {
        this.pendingLocalMutationsByMessageId.set(mutation.messageId, mutation);
        this.logDiagnostic('local_mutation_buffered', {
            kind: mutation.kind,
            messageId: mutation.messageId,
            pendingLocalMutationCount: this.pendingLocalMutationsByMessageId.size,
            threadId: mutation.threadId,
        });
    }

    private reconcilePendingLocalMutations(entries: OverleafReviewThreadEntry[], reason: string) {
        const pendingMutations = Array.from(this.pendingLocalMutationsByMessageId.values());
        if (pendingMutations.length===0) {
            return entries;
        }
        const {entries: reconciledEntries, retainedMutations} = applyPendingReviewLocalMutations(entries, pendingMutations);
        this.pendingLocalMutationsByMessageId = new Map(
            retainedMutations.map((mutation) => [mutation.messageId, mutation] as const),
        );
        this.logDiagnostic('pending_local_mutations_reconciled', {
            discardedMutationCount: Math.max(0, pendingMutations.length - retainedMutations.length),
            reason,
            retainedMutationCount: retainedMutations.length,
            sourceMutationCount: pendingMutations.length,
        });
        return reconciledEntries;
    }

    private applyProjectedThreadEntry(options: {
        entry?: OverleafReviewThreadEntry,
        messageId?: string,
        threadId: string,
    }) {
        const resolvedTarget = resolveReviewEntryByThreadOrMessage(
            this.entriesByThreadId.values(),
            options.threadId,
            options.messageId,
        );
        const previousThreadId = resolvedTarget?.entry.threadId;

        if (!options.entry) {
            if (!previousThreadId) {
                this.logDiagnostic('local_projection_skipped_missing_entry', {
                    messageId: options.messageId ?? '',
                    threadId: options.threadId,
                });
                return;
            }
            this.entriesByThreadId.delete(previousThreadId);
            this.renderCurrentEntries();
            this.recordReviewDebugEvent('local_projection_applied', {
                messageId: options.messageId ?? '',
                projectedThreadId: '',
                removedThread: true,
                threadId: options.threadId,
            });
            this.logDiagnostic('local_projection_applied', {
                messageId: options.messageId ?? '',
                projectedThreadId: '',
                removedThread: true,
                threadId: options.threadId,
            });
            return;
        }

        const reconciledProjectedEntries = this.reconcilePendingLocalMutations([options.entry], 'local_thread_projection');
        const projectedEntry = reconciledProjectedEntries[0] ?? options.entry;
        if (previousThreadId && previousThreadId!==projectedEntry.threadId) {
            this.entriesByThreadId.delete(previousThreadId);
        }
        this.entriesByThreadId.set(projectedEntry.threadId, projectedEntry);
        this.renderCurrentEntries();
        this.recordReviewDebugEvent('local_projection_applied', {
            docId: projectedEntry.docId,
            messageId: options.messageId ?? '',
            projectedThreadId: projectedEntry.threadId,
            removedThread: false,
            threadId: options.threadId,
        });
        this.logDiagnostic('local_projection_applied', {
            messageId: options.messageId ?? '',
            projectedThreadId: projectedEntry.threadId,
            removedThread: false,
            threadId: options.threadId,
        });
    }

    private applyLocalMutation(options: {
        content?: string,
        kind: string,
        messageId: string,
        threadId: string,
    }) {
        if (options.kind!=='editMessage' && options.kind!=='deleteMessage' && options.kind!=='deleteThread') {
            this.logDiagnostic('local_mutation_skipped_invalid_kind', {
                kind: options.kind,
                messageId: options.messageId,
                threadId: options.threadId,
            });
            return;
        }
        this.bufferLocalMutation({
            content: options.content,
            kind: options.kind,
            messageId: options.messageId,
            threadId: options.threadId,
        });
        const resolvedTarget = resolveReviewEntryByThreadOrMessage(
            this.entriesByThreadId.values(),
            options.threadId,
            options.messageId,
        );
        if (!resolvedTarget) {
            this.logDiagnostic('local_mutation_skipped_missing_entry', {
                kind: options.kind,
                messageId: options.messageId,
                threadId: options.threadId,
            });
            return;
        }
        const existingEntry = resolvedTarget.entry;
        const targetThreadId = existingEntry.threadId;
        if (options.kind==='deleteThread') {
            this.entriesByThreadId.delete(targetThreadId);
            this.renderCurrentEntries();
            return;
        }
        let nextEntry = existingEntry;
        if (options.kind==='editMessage' && typeof options.content==='string') {
            nextEntry = applyReviewMessageEditLocally(existingEntry, options.messageId, options.content);
        } else if (options.kind==='deleteMessage') {
            const deletedEntry = applyReviewMessageDeleteLocally(existingEntry, options.messageId);
            if (!deletedEntry) {
                this.entriesByThreadId.delete(targetThreadId);
                this.renderCurrentEntries();
                this.logDiagnostic('local_mutation_applied', {
                    kind: options.kind,
                    matchedBy: resolvedTarget.matchedBy,
                    messageId: options.messageId,
                    pendingLocalMutationCount: this.pendingLocalMutationsByMessageId.size,
                    removedThread: true,
                    threadId: targetThreadId,
                });
                return;
            }
            nextEntry = deletedEntry;
        }
        this.entriesByThreadId.set(targetThreadId, nextEntry);
        this.renderCurrentEntries();
        this.logDiagnostic('local_mutation_applied', {
            kind: options.kind,
            matchedBy: resolvedTarget.matchedBy,
            messageId: options.messageId,
            pendingLocalMutationCount: this.pendingLocalMutationsByMessageId.size,
            removedThread: false,
            threadId: targetThreadId,
        });
    }

    private applyAuthoritativeLocalEntries(entries: OverleafReviewThreadEntry[], reason: string, docIds?: string[]) {
        const reconciledEntries = this.reconcilePendingLocalMutations(entries, `authoritative_local:${reason}`);
        const nextEntries = mergeScopedReviewThreadEntries(
            this.entriesByThreadId.values(),
            reconciledEntries,
            docIds,
        );
        this.entriesByThreadId = new Map(nextEntries.map((entry) => [entry.threadId, entry]));
        this.needsRefresh = false;
        this.renderCurrentEntries();
        this.recordReviewDebugEvent('authoritative_local_entries_applied', {
            docCount: docIds?.length ?? 0,
            entryCount: nextEntries.length,
            reason,
        });
        this.logDiagnostic('authoritative_local_entries_applied', {
            docCount: docIds?.length ?? 0,
            entryCount: nextEntries.length,
            reason,
        });
    }

    private async refresh(reason: string) {
        if (!this.webviewView || !this.ready || !this.webviewView.visible) {
            this.needsRefresh = true;
            return;
        }
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }

        const refreshSequence = ++this.refreshSequence;
        const targetDocIds = reason.startsWith('comments_changed:')
            && !this.pendingCommentsChangedProjectWide
            && this.pendingCommentsChangedDocIds.size > 0
            ? Array.from(this.pendingCommentsChangedDocIds)
            : undefined;
        this.logDiagnostic('refresh_started', {
            pendingCommentsChangedProjectWide: this.pendingCommentsChangedProjectWide,
            reason,
            refreshSequence,
            targetDocCount: targetDocIds?.length ?? 0,
        });
        this.recordReviewDebugEvent('refresh_started', {
            pendingCommentsChangedProjectWide: this.pendingCommentsChangedProjectWide,
            reason,
            refreshSequence,
            targetDocCount: targetDocIds?.length ?? 0,
        });
        try {
            const useBlockingHydration = reason==='manual_refresh'
                || reason==='view_visible'
                || reason==='webview_ready'
                || reason==='webview_refresh'
                || this.isLifecycleHydrationRefresh(reason);
            const preferLocalState = shouldPreferLocalCommentReviewStateForReason(reason);
            const entries = await this.vfs.getProjectCommentReviewEntries({
                blockingHydration: useBlockingHydration,
                docIds: targetDocIds,
                preferLocalState,
                reason,
            });
            const reconciledEntries = this.reconcilePendingLocalMutations(entries, reason);
            const shouldPreserveExistingEntries = shouldPreserveLocalReviewEntriesOnEmptyRefresh({
                connectionPhase: this.vfs.realtimeConnectionPhase,
                deferredSynchronizationMode: this.vfs.synchronizationMode,
                existingEntryCount: this.entriesByThreadId.size,
                isOfflineMode: this.vfs.isOfflineMode,
                nextEntryCount: reconciledEntries.length,
                reason,
            });
            if (shouldPreserveExistingEntries) {
                this.needsRefresh = true;
                this.pendingRefreshReason = reason;
                this.logDiagnostic('refresh_preserved_local_entries_after_empty_offline_snapshot', {
                    reason,
                    refreshSequence,
                    retainedThreadCount: this.entriesByThreadId.size,
                    targetDocCount: targetDocIds?.length ?? 0,
                });
                return;
            }
            if (refreshSequence!==this.refreshSequence) {
                this.logDiagnostic('refresh_discarded_stale', {
                    latestRefreshSequence: this.refreshSequence,
                    reason,
                    refreshSequence,
                });
                return;
            }
            const nextEntries = mergeScopedReviewThreadEntries(
                this.entriesByThreadId.values(),
                reconciledEntries,
                targetDocIds,
            );
            this.entriesByThreadId = new Map(nextEntries.map((entry) => [entry.threadId, entry]));
            this.postToWebview({
                type: 'render-review',
                content: {
                    entries: this.getRenderableEntries(),
                    projectName: this.vfs.projectName,
                    showResolved: this.showResolved,
                },
            });
            this.needsRefresh = false;
            this.pendingRefreshReason = undefined;
            // `pendingCommentsChanged*` only affects comments_changed refresh
            // scoping. Clear it after any successful render so non-comments
            // reasons (for example `webview_ready`) cannot carry stale scope
            // into subsequent mutation refreshes.
            this.pendingCommentsChangedDocIds.clear();
            this.pendingCommentsChangedProjectWide = false;
            this.logDiagnostic('refresh_completed', {
                pendingCommentsChangedProjectWide: this.pendingCommentsChangedProjectWide,
                pendingLocalMutationCount: this.pendingLocalMutationsByMessageId.size,
                reason,
                refreshSequence,
                scopedRefreshApplied: Boolean(targetDocIds && targetDocIds.length > 0),
                targetDocCount: targetDocIds?.length ?? 0,
                visibleThreadCount: this.getRenderableEntries().length,
                threadCount: nextEntries.length,
            });
            this.recordReviewDebugEvent('refresh_completed', {
                reason,
                refreshSequence,
                scopedRefreshApplied: Boolean(targetDocIds && targetDocIds.length > 0),
                targetDocCount: targetDocIds?.length ?? 0,
                threadCount: nextEntries.length,
                visibleThreadCount: this.getRenderableEntries().length,
            });
            if (reason.startsWith('comments_changed:') && this.pendingCommentsChangedLatencySamples.length > 0) {
                const latest = this.pendingCommentsChangedLatencySamples.at(-1)!;
                this.pendingCommentsChangedLatencySamples = [];
                const refreshCompletedAtMs = Date.now();
                this.logDiagnostic('comments_changed_latency_measured', {
                    docCount: latest.docCount,
                    emittedAtMs: latest.emittedAtMs,
                    endToEndLatencyMs: Math.max(0, refreshCompletedAtMs - latest.emittedAtMs),
                    eventTransitMs: Math.max(0, latest.receivedAtMs - latest.emittedAtMs),
                    eventReason: latest.reason,
                    receivedAtMs: latest.receivedAtMs,
                    refreshCompletedAtMs,
                    refreshReason: reason,
                    scheduleToRenderMs: Math.max(0, refreshCompletedAtMs - latest.receivedAtMs),
                    sequence: latest.sequence,
                    threadCount: latest.threadCount,
                });
            }
        } catch (error) {
            if (refreshSequence!==this.refreshSequence) {
                this.logDiagnostic('refresh_failed_stale', {
                    latestRefreshSequence: this.refreshSequence,
                    reason,
                    refreshSequence,
                }, error);
                return;
            }
            this.postToWebview({
                type: 'review-error',
                content: {
                    message: error instanceof Error ? error.message : vscode.l10n.t('Unable to load Overleaf review threads.'),
                },
            });
            this.recordReviewDebugEvent('refresh_failed', {
                errorMessage: error instanceof Error ? error.message : String(error),
                reason,
                refreshSequence,
            });
            this.logDiagnostic('refresh_failed', {reason}, error);
        }
    }

    private resolveVisibilityRefreshReason() {
        if (this.needsRefresh && this.pendingRefreshReason) {
            return this.pendingRefreshReason;
        }
        return 'view_visible';
    }

    private getEntry(threadId: string) {
        return this.entriesByThreadId.get(threadId);
    }

    private async navigateToThread(threadId: string) {
        const entry = this.getEntry(threadId);
        if (!entry) {
            this.logDiagnostic('navigate_thread_missing_entry', {threadId});
            return;
        }

        const uri = await resolveProjectRenderUriForPath(this.vfs.origin, entry.filePath);
        if (!uri) {
            this.logDiagnostic('navigate_thread_missing_uri', {
                filePath: entry.filePath,
                threadId,
            });
            return;
        }
        const selection = new vscode.Selection(
            entry.rangeStart.line,
            entry.rangeStart.character,
            entry.rangeEnd.line,
            entry.rangeEnd.character,
        );

        this.logDiagnostic('navigate_thread_started', {
            filePath: entry.filePath,
            threadId,
            uri: entry.overleafUri,
        });
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, {
            preview: false,
            selection,
        });
        editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        await vscode.commands.executeCommand(`${ROOT_NAME}.comments.refresh`);
        await vscode.commands.executeCommand(`${ROOT_NAME}.comments.focusThread`, {
            reason: 'review_navigate_thread',
            renderUri: uri,
            selection,
            threadId,
        });
        this.logDiagnostic('navigate_thread_completed', {
            filePath: entry.filePath,
            threadId,
            uri: entry.overleafUri,
        });
    }

    private async resolveThread(threadId: string, resolved: boolean) {
        const entry = this.getEntry(threadId);
        if (!entry) {
            return;
        }
        if (!entry.canResolveThread) {
            this.logDiagnostic('resolve_thread_skipped_forbidden', {threadId});
            return;
        }
        const uri = vscode.Uri.parse(entry.overleafUri);
        this.logDiagnostic(resolved ? 'resolve_thread_started' : 'reopen_thread_started', {
            threadId,
            uri: entry.overleafUri,
        });
        await this.vfs.resolveCommentThread(uri, threadId, resolved);
        this.scheduleRefresh(resolved ? 'resolve_thread' : 'reopen_thread', {immediate: true});
    }

    private renderCurrentEntries() {
        this.postToWebview({
            type: 'render-review',
            content: {
                entries: this.getRenderableEntries(),
                projectName: this.vfs.projectName,
                showResolved: this.showResolved,
            },
        });
    }

    private applyOptimisticThreadResolvedState(threadId: string, resolved: boolean) {
        const entry = this.getEntry(threadId);
        if (!entry) {
            return undefined;
        }
        const nextEntry = {
            ...entry,
            resolved,
        };
        this.entriesByThreadId.set(threadId, nextEntry);
        this.renderCurrentEntries();
        return entry;
    }

    private async toggleThreadResolved(threadId: string) {
        const entry = this.getEntry(threadId);
        if (!entry) {
            this.logDiagnostic('toggle_thread_skipped_missing_entry', {threadId});
            return;
        }
        const nextResolvedState = !entry.resolved;
        const previousEntry = this.applyOptimisticThreadResolvedState(threadId, nextResolvedState);
        try {
            await this.resolveThread(threadId, nextResolvedState);
        } catch (error) {
            if (previousEntry) {
                this.entriesByThreadId.set(threadId, previousEntry);
                this.renderCurrentEntries();
            }
            this.logDiagnostic(nextResolvedState ? 'resolve_thread_failed' : 'reopen_thread_failed', {
                threadId,
            }, error);
            void vscode.window.showErrorMessage(error instanceof Error
                ? error.message
                : vscode.l10n.t('Unable to update the Overleaf review thread.'));
        }
    }

    private async setShowResolved(nextValue: boolean) {
        if (this.showResolved===nextValue) {
            return;
        }
        this.showResolved = nextValue;
        await this.context.workspaceState.update(ReviewViewProvider.showResolvedStateKey, nextValue);
        this.logDiagnostic('filter.show_resolved_updated', {nextValue});
        this.renderCurrentEntries();
    }

    private findMessage(threadId: string, messageId: string) {
        const entry = this.getEntry(threadId);
        const message = entry?.messages.find((candidate) => candidate.id===messageId);
        if (!entry || !message) {
            return undefined;
        }
        return {
            entry,
            message,
        };
    }

    private async editComment(threadId: string, messageId: string) {
        const resolvedMessage = this.findMessage(threadId, messageId);
        if (!resolvedMessage?.message.canEdit) {
            this.logDiagnostic('edit_comment_skipped', {messageId, threadId});
            return;
        }
        const {message} = resolvedMessage;

        const updatedContent = await vscode.window.showInputBox({
            ignoreFocusOut: true,
            placeHolder: vscode.l10n.t('Edit comment'),
            prompt: vscode.l10n.t('Update Overleaf comment'),
            value: message.content,
            validateInput: (value) => value.trim().length===0 ? vscode.l10n.t('Comment text is required.') : undefined,
        });
        if (!updatedContent) {
            return;
        }

        this.logDiagnostic('edit_comment_started', {messageId, threadId});
        await this.vfs.editComment(threadId, messageId, updatedContent);
        this.scheduleRefresh('edit_comment', {immediate: true});
    }

    private async deleteComment(threadId: string, messageId: string) {
        const resolvedMessage = this.findMessage(threadId, messageId);
        if (!resolvedMessage?.message.canDelete) {
            this.logDiagnostic('delete_comment_skipped', {messageId, threadId});
            return;
        }
        const {message} = resolvedMessage;

        const confirmation = await vscode.window.showWarningMessage(
            vscode.l10n.t('Delete this Overleaf comment from the review panel?'),
            {modal: true},
            vscode.l10n.t('Delete'),
        );
        if (!confirmation) {
            return;
        }

        this.logDiagnostic('delete_comment_started', {messageId, threadId});
        await this.vfs.deleteComment(threadId, messageId, message.deleteOwnOnly);
        this.scheduleRefresh('delete_comment', {immediate: true});
        this.logDiagnostic('delete_comment_completed', {messageId, threadId});
    }

    private async deleteThread(threadId: string) {
        const entry = this.getEntry(threadId);
        if (!entry?.canDeleteRootComment) {
            this.logDiagnostic('delete_thread_skipped', {threadId});
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            vscode.l10n.t('Delete this Overleaf comment thread from the review panel?'),
            {modal: true},
            vscode.l10n.t('Delete'),
        );
        if (!confirmation) {
            return;
        }

        const uri = vscode.Uri.parse(entry.overleafUri);
        this.logDiagnostic('delete_thread_started', {
            threadId,
            uri: entry.overleafUri,
        });
        await this.vfs.deleteCommentThread(uri, threadId);
        this.scheduleRefresh('delete_thread', {immediate: true});
        this.logDiagnostic('delete_thread_completed', {
            threadId,
            uri: entry.overleafUri,
        });
    }

    private async replyToThread(threadId: string, content: string) {
        const entry = this.getEntry(threadId);
        const trimmedContent = content.trim();
        if (!entry) {
            this.logDiagnostic('reply_comment_skipped_missing_entry', {threadId});
            this.postToWebview({
                type: 'reply-comment-result',
                content: {
                    message: vscode.l10n.t('Unable to find the Overleaf thread to reply to.'),
                    success: false,
                    threadId,
                },
            });
            return;
        }
        if (!entry.canReply || entry.resolved) {
            this.logDiagnostic('reply_comment_skipped_forbidden', {
                resolved: entry.resolved,
                threadId,
            });
            this.postToWebview({
                type: 'reply-comment-result',
                content: {
                    message: vscode.l10n.t('Replies are not available for this Overleaf thread right now.'),
                    success: false,
                    threadId,
                },
            });
            return;
        }
        if (trimmedContent.length===0) {
            this.logDiagnostic('reply_comment_skipped_empty', {threadId});
            this.postToWebview({
                type: 'reply-comment-result',
                content: {
                    message: vscode.l10n.t('Reply text is required.'),
                    success: false,
                    threadId,
                },
            });
            return;
        }

        this.logDiagnostic('reply_comment_started', {
            contentLength: trimmedContent.length,
            threadId,
        });
        try {
            await this.vfs.replyToComment(threadId, content);
            await this.refresh('reply_comment');
            this.postToWebview({
                type: 'reply-comment-result',
                content: {
                    success: true,
                    threadId,
                },
            });
            this.logDiagnostic('reply_comment_completed', {
                contentLength: trimmedContent.length,
                messageCount: this.getEntry(threadId)?.messages.length ?? 0,
                threadId,
            });
        } catch (error) {
            const message = error instanceof Error
                ? error.message
                : vscode.l10n.t('Unable to reply to the Overleaf comment thread.');
            this.postToWebview({
                type: 'reply-comment-result',
                content: {
                    message,
                    success: false,
                    threadId,
                },
            });
            this.logDiagnostic('reply_comment_failed', {
                contentLength: trimmedContent.length,
                threadId,
            }, error);
            void vscode.window.showErrorMessage(message);
        }
    }

    private async handleWebviewMessage(rawMessage: unknown) {
        const message = normalizeReviewWebviewMessage(rawMessage);
        if (message === undefined) {
            this.logDiagnostic('webview_message_ignored', {
                type: typeof rawMessage === 'object' && rawMessage !== null
                    ? String((rawMessage as Record<string, unknown>).type ?? '')
                    : typeof rawMessage,
            });
            return;
        }

        switch (message.type) {
            case 'ready':
                this.ready = true;
                await this.refresh(this.resolveVisibilityRefreshReason());
                return;
            case 'refresh':
                await this.refresh('webview_refresh');
                return;
            case 'toggle-show-resolved':
                await this.setShowResolved(Boolean(message.showResolved));
                return;
            case 'navigate-thread':
                if (message.threadId) {
                    await this.navigateToThread(message.threadId);
                }
                return;
            case 'resolve-thread':
                if (message.threadId) {
                    await this.toggleThreadResolved(message.threadId);
                }
                return;
            case 'reopen-thread':
                if (message.threadId) {
                    await this.toggleThreadResolved(message.threadId);
                }
                return;
            case 'edit-comment':
                if (message.threadId && message.messageId) {
                    await this.editComment(message.threadId, message.messageId);
                }
                return;
            case 'delete-comment':
                if (message.threadId && message.messageId) {
                    await this.deleteComment(message.threadId, message.messageId);
                }
                return;
            case 'delete-thread':
                if (message.threadId) {
                    await this.deleteThread(message.threadId);
                }
                return;
            case 'reply-comment':
                if (message.threadId && typeof message.content==='string') {
                    await this.replyToThread(message.threadId, message.content);
                }
                return;
            default: {
                const unknownMessage = message as {type?: unknown};
                this.logDiagnostic('webview_message_unknown', {
                    type: typeof unknownMessage.type==='string' ? unknownMessage.type : 'unknown',
                });
            }
        }
    }

    private getHtml(webview: vscode.Webview) {
        const nonce = createNonce();
        const csp = [
            `default-src 'none'`,
            `base-uri 'none'`,
            `object-src 'none'`,
            `img-src data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
        ].join('; ');
        return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Overleaf Review</title>
    <style>
        :root {
            color-scheme: light dark;
        }
        html, body {
            height: 100%;
        }
        body {
            background: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            margin: 0;
        }
        .review-root {
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            gap: 12px;
            height: 100%;
            padding: 12px;
        }
        .review-toolbar {
            align-items: center;
            display: flex;
            justify-content: flex-start;
        }
        .review-toggle {
            align-items: center;
            color: var(--vscode-foreground);
            cursor: pointer;
            display: inline-flex;
            font-size: 0.92em;
            gap: 8px;
            user-select: none;
        }
        .review-toggle input {
            accent-color: var(--vscode-button-background);
            margin: 0;
        }
        .state {
            align-items: center;
            border: 1px dashed var(--vscode-panel-border);
            border-radius: 8px;
            color: var(--vscode-descriptionForeground);
            display: none;
            justify-content: center;
            min-height: 120px;
            padding: 16px;
            text-align: center;
        }
        .state.visible {
            display: flex;
        }
        .thread-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            overflow-y: auto;
            padding-right: 2px;
        }
        .thread-card {
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-editorWidget-border);
            border-radius: 10px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 12px;
        }
        .thread-card.resolved {
            opacity: 0.78;
        }
        .thread-main {
            cursor: pointer;
            display: flex;
            flex-direction: column;
            gap: 10px;
            min-width: 0;
            outline: none;
        }
        .thread-main:focus-visible {
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
            border-radius: 6px;
        }
        .thread-file-row {
            align-items: center;
            color: var(--vscode-descriptionForeground);
            display: flex;
            gap: 8px;
            justify-content: space-between;
        }
        .thread-file-path {
            align-items: center;
            display: inline-flex;
            min-height: 24px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .thread-header-actions {
            align-items: center;
            display: inline-flex;
            flex-shrink: 0;
            gap: 6px;
            margin-right: -4px;
            min-height: 24px;
        }
        .thread-badge {
            background: var(--vscode-badge-background);
            border-radius: 999px;
            color: var(--vscode-badge-foreground);
            font-size: 11px;
            padding: 2px 8px;
        }
        .thread-selection {
            color: var(--vscode-descriptionForeground);
            font-size: 0.92em;
            font-style: italic;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .message-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .reply-composer {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-top: 2px;
        }
        .reply-input {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
            border-radius: 8px;
            box-sizing: border-box;
            color: var(--vscode-input-foreground);
            font: inherit;
            line-height: 1.45;
            min-height: calc(1.45em + 16px);
            overflow: hidden;
            padding: 8px 10px;
            resize: none;
            width: 100%;
        }
        .reply-input::placeholder {
            color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
        }
        .reply-input:focus {
            border-color: var(--vscode-focusBorder);
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 0;
        }
        .reply-input:disabled {
            opacity: 0.8;
        }
        .message-item {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .message-item.reply {
            border-left: 1px solid var(--vscode-widget-border);
            margin-left: 18px;
            padding-left: 12px;
        }
        .message-header {
            align-items: center;
            display: flex;
            gap: 8px;
            justify-content: space-between;
        }
        .message-header-main {
            align-items: center;
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .author-tag {
            border: 1px solid rgba(255,255,255,0.22);
            border-radius: 999px;
            display: inline-block;
            height: 10px;
            width: 14px;
        }
        .author-name {
            font-weight: 600;
        }
        .timestamp {
            color: var(--vscode-descriptionForeground);
            font-size: 0.92em;
        }
        .message-body {
            line-height: 1.45;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .message-header-actions {
            align-items: center;
            display: flex;
            gap: 8px;
        }
        .resolved-indicator {
            border: 1px solid var(--vscode-widget-border);
            border-radius: 999px;
            color: var(--vscode-descriptionForeground);
            font-size: 0.8em;
            padding: 2px 8px;
        }
        .icon-button, .menu-button, .menu-item {
            background: transparent;
            border: 1px solid transparent;
            border-radius: 6px;
            color: var(--vscode-foreground);
            cursor: pointer;
            font: inherit;
        }
        .icon-button, .menu-button {
            min-height: 28px;
            min-width: 28px;
            padding: 4px 8px;
        }
        .icon-button:hover, .menu-button:hover, .menu-item:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .icon-button.resolved {
            background: transparent;
            color: var(--vscode-descriptionForeground);
        }
        .thread-menu {
            position: relative;
        }
        .message-menu .menu-button {
            min-height: 24px;
            min-width: 24px;
            padding: 2px 6px;
        }
        .thread-menu[open] .menu-button {
            background: var(--vscode-toolbar-activeBackground);
            border-color: var(--vscode-focusBorder);
        }
        .thread-menu summary {
            list-style: none;
        }
        .thread-header-actions .icon-button,
        .thread-header-actions .menu-button {
            align-items: center;
            display: inline-flex;
            justify-content: center;
            line-height: 1;
            min-height: 24px;
            min-width: 24px;
            padding: 2px 4px;
        }
        .thread-header-menu {
            display: inline-flex;
        }
        .thread-header-menu summary.menu-button {
            align-items: center;
            display: inline-flex;
            justify-content: center;
            line-height: 1;
        }
        .thread-menu summary::-webkit-details-marker {
            display: none;
        }
        .menu-popover {
            background: var(--vscode-menu-background);
            border: 1px solid var(--vscode-menu-border);
            border-radius: 8px;
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
            display: flex;
            flex-direction: column;
            gap: 2px;
            min-width: 120px;
            padding: 6px;
            position: absolute;
            right: 0;
            top: calc(100% + 6px);
            z-index: 10;
        }
        .menu-item {
            padding: 6px 8px;
            text-align: left;
        }
    </style>
</head>
<body>
    <div class="review-root">
        <div class="review-toolbar">
            <label class="review-toggle" for="show-resolved-toggle">
                <input id="show-resolved-toggle" type="checkbox" />
                <span>Show Resolved</span>
            </label>
        </div>
        <div id="empty-state" class="state">No active Overleaf comments in this project.</div>
        <div id="error-state" class="state"></div>
        <div id="thread-list" class="thread-list"></div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const showResolvedToggle = document.getElementById('show-resolved-toggle');
        const threadList = document.getElementById('thread-list');
        const emptyState = document.getElementById('empty-state');
        const errorState = document.getElementById('error-state');
        const state = {
            entries: [],
            error: '',
            focusThreadId: '',
            replyDrafts: {},
            replySubmittingThreads: {},
            showResolved: false,
        };

        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function getReplyDraft(threadId) {
            return state.replyDrafts[threadId] ?? '';
        }

        function setReplyDraft(threadId, value) {
            if (!threadId) {
                return;
            }
            if (value.length===0) {
                delete state.replyDrafts[threadId];
                return;
            }
            state.replyDrafts[threadId] = value;
        }

        function setReplySubmitting(threadId, submitting) {
            if (!threadId) {
                return;
            }
            if (!submitting) {
                delete state.replySubmittingThreads[threadId];
                return;
            }
            state.replySubmittingThreads[threadId] = true;
        }

        function findReplyInput(threadId) {
            return Array.from(threadList.querySelectorAll('.reply-input'))
                .find((element) => element.dataset.threadId===threadId);
        }

        function autoResizeReplyInput(input) {
            input.style.height = 'auto';
            input.style.height = input.scrollHeight + 'px';
        }

        function syncReplyInputs() {
            Array.from(threadList.querySelectorAll('.reply-input')).forEach((input) => {
                autoResizeReplyInput(input);
            });
        }

        function focusReplyInput(threadId) {
            if (!threadId) {
                return;
            }
            const input = findReplyInput(threadId);
            if (!input) {
                state.focusThreadId = '';
                return;
            }
            requestAnimationFrame(() => {
                input.focus();
                const cursorPosition = input.value.length;
                input.setSelectionRange(cursorPosition, cursorPosition);
                autoResizeReplyInput(input);
            });
        }

        function getOpenMenus() {
            return Array.from(threadList.querySelectorAll('.thread-menu[open]'));
        }

        function closeMenus(exceptMenu) {
            getOpenMenus().forEach((menu) => {
                if (exceptMenu && menu===exceptMenu) {
                    return;
                }
                menu.removeAttribute('open');
            });
        }

        function insertReplyNewline(input) {
            const selectionStart = input.selectionStart ?? input.value.length;
            const selectionEnd = input.selectionEnd ?? input.value.length;
            const nextValue = input.value.slice(0, selectionStart) + '\\n' + input.value.slice(selectionEnd);
            input.value = nextValue;
            setReplyDraft(input.dataset.threadId, nextValue);
            autoResizeReplyInput(input);
            const nextCursorPosition = selectionStart + 1;
            requestAnimationFrame(() => {
                input.focus();
                input.setSelectionRange(nextCursorPosition, nextCursorPosition);
            });
        }

        function submitReply(threadId) {
            const draft = getReplyDraft(threadId);
            if (!threadId || state.replySubmittingThreads[threadId] || draft.trim().length===0) {
                return;
            }
            state.focusThreadId = threadId;
            setReplySubmitting(threadId, true);
            const replyInput = findReplyInput(threadId);
            if (replyInput) {
                replyInput.disabled = true;
            }
            vscode.postMessage({
                type: 'reply-comment',
                content: draft,
                threadId,
            });
        }

        function renderMessage(message, entry) {
            const menuItems = [];
            if (!message.isRoot && message.canEdit) {
                menuItems.push('<button class="menu-item" data-action="edit-comment">Edit</button>');
            }
            if (!message.isRoot && message.canDelete) {
                menuItems.push('<button class="menu-item" data-action="delete-comment">Delete</button>');
            }
            return [
                '<div class="message-item ' + (message.isRoot ? 'root' : 'reply') + '" data-message-id="' + escapeHtml(message.id) + '">',
                    '<div class="message-header">',
                        '<span class="message-header-main">',
                            '<span class="author-tag" style="background:' + escapeHtml(message.userColor) + ';"></span>',
                            '<span class="author-name">' + escapeHtml(message.authorName) + '</span>',
                            '<span class="timestamp">' + escapeHtml(message.timestamp) + '</span>',
                        '</span>',
                        ((message.isRoot && entry.resolved) || menuItems.length > 0
                            ? [
                                '<span class="message-header-actions">',
                                    (message.isRoot && entry.resolved ? '<span class="resolved-indicator">Resolved</span>' : ''),
                                    (menuItems.length > 0
                                        ? [
                                            '<details class="thread-menu message-menu" data-stop-navigation="true">',
                                                '<summary class="menu-button" role="button" aria-label="More actions" data-stop-navigation="true">⋯</summary>',
                                                '<div class="menu-popover">',
                                                    menuItems.join(''),
                                                '</div>',
                                            '</details>',
                                        ].join('')
                                        : ''),
                                '</span>',
                            ].join('')
                            : ''),
                    '</div>',
                    '<div class="message-body">' + escapeHtml(message.content) + '</div>',
                '</div>',
            ].join('');
        }

        function renderThread(entry) {
            const rootMessage = entry.messages.find((message) => message.isRoot) ?? entry.messages[0];
            const replyDraft = getReplyDraft(entry.threadId);
            const isReplySubmitting = Boolean(state.replySubmittingThreads[entry.threadId]);
            const rootMenuItems = [];
            if (rootMessage?.canEdit) {
                rootMenuItems.push('<button class="menu-item" data-action="edit-comment">Edit</button>');
            }
            if (rootMessage?.canDelete) {
                rootMenuItems.push('<button class="menu-item" data-action="delete-thread">Delete</button>');
            }
            const threadResolveButton = entry.canResolveThread
                ? '<button class="icon-button thread-resolve-button ' + (entry.resolved ? 'resolved' : '') + '" type="button" title="' + escapeHtml(entry.resolved ? 'Reopen Comment Thread' : 'Resolve Comment Thread') + '" aria-label="' + escapeHtml(entry.resolved ? 'Reopen Comment Thread' : 'Resolve Comment Thread') + '" data-action="' + escapeHtml(entry.resolved ? 'reopen-thread' : 'resolve-thread') + '">✓</button>'
                : '';
            const messagesHtml = entry.messages.map((message) => renderMessage(message, entry)).join('');

            return [
                '<article class="thread-card ' + (entry.resolved ? 'resolved' : '') + '" data-thread-id="' + escapeHtml(entry.threadId) + '">',
                    '<div class="thread-main" role="button" tabindex="0" data-thread-action="navigate-thread">',
                        '<div class="thread-file-row">',
                            '<span class="thread-file-path" title="' + escapeHtml(entry.filePath) + ':' + String(entry.rangeStart.line + 1) + '">' + escapeHtml(entry.filePath) + ':' + String(entry.rangeStart.line + 1) + '</span>',
                            ((threadResolveButton || rootMenuItems.length > 0) && rootMessage
                                ? [
                                    '<span class="thread-header-actions" data-message-id="' + escapeHtml(rootMessage.id) + '">',
                                        threadResolveButton,
                                        (rootMenuItems.length > 0
                                            ? [
                                                '<details class="thread-menu message-menu thread-header-menu" data-stop-navigation="true">',
                                                    '<summary class="menu-button" role="button" aria-label="More actions" data-stop-navigation="true">⋯</summary>',
                                                    '<div class="menu-popover">',
                                                        rootMenuItems.join(''),
                                                    '</div>',
                                                '</details>',
                                            ].join('')
                                            : ''),
                                    '</span>',
                                ].join('')
                                : ''),
                        '</div>',
                        '<div class="thread-selection" title="' + escapeHtml(entry.selectedText) + '">' + escapeHtml(entry.headerPreview ?? entry.selectedText) + '</div>',
                        '<div class="message-list">' + messagesHtml + '</div>',
                        (entry.canReply && !entry.resolved
                            ? [
                                '<div class="reply-composer" data-stop-navigation="true">',
                                    '<textarea class="reply-input" data-stop-navigation="true" data-thread-id="' + escapeHtml(entry.threadId) + '" placeholder="Reply" rows="1"' + (isReplySubmitting ? ' disabled' : '') + '>' + escapeHtml(replyDraft) + '</textarea>',
                                '</div>',
                            ].join('')
                            : ''),
                    '</div>',
                '</article>',
            ].join('');
        }

        function render() {
            const previousScrollTop = threadList.scrollTop;
            if (state.error) {
                errorState.textContent = state.error;
                errorState.classList.add('visible');
                emptyState.classList.remove('visible');
                threadList.innerHTML = '';
                return;
            }
            errorState.classList.remove('visible');
            emptyState.textContent = state.showResolved
                ? 'No Overleaf comments in this project yet.'
                : 'No active Overleaf comments in this project.';
            if (state.entries.length === 0) {
                emptyState.classList.add('visible');
                threadList.innerHTML = '';
                return;
            }
            emptyState.classList.remove('visible');
            threadList.innerHTML = state.entries.map(renderThread).join('');
            threadList.scrollTop = previousScrollTop;
            syncReplyInputs();
            focusReplyInput(state.focusThreadId);
        }

        window.addEventListener('message', (event) => {
            const message = event.data;
            switch (message.type) {
                case 'render-review':
                    state.entries = message.content.entries ?? [];
                    state.error = '';
                    state.showResolved = Boolean(message.content.showResolved);
                    showResolvedToggle.checked = state.showResolved;
                    render();
                    break;
                case 'reply-comment-result':
                    if (!message.content?.threadId) {
                        break;
                    }
                    setReplySubmitting(message.content.threadId, false);
                    if (message.content.success) {
                        setReplyDraft(message.content.threadId, '');
                        state.focusThreadId = message.content.threadId;
                    }
                    render();
                    break;
                case 'review-error':
                    state.error = message.content.message ?? 'Unable to load Overleaf review threads.';
                    render();
                    break;
                default:
                    break;
            }
        });

        document.addEventListener('click', (event) => {
            const openMenu = event.target.closest('.thread-menu');
            if (!openMenu) {
                closeMenus();
            } else {
                closeMenus(openMenu);
            }

            const actionElement = event.target.closest('[data-action]');
            if (actionElement) {
                const threadCard = actionElement.closest('.thread-card');
                const messageContext = actionElement.closest('[data-message-id]');
                if (!threadCard) {
                    return;
                }
                const threadId = threadCard.dataset.threadId;
                const messageId = messageContext?.dataset.messageId;
                const action = actionElement.dataset.action;
                if (!threadId || !action) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                closeMenus();
                vscode.postMessage({ type: action, messageId, threadId });
                return;
            }
            if (event.target.closest('[data-stop-navigation="true"]')) {
                event.stopPropagation();
                return;
            }

            const navigationElement = event.target.closest('[data-thread-action="navigate-thread"]');
            const threadCard = navigationElement?.closest('.thread-card');
            const threadId = threadCard?.dataset.threadId;
            if (!threadId) {
                return;
            }
            event.preventDefault();
            vscode.postMessage({ type: 'navigate-thread', threadId });
        });

        document.addEventListener('keydown', (event) => {
            if (event.key==='Escape') {
                const openMenus = getOpenMenus();
                if (openMenus.length > 0) {
                    event.preventDefault();
                    event.stopPropagation();
                    closeMenus();
                    return;
                }
            }
            const replyInput = event.target.closest('.reply-input');
            if (replyInput) {
                if (event.key==='Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    insertReplyNewline(replyInput);
                    return;
                }
                if (event.key==='Enter') {
                    event.preventDefault();
                    submitReply(replyInput.dataset.threadId);
                    return;
                }
            }
            if (event.target.closest('[data-stop-navigation="true"]')) {
                return;
            }
            const actionElement = event.target.closest('[data-thread-action="navigate-thread"]');
            if (!actionElement) {
                return;
            }
            if (event.key !== 'Enter' && event.key !== ' ') {
                return;
            }
            const threadCard = actionElement.closest('.thread-card');
            const threadId = threadCard?.dataset.threadId;
            if (!threadId) {
                return;
            }
            event.preventDefault();
            vscode.postMessage({ type: 'navigate-thread', threadId });
        });

        document.addEventListener('input', (event) => {
            const replyInput = event.target.closest('.reply-input');
            if (!replyInput) {
                return;
            }
            setReplyDraft(replyInput.dataset.threadId, replyInput.value);
            autoResizeReplyInput(replyInput);
        });

        showResolvedToggle.addEventListener('change', (event) => {
            vscode.postMessage({
                type: 'toggle-show-resolved',
                showResolved: event.target.checked,
            });
        });

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext<unknown>,
        token: vscode.CancellationToken,
    ): Thenable<void> {
        this.webviewView = webviewView;
        ReviewViewProvider.resolvedProvidersByOrigin.set(this.originKey, this);
        this.ready = false;
        webviewView.webview.options = {enableScripts: true, localResourceRoots: []};
        webviewView.webview.html = this.getHtml(webviewView.webview);
        this.logDiagnostic('webview.resolved');
        webviewView.webview.onDidReceiveMessage((message) => {
            void this.handleWebviewMessage(message);
        });
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                ReviewViewProvider.resolvedProvidersByOrigin.set(this.originKey, this);
            }
            this.logDiagnostic('webview.visibility_changed', {visible: webviewView.visible});
            if (webviewView.visible) {
                const refreshReason = this.resolveVisibilityRefreshReason();
                this.logDiagnostic('webview.visibility_refresh_requested', {
                    needsRefresh: this.needsRefresh,
                    pendingRefreshReason: this.pendingRefreshReason ?? '',
                    refreshReason,
                });
                void this.refresh(refreshReason);
            }
        });
        return Promise.resolve();
    }

    get triggers() {
        return [
            this.reviewDiagnosticsStateRegistration,
            EventBus.on('reviewLocalMutationEvent', (mutation) => {
                if (mutation.origin!==this.vfs.origin.toString()) {
                    this.logDiagnostic('local_mutation_event_ignored_unmatched_origin', {
                        kind: mutation.kind,
                        messageId: mutation.messageId,
                        origin: mutation.origin,
                        threadId: mutation.threadId,
                    });
                    return;
                }
                this.applyLocalMutation(mutation);
            }),
            EventBus.on('reviewThreadProjectionEvent', (projection) => {
                if (projection.origin!==this.vfs.origin.toString()) {
                    this.logDiagnostic('local_projection_event_ignored_unmatched_origin', {
                        messageId: projection.messageId ?? '',
                        origin: projection.origin,
                        threadId: projection.threadId,
                    });
                    return;
                }
                this.applyProjectedThreadEntry({
                    entry: projection.entry as OverleafReviewThreadEntry | undefined,
                    messageId: projection.messageId,
                    threadId: projection.threadId,
                });
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.applyLocalMutation`, (options?: unknown) => {
                const normalized = this.normalizeLocalMutationCommandOptions(options);
                if (!normalized) {
                    this.logDiagnostic('local_mutation_skipped_invalid_payload');
                    return;
                }
                if (normalized.origin && normalized.origin!==this.vfs.origin.toString()) {
                    this.logDiagnostic('local_mutation_ignored_unmatched_origin', {
                        kind: normalized.kind,
                        messageId: normalized.messageId,
                        origin: normalized.origin,
                        threadId: normalized.threadId,
                    });
                    return;
                }
                this.applyLocalMutation(normalized);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.review.refresh`, (options?: unknown) => {
                const normalized = this.normalizeRefreshCommandOptions(options);
                if (normalized.origin && normalized.origin!==this.vfs.origin.toString()) {
                    this.logDiagnostic('refresh_ignored_unmatched_origin', {
                        origin: normalized.origin,
                        reason: normalized.reason,
                    });
                    return;
                }
                this.scheduleRefresh(normalized.reason, {
                    docIds: normalized.docIds,
                    immediate: normalized.immediate,
                });
            }),
            vscode.window.registerWebviewViewProvider(`${ROOT_NAME}.reviewWebview`, this, {
                webviewOptions: {retainContextWhenHidden: true},
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (didCommentUserPaletteChange(event)) {
                    this.scheduleRefresh('comment_color_configuration_changed');
                }
            }),
            EventBus.on('commentsChangedEvent', ({origin, reason, sequence, emittedAtMs, docIds, threadIds}) => {
                if (origin!==this.vfs.origin.toString()) {
                    return;
                }
                if (shouldDeferThreadOnlyCommentCreateChange({
                    docIds: docIds ?? [],
                    hasPreviousThread: false,
                    reason,
                })) {
                    this.logDiagnostic('refresh_deferred_for_thread_only_create_event', {
                        reason,
                        sequence: sequence ?? -1,
                        threadCount: threadIds?.length ?? 0,
                    });
                    return;
                }
                const receivedAtMs = Date.now();
                const emittedAt = emittedAtMs ?? receivedAtMs;
                this.pendingCommentsChangedLatencySamples.push({
                    docCount: docIds?.length ?? 0,
                    emittedAtMs: emittedAt,
                    reason,
                    receivedAtMs,
                    sequence: sequence ?? -1,
                    threadCount: threadIds?.length ?? 0,
                });
                if (this.pendingCommentsChangedLatencySamples.length > 20) {
                    this.pendingCommentsChangedLatencySamples.splice(0, this.pendingCommentsChangedLatencySamples.length - 20);
                }
                this.scheduleRefresh(`comments_changed:${reason}`, {
                    docIds,
                    immediate: true,
                });
            }),
            EventBus.on('realtimeConnectionStateChangedEvent', ({origin, phase, reason}) => {
                if (origin!==this.vfs.origin.toString()) {
                    return;
                }
                this.scheduleRefresh(`realtime_state_changed:${phase}:${reason}`, {
                    immediate: phase==='live',
                });
            }),
            EventBus.on('offlineSynchronizationStateChangedEvent', ({origin, mode, reason}) => {
                if (origin!==this.vfs.origin.toString()) {
                    return;
                }
                this.scheduleRefresh(`offline_state_changed:${mode}:${reason}`, {
                    immediate: mode==='online',
                });
            }),
        ];
    }
}
