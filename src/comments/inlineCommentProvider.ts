import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { parseUri, RemoteFileSystemProvider, VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';
import {
    collectDiagnosticSnapshot,
    createDiagnosticTraceContext,
    logDiagnostic,
    registerDiagnosticStateProvider,
    sanitizeDiagnosticPayload,
    startDiagnosticSpan,
    withDiagnosticTraceFields,
} from '../utils/diagnostics';
import {
    getCommentDiagnosticsRuntimeConfiguration,
    logCommentDiagnostics,
} from './commentDiagnostics';
import {
    buildCommentThreadParityByDocId,
    summarizeInlineCommentSnapshot,
} from './commentDebugParity';
import { shouldSkipBuiltInCommentLineFocus } from './commentFocusPolicy';
import {
    applyTextOperationsToCommentRanges,
    cloneCommentRange,
    generateCommentThreadId,
    OverleafTextOperation,
    resolveCommentThreadAnchorLine,
} from './commentRanges';
import {
    getConfiguredCommentUserPalette,
    didCommentUserPaletteChange,
    ResolvedCommentUserPalette,
} from './commentColorConfiguration';
import {
    resolveCommentUserColorByIndex,
    resolveCommentUserIdentifier,
} from './commentColors';
import {
    PendingCommentRefreshSuppression,
    shouldForceRemoteCommentThreadRebuild,
    shouldSuppressCommentRefresh,
} from './commentRefreshPolicy';
import {
    resolveCommentsOpenViewSuppressionDecision,
    shouldSuppressStartupPanelAfterRender,
} from './commentPanelAutoOpenPolicy';
import { formatCommentThreadPreview } from './commentThreadPreview';
import { dedupeDocumentCommentSnapshotThreadsByThreadId } from './commentThreads';
import {
    resolveCommentThreadDisplayRange,
    resolveCommentThreadExtentRange,
    resolveViewportAdjustedCommentThreadRange,
    shouldPinCommentThreadToStartAnchor,
} from './commentThreadAnchorPolicy';
import {
    areStableCommentRenderListsEqual,
    collapseExpandedCommentThreads,
} from './commentThreadState';
import { formatOverleafCommentTimestamp } from './commentTimestamps';
import { shouldTreatCommentsChangedRefreshAsProjectWide } from './reviewSyncPolicy';
import { ReviewViewProvider } from './reviewViewProvider';
import {
    LOCAL_REPLICA_SETTINGS_DIR_NAME,
    LOCAL_REPLICA_SETTINGS_FILE_NAME,
} from '../scm/localReplicaWorkspace';
import {
    type ProjectDocumentBinding,
    resolveActiveProjectWorkspaceBinding,
    resolveProjectDocumentBinding,
    resolveProjectWorkspaceModeForUri,
} from '../core/projectWorkspaceBinding';
import {
    OverleafCommentMessage,
    OverleafCommentPermissions,
    OverleafCommentRange,
    OverleafDocumentCommentSnapshot,
    OverleafCommentThread,
} from './types';

type OverleafCommentThreadHandle = vscode.CommentThread & {
    overleafDisplayBaseRange?: vscode.Range,
    overleafDocId?: string,
    overleafDraftId?: string,
    overleafOptimisticCreateThreadId?: string,
    overleafPinnedToStartAnchor?: boolean,
    overleafPendingEndOffset?: number,
    overleafPendingSelection?: vscode.Selection,
    overleafPendingSelectedText?: string,
    overleafPendingStartOffset?: number,
    overleafUri?: vscode.Uri,
    overleafThreadId?: string,
};

type OverleafVSCodeComment = vscode.Comment & {
    overleafMessageId?: string,
    overleafRenderUri?: vscode.Uri,
    overleafThreadId?: string,
    overleafUri?: vscode.Uri,
    overleafUserId?: string,
};

interface OverleafThreadPermissionsHandle {
    canDeleteComment: (messageUserId: string | undefined) => boolean;
    canDeleteThread: boolean;
    canEditComment: (messageUserId: string | undefined) => boolean;
    canResolveThread: boolean;
    currentUserId: string | undefined;
    permissions: OverleafCommentPermissions;
}

interface AddCommentCommandContext {
    editor: vscode.TextEditor;
    nonEmptySelectionCount: number;
    selectionSource: 'explicitRange' | 'primarySelection' | 'additionalSelection';
    selection: vscode.Selection;
    uri: vscode.Uri;
}

type CommentUriBinding = ProjectDocumentBinding;

interface PendingLocalReplicaDraftContext {
    createdAt: number;
    draftId: string;
    endOffset: number;
    selection: vscode.Selection;
    selectedText: string;
    startOffset: number;
}

interface PendingLocalReplicaCommentingRangeState {
    expiresAt: number;
    ranges: vscode.Range[];
}

interface PendingCreatedCommentFocusRequest {
    createdAt: number;
    reason: string;
    requestId: number;
    selection: vscode.Selection;
    snapshotThreadCountBeforeCreate: number;
}

const LOCAL_REPLICA_ADD_COMMENT_SUPPORTED_EDITOR_CONTEXT = `${ROOT_NAME}.comments.localReplicaSupportedEditor`;
const LOCAL_REPLICA_ADD_COMMENT_SELECTION_CONTEXT = `${ROOT_NAME}.comments.localReplicaHasSelection`;
const INLINE_PROVIDER_GLOBAL_KEY = '__overleafInlineCommentProvider';

type InlineCommentProviderGlobalHandle = {
    dispose: (reason: string) => void,
    provider: unknown,
};

function getGlobalInlineCommentProviderHandle() {
    const globalState = globalThis as typeof globalThis & {
        [INLINE_PROVIDER_GLOBAL_KEY]?: InlineCommentProviderGlobalHandle,
    };
    return globalState[INLINE_PROVIDER_GLOBAL_KEY];
}

function setGlobalInlineCommentProviderHandle(handle: InlineCommentProviderGlobalHandle | undefined) {
    const globalState = globalThis as typeof globalThis & {
        [INLINE_PROVIDER_GLOBAL_KEY]?: InlineCommentProviderGlobalHandle,
    };
    if (!handle) {
        delete globalState[INLINE_PROVIDER_GLOBAL_KEY];
        return;
    }
    globalState[INLINE_PROVIDER_GLOBAL_KEY] = handle;
}

function describeCommentAuthor(message: OverleafCommentMessage) {
    const user = message.user;
    const name = user?.name
        ?? [user?.first_name, user?.last_name].filter(Boolean).join(' ')
        ?? user?.email
        ?? message.user_id;
    return {
        iconPath: undefined,
        name,
    };
}

function buildCommentContextValue(
    permissions: OverleafCommentPermissions & {
        canDeleteComment?: boolean,
        canEditComment?: boolean,
    },
    messageUserId: string | undefined,
    currentUserId: string | undefined,
    options?: {
        canResolveThread?: boolean,
        isThreadRoot?: boolean,
    },
) {
    const canEdit = Boolean(permissions.canEditComment && currentUserId && messageUserId && currentUserId===messageUserId);
    const canDelete = Boolean(permissions.canDeleteComment);
    const contextFlags = ['overleafComment', options?.isThreadRoot ? 'root' : 'reply'];
    if (Boolean(options?.canResolveThread && options?.isThreadRoot)) {
        contextFlags.push('rootResolvable');
    }
    if (canEdit) {
        contextFlags.push('editable');
    }
    if (canDelete) {
        contextFlags.push('deletable');
    }
    if (!canEdit && !canDelete) {
        contextFlags.push('readonly');
    }
    return contextFlags.join(' ');
}

function buildThreadContextValue(canResolveThread: boolean) {
    return canResolveThread ? 'overleafThreadUnresolved' : 'overleafThreadReadonly';
}

export class InlineCommentProvider {
    private static activeProvider?: InlineCommentProvider;
    private static providerInstanceSequence = 0;
    private static readonly AUTHOR_BADGE_HEIGHT_PX = 10;
    private static readonly AUTHOR_BADGE_RECT_HEIGHT_PX = 8;
    private static readonly AUTHOR_BADGE_RECT_WIDTH_PX = 12;
    private static readonly AUTHOR_BADGE_RECT_X_PX = 1;
    private static readonly AUTHOR_BADGE_RECT_Y_PX = 1;
    private static readonly AUTHOR_BADGE_WIDTH_PX = 14;
    private static readonly LOCAL_REPLICA_COMMENTING_RANGE_TIMEOUT_MS = 1500;
    private static readonly LOCAL_REPLICA_DRAFT_TIMEOUT_MS = 120000;
    private static readonly PENDING_CREATED_THREAD_FOCUS_TIMEOUT_MS = 30000;
    private static readonly REPLY_REFRESH_SUPPRESSION_TIMEOUT_MS = 250;
    private static readonly STARTUP_PANEL_SUPPRESSION_DELAY_MS = 75;
    private static readonly STARTUP_PANEL_SUPPRESSION_REPEAT_DELAY_MS = 175;
    private static readonly STARTUP_PANEL_SUPPRESSION_MAX_ATTEMPTS = 4;
    private static readonly STARTUP_PANEL_SUPPRESSION_WINDOW_MS = 30000;
    private static readonly INLINE_COMMENT_CLICK_FOCUS_DELAY_MS = 90;
    private static readonly createdThreadFocusStabilizationDelayMs = 90;
    private static readonly RENDERED_THREAD_EXPANSION_FOCUS_SCAN_INTERVAL_MS = 125;
    private static readonly commentThreadFocusMaxAttempts = 6;
    private static readonly commentThreadFocusRetryDelayMs = 60;
    private static readonly TRANSIENT_REHYDRATION_MAX_RETRIES = 4;
    private static readonly TRANSIENT_REHYDRATION_RETRY_DELAY_MS = 100;
    private readonly controller = vscode.comments.createCommentController(`${ROOT_NAME}.comments`, 'Overleaf Comments');
    private readonly unresolvedDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.commentForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    private readonly resolvedDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
        overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.commentForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        opacity: '0.55',
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    private readonly threadsByUri = new Map<string, Map<string, OverleafCommentThreadHandle>>();
    private readonly createdThreadHandlesByUri = new Map<string, Set<OverleafCommentThreadHandle>>();
    private readonly snapshotsByUri = new Map<string, OverleafDocumentCommentSnapshot>();
    private readonly transientRangesByUri = new Map<string, OverleafCommentRange[]>();
    private readonly overleafUriByRenderUri = new Map<string, string>();
    private readonly renderQueueByUri = new Map<string, Promise<void>>();
    private readonly renderSequenceByUri = new Map<string, number>();
    private readonly refreshPromises = new Map<string, Promise<void>>();
    private readonly queuedSyncReasonsByUri = new Map<string, Set<string>>();
    private readonly suppressedReplyRefreshByUri = new Map<string, PendingCommentRefreshSuppression & {
        timeout: ReturnType<typeof setTimeout>,
    }>();
    private readonly authorBadgeIconByColor = new Map<string, vscode.Uri>();
    private readonly commentUserColorsByDocId = new Map<string, Map<string, string>>();
    private readonly pendingCreatedCommentFocusByUri = new Map<string, PendingCreatedCommentFocusRequest[]>();
    private readonly pendingLocalReplicaDraftsByUri = new Map<string, PendingLocalReplicaDraftContext[]>();
    private readonly temporaryLocalReplicaCommentingRangesByUri = new Map<string, PendingLocalReplicaCommentingRangeState>();
    private readonly commentsChangedObservationBySequence = new Map<string, {
        count: number,
        firstObservedAtMs: number,
        lastObservedAtMs: number,
    }>();
    private readonly threadHandleIds = new WeakMap<OverleafCommentThreadHandle, number>();
    private readonly collapsibleStateByUriThreadId = new Map<string, number>();
    private readonly lifecycleObservationByUriThreadId = new Map<string, {
        createCount: number,
        disposeCount: number,
        renderCount: number,
        reuseCount: number,
    }>();
    private readonly recentCommentDebugEvents: Array<Record<string, unknown>> = [];
    private readonly inlineDiagnosticsStateRegistration: {dispose: () => void};
    private commentUserPalette: ResolvedCommentUserPalette = getConfiguredCommentUserPalette();
    private commentCommandContextSequence = 0;
    private readonly startupPanelSuppressionExpiresAtMs = Date.now()
        + InlineCommentProvider.STARTUP_PANEL_SUPPRESSION_WINDOW_MS;
    private externallyExpandedThreadFocusScanInFlight = false;
    private initialCommentsOpenViewSuppressionSettled = false;
    private startupPanelSuppressionTimer?: ReturnType<typeof setTimeout>;
    private inlineCommentClickFocusTimer?: ReturnType<typeof setTimeout>;
    private renderedThreadExpansionFocusScanTimer?: ReturnType<typeof setInterval>;
    private pendingCreatedCommentFocusRequestSequence = 0;
    private threadHandleSequence = 0;
    private readonly initialCommentsOpenViewSuppression: Promise<void>;
    private initialVisibleEditorsSyncTimer?: ReturnType<typeof setTimeout>;
    private localReplicaDraftThreadSequence = 0;
    private providerDisposed = false;
    private readonly providerInstanceId = ++InlineCommentProvider.providerInstanceSequence;
    private triggerRegistrations?: vscode.Disposable[];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly vfsm: RemoteFileSystemProvider,
        ) {
            const globalActiveProvider = getGlobalInlineCommentProviderHandle();
        if (globalActiveProvider && !Object.is(globalActiveProvider.provider, this)) {
            globalActiveProvider.dispose('superseded_by_new_provider_instance_global');
        }
            if (InlineCommentProvider.activeProvider && InlineCommentProvider.activeProvider!==this) {
            InlineCommentProvider.activeProvider.disposeSupersededProvider('superseded_by_new_provider_instance');
        }
        InlineCommentProvider.activeProvider = this;
        setGlobalInlineCommentProviderHandle({
            dispose: (reason: string) => this.disposeSupersededProvider(reason),
            provider: this,
        });
            this.controller.options = {
            placeHolder: vscode.l10n.t('Reply'),
            prompt: vscode.l10n.t('Reply'),
        };
        this.resetCommentingRangeProvider('initialize');
        this.initialCommentsOpenViewSuppression = this.suppressAutomaticCommentsPanelActivation('initialize')
            .finally(() => {
                this.initialCommentsOpenViewSuppressionSettled = true;
            });
        this.inlineDiagnosticsStateRegistration = registerDiagnosticStateProvider('inlineComments', () => this.collectInlineDiagnosticsState());
        this.renderedThreadExpansionFocusScanTimer = setInterval(() => {
            if (this.externallyExpandedThreadFocusScanInFlight) {
                return;
            }
            this.externallyExpandedThreadFocusScanInFlight = true;
            void this.scanForExternallyExpandedThreads()
                .finally(() => {
                    this.externallyExpandedThreadFocusScanInFlight = false;
                });
        }, InlineCommentProvider.RENDERED_THREAD_EXPANSION_FOCUS_SCAN_INTERVAL_MS);
        if (this.commentUserPalette.usedDefaultPalette) {
            this.logDiagnostic('color_palette_invalid_configuration', {
                configuredItemCount: this.commentUserPalette.configuredItemCount,
                paletteSize: this.commentUserPalette.palette.length,
            });
        }
        this.logTrace('provider.instance_initialized', {
            providerInstanceId: this.providerInstanceId,
        });
    }

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('InlineComments', event, {
            commentSubsystem: 'comments:inline',
            providerDisposed: this.providerDisposed,
            providerInstanceId: this.providerInstanceId,
            ...fields,
        }, error);
    }

    private logTrace(event: string, fields: Record<string, unknown> = {}) {
        logCommentDiagnostics('InlineComments', 'lifecycle', event, {
            providerDisposed: this.providerDisposed,
            providerInstanceId: this.providerInstanceId,
            ...fields,
        });
    }

    private recordCommentDebugEvent(event: string, fields: Record<string, unknown> = {}) {
        this.recentCommentDebugEvents.push({
            event,
            providerDisposed: this.providerDisposed,
            providerInstanceId: this.providerInstanceId,
            recordedAt: new Date().toISOString(),
            ...fields,
        });
        if (this.recentCommentDebugEvents.length > 120) {
            this.recentCommentDebugEvents.splice(0, this.recentCommentDebugEvents.length - 120);
        }
    }

    private formatSelectionForDiagnostics(selection: vscode.Selection) {
        return {
            selectionEnd: `${selection.end.line}:${selection.end.character}`,
            selectionStart: `${selection.start.line}:${selection.start.character}`,
        };
    }

    private getRecentCommentDebugEventsMatching(matcher: (event: string) => boolean) {
        return this.recentCommentDebugEvents.filter((entry) => {
            return typeof entry.event === 'string' && matcher(entry.event);
        });
    }

    private collectPendingCreatedCommentFocusDiagnosticsState() {
        const now = Date.now();
        const pendingByUri = Array.from(this.pendingCreatedCommentFocusByUri.entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([uriKey, requests]) => {
                const activeRequests = requests
                    .filter((candidate) => {
                        return now - candidate.createdAt <= InlineCommentProvider.PENDING_CREATED_THREAD_FOCUS_TIMEOUT_MS;
                    })
                    .sort((left, right) => left.createdAt - right.createdAt)
                    .map((candidate) => ({
                        ageMs: Math.max(0, now - candidate.createdAt),
                        createdAt: new Date(candidate.createdAt).toISOString(),
                        reason: candidate.reason,
                        requestId: candidate.requestId,
                        snapshotThreadCountBeforeCreate: candidate.snapshotThreadCountBeforeCreate,
                        ...this.formatSelectionForDiagnostics(candidate.selection),
                    }));
                const staleRequestCount = Math.max(0, requests.length - activeRequests.length);
                if (activeRequests.length===0 && staleRequestCount===0) {
                    return undefined;
                }
                return {
                    activeRequestCount: activeRequests.length,
                    requests: activeRequests,
                    staleRequestCount,
                    uri: uriKey,
                };
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry!==undefined);
        return {
            pendingRequestCount: pendingByUri.reduce((total, entry) => total + entry.activeRequestCount, 0),
            pendingUriCount: pendingByUri.filter((entry) => entry.activeRequestCount > 0).length,
            pendingByUri,
            staleRequestCount: pendingByUri.reduce((total, entry) => total + entry.staleRequestCount, 0),
            timeoutMs: InlineCommentProvider.PENDING_CREATED_THREAD_FOCUS_TIMEOUT_MS,
        };
    }

    private collectPanelSuppressionDiagnosticsState() {
        const now = Date.now();
        return {
            initialCommentsOpenViewSuppressionSettled: this.initialCommentsOpenViewSuppressionSettled,
            startup: {
                delayMs: InlineCommentProvider.STARTUP_PANEL_SUPPRESSION_DELAY_MS,
                expiresAt: new Date(this.startupPanelSuppressionExpiresAtMs).toISOString(),
                maxAttempts: InlineCommentProvider.STARTUP_PANEL_SUPPRESSION_MAX_ATTEMPTS,
                remainingWindowMs: Math.max(0, this.startupPanelSuppressionExpiresAtMs - now),
                repeatDelayMs: InlineCommentProvider.STARTUP_PANEL_SUPPRESSION_REPEAT_DELAY_MS,
                timerActive: Boolean(this.startupPanelSuppressionTimer),
                windowMs: InlineCommentProvider.STARTUP_PANEL_SUPPRESSION_WINDOW_MS,
            },
        };
    }

    private collectCommentInteractionDiagnosticsState() {
        const recentPendingFocusEvents = this.getRecentCommentDebugEventsMatching((event) => {
            return event.startsWith('comment_thread.pending_focus')
                || event==='create_comment_thread.inline_focus_completed'
                || event==='create_comment_thread.inline_focus_deferred_to_pending_request';
        });
        const recentPanelSuppressionEvents = this.getRecentCommentDebugEventsMatching((event) => {
            return event.startsWith('comments_panel_auto_open');
        });
        return {
            panelSuppression: this.collectPanelSuppressionDiagnosticsState(),
            pendingCreatedCommentFocus: this.collectPendingCreatedCommentFocusDiagnosticsState(),
            recentCreateFocusEventCount: recentPendingFocusEvents.length,
            recentCreateFocusEvents: recentPendingFocusEvents.slice(-40),
            recentPanelSuppressionEventCount: recentPanelSuppressionEvents.length,
            recentPanelSuppressionEvents: recentPanelSuppressionEvents.slice(-40),
        };
    }

    private toLifecycleObservationKey(uriKey: string, threadId: string) {
        return `${uriKey}\u0000${threadId}`;
    }

    private recordLifecycleObservation(
        uriKey: string,
        threadId: string,
        event: 'create' | 'dispose' | 'render' | 'reuse',
        fields: Record<string, unknown> = {},
    ) {
        const key = this.toLifecycleObservationKey(uriKey, threadId);
        const previous = this.lifecycleObservationByUriThreadId.get(key) ?? {
            createCount: 0,
            disposeCount: 0,
            renderCount: 0,
            reuseCount: 0,
        };
        const next = {
            ...previous,
            createCount: previous.createCount + (event==='create' ? 1 : 0),
            disposeCount: previous.disposeCount + (event==='dispose' ? 1 : 0),
            renderCount: previous.renderCount + (event==='render' ? 1 : 0),
            reuseCount: previous.reuseCount + (event==='reuse' ? 1 : 0),
        };
        this.lifecycleObservationByUriThreadId.set(key, next);
        this.logTrace('thread.lifecycle_observed', {
            event,
            threadId,
            uri: uriKey,
            ...next,
            ...fields,
        });
    }

    private getThreadHandleId(thread: OverleafCommentThreadHandle) {
        const existingId = this.threadHandleIds.get(thread);
        if (existingId!==undefined) {
            return existingId;
        }
        this.threadHandleSequence += 1;
        const assignedId = this.threadHandleSequence;
        this.threadHandleIds.set(thread, assignedId);
        return assignedId;
    }

    private trackCreatedThreadHandle(
        renderUri: vscode.Uri,
        thread: OverleafCommentThreadHandle,
        source: string,
        threadKey?: string,
    ) {
        const uriKey = renderUri.toString();
        const handles = this.createdThreadHandlesByUri.get(uriKey) ?? new Set<OverleafCommentThreadHandle>();
        handles.add(thread);
        this.createdThreadHandlesByUri.set(uriKey, handles);
        if (threadKey) {
            this.recordLifecycleObservation(uriKey, threadKey, 'create', {
                handleId: this.getThreadHandleId(thread),
                source,
            });
        }
        this.logDiagnostic('thread_handle.tracked', {
            handleId: this.getThreadHandleId(thread),
            source,
            threadKey: threadKey ?? '',
            trackedHandleCount: handles.size,
            uri: uriKey,
        });
    }

    private untrackCreatedThreadHandle(renderUri: vscode.Uri, thread: OverleafCommentThreadHandle) {
        const uriKey = renderUri.toString();
        const handles = this.createdThreadHandlesByUri.get(uriKey);
        if (!handles) {
            return;
        }
        handles.delete(thread);
        if (handles.size===0) {
            this.createdThreadHandlesByUri.delete(uriKey);
            return;
        }
        this.createdThreadHandlesByUri.set(uriKey, handles);
    }

    private createTrackedCommentThread(
        renderUri: vscode.Uri,
        range: vscode.Range,
        comments: readonly vscode.Comment[],
        source: string,
        threadKey?: string,
    ) {
        const thread = this.controller.createCommentThread(renderUri, range, comments) as OverleafCommentThreadHandle;
        this.trackCreatedThreadHandle(renderUri, thread, source, threadKey);
        return thread;
    }

    private assignThreadCommentsIfChanged(
        thread: OverleafCommentThreadHandle,
        comments: readonly OverleafVSCodeComment[],
    ) {
        if (areStableCommentRenderListsEqual(thread.comments as readonly OverleafVSCodeComment[], comments)) {
            return false;
        }
        thread.comments = comments;
        return true;
    }

    private assignThreadRangeIfChanged(
        thread: OverleafCommentThreadHandle,
        range: vscode.Range,
    ) {
        if (thread.range.isEqual(range)) {
            return false;
        }
        thread.range = range;
        return true;
    }

    private assignThreadDisplayBaseRangeIfChanged(
        thread: OverleafCommentThreadHandle,
        range: vscode.Range,
    ) {
        if (thread.overleafDisplayBaseRange?.isEqual(range)) {
            return false;
        }
        thread.overleafDisplayBaseRange = range;
        return true;
    }

    private getThreadInteractionRange(thread: vscode.CommentThread) {
        return (thread as OverleafCommentThreadHandle).overleafDisplayBaseRange ?? thread.range;
    }

    private disposeTrackedThread(
        renderUri: vscode.Uri,
        thread: OverleafCommentThreadHandle,
        reason: string,
        fields: Record<string, unknown> = {},
    ) {
        this.untrackCreatedThreadHandle(renderUri, thread);
        thread.dispose();
        const uriKey = renderUri.toString();
        if (thread.overleafThreadId) {
            this.recordLifecycleObservation(uriKey, thread.overleafThreadId, 'dispose', {
                handleId: this.getThreadHandleId(thread),
                reason,
            });
            this.collapsibleStateByUriThreadId.delete(this.toLifecycleObservationKey(uriKey, thread.overleafThreadId));
        }
        this.logDiagnostic('thread_handle.disposed', {
            handleId: this.getThreadHandleId(thread),
            reason,
            uri: renderUri.toString(),
            ...fields,
        });
    }

    private summarizeThreadMapForDiagnostics(threads: Map<string, OverleafCommentThreadHandle>) {
        return Array.from(threads.entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, 80)
            .map(([threadKey, thread]) => ({
                collapsibleState: thread.collapsibleState,
                commentCount: thread.comments.length,
                handleId: this.getThreadHandleId(thread),
            isDraft: this.isLocalReplicaDraftThread(thread),
            pinnedToStartAnchor: Boolean(thread.overleafPinnedToStartAnchor),
            rangeStart: `${thread.range.start.line}:${thread.range.start.character}`,
            threadKey,
            overleafThreadId: thread.overleafThreadId ?? '',
        }));
    }

    private summarizeDuplicateThreadHandles(threads: Map<string, OverleafCommentThreadHandle>) {
        const entriesByOverleafThreadId = new Map<string, Array<{handleId: number, threadKey: string}>>();
        for (const [threadKey, thread] of threads.entries()) {
            if (!thread.overleafThreadId) {
                continue;
            }
            const entries = entriesByOverleafThreadId.get(thread.overleafThreadId) ?? [];
            entries.push({
                handleId: this.getThreadHandleId(thread),
                threadKey,
            });
            entriesByOverleafThreadId.set(thread.overleafThreadId, entries);
        }
        return Array.from(entriesByOverleafThreadId.entries())
            .filter(([, entries]) => entries.length > 1)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([overleafThreadId, entries]) => ({
                handleIds: entries.map((entry) => entry.handleId).sort((left, right) => left - right),
                overleafThreadId,
                threadKeys: entries.map((entry) => entry.threadKey).sort((left, right) => left.localeCompare(right)),
            }));
    }

    private collectInlineDiagnosticsState() {
        const uriKeys = Array.from(this.threadsByUri.keys()).sort((left, right) => left.localeCompare(right));
        return {
            commentsChangedObservationCount: this.commentsChangedObservationBySequence.size,
            interactionState: this.collectCommentInteractionDiagnosticsState(),
            isActiveProvider: InlineCommentProvider.activeProvider===this,
            lifecycleObservationCount: this.lifecycleObservationByUriThreadId.size,
            providerDisposed: this.providerDisposed,
            providerInstanceId: this.providerInstanceId,
            recentCommentDebugEventCount: this.recentCommentDebugEvents.length,
            recentCommentDebugEvents: this.recentCommentDebugEvents,
            refreshPromiseCount: this.refreshPromises.size,
            renderQueueCount: this.renderQueueByUri.size,
            renderedSnapshotDocCount: this.snapshotsByUri.size,
            trackedHandleUriCount: this.createdThreadHandlesByUri.size,
            triggerRegistrationCount: this.triggerRegistrations?.length ?? 0,
            uriState: uriKeys.map((uriKey) => {
                const threads = this.threadsByUri.get(uriKey) ?? new Map<string, OverleafCommentThreadHandle>();
                return {
                    duplicateOverleafThreadIds: this.summarizeDuplicateThreadHandles(threads),
                    entries: this.summarizeThreadMapForDiagnostics(threads),
                    renderedThreadKeyCount: threads.size,
                    trackedHandleCount: this.createdThreadHandlesByUri.get(uriKey)?.size ?? 0,
                    uri: uriKey,
                };
            }),
        };
    }

    private collectUriThreadDebugState(uri: vscode.Uri) {
        const uriKey = uri.toString();
        const threads = this.threadsByUri.get(uriKey) ?? new Map<string, OverleafCommentThreadHandle>();
        const snapshot = this.snapshotsByUri.get(uriKey);
        return {
            duplicateOverleafThreadIds: this.summarizeDuplicateThreadHandles(threads),
            renderSequence: this.renderSequenceByUri.get(uriKey) ?? 0,
            renderedThreadKeyCount: threads.size,
            snapshotThreadCount: snapshot?.threads.length ?? 0,
            threadEntries: this.summarizeThreadMapForDiagnostics(threads),
            trackedHandleCount: this.createdThreadHandlesByUri.get(uriKey)?.size ?? 0,
            transientRangeCount: this.transientRangesByUri.get(uriKey)?.length ?? 0,
            uri: uriKey,
        };
    }

    private async collectRenderedReviewParityDiagnostics() {
        const activeBinding = await resolveActiveProjectWorkspaceBinding();
        if (!activeBinding) {
            return {
                activeProjectUri: '',
                available: false,
                reason: 'no_active_binding',
            };
        }
        const reviewDebugState = ReviewViewProvider.getDebugSnapshotForProject({
            origin: activeBinding.overleafProjectUri.toString(),
        });
        if (!reviewDebugState) {
            return {
                activeProjectUri: activeBinding.overleafProjectUri.toString(),
                available: false,
                reason: 'review_provider_unavailable',
            };
        }

        const renderedDocThreads = (await Promise.all(
            Array.from(this.snapshotsByUri.entries()).map(async ([uriKey, snapshot]) => {
                const renderUri = vscode.Uri.parse(uriKey);
                const overleafUri = await this.resolveOverleafProjectUri(renderUri);
                if (!overleafUri || !this.sameOverleafProject(overleafUri, activeBinding.overleafProjectUri)) {
                    return undefined;
                }
                const inlineThreads = summarizeInlineCommentSnapshot(snapshot);
                return {
                    docId: snapshot.docId,
                    inlineThreadCount: inlineThreads.length,
                    inlineThreads,
                    overleafUri: overleafUri.toString(),
                    renderUri: uriKey,
                    threadIds: inlineThreads.map((thread) => thread.threadId),
                };
            }),
        )).filter((entry): entry is NonNullable<typeof entry> => entry!==undefined);

        const inlineThreads = renderedDocThreads.flatMap((entry) => entry.inlineThreads);
        const renderedDocs = renderedDocThreads.map(({inlineThreads: _inlineThreads, ...entry}) => entry);
        const reviewThreads = Array.isArray(reviewDebugState.entries)
            ? reviewDebugState.entries
            : [];
        const parityByDocId = buildCommentThreadParityByDocId({
            inlineThreads,
            reviewThreads,
        });
        const mismatchDocCount = parityByDocId.filter((summary) => {
            return summary.missingInInline.length > 0
                || summary.missingInReview.length > 0
                || summary.messageCountMismatches.length > 0
                || summary.resolvedMismatches.length > 0
                || summary.selectedTextMismatches.length > 0;
        }).length;
        return {
            activeProjectUri: activeBinding.overleafProjectUri.toString(),
            available: true,
            mismatchDocCount,
            parityByDocId,
            renderedDocs,
            reviewProviderState: reviewDebugState,
        };
    }

    private async showCommentDebugDocument(title: string, payload: unknown) {
        const serialized = JSON.stringify(sanitizeDiagnosticPayload(payload), null, 2);
        const document = await vscode.workspace.openTextDocument({
            content: serialized,
            language: 'json',
        });
        await vscode.window.showTextDocument(document, {
            preview: false,
            viewColumn: vscode.ViewColumn.Beside,
        });
        this.logDiagnostic('debug.document_opened', {
            bytes: serialized.length,
            title,
        });
    }

    private async dumpCommentDiagnosticsState() {
        const snapshot = collectDiagnosticSnapshot({recentLimit: 400});
        const commentState = Object.fromEntries(
            Object.entries(snapshot.state)
                .filter(([scope]) => {
                    return scope==='commentsDebug'
                        || scope==='inlineComments'
                        || scope.startsWith('comments:')
                        || scope.startsWith('reviewPanel:');
                })
                .sort(([left], [right]) => left.localeCompare(right)),
        );
        const commentRecords = snapshot.recentRecords.filter((record) => {
            const category = record.category;
            const subsystem = record.commentSubsystem;
            return category==='comments'
                || (typeof subsystem === 'string' && subsystem.startsWith('comments:'));
        });
        const activeBinding = await resolveActiveProjectWorkspaceBinding();
        const renderedReviewParity = await this.collectRenderedReviewParityDiagnostics();

        await this.showCommentDebugDocument('comment-diagnostics-snapshot', {
            activeBinding: activeBinding
                ? {
                    mode: activeBinding.mode,
                    overleafProjectUri: activeBinding.overleafProjectUri.toString(),
                    workspaceRootUri: activeBinding.workspaceRootUri?.toString() ?? '',
                }
                : null,
            diagnosticsRuntimeConfiguration: snapshot.runtimeConfiguration,
            eventBus: EventBus.getDiagnosticsState(),
            generatedAt: new Date().toISOString(),
            inlineProviderState: this.collectInlineDiagnosticsState(),
            recentCommentRecords: commentRecords,
            renderedReviewParity,
            state: commentState,
        });
    }

    private async inspectCommentEventListeners() {
        await this.showCommentDebugDocument('comment-event-listeners', {
            commentDiagnosticsRuntime: getCommentDiagnosticsRuntimeConfiguration(),
            eventBus: EventBus.getDiagnosticsState(),
            generatedAt: new Date().toISOString(),
        });
    }

    private async forceCommentReconciliation() {
        const traceContext = createDiagnosticTraceContext();
        const targetEditors = vscode.window.visibleTextEditors
            .filter((editor) => this.isOverleafDocument(editor.document));
        const activeBinding = await resolveActiveProjectWorkspaceBinding();
        this.recordCommentDebugEvent('force_reconcile_started', {
            activeOrigin: activeBinding?.overleafProjectUri.toString() ?? '',
            targetEditorCount: targetEditors.length,
        });
        this.logDiagnostic('debug.force_reconcile_started', withDiagnosticTraceFields({
            targetEditorCount: targetEditors.length,
        }, traceContext));
        try {
            await Promise.all([
                this.syncVisibleEditors('debug_force_reconcile', targetEditors),
                vscode.commands.executeCommand(`${ROOT_NAME}.review.refresh`, {
                    origin: activeBinding?.overleafProjectUri.toString(),
                }),
            ]);
            this.recordCommentDebugEvent('force_reconcile_completed', {
                activeOrigin: activeBinding?.overleafProjectUri.toString() ?? '',
                targetEditorCount: targetEditors.length,
            });
            this.logDiagnostic('debug.force_reconcile_completed', withDiagnosticTraceFields({
                targetEditorCount: targetEditors.length,
            }, traceContext));
        } catch (error) {
            this.recordCommentDebugEvent('force_reconcile_failed', {
                activeOrigin: activeBinding?.overleafProjectUri.toString() ?? '',
                errorMessage: error instanceof Error ? error.message : String(error),
                targetEditorCount: targetEditors.length,
            });
            this.logDiagnostic('debug.force_reconcile_failed', withDiagnosticTraceFields({
                targetEditorCount: targetEditors.length,
            }, traceContext), error);
            throw error;
        }
    }

    private recordCommentsChangedObservation(
        origin: string,
        reason: string,
        sequence: number | undefined,
        emittedAtMs: number | undefined,
    ) {
        const sequenceKey = sequence===undefined ? 'none' : String(sequence);
        const emittedAtKey = emittedAtMs===undefined ? 'none' : String(emittedAtMs);
        const observationKey = `${origin}\u0000${reason}\u0000${sequenceKey}\u0000${emittedAtKey}`;
        const now = Date.now();
        const previous = this.commentsChangedObservationBySequence.get(observationKey);
        const next = {
            count: (previous?.count ?? 0) + 1,
            firstObservedAtMs: previous?.firstObservedAtMs ?? now,
            lastObservedAtMs: now,
        };
        this.commentsChangedObservationBySequence.set(observationKey, next);
        if (this.commentsChangedObservationBySequence.size > 240) {
            const keys = Array.from(this.commentsChangedObservationBySequence.keys());
            const amountToTrim = this.commentsChangedObservationBySequence.size - 240;
            keys.slice(0, amountToTrim).forEach((key) => {
                this.commentsChangedObservationBySequence.delete(key);
            });
        }
        return {
            observationCount: next.count,
            observationKey,
        };
    }

    private async suppressAutomaticCommentsPanelActivation(reason: string) {
        const activeBinding = await resolveActiveProjectWorkspaceBinding();
        const configuration = vscode.workspace.getConfiguration('comments');
        const openView = configuration.get<string>('openView', 'firstFile');
        const decision = resolveCommentsOpenViewSuppressionDecision({
            mode: activeBinding?.mode,
            openView,
            workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
        });
        if (decision==='already_disabled') {
            this.recordCommentDebugEvent('comments_panel_auto_open_already_disabled', {
                mode: activeBinding?.mode ?? 'none',
                reason,
            });
            this.logDiagnostic('comments_panel_auto_open_already_disabled', {
                mode: activeBinding?.mode ?? 'none',
                reason,
            });
            return;
        }

        if (decision==='skip_no_workspace') {
            this.recordCommentDebugEvent('comments_panel_auto_open_disable_skipped', {
                mode: activeBinding?.mode ?? 'none',
                openView,
                reason,
            });
            this.logDiagnostic('comments_panel_auto_open_disable_skipped', {
                mode: activeBinding?.mode ?? 'none',
                openView,
                reason,
            });
            return;
        }

        if (decision==='skip_unmanaged_workspace') {
            this.recordCommentDebugEvent('comments_panel_auto_open_disable_skipped_unmanaged_workspace', {
                mode: activeBinding?.mode ?? 'none',
                openView,
                reason,
            });
            this.logDiagnostic('comments_panel_auto_open_disable_skipped_unmanaged_workspace', {
                mode: activeBinding?.mode ?? 'none',
                openView,
                reason,
            });
            return;
        }

        try {
            await configuration.update('openView', 'never', vscode.ConfigurationTarget.Workspace);
            this.recordCommentDebugEvent('comments_panel_auto_open_disabled_workspace', {
                mode: activeBinding?.mode ?? 'none',
                previousOpenView: openView,
                reason,
            });
            this.logDiagnostic('comments_panel_auto_open_disabled_workspace', {
                mode: activeBinding?.mode ?? 'none',
                previousOpenView: openView,
                reason,
            });
        } catch (error) {
            this.recordCommentDebugEvent('comments_panel_auto_open_disable_failed_workspace', {
                mode: activeBinding?.mode ?? 'none',
                openView,
                reason,
            });
            this.logDiagnostic('comments_panel_auto_open_disable_failed_workspace', {
                mode: activeBinding?.mode ?? 'none',
                openView,
                reason,
            }, error);
        }
    }

    private shouldSuppressStartupPanelForReason(renderUri: vscode.Uri, reason: string) {
        return shouldSuppressStartupPanelAfterRender({
            expiresAtMs: this.startupPanelSuppressionExpiresAtMs,
            isProviderDisposed: this.providerDisposed,
            mode: resolveProjectWorkspaceModeForUri(renderUri),
            reason,
            renderPath: renderUri.path,
            snapshotThreadCount: this.snapshotsByUri.get(renderUri.toString())?.threads.length ?? 0,
        });
    }

    private scheduleStartupPanelSuppression(renderUri: vscode.Uri, reason: string) {
        if (!this.shouldSuppressStartupPanelForReason(renderUri, reason)) {
            return;
        }

        if (this.startupPanelSuppressionTimer) {
            clearTimeout(this.startupPanelSuppressionTimer);
        }
        const runAttempt = (attempt: number) => {
            if (this.providerDisposed || Date.now() > this.startupPanelSuppressionExpiresAtMs) {
                return;
            }
            void vscode.commands.executeCommand('workbench.action.closePanel').then(
                () => {
                    this.recordCommentDebugEvent('comments_panel_auto_open_suppressed_startup', {
                        attempt,
                        reason,
                        uri: renderUri.toString(),
                    });
                    this.logDiagnostic('comments_panel_auto_open_suppressed_startup', {
                        attempt,
                        reason,
                        uri: renderUri.toString(),
                    });
                },
                (error) => {
                    this.recordCommentDebugEvent('comments_panel_auto_open_suppression_failed_startup', {
                        attempt,
                        reason,
                        uri: renderUri.toString(),
                    });
                    this.logDiagnostic('comments_panel_auto_open_suppression_failed_startup', {
                        attempt,
                        reason,
                        uri: renderUri.toString(),
                    }, error);
                },
            );
            if (attempt + 1 < InlineCommentProvider.STARTUP_PANEL_SUPPRESSION_MAX_ATTEMPTS) {
                this.startupPanelSuppressionTimer = setTimeout(() => {
                    this.startupPanelSuppressionTimer = undefined;
                    runAttempt(attempt + 1);
                }, InlineCommentProvider.STARTUP_PANEL_SUPPRESSION_REPEAT_DELAY_MS);
            }
        };
        runAttempt(0);
        this.recordCommentDebugEvent('comments_panel_auto_open_suppression_scheduled_startup', {
            reason,
            snapshotThreadCount: this.snapshotsByUri.get(renderUri.toString())?.threads.length ?? 0,
            uri: renderUri.toString(),
        });
        this.logDiagnostic('comments_panel_auto_open_suppression_scheduled_startup', {
            reason,
            snapshotThreadCount: this.snapshotsByUri.get(renderUri.toString())?.threads.length ?? 0,
            uri: renderUri.toString(),
        });
    }

    private resolveCommentOperatingMode(uri: vscode.Uri | undefined) {
        if (!uri) {
            return 'none';
        }
        const mode = resolveProjectWorkspaceModeForUri(uri);
        if (mode==='currentWindow') {
            return 'currentWindow';
        }
        if (mode==='localReplica') {
            return 'localReplica';
        }
        return 'unsupported';
    }

    private inferAddCommentInvocationSource(args: unknown[]) {
        return args.some((argument) => this.isTextEditor(argument) || this.isUri(argument) || this.isRange(argument))
            ? 'context_menu_or_api'
            : 'keybinding_or_palette';
    }

    private describeAddCommentEditorState(editor: vscode.TextEditor | undefined, supportedEditor?: boolean) {
        const document = editor?.document;
        const uri = document?.uri;
        const nonEmptySelectionCount = editor?.selections.filter((selection) => !selection.isEmpty).length ?? 0;
        const mode = this.resolveCommentOperatingMode(uri);
        return {
            languageId: document?.languageId ?? '',
            localShortcutEligible: mode==='localReplica' && Boolean(supportedEditor) && nonEmptySelectionCount > 0,
            mode,
            nonEmptySelectionCount,
            remoteShortcutEligible: mode==='currentWindow' && nonEmptySelectionCount > 0,
            scheme: uri?.scheme ?? '',
            selectionEmpty: editor?.selection?.isEmpty ?? true,
            uri: uri?.toString() ?? '',
        };
    }

    private isOverleafDocument(document: vscode.TextDocument) {
        if (document.uri.scheme===ROOT_NAME) {
            return true;
        }
        if (document.uri.scheme!=='file') {
            return false;
        }
        return Boolean(vscode.workspace.getWorkspaceFolder(document.uri));
    }

    private isTextEditor(value: unknown): value is vscode.TextEditor {
        return Boolean(value
            && typeof value === 'object'
            && 'document' in value
            && 'selection' in value
            && (value as vscode.TextEditor).document?.uri);
    }

    private isUri(value: unknown): value is vscode.Uri {
        return Boolean(value
            && typeof value === 'object'
            && 'scheme' in value
            && 'path' in value
            && typeof (value as vscode.Uri).toString === 'function');
    }

    private isRange(value: unknown): value is vscode.Range {
        return Boolean(value
            && typeof value === 'object'
            && 'start' in value
            && 'end' in value);
    }

    private describeCommandArguments(args: unknown[]) {
        return args.map((argument) => {
            if (this.isTextEditor(argument)) {
                return 'TextEditor';
            }
            if (this.isUri(argument)) {
                return 'Uri';
            }
            if (this.isRange(argument)) {
                return 'Range';
            }
            if (argument === undefined) {
                return 'undefined';
            }
            if (argument === null) {
                return 'null';
            }
            return typeof argument;
        });
    }

    private getOpenDocument(uri: vscode.Uri) {
        return vscode.workspace.textDocuments.find((document) => document.uri.toString()===uri.toString());
    }

    private async provideCommentingRanges(document: vscode.TextDocument) {
        if (!this.isOverleafDocument(document)) {
            return [];
        }
        const binding = await this.resolveCommentDocumentBinding(document.uri);
        if (!binding) {
            return [];
        }
        if (binding.mode==='localReplica') {
            const pendingRanges = this.getPendingLocalReplicaCommentingRanges(document.uri);
            if (!pendingRanges) {
                return [];
            }
            return pendingRanges;
        }
        return [];
    }

    private sameOverleafProject(left: vscode.Uri, right: vscode.Uri) {
        if (left.scheme!==ROOT_NAME || right.scheme!==ROOT_NAME) {
            return false;
        }
        try {
            const target = parseUri(left);
            const project = parseUri(right);
            return target.serverName===project.serverName
                && target.projectId===project.projectId
                && target.userId===project.userId;
        } catch {
            return false;
        }
    }

    private async resolveCommentDocumentBinding(renderUri: vscode.Uri): Promise<CommentUriBinding | undefined> {
        return resolveProjectDocumentBinding(renderUri);
    }

    private async resolveOverleafProjectUri(uri: vscode.Uri) {
        if (uri.scheme===ROOT_NAME) {
            return uri;
        }
        const cached = this.overleafUriByRenderUri.get(uri.toString());
        if (cached) {
            return vscode.Uri.parse(cached);
        }
        const binding = await this.resolveCommentDocumentBinding(uri);
        return binding?.overleafUri;
    }

    private async collectCommentRefreshUris(projectUri: vscode.Uri, docIds?: string[]) {
        const targetDocIds = docIds && docIds.length > 0 ? new Set(docIds) : undefined;
        const targetUris = new Map<string, vscode.Uri>();
        let visibleEditorCount = 0;
        let visibleEditorDocFilterSkips = 0;
        let visibleEditorProjectSkips = 0;
        let snapshotCacheCount = 0;
        let snapshotDocFilterSkips = 0;
        let snapshotProjectSkips = 0;

        for (const editor of vscode.window.visibleTextEditors) {
            if (!this.isOverleafDocument(editor.document)) {
                continue;
            }
            visibleEditorCount += 1;
            if (targetDocIds) {
                const cachedSnapshot = this.snapshotsByUri.get(editor.document.uri.toString());
                if (cachedSnapshot && !targetDocIds.has(cachedSnapshot.docId)) {
                    visibleEditorDocFilterSkips += 1;
                    continue;
                }
            }
            const overleafUri = await this.resolveOverleafProjectUri(editor.document.uri);
            if (!overleafUri || !this.sameOverleafProject(overleafUri, projectUri)) {
                visibleEditorProjectSkips += 1;
                continue;
            }
            targetUris.set(editor.document.uri.toString(), editor.document.uri);
        }

        for (const [uriKey, snapshot] of this.snapshotsByUri.entries()) {
            snapshotCacheCount += 1;
            if (targetDocIds && !targetDocIds.has(snapshot.docId)) {
                snapshotDocFilterSkips += 1;
                continue;
            }
            const uri = vscode.Uri.parse(uriKey);
            const overleafUri = await this.resolveOverleafProjectUri(uri);
            if (!overleafUri || !this.sameOverleafProject(overleafUri, projectUri)) {
                snapshotProjectSkips += 1;
                continue;
            }
            targetUris.set(uriKey, uri);
        }

        const resolvedTargetUris = Array.from(targetUris.values());
        this.logDiagnostic('render.refresh_targets_collected', {
            docCount: targetDocIds?.size ?? 0,
            origin: projectUri.toString(),
            snapshotCacheCount,
            snapshotDocFilterSkips,
            snapshotProjectSkips,
            targetUriCount: resolvedTargetUris.length,
            targetUrisSample: resolvedTargetUris.slice(0, 12).map((uri) => uri.toString()),
            visibleEditorCount,
            visibleEditorDocFilterSkips,
            visibleEditorProjectSkips,
        });
        return resolvedTargetUris;
    }

    private async syncVisibleEditorsForProject(origin: string, reason: string) {
        const projectUri = vscode.Uri.parse(origin);
        const projectVfs = await this.vfsm.prefetch(projectUri);
        if (!projectVfs.isOfflineMode
            && (projectVfs.realtimeConnectionPhase==='initializing' || projectVfs.realtimeConnectionPhase==='recovering')) {
            this.logDiagnostic('render.skipped_project_sync_recovery_pending', {
                origin,
                phase: projectVfs.realtimeConnectionPhase,
                reason,
                synchronizationMode: projectVfs.synchronizationMode,
            });
            return;
        }
        const relevantEditors = await Promise.all(vscode.window.visibleTextEditors.map(async (editor) => {
            if (!this.isOverleafDocument(editor.document)) {
                return undefined;
            }
            const overleafUri = await this.resolveOverleafProjectUri(editor.document.uri);
            if (!overleafUri || !this.sameOverleafProject(overleafUri, projectUri)) {
                return undefined;
            }
            return editor;
        }));
        return this.syncVisibleEditors(reason, relevantEditors.filter((editor): editor is vscode.TextEditor => editor!==undefined));
    }

    private async getReadyCommentVfs(overleafUri: vscode.Uri, _reason: string) {
        return this.vfsm.prefetch(overleafUri);
    }

    private normalizeSnapshot(snapshot: OverleafDocumentCommentSnapshot): OverleafDocumentCommentSnapshot {
        return {
            ...snapshot,
            threads: dedupeDocumentCommentSnapshotThreadsByThreadId(snapshot.threads),
        };
    }

    private snapshotHasRenderableThread(
        snapshot: OverleafDocumentCommentSnapshot | undefined,
        threadId?: string,
    ) {
        if (!snapshot) {
            return false;
        }
        if (!threadId) {
            return snapshot.threads.length > 0;
        }
        return this.normalizeSnapshot(snapshot).threads.some(({range, thread}) => {
            return range.op.t===threadId && Boolean(thread && thread.messages.length > 0);
        });
    }

    private async tryRenderSnapshotCandidate(options: {
        expectedThreadId?: string,
        overleafUri: vscode.Uri,
        reason: string,
        renderSource: 'direct_local_snapshot' | 'transient_synthesized_snapshot' | 'delayed_sync_fallback' | 'vfs_snapshot',
        renderUri: vscode.Uri,
        snapshot: OverleafDocumentCommentSnapshot | undefined,
        vfs: VirtualFileSystem,
    }) {
        const normalizedSnapshot = options.snapshot
            ? this.normalizeSnapshot(options.snapshot)
            : undefined;
        if (!normalizedSnapshot) {
            return false;
        }
        if (options.expectedThreadId && !this.snapshotHasRenderableThread(normalizedSnapshot, options.expectedThreadId)) {
            return false;
        }
        await this.renderSnapshot(
            options.renderUri,
            options.overleafUri,
            normalizedSnapshot,
            options.reason,
            options.vfs,
        );
        this.logDiagnostic('render.local_state_refresh_completed', {
            docId: normalizedSnapshot.docId,
            expectedThreadId: options.expectedThreadId ?? '',
            reason: options.reason,
            renderSource: options.renderSource,
            snapshotThreadCount: normalizedSnapshot.threads.length,
            uri: options.renderUri.toString(),
        });
        return true;
    }

    private async renderSnapshot(
        renderUri: vscode.Uri,
        overleafUri: vscode.Uri,
        snapshot: OverleafDocumentCommentSnapshot,
        reason: string,
        vfs?: VirtualFileSystem,
    ) {
        const normalizedSnapshot = this.normalizeSnapshot(snapshot);
        const uriKey = renderUri.toString();
        this.snapshotsByUri.set(uriKey, normalizedSnapshot);
        this.transientRangesByUri.set(
            uriKey,
            normalizedSnapshot.threads.map(({range}) => cloneCommentRange(range)),
        );
        this.logTrace('render.snapshot_loaded', {
            docId: normalizedSnapshot.docId,
            reason,
            threadCount: normalizedSnapshot.threads.length,
            threadIdsSample: normalizedSnapshot.threads
                .slice(0, 24)
                .map(({range, thread}) => ({
                    rootCommentId: thread?.messages?.[0]?.id ?? '',
                    threadId: range.op.t,
                })),
            uri: uriKey,
        });
        await this.renderUri(renderUri, overleafUri, normalizedSnapshot, reason, vfs);
        const normalizedReason = this.getTransientRehydrationAttempt(reason).baseReason;
        if (vfs
            && (normalizedReason.startsWith('comments_changed_event:')
                || normalizedReason.startsWith('offline_state_changed:')
                || normalizedReason.startsWith('realtime_state_changed:'))) {
            await this.renderAuthoritativeReviewEntriesFromLocalState({
                docIds: [normalizedSnapshot.docId],
                reason: normalizedReason,
                traceFields: {
                    docId: normalizedSnapshot.docId,
                    renderReason: normalizedReason,
                    renderUri: renderUri.toString(),
                },
                vfs,
            });
        }
        this.recordCommentDebugEvent('render_snapshot_applied', {
            docId: normalizedSnapshot.docId,
            normalizedReason,
            reason,
            threadCount: normalizedSnapshot.threads.length,
            uri: renderUri.toString(),
        });
        this.logDiagnostic('render.completed', {
            duplicateThreadCount: snapshot.threads.length - normalizedSnapshot.threads.length,
            reason,
            threadCount: normalizedSnapshot.threads.length,
            uri: renderUri.toString(),
        });
        return normalizedSnapshot;
    }

    private async runWithSerializedRender<T>(renderUri: vscode.Uri, reason: string, operation: () => Promise<T>) {
        const uriKey = renderUri.toString();
        const previous = this.renderQueueByUri.get(uriKey) ?? Promise.resolve();
        let releaseBarrier: (() => void) | undefined;
        const barrier = new Promise<void>((resolve) => {
            releaseBarrier = resolve;
        });
        const queueTail = previous
            .catch(() => undefined)
            .then(() => barrier);
        this.renderQueueByUri.set(uriKey, queueTail);

        const queuedAtMs = Date.now();
        await previous.catch(() => undefined);
        const startedAtMs = Date.now();
        const waitMs = Math.max(0, startedAtMs - queuedAtMs);
        if (waitMs > 0) {
            this.logDiagnostic('render.queue_waited', {
                reason,
                uri: uriKey,
                waitMs,
            });
        }

        try {
            return await operation();
        } finally {
            releaseBarrier?.();
            if (this.renderQueueByUri.get(uriKey)===queueTail) {
                this.renderQueueByUri.delete(uriKey);
            }
        }
    }

    private async refreshUriFromVfsState(
        renderUri: vscode.Uri,
        overleafUri: vscode.Uri,
        vfs: VirtualFileSystem,
        reason: string,
        options: {
            expectedThreadId?: string,
            preferLocalSnapshot?: boolean,
        } = {},
    ) {
        return this.runWithSerializedRender(renderUri, reason, async () => {
            let localSnapshot: OverleafDocumentCommentSnapshot | undefined;
            if (options.preferLocalSnapshot) {
                localSnapshot = await vfs.getCommentSnapshotFromLocalState(overleafUri);
                if (await this.tryRenderSnapshotCandidate({
                    expectedThreadId: options.expectedThreadId,
                    overleafUri,
                    reason,
                    renderSource: 'direct_local_snapshot',
                    renderUri,
                    snapshot: localSnapshot,
                    vfs,
                })) {
                    return true;
                }
            }
            const snapshot = await vfs.getCommentSnapshot(overleafUri);
            if (await this.tryRenderSnapshotCandidate({
                expectedThreadId: options.expectedThreadId,
                overleafUri,
                reason,
                renderSource: options.preferLocalSnapshot ? 'delayed_sync_fallback' : 'vfs_snapshot',
                renderUri,
                snapshot,
                vfs,
            })) {
                return true;
            }
            if (options.preferLocalSnapshot && await this.tryRenderSnapshotCandidate({
                expectedThreadId: options.expectedThreadId,
                overleafUri,
                reason,
                renderSource: 'transient_synthesized_snapshot',
                renderUri,
                snapshot: localSnapshot,
                vfs,
            })) {
                return true;
            }
            if (!snapshot) {
                const uriKey = renderUri.toString();
                const renderedThreadCount = this.threadsByUri.get(uriKey)?.size ?? 0;
                const shouldPreserveRenderedSnapshot = this.snapshotsByUri.has(uriKey)
                    && (vfs.isOfflineMode
                        || vfs.synchronizationMode==='sync-recovery'
                        || vfs.realtimeConnectionPhase!=='live');
                if (shouldPreserveRenderedSnapshot || renderedThreadCount > 0) {
                    this.logDiagnostic('render.snapshot_unavailable_preserved_local', {
                        phase: vfs.realtimeConnectionPhase,
                        reason,
                        renderedThreadCount,
                        synchronizationMode: vfs.synchronizationMode,
                        uri: renderUri.toString(),
                    });
                    this.scheduleTransientRehydration(renderUri, reason);
                    return true;
                }
                this.disposeThreadsForUri(renderUri);
                this.logDiagnostic('render.skipped_no_snapshot', {
                    phase: vfs.realtimeConnectionPhase,
                    reason,
                    synchronizationMode: vfs.synchronizationMode,
                    uri: renderUri.toString(),
                });
                return false;
            }
            this.logDiagnostic('render.snapshot_missing_expected_thread_preserved_local', {
                expectedThreadId: options.expectedThreadId ?? '',
                hasRenderedSnapshot: this.snapshotsByUri.has(renderUri.toString()),
                reason,
                snapshotThreadCount: snapshot.threads.length,
                uri: renderUri.toString(),
            });
            this.scheduleTransientRehydration(renderUri, reason);
            return true;
        });
    }

    private isOfflineVisibilityPreservingReason(reason: string) {
        const normalizedReason = this.getTransientRehydrationAttempt(reason).baseReason;
        return normalizedReason.includes('thread_created_offline')
            || normalizedReason.includes('thread_created_queued_after_connectivity_failure')
            || normalizedReason.includes('thread_message_created_offline')
            || normalizedReason.includes('thread_reply_created_offline')
            || normalizedReason.includes('thread_message_edited_offline')
            || normalizedReason.includes('comments_recovery_ranges_preserved')
            || normalizedReason.includes('comments_replay_server_thread_id_resolved')
            || normalizedReason.includes('thread_message_replayed')
            || normalizedReason.includes('thread_reply_replayed')
            || normalizedReason.includes('thread_edit_replayed')
            || normalizedReason.includes('comments_replay_thread_id_reconciled')
            || normalizedReason.includes('comments_replay_thread_reconciled')
            || normalizedReason.includes('comments_replay_range_restored_from_operation_payload')
            || normalizedReason.includes('comments_threads_hydrated')
            || normalizedReason.includes('offline_state_changed:')
            || normalizedReason.includes('realtime_state_changed:');
    }

    private shouldPreserveExistingThreadsDuringRender(vfs: VirtualFileSystem, reason: string) {
        const {attempt, baseReason} = this.getTransientRehydrationAttempt(reason);
        if (attempt >= InlineCommentProvider.TRANSIENT_REHYDRATION_MAX_RETRIES) {
            return false;
        }
        if (!this.isOfflineVisibilityPreservingReason(baseReason)) {
            return false;
        }
        return vfs.isOfflineMode
            || vfs.synchronizationMode==='sync-recovery'
            || vfs.realtimeConnectionPhase!=='live'
            || baseReason.includes('thread_message_replayed')
            || baseReason.includes('thread_reply_replayed')
            || baseReason.includes('thread_edit_replayed')
            || baseReason.includes('comments_replay_');
    }

    private getTransientRehydrationAttempt(reason: string) {
        const match = reason.match(/_transient_rehydration_retry_(\d+)$/);
        if (!match) {
            return {
                attempt: 0,
                baseReason: reason,
            };
        }
        return {
            attempt: Number.parseInt(match[1], 10) || 0,
            baseReason: reason.slice(0, match.index),
        };
    }

    private scheduleTransientRehydration(renderUri: vscode.Uri, reason: string) {
        const {attempt, baseReason} = this.getTransientRehydrationAttempt(reason);
        if (attempt >= InlineCommentProvider.TRANSIENT_REHYDRATION_MAX_RETRIES) {
            this.logDiagnostic('render.transient_rehydration_exhausted', {
                attempt,
                reason,
                uri: renderUri.toString(),
            });
            return;
        }
        const nextAttempt = attempt + 1;
        setTimeout(() => {
            void this.syncUri(renderUri, `${baseReason}_transient_rehydration_retry_${nextAttempt}`);
        }, InlineCommentProvider.TRANSIENT_REHYDRATION_RETRY_DELAY_MS);
    }

    private async setAddCommentContext(supportedEditor: boolean, hasSelection: boolean, reason: string, uri?: string) {
        await Promise.all([
            vscode.commands.executeCommand('setContext', LOCAL_REPLICA_ADD_COMMENT_SUPPORTED_EDITOR_CONTEXT, supportedEditor),
            vscode.commands.executeCommand('setContext', LOCAL_REPLICA_ADD_COMMENT_SELECTION_CONTEXT, hasSelection),
        ]);
        this.logDiagnostic('shortcut_probe.context_updated', {
            hasSelection,
            reason,
            supportedEditor,
            uri: uri ?? '',
        });
    }

    private async updateAddCommentContext(reason: string) {
        const sequence = ++this.commentCommandContextSequence;
        const activeEditor = vscode.window.activeTextEditor;
        let supportedEditor = false;
        let hasSelection = false;
        let uri = '';

        try {
            if (activeEditor && this.isOverleafDocument(activeEditor.document)) {
                uri = activeEditor.document.uri.toString();
                const binding = await this.resolveCommentDocumentBinding(activeEditor.document.uri);
                supportedEditor = binding?.mode==='localReplica';
                hasSelection = supportedEditor && activeEditor.selections.some((selection) => !selection.isEmpty);
            }
        } catch (error) {
            this.logDiagnostic('shortcut_probe.context_update_failed', {
                reason,
                uri,
            }, error);
        }

        if (sequence!==this.commentCommandContextSequence) {
            this.logDiagnostic('shortcut_probe.context_update_discarded', {
                reason,
                sequence,
                uri,
            });
            return;
        }
        this.logDiagnostic('shortcut_probe.context_snapshot', {
            ...this.describeAddCommentEditorState(activeEditor, supportedEditor),
            hasSelection,
            reason,
            supportedEditor,
        });
        await this.setAddCommentContext(supportedEditor, hasSelection, reason, uri);
    }

    private resolveAddCommentCommandContext(...args: unknown[]): AddCommentCommandContext | undefined {
        const explicitEditor = args.find((argument) => this.isTextEditor(argument)) as vscode.TextEditor | undefined;
        const explicitUri = args.find((argument) => this.isUri(argument)) as vscode.Uri | undefined;
        const explicitRange = args.find((argument) => this.isRange(argument)) as vscode.Range | undefined;

        const matchingVisibleEditor = explicitUri
            ? vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString()===explicitUri.toString())
            : undefined;
        const activeEditor = vscode.window.activeTextEditor;
        const editor = (explicitEditor && this.isOverleafDocument(explicitEditor.document) ? explicitEditor : undefined)
            ?? matchingVisibleEditor
            ?? (activeEditor && (!explicitUri || activeEditor.document.uri.toString()===explicitUri.toString()) ? activeEditor : undefined);

        if (!editor || !this.isOverleafDocument(editor.document)) {
            this.logDiagnostic('shortcut_probe.command_context_resolution_failed', {
                activeEditorPresent: Boolean(activeEditor),
                explicitEditorPresent: Boolean(explicitEditor),
                explicitRangePresent: Boolean(explicitRange),
                explicitUriPresent: Boolean(explicitUri),
                matchingVisibleEditorPresent: Boolean(matchingVisibleEditor),
                reason: !editor ? 'no_matching_editor' : 'editor_not_overleaf_document',
            });
            return undefined;
        }

        const nonEmptySelections = editor.selections.filter((selection) => !selection.isEmpty);
        const explicitSelection = explicitRange && !explicitRange.isEmpty
            ? new vscode.Selection(explicitRange.start, explicitRange.end)
            : undefined;
        const fallbackSelection = nonEmptySelections[0];
        // Context-menu invocations can pass an explicit range while leaving the
        // primary editor.selection collapsed, so add-comment must prefer the
        // explicit range first and then fall back to any non-empty editor
        // selection instead of trusting editor.selection alone.
        const selection = explicitSelection
            ?? (!editor.selection.isEmpty ? editor.selection : fallbackSelection ?? editor.selection);
        const selectionSource: AddCommentCommandContext['selectionSource'] = explicitSelection
            ? 'explicitRange'
            : (!editor.selection.isEmpty || !fallbackSelection ? 'primarySelection' : 'additionalSelection');

        const resolvedContext = {
            editor,
            nonEmptySelectionCount: nonEmptySelections.length,
            selection,
            selectionSource,
            uri: editor.document.uri,
        };
        this.logDiagnostic('shortcut_probe.command_context_resolved', {
            ...this.describeAddCommentEditorState(editor),
            explicitEditorPresent: Boolean(explicitEditor),
            explicitRangePresent: Boolean(explicitRange),
            explicitUriPresent: Boolean(explicitUri),
            matchingVisibleEditorPresent: Boolean(matchingVisibleEditor),
            resolvedFrom: explicitEditor && this.isOverleafDocument(explicitEditor.document)
                ? 'explicit_editor'
                : matchingVisibleEditor
                    ? 'visible_editor'
                    : 'active_editor',
            selectionSource,
        });
        return resolvedContext;
    }

    private createOffsetRange(document: vscode.TextDocument, range: OverleafCommentRange) {
        const textLength = document.getText().length;
        const startOffset = Math.min(Math.max(range.op.p, 0), textLength);
        const endOffset = Math.min(Math.max(startOffset + range.op.c.length, startOffset), textLength);
        return new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
    }

    private createThreadExtentRange(document: vscode.TextDocument, commentRange: vscode.Range) {
        const anchorLine = resolveCommentThreadAnchorLine(commentRange);
        const line = document.lineAt(anchorLine);
        const range = resolveCommentThreadExtentRange({
            anchorLine,
            commentEndCharacter: commentRange.end.character,
            commentEndLine: commentRange.end.line,
            commentStartCharacter: commentRange.start.character,
            commentStartLine: commentRange.start.line,
            hasLineBreak: !line.rangeIncludingLineBreak.isEqual(line.range),
            lineTextLength: line.text.length,
        });
        // Keep the real commented extent available for synchronization and
        // focus heuristics, while the native thread range stays a line anchor.
        return new vscode.Range(
            new vscode.Position(range.startLine, range.startCharacter),
            new vscode.Position(range.endLine, range.endCharacter),
        );
    }

    private createMinimalThreadRangeAt(document: vscode.TextDocument, position: vscode.Position) {
        const line = document.lineAt(position.line);
        const clampedStartCharacter = Math.min(Math.max(position.character, 0), line.text.length);
        if (line.text.length > clampedStartCharacter) {
            return new vscode.Range(
                position.line,
                clampedStartCharacter,
                position.line,
                clampedStartCharacter + 1,
            );
        }
        if (line.text.length > 0) {
            const fallbackStartCharacter = Math.max(0, line.text.length - 1);
            return new vscode.Range(position.line, fallbackStartCharacter, position.line, line.text.length);
        }
        return new vscode.Range(position.line, 0, position.line, 0);
    }

    private createThreadDisplayRange(document: vscode.TextDocument, commentRange: vscode.Range) {
        const anchorLine = resolveCommentThreadAnchorLine(commentRange);
        const line = document.lineAt(anchorLine);
        const range = resolveCommentThreadDisplayRange({
            anchorLine,
            commentEndCharacter: commentRange.end.character,
            commentEndLine: commentRange.end.line,
            commentStartCharacter: commentRange.start.character,
            commentStartLine: commentRange.start.line,
            hasLineBreak: !line.rangeIncludingLineBreak.isEqual(line.range),
            lineTextLength: line.text.length,
        });
        return new vscode.Range(
            new vscode.Position(range.startLine, range.startCharacter),
            new vscode.Position(range.endLine, range.endCharacter),
        );
    }

    private resolveViewportAdjustedThreadRange(
        thread: OverleafCommentThreadHandle,
        editor: vscode.TextEditor,
    ) {
        const baseRange = thread.overleafDisplayBaseRange ?? thread.range;
        if (baseRange.start.line===baseRange.end.line) {
            return this.createMinimalThreadRangeAt(editor.document, baseRange.start);
        }
        const adjustedRange = resolveViewportAdjustedCommentThreadRange({
            baseEndCharacter: baseRange.end.character,
            baseEndLine: baseRange.end.line,
            baseStartCharacter: baseRange.start.character,
            baseStartLine: baseRange.start.line,
            visibleRanges: editor.visibleRanges.map((visibleRange) => ({
                endCharacter: visibleRange.end.character,
                endLine: visibleRange.end.line,
                startCharacter: visibleRange.start.character,
                startLine: visibleRange.start.line,
            })),
        });
        return this.createMinimalThreadRangeAt(
            editor.document,
            new vscode.Position(adjustedRange.startLine, adjustedRange.startCharacter),
        );
    }

    private updateRenderedThreadViewportRanges(editor: vscode.TextEditor, reason: string) {
        const uriKey = editor.document.uri.toString();
        const threads = this.threadsByUri.get(uriKey);
        if (!threads || threads.size===0) {
            return;
        }
        let adjustedThreadCount = 0;
        for (const thread of threads.values()) {
            if (!thread.overleafThreadId || this.isPendingDraftThread(thread)) {
                continue;
            }
            if (thread.overleafPinnedToStartAnchor) {
                continue;
            }
            const nextRange = this.resolveViewportAdjustedThreadRange(thread, editor);
            if (thread.range.isEqual(nextRange)) {
                continue;
            }
            this.assignThreadRangeIfChanged(thread, nextRange);
            adjustedThreadCount += 1;
        }
        if (adjustedThreadCount===0) {
            return;
        }
        const firstVisibleRange = editor.visibleRanges[0];
        this.logDiagnostic('render.thread_ranges_adjusted_for_viewport', {
            adjustedThreadCount,
            reason,
            uri: uriKey,
            visibleRangeEnd: firstVisibleRange
                ? `${firstVisibleRange.end.line}:${firstVisibleRange.end.character}`
                : '',
            visibleRangeStart: firstVisibleRange
                ? `${firstVisibleRange.start.line}:${firstVisibleRange.start.character}`
                : '',
        });
    }

    private resetCommentingRangeProvider(reason: string) {
        // Reassigning the provider forces VS Code's comments controller to
        // invalidate cached commenting ranges. Local replica draft creation
        // relies on that refresh because the public API has no explicit
        // "commenting ranges changed" event.
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: async (document) => this.provideCommentingRanges(document),
        };
        this.logDiagnostic('commenting_ranges_provider_reset', {reason});
    }

    private getSelectionTrackedCommentThread() {
        // Use editor/selection heuristics only. The stable VS Code comments API
        // does not expose the active inline comment widget, and the proposed
        // active-comment API cannot be used in the shipped extension.
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            return undefined;
        }
        const threads = this.threadsByUri.get(activeEditor.document.uri.toString());
        if (!threads || threads.size===0) {
            return undefined;
        }
        const activeSelection = activeEditor.selection;
        const activePosition = activeSelection.active;
        for (const thread of threads.values()) {
            const interactionRange = this.getThreadInteractionRange(thread);
            if (interactionRange.contains(activePosition)
                || interactionRange.start.isEqual(activeSelection.start)
                || interactionRange.end.isEqual(activeSelection.end)
                || thread.range.contains(activePosition)
                || thread.range.start.isEqual(activeSelection.start)
                || thread.range.end.isEqual(activeSelection.end)) {
                return thread;
            }
        }
        return undefined;
    }

    private findRenderedThreadAtSelection(
        renderUri: vscode.Uri,
        selection: vscode.Selection,
    ) {
        const threads = this.threadsByUri.get(renderUri.toString());
        if (!threads || threads.size===0) {
            return undefined;
        }
        const selectionRange = new vscode.Range(selection.start, selection.end);
        for (const thread of threads.values()) {
            const interactionRange = this.getThreadInteractionRange(thread);
            if (interactionRange.contains(selection.active)
                || interactionRange.start.isEqual(selection.start)
                || (!selection.isEmpty && interactionRange.intersection(selectionRange)!==undefined)
                || thread.range.contains(selection.active)
                || thread.range.start.isEqual(selection.start)
                || (!selection.isEmpty && thread.range.intersection(selectionRange)!==undefined)) {
                return thread;
            }
        }
        return undefined;
    }

    private resolveRenderedThreadStateKey(renderUri: vscode.Uri, thread: OverleafCommentThreadHandle) {
        const fallbackThreadKey = thread.overleafDraftId
            ?? `${thread.range.start.line}:${thread.range.start.character}:${thread.range.end.line}:${thread.range.end.character}`;
        return this.toLifecycleObservationKey(renderUri.toString(), thread.overleafThreadId ?? fallbackThreadKey);
    }

    private recordObservedThreadCollapsibleState(renderUri: vscode.Uri, thread: OverleafCommentThreadHandle) {
        this.collapsibleStateByUriThreadId.set(
            this.resolveRenderedThreadStateKey(renderUri, thread),
            thread.collapsibleState,
        );
    }

    private scheduleInlineCommentClickFocus(
        editor: vscode.TextEditor,
        selection: vscode.Selection,
        selectionKind: vscode.TextEditorSelectionChangeKind | undefined,
    ) {
        if (selection.isEmpty===false) {
            return;
        }
        if (selectionKind===vscode.TextEditorSelectionChangeKind.Keyboard
            || selectionKind===vscode.TextEditorSelectionChangeKind.Command) {
            return;
        }
        const renderUri = editor.document.uri;
        const observedThread = this.findRenderedThreadAtSelection(renderUri, selection);
        if (!observedThread || this.isPendingDraftThread(observedThread)) {
            return;
        }
        const observedThreadId = observedThread.overleafThreadId;
        const observedStateKey = this.resolveRenderedThreadStateKey(renderUri, observedThread);
        const observedSelection = new vscode.Selection(selection.start, selection.end);
        const observedCollapsibleState = observedThread.collapsibleState;

        if (this.inlineCommentClickFocusTimer) {
            clearTimeout(this.inlineCommentClickFocusTimer);
        }
        this.inlineCommentClickFocusTimer = setTimeout(() => {
            this.inlineCommentClickFocusTimer = undefined;
            if (this.providerDisposed) {
                return;
            }
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor.document.uri.toString()!==renderUri.toString()) {
                return;
            }
            if (!activeEditor.selection.isEqual(observedSelection)) {
                return;
            }

            const currentThread = (observedThreadId
                ? this.findRenderedThreadById(renderUri, observedThreadId)
                : undefined)
                ?? this.findRenderedThreadAtSelection(renderUri, activeEditor.selection);
            if (!currentThread || this.isPendingDraftThread(currentThread)) {
                return;
            }

            const currentCollapsibleState = currentThread.collapsibleState;
            const previousCollapsibleState = this.collapsibleStateByUriThreadId.get(observedStateKey)
                ?? observedCollapsibleState;
            this.recordObservedThreadCollapsibleState(renderUri, currentThread);
            if (currentCollapsibleState!==vscode.CommentThreadCollapsibleState.Expanded
                || previousCollapsibleState===vscode.CommentThreadCollapsibleState.Expanded) {
                return;
            }

            void this.focusCommentThreadInEditor(
                renderUri,
                new vscode.Selection(currentThread.range.start, currentThread.range.start),
                'mouse_open_inline_comment',
                currentThread.overleafThreadId,
            );
        }, InlineCommentProvider.INLINE_COMMENT_CLICK_FOCUS_DELAY_MS);
    }

    private async scanForExternallyExpandedThreads() {
        if (this.providerDisposed) {
            return;
        }
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || !this.isOverleafDocument(activeEditor.document)) {
            return;
        }
        const renderUri = activeEditor.document.uri;
        const threads = this.threadsByUri.get(renderUri.toString());
        if (!threads || threads.size===0) {
            return;
        }

        let expandedThread: OverleafCommentThreadHandle | undefined;
        for (const thread of threads.values()) {
            if (this.isPendingDraftThread(thread)) {
                continue;
            }
            const stateKey = this.resolveRenderedThreadStateKey(renderUri, thread);
            const currentState = thread.collapsibleState;
            const previousState = this.collapsibleStateByUriThreadId.get(stateKey) ?? currentState;
            this.collapsibleStateByUriThreadId.set(stateKey, currentState);
            if (!expandedThread
                && currentState===vscode.CommentThreadCollapsibleState.Expanded
                && previousState!==vscode.CommentThreadCollapsibleState.Expanded) {
                expandedThread = thread;
            }
        }

        if (!expandedThread) {
            return;
        }

        await this.focusCommentThreadInEditor(
            renderUri,
            new vscode.Selection(expandedThread.range.start, expandedThread.range.start),
            'detected_expanded_inline_comment',
            expandedThread.overleafThreadId,
        );
    }

    private isNativeLocalReplicaDraftThread(
        thread: vscode.CommentThread | undefined,
        uri: vscode.Uri,
        selection: vscode.Selection,
    ) {
        if (!thread || thread.uri.toString()!==uri.toString()) {
            return false;
        }
        return this.getThreadInteractionRange(thread).intersection(new vscode.Range(selection.start, selection.end))!==undefined
            || thread.range.intersection(new vscode.Range(selection.start, selection.end))!==undefined;
    }

    private getPendingLocalReplicaCommentingRanges(uri: vscode.Uri) {
        const uriKey = uri.toString();
        const pending = this.temporaryLocalReplicaCommentingRangesByUri.get(uriKey);
        if (!pending) {
            return undefined;
        }
        if (Date.now() > pending.expiresAt) {
            this.temporaryLocalReplicaCommentingRangesByUri.delete(uriKey);
            return undefined;
        }
        return pending.ranges;
    }

    private clearPendingLocalReplicaCommentingRanges(uri: vscode.Uri, reason: string) {
        const uriKey = uri.toString();
        if (!this.temporaryLocalReplicaCommentingRangesByUri.delete(uriKey)) {
            return;
        }
        this.resetCommentingRangeProvider(`clear:${reason}`);
        this.logDiagnostic('draft_thread.commenting_ranges_cleared', {
            reason,
            uri: uriKey,
        });
    }

    private stagePendingLocalReplicaDraft(context: AddCommentCommandContext) {
        const {editor, selection, uri} = context;
        const selectedText = editor.document.getText(selection);
        if (selectedText.length===0) {
            throw new Error(vscode.l10n.t('Select text before creating an Overleaf comment.'));
        }

        const uriKey = uri.toString();
        const draftId = `local-draft-${++this.localReplicaDraftThreadSequence}`;
        const pendingDrafts = (this.pendingLocalReplicaDraftsByUri.get(uriKey) ?? [])
            .filter((candidate) => Date.now() - candidate.createdAt <= InlineCommentProvider.LOCAL_REPLICA_DRAFT_TIMEOUT_MS);
        pendingDrafts.push({
            createdAt: Date.now(),
            draftId,
            endOffset: editor.document.offsetAt(selection.end),
            selection: new vscode.Selection(selection.start, selection.end),
            selectedText,
            startOffset: editor.document.offsetAt(selection.start),
        });
        this.pendingLocalReplicaDraftsByUri.set(uriKey, pendingDrafts);

        // Only expose a commenting range for the exact selection while the native
        // add-comment command is running. This restores VS Code's richer thread
        // template UI without reintroducing the persistent local gutter "+" UI.
        this.temporaryLocalReplicaCommentingRangesByUri.set(uriKey, {
            expiresAt: Date.now() + InlineCommentProvider.LOCAL_REPLICA_COMMENTING_RANGE_TIMEOUT_MS,
            ranges: [new vscode.Range(selection.start, selection.end)],
        });
        this.logDiagnostic('draft_thread.staged_native_template', {
            draftId,
            selectionLength: selectedText.length,
            uri: uriKey,
        });
        return draftId;
    }

    private consumePendingLocalReplicaDraftContext(thread: OverleafCommentThreadHandle) {
        const uriKey = thread.uri.toString();
        const pendingDrafts = (this.pendingLocalReplicaDraftsByUri.get(uriKey) ?? [])
            .filter((candidate) => Date.now() - candidate.createdAt <= InlineCommentProvider.LOCAL_REPLICA_DRAFT_TIMEOUT_MS);
        if (pendingDrafts.length===0) {
            this.pendingLocalReplicaDraftsByUri.delete(uriKey);
            return undefined;
        }

        let candidateIndex = pendingDrafts.length===1
            ? 0
            : pendingDrafts.findIndex((candidate) => candidate.selection.start.line===thread.range.start.line);
        if (candidateIndex < 0) {
            candidateIndex = pendingDrafts.length - 1;
        }
        const [pendingDraft] = pendingDrafts.splice(candidateIndex, 1);
        if (pendingDrafts.length===0) {
            this.pendingLocalReplicaDraftsByUri.delete(uriKey);
        } else {
            this.pendingLocalReplicaDraftsByUri.set(uriKey, pendingDrafts);
        }
        return pendingDraft;
    }

    private adoptPendingLocalReplicaDraftThread(thread: OverleafCommentThreadHandle) {
        if (thread.overleafPendingSelection
            && thread.overleafPendingSelectedText!==undefined
            && thread.overleafPendingStartOffset!==undefined
            && thread.overleafPendingEndOffset!==undefined) {
            return;
        }
        const pendingDraft = this.consumePendingLocalReplicaDraftContext(thread);
        if (!pendingDraft) {
            return;
        }
        thread.overleafDraftId = pendingDraft.draftId;
        thread.overleafPendingEndOffset = pendingDraft.endOffset;
        thread.overleafPendingSelection = pendingDraft.selection;
        thread.overleafPendingSelectedText = pendingDraft.selectedText;
        thread.overleafPendingStartOffset = pendingDraft.startOffset;
        this.logDiagnostic('draft_thread.native_template_adopted', {
            draftId: pendingDraft.draftId,
            uri: thread.uri.toString(),
        });
    }

    private isLocalReplicaDraftThread(thread: OverleafCommentThreadHandle) {
        return Boolean(
            thread.overleafDraftId
            && !thread.overleafThreadId
            && resolveProjectWorkspaceModeForUri(thread.uri)==='localReplica',
        );
    }

    private isPendingDraftThread(thread: OverleafCommentThreadHandle) {
        return Boolean(thread.overleafDraftId && !thread.overleafThreadId);
    }

    private isOptimisticCreateThread(thread: OverleafCommentThreadHandle) {
        return Boolean(
            thread.overleafOptimisticCreateThreadId
            && thread.overleafThreadId===thread.overleafOptimisticCreateThreadId,
        );
    }

    private ensureTrackedSubmittedDraftThread(
        thread: OverleafCommentThreadHandle,
        selection: vscode.Selection,
        selectedText: string,
        startOffset: number,
        endOffset: number,
        draftIdPrefix: string,
    ) {
        const draftId = thread.overleafDraftId ?? `${draftIdPrefix}-${++this.localReplicaDraftThreadSequence}`;
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.contextValue = 'overleafThreadDraft';
        thread.label = formatCommentThreadPreview(selectedText);
        thread.overleafDraftId = draftId;
        thread.overleafPinnedToStartAnchor = true;
        thread.overleafPendingEndOffset = endOffset;
        thread.overleafPendingSelection = new vscode.Selection(selection.start, selection.end);
        thread.overleafPendingSelectedText = selectedText;
        thread.overleafPendingStartOffset = startOffset;
        thread.state = vscode.CommentThreadState.Unresolved;
        const existingThread = this.threadsByUri.get(thread.uri.toString())?.get(draftId);
        if (existingThread!==thread) {
            this.registerThread(thread.uri, draftId, thread);
        }
        return draftId;
    }

    private registerThread(renderUri: vscode.Uri, threadKey: string, thread: OverleafCommentThreadHandle) {
        const uriKey = renderUri.toString();
        const threads = this.threadsByUri.get(uriKey) ?? new Map<string, OverleafCommentThreadHandle>();
        const replacedHandle = threads.get(threadKey);
        threads.set(threadKey, thread);
        this.threadsByUri.set(uriKey, threads);
        this.logDiagnostic('thread_map.registered', {
            handleId: this.getThreadHandleId(thread),
            replacedHandleId: replacedHandle ? this.getThreadHandleId(replacedHandle) : -1,
            threadKey,
            threadKeyCount: threads.size,
            uri: uriKey,
        });
    }

    private unregisterThread(renderUri: vscode.Uri, threadKey: string) {
        const uriKey = renderUri.toString();
        const threads = this.threadsByUri.get(uriKey);
        if (!threads) {
            return;
        }
        const removedThread = threads.get(threadKey);
        threads.delete(threadKey);
        if (removedThread) {
            this.logDiagnostic('thread_map.unregistered', {
                handleId: this.getThreadHandleId(removedThread),
                threadKey,
                threadKeyCount: threads.size,
                uri: uriKey,
            });
        }
        if (threads.size===0) {
            this.threadsByUri.delete(uriKey);
        }
    }

    private hasRenderedThread(renderUri: vscode.Uri, threadId: string) {
        return Boolean(this.threadsByUri.get(renderUri.toString())?.has(threadId));
    }

    private async ensureCreatedThreadMaterialized(renderUri: vscode.Uri, threadId: string, reason: string) {
        if (this.hasRenderedThread(renderUri, threadId)) {
            return true;
        }
        await this.syncUri(renderUri, `${reason}_materialize`);
        if (this.hasRenderedThread(renderUri, threadId)) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 75));
        await this.syncUri(renderUri, `${reason}_materialize_retry`);
        return this.hasRenderedThread(renderUri, threadId);
    }

    private async finalizeSubmittedDraftThread(
        renderUri: vscode.Uri,
        threadId: string,
        draftThread: OverleafCommentThreadHandle,
        reason: string,
        attempt = 0,
    ) {
        const draftId = draftThread.overleafDraftId ?? '';
        const materialized = await this.ensureCreatedThreadMaterialized(
            renderUri,
            threadId,
            reason,
        );
        if (!materialized) {
            draftThread.canReply = false;
            this.logDiagnostic('draft_thread.materialization_pending', {
                attempt,
                createdThreadId: threadId,
                draftId,
                uri: renderUri.toString(),
            });
            if (attempt < 4) {
                setTimeout(() => {
                    void this.finalizeSubmittedDraftThread(renderUri, threadId, draftThread, reason, attempt + 1);
                }, 250);
            }
            return;
        }
        if (draftId) {
            this.unregisterThread(renderUri, draftId);
        }
        this.disposeTrackedThread(renderUri, draftThread, 'draft_thread_materialized_cleanup', {
            draftId,
            threadId,
        });
        this.logDiagnostic('draft_thread.materialized_cleanup_completed', {
            attempt,
            createdThreadId: threadId,
            draftId,
            uri: renderUri.toString(),
        });
    }

    private async createCommentThreadFromSelection(
        renderUri: vscode.Uri,
        binding: CommentUriBinding,
        selection: vscode.Selection,
        content: string,
        options: {
            endOffset: number,
            selectedText: string,
            startOffset: number,
        },
        reason: string,
    ) {
        const createSpan = startDiagnosticSpan('InlineComments', 'comments.create_from_selection', {
            overleafUri: binding.overleafUri.toString(),
            rangeEnd: `${selection.end.line}:${selection.end.character}`,
            rangeStart: `${selection.start.line}:${selection.start.character}`,
            reason,
            renderUri: renderUri.toString(),
            selectedTextLength: options.selectedText.length,
        }, {
            category: 'comments',
            level: 'info',
        });
        const traceFields = withDiagnosticTraceFields({
            overleafUri: binding.overleafUri.toString(),
            reason,
            renderUri: renderUri.toString(),
        }, createSpan.traceContext);
        const createStartedAtMs = Date.now();
        const snapshotThreadCountBeforeCreate = this.snapshotsByUri.get(renderUri.toString())?.threads.length ?? 0;
        let pendingCreatedThreadFocusRequestId: number | undefined;
        let optimisticThread: OverleafCommentThreadHandle | undefined;
        const threadId = generateCommentThreadId();
        const localMessageId = `pending-comment-${threadId}`;
        const localMessageTimestamp = new Date().toISOString();
        let focusApplied = false;
        let focusStabilizationScheduled = false;
        try {
            if (!this.initialCommentsOpenViewSuppressionSettled) {
                await this.initialCommentsOpenViewSuppression.catch((error) => {
                    this.logDiagnostic('comments_panel_auto_open_initial_suppression_failed_before_create', {
                        ...traceFields,
                        threadId,
                    }, error);
                });
            }
            const vfs = await this.getReadyCommentVfs(binding.overleafUri, reason);
            pendingCreatedThreadFocusRequestId = this.enqueuePendingCreatedCommentFocus(
                renderUri,
                selection,
                reason,
                snapshotThreadCountBeforeCreate,
            );
            const document = this.getOpenDocument(renderUri) ?? await vscode.workspace.openTextDocument(renderUri);
            const localMessage = vfs.createLocalPendingCommentMessage(content, localMessageId, localMessageTimestamp);
            optimisticThread = this.createOptimisticSubmittedCommentThread({
                document,
                localMessage,
                overleafUri: binding.overleafUri,
                renderUri,
                selectedText: options.selectedText,
                selection,
                threadId,
                vfs,
            });
            const optimisticFocusStartedAtMs = Date.now();
            focusApplied = await this.focusCommentThread(renderUri, {
                reason: `${reason}_optimistic_thread`,
                selection,
                threadId,
            });
            const optimisticFocusCompletedAtMs = Date.now();
            this.recordCommentDebugEvent('create_comment_thread.optimistic_focus_completed', {
                ...traceFields,
                elapsedSinceCreateStartMs: Math.max(0, optimisticFocusCompletedAtMs - createStartedAtMs),
                focusApplied,
                focusDurationMs: Math.max(0, optimisticFocusCompletedAtMs - optimisticFocusStartedAtMs),
                pendingFocusRequestId: pendingCreatedThreadFocusRequestId ?? -1,
                threadId,
            });
            this.logDiagnostic('create_comment_thread.optimistic_focus_completed', {
                ...traceFields,
                elapsedSinceCreateStartMs: Math.max(0, optimisticFocusCompletedAtMs - createStartedAtMs),
                focusApplied,
                focusDurationMs: Math.max(0, optimisticFocusCompletedAtMs - optimisticFocusStartedAtMs),
                pendingFocusRequestId: pendingCreatedThreadFocusRequestId ?? -1,
                threadId,
            });
            if (focusApplied) {
                this.scheduleCreatedThreadFocusStabilization(
                    renderUri,
                    threadId,
                    `${reason}_optimistic_thread`,
                );
                focusStabilizationScheduled = true;
                this.removePendingCreatedCommentFocus(
                    renderUri,
                    pendingCreatedThreadFocusRequestId,
                    'completed_after_optimistic_focus',
                );
            }
            this.logDiagnostic('create_comment_thread.local_mutation_requested', {
                ...traceFields,
                connectionPhase: vfs.realtimeConnectionPhase,
                isOfflineMode: vfs.isOfflineMode,
                syncMode: vfs.synchronizationMode,
                threadId,
            });
            const createdThreadId = await vfs.createComment(binding.overleafUri, selection, content, {
                ...options,
                diagnosticTraceContext: createSpan.traceContext,
                localMessage,
                localMessageId,
                localMessageTimestamp,
                threadId,
            });
            const refreshedLocally = await this.refreshUriFromVfsState(
                renderUri,
                binding.overleafUri,
                vfs,
                `${reason}_local_state`,
                {
                    expectedThreadId: createdThreadId,
                    preferLocalSnapshot: true,
                },
            );
            const renderedAfterLocalRefresh = this.hasRenderedThread(renderUri, createdThreadId);
            this.logDiagnostic('create_comment_thread.local_refresh_completed', {
                ...traceFields,
                refreshedLocally,
                renderedAfterLocalRefresh,
                snapshotThreadCount: this.snapshotsByUri.get(renderUri.toString())?.threads.length ?? 0,
                threadId: createdThreadId,
            });
            const reviewRefreshPromise = this.requestTargetedReviewRefreshForCommentMutation({
                overleafUri: binding.overleafUri,
                reasonWhenOffline: 'comments_changed:thread_created_offline',
                reasonWhenOnline: 'comments_changed:thread_created_queued_after_connectivity_failure',
                traceFields,
                threadId: createdThreadId,
                vfs,
            });
            if (!refreshedLocally || !renderedAfterLocalRefresh) {
                await this.ensureCreatedThreadMaterialized(renderUri, createdThreadId, reason);
            }
            const focusStartedAtMs = Date.now();
            if (!focusApplied) {
                focusApplied = await this.focusCommentThread(renderUri, {
                    reason: `${reason}_created_thread`,
                    selection,
                    threadId: createdThreadId,
                });
            }
            const focusCompletedAtMs = Date.now();
            const pendingFocusRequestRetained = !focusApplied
                && this.hasPendingCreatedCommentFocusRequest(renderUri, pendingCreatedThreadFocusRequestId);
            this.recordCommentDebugEvent('create_comment_thread.inline_focus_completed', {
                ...traceFields,
                elapsedSinceCreateStartMs: Math.max(0, focusCompletedAtMs - createStartedAtMs),
                focusApplied,
                focusDurationMs: Math.max(0, focusCompletedAtMs - focusStartedAtMs),
                pendingFocusRequestId: pendingCreatedThreadFocusRequestId ?? -1,
                pendingFocusRequestRetained,
                threadId: createdThreadId,
            });
            this.logDiagnostic('create_comment_thread.inline_focus_completed', {
                ...traceFields,
                elapsedSinceCreateStartMs: Math.max(0, focusCompletedAtMs - createStartedAtMs),
                focusApplied,
                focusDurationMs: Math.max(0, focusCompletedAtMs - focusStartedAtMs),
                pendingFocusRequestId: pendingCreatedThreadFocusRequestId ?? -1,
                pendingFocusRequestRetained,
                threadId: createdThreadId,
            });
            if (focusApplied) {
                if (!focusStabilizationScheduled) {
                    this.scheduleCreatedThreadFocusStabilization(
                        renderUri,
                        createdThreadId,
                        `${reason}_created_thread`,
                    );
                    focusStabilizationScheduled = true;
                }
                this.removePendingCreatedCommentFocus(
                    renderUri,
                    pendingCreatedThreadFocusRequestId,
                    'completed_after_direct_focus',
                );
            } else if (pendingFocusRequestRetained) {
                this.recordCommentDebugEvent('create_comment_thread.inline_focus_deferred_to_pending_request', {
                    ...traceFields,
                    pendingFocusRequestId: pendingCreatedThreadFocusRequestId ?? -1,
                    threadId: createdThreadId,
                });
                this.logDiagnostic('create_comment_thread.inline_focus_deferred_to_pending_request', {
                    ...traceFields,
                    pendingFocusRequestId: pendingCreatedThreadFocusRequestId ?? -1,
                    threadId: createdThreadId,
                });
            }
            await reviewRefreshPromise;
            createSpan.end({
                focusApplied,
                renderedAfterCreate: this.hasRenderedThread(renderUri, createdThreadId),
                threadId: createdThreadId,
            });
            return createdThreadId;
        } catch (error) {
            this.removePendingCreatedCommentFocus(renderUri, pendingCreatedThreadFocusRequestId, 'create_failed');
            if (optimisticThread && this.findRenderedThreadById(renderUri, threadId)===optimisticThread) {
                this.unregisterThread(renderUri, threadId);
                this.disposeTrackedThread(renderUri, optimisticThread, 'optimistic_create_thread_failed', {
                    threadId,
                });
            }
            createSpan.fail(error, {
                ...traceFields,
            });
            throw error;
        }
    }

    private async requestTargetedReviewRefreshForCommentMutation(options: {
        reasonWhenOffline: string,
        reasonWhenOnline: string,
        traceFields: Record<string, unknown>,
        vfs: VirtualFileSystem,
        overleafUri: vscode.Uri,
        threadId: string,
    }) {
        const snapshot = await options.vfs.getCommentSnapshotFromLocalState(options.overleafUri)
            ?? await options.vfs.getCommentSnapshot(options.overleafUri);
        const reviewRefreshReason = options.vfs.isOfflineMode
            ? options.reasonWhenOffline
            : options.reasonWhenOnline;
        const reviewRefreshDocIds = snapshot?.docId ? [snapshot.docId] : undefined;
        const projectWide = shouldTreatCommentsChangedRefreshAsProjectWide({
            docIds: reviewRefreshDocIds,
            reason: reviewRefreshReason,
        });
        await this.renderAuthoritativeReviewEntriesFromLocalState({
            docIds: reviewRefreshDocIds,
            reason: reviewRefreshReason,
            traceFields: {
                ...options.traceFields,
                projectWide,
                threadId: options.threadId,
            },
            vfs: options.vfs,
        });
        this.recordCommentDebugEvent('review_refresh_requested', {
            docIds: reviewRefreshDocIds ?? [],
            projectWide,
            reason: reviewRefreshReason,
            threadId: options.threadId,
            traceFields: options.traceFields,
        });
        void vscode.commands.executeCommand(`${ROOT_NAME}.review.refresh`, {
            docIds: reviewRefreshDocIds,
            immediate: true,
            origin: options.vfs.origin.toString(),
            reason: reviewRefreshReason,
        }).then(
            () => {
                this.logDiagnostic('comment_thread.review_refresh_requested_after_local_mutation', {
                    ...options.traceFields,
                    projectWide,
                    reviewRefreshDocId: snapshot?.docId ?? '',
                    reviewRefreshReason,
                    threadId: options.threadId,
                });
            },
            (error) => {
                this.logDiagnostic('comment_thread.review_refresh_failed_after_local_mutation', {
                    ...options.traceFields,
                    projectWide,
                    reviewRefreshDocId: snapshot?.docId ?? '',
                    reviewRefreshReason,
                    threadId: options.threadId,
                }, error);
            },
        );

        // Local mutation events can arrive before range/thread reconciliation has
        // fully settled during offline/recovery transitions. Queue a short
        // follow-up refresh so review and inline converge deterministically.
        setTimeout(() => {
            void vscode.commands.executeCommand(`${ROOT_NAME}.review.refresh`, {
                docIds: reviewRefreshDocIds,
                immediate: true,
                origin: options.vfs.origin.toString(),
                reason: `${reviewRefreshReason}:settle`,
            }).then(
                () => {
                    this.logDiagnostic('comment_thread.review_refresh_requested_after_local_mutation_settle', {
                        ...options.traceFields,
                        projectWide,
                        reviewRefreshDocId: snapshot?.docId ?? '',
                        reviewRefreshReason: `${reviewRefreshReason}:settle`,
                        threadId: options.threadId,
                    });
                },
                (error) => {
                    this.logDiagnostic('comment_thread.review_refresh_failed_after_local_mutation_settle', {
                        ...options.traceFields,
                        projectWide,
                        reviewRefreshDocId: snapshot?.docId ?? '',
                        reviewRefreshReason: `${reviewRefreshReason}:settle`,
                        threadId: options.threadId,
                    }, error);
                },
            );
        }, 140);
    }

    private findRenderedThreadById(
        renderUri: vscode.Uri,
        threadId: string | undefined,
    ) {
        if (!threadId) {
            return undefined;
        }
        const threads = this.threadsByUri.get(renderUri.toString());
        if (!threads || threads.size===0) {
            return undefined;
        }
        const directMatch = threads.get(threadId);
        if (directMatch) {
            return directMatch;
        }
        for (const [threadKey, thread] of threads.entries()) {
            if (threadKey===threadId || thread.overleafThreadId===threadId) {
                return thread;
            }
        }
        return undefined;
    }

    private async focusCommentThreadInEditor(
        renderUri: vscode.Uri,
        anchorSelection: vscode.Selection,
        reason: string,
        threadId?: string,
        attempt = 0,
    ): Promise<boolean> {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.uri.toString()!==renderUri.toString()) {
            this.logDiagnostic('comment_thread_focus_skipped_inactive_editor', {
                attempt,
                reason,
                threadId: threadId ?? '',
                uri: renderUri.toString(),
            });
            return false;
        }

        activeEditor.selection = anchorSelection;
        activeEditor.revealRange(
            new vscode.Range(anchorSelection.start, anchorSelection.end),
            vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );

        const renderedThread = threadId
            ? this.findRenderedThreadById(renderUri, threadId)
            : this.findRenderedThreadAtSelection(renderUri, anchorSelection);
        if (shouldSkipBuiltInCommentLineFocus({
            mode: resolveProjectWorkspaceModeForUri(renderUri),
            threadExpanded: renderedThread?.collapsibleState===vscode.CommentThreadCollapsibleState.Expanded,
        })) {
            this.logDiagnostic('comment_thread_focus_applied_without_builtin_command', {
                attempt,
                reason,
                threadExpanded: true,
                threadId: threadId ?? '',
                uri: renderUri.toString(),
            });
            return true;
        }

        try {
            await vscode.commands.executeCommand('workbench.action.focusCommentOnCurrentLine');
            this.logDiagnostic('comment_thread_focus_applied_unverified', {
                attempt,
                reason,
                threadId: threadId ?? '',
                uri: renderUri.toString(),
            });
            return true;
        } catch (error) {
            if (attempt + 1 >= InlineCommentProvider.commentThreadFocusMaxAttempts) {
                this.logDiagnostic('comment_thread_focus_failed', {
                    attempt,
                    reason,
                    threadId: threadId ?? '',
                    uri: renderUri.toString(),
                }, error);
                return false;
            }
        }

        await new Promise((resolve) => setTimeout(resolve, InlineCommentProvider.commentThreadFocusRetryDelayMs));
        return this.focusCommentThreadInEditor(renderUri, anchorSelection, reason, threadId, attempt + 1);
    }

    private async focusCommentThread(
        renderUri: vscode.Uri,
        options: {
            reason: string,
            selection?: vscode.Selection,
            threadId?: string,
        },
    ): Promise<boolean> {
        let renderedThread = this.findRenderedThreadById(renderUri, options.threadId);
        if (options.threadId && !renderedThread) {
            await this.syncUri(renderUri, `${options.reason}_focus_materialize`);
            renderedThread = this.findRenderedThreadById(renderUri, options.threadId);
        }

        if (options.threadId && !renderedThread && !options.selection) {
            this.logDiagnostic('comment_thread_focus_skipped_unrendered_thread', {
                reason: options.reason,
                threadId: options.threadId,
                uri: renderUri.toString(),
            });
            return false;
        }

        const threadAnchor = renderedThread?.range.start ?? options.selection?.start;
        if (!threadAnchor) {
            this.logDiagnostic('comment_thread_focus_skipped_missing_anchor', {
                reason: options.reason,
                threadId: options.threadId ?? '',
                uri: renderUri.toString(),
            });
            return false;
        }

        if (renderedThread) {
            renderedThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
            this.recordObservedThreadCollapsibleState(renderUri, renderedThread);
        }
        const anchorSelection = new vscode.Selection(threadAnchor, threadAnchor);

        try {
            const document = await vscode.workspace.openTextDocument(renderUri);
            const editor = await vscode.window.showTextDocument(document, {
                preview: false,
                selection: options.selection ?? anchorSelection,
            });
            editor.selection = anchorSelection;
            editor.revealRange(
                new vscode.Range(threadAnchor, threadAnchor),
                vscode.TextEditorRevealType.InCenterIfOutsideViewport,
            );
        } catch (error) {
            this.logDiagnostic('comment_thread_focus_failed', {
                reason: options.reason,
                threadId: options.threadId ?? '',
                uri: renderUri.toString(),
            }, error);
            return false;
        }

        return this.focusCommentThreadInEditor(
            renderUri,
            anchorSelection,
            options.reason,
            options.threadId,
        );
    }

    private scheduleCreatedThreadFocusStabilization(
        renderUri: vscode.Uri,
        threadId: string,
        reason: string,
    ) {
        setTimeout(() => {
            if (this.providerDisposed) {
                return;
            }
            const activeEditor = vscode.window.activeTextEditor;
            if (!activeEditor || activeEditor.document.uri.toString()!==renderUri.toString()) {
                return;
            }
            const renderedThread = this.findRenderedThreadById(renderUri, threadId);
            if (!renderedThread || renderedThread.collapsibleState!==vscode.CommentThreadCollapsibleState.Expanded) {
                return;
            }
            void this.focusCommentThreadInEditor(
                renderUri,
                new vscode.Selection(renderedThread.range.start, renderedThread.range.start),
                `${reason}_focus_stabilize`,
                threadId,
            );
        }, InlineCommentProvider.createdThreadFocusStabilizationDelayMs);
    }

    private async projectReviewThreadEntryFromLocalState(options: {
        messageId?: string,
        overleafUri: vscode.Uri,
        threadId: string,
        traceFields: Record<string, unknown>,
        vfs: VirtualFileSystem,
    }) {
        try {
            const entry = await options.vfs.getLocalCommentReviewEntry(options.overleafUri, {
                messageId: options.messageId,
                threadId: options.threadId,
            });
            EventBus.fire('reviewThreadProjectionEvent', {
                entry,
                messageId: options.messageId,
                origin: options.vfs.origin.toString(),
                threadId: options.threadId,
            });
            ReviewViewProvider.notifyProjectedThreadEntryForOrigin(options.vfs.origin.toString(), {
                entry,
                messageId: options.messageId,
                threadId: options.threadId,
            });
            this.logDiagnostic('comment_thread.review_projection_emitted_after_local_mutation', {
                ...options.traceFields,
                hasProjectedEntry: Boolean(entry),
                messageId: options.messageId ?? '',
                projectedThreadId: entry?.threadId ?? '',
                threadId: options.threadId,
            });
        } catch (error) {
            this.logDiagnostic('comment_thread.review_projection_failed_after_local_mutation', {
                ...options.traceFields,
                messageId: options.messageId ?? '',
                threadId: options.threadId,
            }, error);
        }
    }

    private async renderAuthoritativeReviewEntriesFromLocalState(options: {
        docIds?: string[],
        reason: string,
        traceFields: Record<string, unknown>,
        vfs: VirtualFileSystem,
    }) {
        const normalizedDocIds = options.docIds?.filter((docId) => typeof docId === 'string' && docId.length > 0);
        try {
            const authoritativeEntries = await options.vfs.getProjectCommentReviewEntries({
                blockingHydration: false,
                docIds: normalizedDocIds,
                preferLocalState: true,
                reason: options.reason,
            });
            const renderedDirectly = ReviewViewProvider.renderAuthoritativeLocalEntriesForProject({
                docIds: normalizedDocIds,
                entries: authoritativeEntries,
                origin: options.vfs.origin.toString(),
                projectId: options.vfs.projectId,
                reason: options.reason,
            });
            this.recordCommentDebugEvent('review_authoritative_render_requested', {
                authoritativeEntryCount: authoritativeEntries.length,
                docCount: normalizedDocIds?.length ?? 0,
                reason: options.reason,
                renderedDirectly,
                traceFields: options.traceFields,
            });
            this.logDiagnostic('comment_thread.review_authoritative_local_render_requested', {
                ...options.traceFields,
                authoritativeEntryCount: authoritativeEntries.length,
                docCount: normalizedDocIds?.length ?? 0,
                renderedDirectly,
                reviewRefreshReason: options.reason,
            });
        } catch (error) {
            this.logDiagnostic('comment_thread.review_authoritative_local_render_failed', {
                ...options.traceFields,
                docCount: normalizedDocIds?.length ?? 0,
                reviewRefreshReason: options.reason,
            }, error);
        }
    }

    private createThreadPermissionsFromVfs(
        vfs: VirtualFileSystem,
        threadId: string,
    ) {
        const permissions = vfs.getCommentThreadPermissions(threadId);
        return {
            canDeleteComment: permissions.canDeleteComment ?? (() => false),
            canDeleteThread: Boolean(permissions.canDeleteThread),
            canEditComment: permissions.canEditComment ?? (() => false),
            canResolveThread: Boolean(permissions.canResolveThread),
            currentUserId: vfs._userId,
            permissions,
        } satisfies OverleafThreadPermissionsHandle;
    }

    private createOptimisticSubmittedCommentThread(options: {
        document: vscode.TextDocument,
        localMessage: OverleafCommentMessage,
        overleafUri: vscode.Uri,
        renderUri: vscode.Uri,
        selectedText: string,
        selection: vscode.Selection,
        threadId: string,
        vfs: VirtualFileSystem,
    }) {
        const threadDisplayRange = this.createThreadDisplayRange(options.document, options.selection);
        const permissions = this.createThreadPermissionsFromVfs(options.vfs, options.threadId);
        const colorDocId = this.snapshotsByUri.get(options.renderUri.toString())?.docId
            ?? options.overleafUri.toString();
        const userColor = this.resolveCommentUserColor(colorDocId, options.localMessage);
        const comment = this.buildComment(
            options.renderUri,
            options.overleafUri,
            options.threadId,
            permissions,
            options.localMessage,
            userColor.color,
            true,
        );
        const existingThread = this.findRenderedThreadById(options.renderUri, options.threadId);
        const thread = existingThread
            ?? this.createTrackedCommentThread(
                options.renderUri,
                threadDisplayRange,
                [comment],
                'optimistic_create_comment_thread',
                options.threadId,
            );

        this.assignThreadCommentsIfChanged(thread, [comment]);
        this.assignThreadDisplayBaseRangeIfChanged(thread, threadDisplayRange);
        this.assignThreadRangeIfChanged(thread, threadDisplayRange);
        thread.canReply = permissions.permissions.comment;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.contextValue = buildThreadContextValue(permissions.canResolveThread);
        thread.label = formatCommentThreadPreview(options.selectedText);
        thread.overleafOptimisticCreateThreadId = options.threadId;
        thread.overleafPendingEndOffset = options.document.offsetAt(options.selection.end);
        thread.overleafPendingSelection = new vscode.Selection(options.selection.start, options.selection.end);
        thread.overleafPendingSelectedText = options.selectedText;
        thread.overleafPendingStartOffset = options.document.offsetAt(options.selection.start);
        thread.overleafPinnedToStartAnchor = true;
        thread.overleafUri = options.overleafUri;
        thread.overleafThreadId = options.threadId;
        thread.state = vscode.CommentThreadState.Unresolved;
        this.registerThread(options.renderUri, options.threadId, thread);
        this.recordObservedThreadCollapsibleState(options.renderUri, thread);
        this.logDiagnostic('create_comment_thread.optimistic_thread_rendered', {
            handleId: this.getThreadHandleId(thread),
            rangeStart: `${threadDisplayRange.start.line}:${threadDisplayRange.start.character}`,
            selectedTextLength: options.selectedText.length,
            threadId: options.threadId,
            uri: options.renderUri.toString(),
        });
        return thread;
    }

    private async createManualLocalReplicaDraftThread(
        context: AddCommentCommandContext,
        binding: CommentUriBinding,
    ) {
        const {editor, selection, uri} = context;
        const selectedText = editor.document.getText(selection);
        if (selectedText.length===0) {
            throw new Error(vscode.l10n.t('Select text before creating an Overleaf comment.'));
        }

        const draftId = `local-draft-${++this.localReplicaDraftThreadSequence}`;
        const threadDisplayRange = this.createThreadDisplayRange(editor.document, selection);
        const thread = this.createTrackedCommentThread(
            uri,
            threadDisplayRange,
            [],
            'manual_local_replica_draft_thread_create',
            draftId,
        );

        // Local replica editors do not use the built-in commenting ranges UI, so
        // create an explicit draft thread and let Return submit it through the
        // same Overleaf-backed createComment pipeline used by other mutations.
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.comments = [];
        thread.contextValue = 'overleafThreadDraft';
        thread.label = formatCommentThreadPreview(selectedText);
        thread.overleafDraftId = draftId;
        thread.overleafPinnedToStartAnchor = true;
        thread.overleafPendingEndOffset = editor.document.offsetAt(selection.end);
        thread.overleafPendingSelection = new vscode.Selection(selection.start, selection.end);
        thread.overleafPendingSelectedText = selectedText;
        thread.overleafPendingStartOffset = editor.document.offsetAt(selection.start);
        thread.overleafDisplayBaseRange = threadDisplayRange;
        thread.overleafUri = binding.overleafUri;
        thread.state = vscode.CommentThreadState.Unresolved;

        this.registerThread(uri, draftId, thread);
        this.logDiagnostic('draft_thread.created', {
            draftId,
            selectionLength: selectedText.length,
            uri: uri.toString(),
        });
    }

    private async createManualCurrentWindowDraftThread(
        context: AddCommentCommandContext,
        binding: CommentUriBinding,
    ) {
        const {editor, selection, uri} = context;
        const selectedText = editor.document.getText(selection);
        if (selectedText.length===0) {
            throw new Error(vscode.l10n.t('Select text before creating an Overleaf comment.'));
        }

        const draftId = `current-window-draft-${++this.localReplicaDraftThreadSequence}`;
        const threadDisplayRange = this.createThreadDisplayRange(editor.document, selection);
        const thread = this.createTrackedCommentThread(
            uri,
            threadDisplayRange,
            [],
            'manual_current_window_draft_thread_create',
            draftId,
        );

        // Mirror local-replica submit safety: keep a tracked draft anchor with the
        // original selection metadata until the canonical created thread renders.
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        thread.comments = [];
        thread.contextValue = 'overleafThreadDraft';
        thread.label = formatCommentThreadPreview(selectedText);
        thread.overleafDraftId = draftId;
        thread.overleafPinnedToStartAnchor = true;
        thread.overleafPendingEndOffset = editor.document.offsetAt(selection.end);
        thread.overleafPendingSelection = new vscode.Selection(selection.start, selection.end);
        thread.overleafPendingSelectedText = selectedText;
        thread.overleafPendingStartOffset = editor.document.offsetAt(selection.start);
        thread.overleafDisplayBaseRange = threadDisplayRange;
        thread.overleafUri = binding.overleafUri;
        thread.state = vscode.CommentThreadState.Unresolved;

        this.registerThread(uri, draftId, thread);
        this.logDiagnostic('draft_thread.created_current_window_manual', {
            draftId,
            selectionLength: selectedText.length,
            uri: uri.toString(),
        });
        return thread;
    }

    private async createLocalReplicaDraftThread(
        context: AddCommentCommandContext,
        binding: CommentUriBinding,
    ) {
        const {selection, uri} = context;
        const draftId = this.stagePendingLocalReplicaDraft(context);
        try {
            this.resetCommentingRangeProvider('native_template_prepare');
            await new Promise((resolve) => setTimeout(resolve, 0));
            await vscode.commands.executeCommand('workbench.action.addComment', {
                range: new vscode.Range(selection.start, selection.end),
            });
            await new Promise((resolve) => setTimeout(resolve, 75));
            const selectionTrackedThread = this.getSelectionTrackedCommentThread();
            if (!this.isNativeLocalReplicaDraftThread(selectionTrackedThread, uri, selection)) {
                throw new Error('Native local replica comment template was not created.');
            }
            this.logDiagnostic('draft_thread.native_template_requested', {
                draftId,
                overleafUri: binding.overleafUri.toString(),
                uri: uri.toString(),
            });
        } catch (error) {
            this.clearPendingLocalReplicaCommentingRanges(uri, 'native_template_failed');
            const uriKey = uri.toString();
            const remainingDrafts = (this.pendingLocalReplicaDraftsByUri.get(uriKey) ?? [])
                .filter((candidate) => candidate.draftId!==draftId);
            if (remainingDrafts.length===0) {
                this.pendingLocalReplicaDraftsByUri.delete(uriKey);
            } else {
                this.pendingLocalReplicaDraftsByUri.set(uriKey, remainingDrafts);
            }
            this.logDiagnostic('draft_thread.native_template_failed', {
                draftId,
                uri: uri.toString(),
            }, error);
            await this.createManualLocalReplicaDraftThread(context, binding);
            return;
        }

        setTimeout(() => {
            this.clearPendingLocalReplicaCommentingRanges(uri, 'native_template_completed');
        }, InlineCommentProvider.LOCAL_REPLICA_COMMENTING_RANGE_TIMEOUT_MS);
    }

    private async submitLocalReplicaDraftThread(
        thread: OverleafCommentThreadHandle,
        content: string,
    ) {
        const draftId = thread.overleafDraftId;
        const selection = thread.overleafPendingSelection;
        const selectedText = thread.overleafPendingSelectedText;
        const startOffset = thread.overleafPendingStartOffset;
        const endOffset = thread.overleafPendingEndOffset;
        if (!selection || selectedText===undefined || startOffset===undefined || endOffset===undefined) {
            throw new Error(vscode.l10n.t('The local Overleaf comment draft is missing its selected text.'));
        }

        const binding = await this.resolveCommentDocumentBinding(thread.uri);
        if (!binding || binding.mode!=='localReplica') {
            throw new Error(vscode.l10n.t('Open a local Overleaf replica document before creating a comment.'));
        }

        const threadId = await this.createCommentThreadFromSelection(
            thread.uri,
            binding,
            selection,
            content,
            {
                endOffset,
                selectedText,
                startOffset,
            },
            'create_comment_from_local_replica_thread',
        );
        if (draftId) {
            // Only remove the draft once the real Overleaf thread has
            // materialized inline. If rendering lags, keep the draft anchor
            // visible to avoid losing the inline icon immediately after submit.
            await this.finalizeSubmittedDraftThread(
                thread.uri,
                threadId,
                thread,
                'create_comment_from_local_replica_thread',
            );
            this.logDiagnostic('draft_thread.submitted', {
                createdThreadId: threadId,
                draftId,
                inlineMaterialized: this.hasRenderedThread(thread.uri, threadId),
                uri: thread.uri.toString(),
            });
            return;
        }
        this.disposeTrackedThread(thread.uri, thread, 'draft_thread_submitted_without_draft_id', {
            createdThreadId: threadId,
        });
        this.logDiagnostic('draft_thread.submitted', {
            createdThreadId: threadId,
            draftId: draftId ?? '',
            uri: thread.uri.toString(),
        });
    }

    private async submitCurrentWindowDraftThread(
        thread: OverleafCommentThreadHandle,
        content: string,
    ) {
        const binding = await this.resolveCommentDocumentBinding(thread.uri);
        if (!binding || binding.mode!=='currentWindow') {
            throw new Error(vscode.l10n.t('Open an Overleaf-backed document before creating a comment.'));
        }
        const document = this.getOpenDocument(thread.uri) ?? await vscode.workspace.openTextDocument(thread.uri);
        const draftSelection = this.resolveCurrentWindowDraftSelection(thread, document);
        const selection = draftSelection.selection;
        if (selection.isEmpty) {
            throw new Error(vscode.l10n.t('Select text before creating an Overleaf comment.'));
        }
        const selectedText = draftSelection.selectedText;
        const startOffset = draftSelection.startOffset;
        const endOffset = draftSelection.endOffset;
        const draftId = this.ensureTrackedSubmittedDraftThread(
            thread,
            selection,
            selectedText,
            startOffset,
            endOffset,
            'current-window-draft',
        );
        const threadId = await this.createCommentThreadFromSelection(
            thread.uri,
            binding,
            selection,
            content,
            {
                endOffset,
                selectedText,
                startOffset,
            },
            'create_comment_from_current_window_draft_thread',
        );
        await this.finalizeSubmittedDraftThread(
            thread.uri,
            threadId,
            thread,
            'create_comment_from_current_window_draft_thread',
        );
        this.logDiagnostic('draft_thread.submitted_current_window', {
            createdThreadId: threadId,
            draftId,
            inlineMaterialized: this.hasRenderedThread(thread.uri, threadId),
            selectionSource: draftSelection.selectionSource,
            selectionLength: selectedText.length,
            uri: thread.uri.toString(),
        });
        return threadId;
    }

    private resolveCurrentWindowDraftSelection(
        thread: OverleafCommentThreadHandle,
        document: vscode.TextDocument,
    ) {
        if (thread.overleafPendingSelection
            && thread.overleafPendingSelectedText!==undefined
            && thread.overleafPendingStartOffset!==undefined
            && thread.overleafPendingEndOffset!==undefined) {
            return {
                endOffset: thread.overleafPendingEndOffset,
                selectedText: thread.overleafPendingSelectedText,
                selection: thread.overleafPendingSelection,
                selectionSource: 'tracked_pending_selection',
                startOffset: thread.overleafPendingStartOffset,
            };
        }

        const activeEditor = vscode.window.visibleTextEditors.find((candidate) => {
            return candidate.document.uri.toString()===thread.uri.toString();
        });
        const matchingEditorSelection = activeEditor?.selections.find((candidate) => {
            if (candidate.isEmpty) {
                return false;
            }
            const interactionRange = this.getThreadInteractionRange(thread);
            return candidate.intersection(interactionRange)!==undefined
                || candidate.contains(interactionRange.start)
                || candidate.intersection(thread.range)!==undefined
                || candidate.contains(thread.range.start)
                || candidate.start.line===interactionRange.start.line;
        });
        if (matchingEditorSelection) {
            return {
                endOffset: document.offsetAt(matchingEditorSelection.end),
                selectedText: document.getText(matchingEditorSelection),
                selection: new vscode.Selection(matchingEditorSelection.start, matchingEditorSelection.end),
                selectionSource: 'active_editor_selection',
                startOffset: document.offsetAt(matchingEditorSelection.start),
            };
        }

        const fallbackRange = this.getThreadInteractionRange(thread);
        const fallbackSelection = new vscode.Selection(fallbackRange.start, fallbackRange.end);
        return {
            endOffset: document.offsetAt(fallbackSelection.end),
            selectedText: document.getText(fallbackSelection),
            selection: fallbackSelection,
            selectionSource: 'thread_range_fallback',
            startOffset: document.offsetAt(fallbackSelection.start),
        };
    }

    private buildThreadHoverMessage(thread: OverleafCommentThread | undefined) {
        const firstMessage = thread?.messages[0];
        if (!firstMessage) {
            return undefined;
        }
        const markdown = new vscode.MarkdownString(undefined, true);
        markdown.isTrusted = false;
        const author = describeCommentAuthor(firstMessage).name;
        const timestamp = formatOverleafCommentTimestamp(firstMessage.timestamp) ?? '';
        markdown.appendMarkdown(`**${author}**  \n${timestamp}`);
        markdown.appendMarkdown(`\n\n${firstMessage.content.trim() || vscode.l10n.t('(empty comment)')}`);
        if ((thread?.messages.length ?? 0) > 1) {
            markdown.appendMarkdown(`\n\n_${vscode.l10n.t('{count} replies', {count: (thread?.messages.length ?? 1) - 1})}_`);
        }
        markdown.appendMarkdown(`\n\n${vscode.l10n.t('Click the comment icon to open the thread.')}`);
        return markdown;
    }

    private createAuthorBadgeIcon(color: string) {
        const cached = this.authorBadgeIconByColor.get(color);
        if (cached) {
            return cached;
        }
        const svg = [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${InlineCommentProvider.AUTHOR_BADGE_WIDTH_PX}" height="${InlineCommentProvider.AUTHOR_BADGE_HEIGHT_PX}" viewBox="0 0 ${InlineCommentProvider.AUTHOR_BADGE_WIDTH_PX} ${InlineCommentProvider.AUTHOR_BADGE_HEIGHT_PX}">`,
            `<rect x="${InlineCommentProvider.AUTHOR_BADGE_RECT_X_PX}" y="${InlineCommentProvider.AUTHOR_BADGE_RECT_Y_PX}" width="${InlineCommentProvider.AUTHOR_BADGE_RECT_WIDTH_PX}" height="${InlineCommentProvider.AUTHOR_BADGE_RECT_HEIGHT_PX}" rx="3" fill="${color}" stroke="rgba(255,255,255,0.28)" stroke-width="1"/>`,
            '</svg>',
        ].join('');
        const iconUri = vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
        this.authorBadgeIconByColor.set(color, iconUri);
        return iconUri;
    }

    private clearCommentColorState() {
        this.authorBadgeIconByColor.clear();
        this.commentUserColorsByDocId.clear();
    }

    private async refreshCommentColorRendering(reason: string) {
        this.clearCommentColorState();
        const openDocuments = vscode.workspace.textDocuments.filter((document) => this.isOverleafDocument(document));
        this.logDiagnostic('render.color_palette_refresh_started', {
            documentCount: openDocuments.length,
            reason,
            usedDefaultPalette: this.commentUserPalette.usedDefaultPalette,
        });
        await Promise.all(openDocuments.map((document) => this.syncUri(document.uri, reason)));
    }

    private async reloadCommentUserPalette(reason: string) {
        const nextPalette = getConfiguredCommentUserPalette();
        const paletteChanged = JSON.stringify(nextPalette.palette)!==JSON.stringify(this.commentUserPalette.palette);
        this.commentUserPalette = nextPalette;
        if (nextPalette.usedDefaultPalette) {
            this.logDiagnostic('color_palette_invalid_configuration', {
                configuredItemCount: nextPalette.configuredItemCount,
                paletteSize: nextPalette.palette.length,
                reason,
            });
        }
        if (!paletteChanged) {
            return;
        }
        await this.refreshCommentColorRendering(reason);
    }

    private resolveCommentUserColor(docId: string, message: OverleafCommentMessage) {
        let colorsByUser = this.commentUserColorsByDocId.get(docId);
        if (!colorsByUser) {
            colorsByUser = new Map<string, string>();
            this.commentUserColorsByDocId.set(docId, colorsByUser);
        }
        const userIdentifier = resolveCommentUserIdentifier(message);
        const existing = colorsByUser.get(userIdentifier);
        if (existing) {
            return {
                color: existing,
                isNew: false,
                userIdentifier,
            };
        }
        const color = resolveCommentUserColorByIndex(colorsByUser.size, this.commentUserPalette.palette);
        colorsByUser.set(userIdentifier, color);
        return {
            color,
            isNew: true,
            userIdentifier,
        };
    }

    private buildComment(
        renderUri: vscode.Uri,
        overleafUri: vscode.Uri,
        threadId: string,
        threadPermissions: OverleafThreadPermissionsHandle,
        message: OverleafCommentMessage,
        color: string,
        isThreadRoot: boolean,
    ): OverleafVSCodeComment {
        const isLocalPendingMessage = message.id.startsWith('pending-comment-') || message.id.startsWith('offline-comment-');
        const canEditComment = threadPermissions.canEditComment(message.user_id)
            || (isLocalPendingMessage && threadPermissions.permissions.comment);
        const canDeleteComment = threadPermissions.canDeleteComment(message.user_id)
            || (isLocalPendingMessage && threadPermissions.permissions.comment);
        const effectiveCurrentUserId = threadPermissions.currentUserId ?? message.user_id;
        const effectiveMessageUserId = isLocalPendingMessage
            ? (threadPermissions.currentUserId ?? message.user_id)
            : message.user_id;
        const authorInfo = describeCommentAuthor(message);
        const comment: OverleafVSCodeComment = {
            author: {
                ...authorInfo,
                iconPath: this.createAuthorBadgeIcon(color),
            },
            body: message.content,
            contextValue: buildCommentContextValue({
                ...threadPermissions.permissions,
                canDeleteComment,
                canEditComment,
            }, effectiveMessageUserId, effectiveCurrentUserId, {
                canResolveThread: threadPermissions.canResolveThread,
                isThreadRoot,
            }),
            mode: vscode.CommentMode.Preview,
            overleafMessageId: message.id,
            overleafRenderUri: renderUri,
            overleafThreadId: threadId,
            overleafUri,
            overleafUserId: message.user_id,
        };
        const formattedTimestamp = formatOverleafCommentTimestamp(message.timestamp);
        if (formattedTimestamp) {
            comment.label = formattedTimestamp;
        }
        return comment;
    }

    private async getThreadPermissions(overleafUri: vscode.Uri, threadId: string) {
        const vfs = await this.vfsm.prefetch(overleafUri);
        const permissions = vfs.getCommentThreadPermissions(threadId);
        return {
            canDeleteComment: permissions.canDeleteComment ?? (() => false),
            canDeleteThread: Boolean(permissions.canDeleteThread),
            canEditComment: permissions.canEditComment ?? (() => false),
            canResolveThread: Boolean(permissions.canResolveThread),
            currentUserId: vfs._userId,
            permissions,
        } satisfies OverleafThreadPermissionsHandle;
    }

    private async syncUri(renderUri: vscode.Uri, reason: string) {
        const uriKey = renderUri.toString();
        const currentPromise = this.refreshPromises.get(uriKey);
        if (currentPromise) {
            const queuedReasons = this.queuedSyncReasonsByUri.get(uriKey) ?? new Set<string>();
            queuedReasons.add(reason);
            this.queuedSyncReasonsByUri.set(uriKey, queuedReasons);
            this.logDiagnostic('render.queued', {
                queueDepth: queuedReasons.size,
                reason,
                uri: renderUri.toString(),
            });
            await currentPromise;
            const nextPromise = this.refreshPromises.get(uriKey);
            if (nextPromise && nextPromise!==currentPromise) {
                return nextPromise;
            }
            return;
        }

        const refreshPromise = (async () => {
            const document = this.getOpenDocument(renderUri);
            if (!document || !this.isOverleafDocument(document)) {
                this.disposeThreadsForUri(renderUri);
                return;
            }

            const binding = await this.resolveCommentDocumentBinding(renderUri);
            if (!binding) {
                const renderedThreadCount = this.threadsByUri.get(uriKey)?.size ?? 0;
                if (renderedThreadCount > 0) {
                    this.logDiagnostic('render.unmapped_document_preserved_local', {
                        reason,
                        renderedThreadCount,
                        uri: renderUri.toString(),
                    });
                    this.scheduleTransientRehydration(renderUri, reason);
                    return;
                }
                this.disposeThreadsForUri(renderUri);
                this.logDiagnostic('render.skipped_unmapped_document', {
                    reason,
                    renderedThreadCount,
                    uri: renderUri.toString(),
                });
                return;
            }

            this.overleafUriByRenderUri.set(uriKey, binding.overleafUri.toString());
            this.logDiagnostic('render.started', {
                overleafUri: binding.overleafUri.toString(),
                reason,
                uri: renderUri.toString(),
            });
            const vfs = await this.getReadyCommentVfs(binding.overleafUri, `sync_uri:${reason}`);
            const refreshed = await this.refreshUriFromVfsState(renderUri, binding.overleafUri, vfs, reason);
            if (refreshed) {
                this.scheduleStartupPanelSuppression(renderUri, reason);
            }
        })().catch((error) => {
            this.logDiagnostic('render.failed', {reason, uri: renderUri.toString()}, error);
        }).finally(() => {
            this.refreshPromises.delete(uriKey);
            const queuedReasons = this.queuedSyncReasonsByUri.get(uriKey);
            if (queuedReasons && queuedReasons.size > 0) {
                this.queuedSyncReasonsByUri.delete(uriKey);
                void this.syncUri(renderUri, `queued:${Array.from(queuedReasons).join('|')}`);
            }
        });

        this.refreshPromises.set(uriKey, refreshPromise);
        return refreshPromise;
    }

    private syncVisibleEditors(reason: string, editors = vscode.window.visibleTextEditors) {
        const overleafEditors = editors.filter((editor) => this.isOverleafDocument(editor.document));
        this.logDiagnostic('render.visible_editors_sync_started', {
            reason,
            visibleEditorCount: overleafEditors.length,
        });
        return Promise.all(overleafEditors.map((editor) => this.syncUri(editor.document.uri, reason)));
    }

    private scheduleReplyRefreshSuppression(uri: vscode.Uri, threadId: string) {
        const uriKey = uri.toString();
        const existing = this.suppressedReplyRefreshByUri.get(uriKey);
        if (existing) {
            clearTimeout(existing.timeout);
        }
        const suppression: PendingCommentRefreshSuppression & {
            timeout: ReturnType<typeof setTimeout>,
        } = {
            expiresAt: Date.now() + InlineCommentProvider.REPLY_REFRESH_SUPPRESSION_TIMEOUT_MS,
            threadId,
            timeout: setTimeout(() => {
                const current = this.suppressedReplyRefreshByUri.get(uriKey);
                if (current===suppression) {
                    this.suppressedReplyRefreshByUri.delete(uriKey);
                }
            }, InlineCommentProvider.REPLY_REFRESH_SUPPRESSION_TIMEOUT_MS),
        };
        this.suppressedReplyRefreshByUri.set(uriKey, suppression);
        this.logDiagnostic('reply.refresh_suppressed', {
            expiresAt: suppression.expiresAt,
            threadId,
            uri: uriKey,
        });
    }

    private clearReplyRefreshSuppression(uri: vscode.Uri) {
        const uriKey = uri.toString();
        const suppression = this.suppressedReplyRefreshByUri.get(uriKey);
        if (!suppression) {
            return;
        }
        clearTimeout(suppression.timeout);
        this.suppressedReplyRefreshByUri.delete(uriKey);
    }

    private shouldSuppressCommentsChangedRefresh(uri: vscode.Uri, reason: string, threadIds?: string[]) {
        const uriKey = uri.toString();
        const suppression = this.suppressedReplyRefreshByUri.get(uriKey);
        const suppress = shouldSuppressCommentRefresh({
            pending: suppression,
            reason,
            threadIds,
        });
        if (!suppression) {
            return false;
        }
        if (!suppress && Date.now() >= suppression.expiresAt) {
            this.clearReplyRefreshSuppression(uri);
        }
        return suppress;
    }

    private isPendingCreatedCommentFocusReason(reason: string) {
        return reason==='thread_created'
            || reason==='thread_created_offline'
            || reason==='thread_created_queued_after_connectivity_failure';
    }

    private getPendingCreatedCommentFocusRequests(renderUri: vscode.Uri) {
        const uriKey = renderUri.toString();
        const now = Date.now();
        const requests = this.pendingCreatedCommentFocusByUri.get(uriKey) ?? [];
        const pending = requests.filter((candidate) => {
            return now - candidate.createdAt <= InlineCommentProvider.PENDING_CREATED_THREAD_FOCUS_TIMEOUT_MS;
        });
        const expired = requests.filter((candidate) => {
            return now - candidate.createdAt > InlineCommentProvider.PENDING_CREATED_THREAD_FOCUS_TIMEOUT_MS;
        });
        if (expired.length > 0) {
            this.recordCommentDebugEvent('comment_thread.pending_focus_expired', {
                expiredRequestCount: expired.length,
                expiredRequestIds: expired.map((candidate) => candidate.requestId),
                uri: uriKey,
            });
            this.logDiagnostic('comment_thread.pending_focus_expired', {
                expiredRequestCount: expired.length,
                expiredRequestIds: expired.map((candidate) => candidate.requestId),
                uri: uriKey,
            });
        }
        if (pending.length===0) {
            this.pendingCreatedCommentFocusByUri.delete(uriKey);
            return [];
        }
        this.pendingCreatedCommentFocusByUri.set(uriKey, pending);
        return pending;
    }

    private enqueuePendingCreatedCommentFocus(
        renderUri: vscode.Uri,
        selection: vscode.Selection,
        reason: string,
        snapshotThreadCountBeforeCreate: number,
    ) {
        const requestId = ++this.pendingCreatedCommentFocusRequestSequence;
        const uriKey = renderUri.toString();
        const pending = this.getPendingCreatedCommentFocusRequests(renderUri);
        pending.push({
            createdAt: Date.now(),
            reason,
            requestId,
            selection: new vscode.Selection(selection.start, selection.end),
            snapshotThreadCountBeforeCreate,
        });
        this.pendingCreatedCommentFocusByUri.set(uriKey, pending);
        this.recordCommentDebugEvent('comment_thread.pending_focus_enqueued', {
            reason,
            requestId,
            snapshotThreadCountBeforeCreate,
            uri: uriKey,
            ...this.formatSelectionForDiagnostics(selection),
        });
        this.logDiagnostic('comment_thread.pending_focus_enqueued', {
            reason,
            requestId,
            snapshotThreadCountBeforeCreate,
            uri: uriKey,
            ...this.formatSelectionForDiagnostics(selection),
        });
        return requestId;
    }

    private hasPendingCreatedCommentFocusRequest(renderUri: vscode.Uri, requestId: number | undefined) {
        if (requestId===undefined) {
            return false;
        }
        return (this.pendingCreatedCommentFocusByUri.get(renderUri.toString()) ?? [])
            .some((candidate) => candidate.requestId===requestId);
    }

    private removePendingCreatedCommentFocus(
        renderUri: vscode.Uri,
        requestId: number | undefined,
        reason = 'removed',
    ) {
        if (requestId===undefined) {
            return;
        }
        const uriKey = renderUri.toString();
        const pendingRequests = this.getPendingCreatedCommentFocusRequests(renderUri);
        const removedRequest = pendingRequests.find((candidate) => candidate.requestId===requestId);
        if (!removedRequest) {
            return;
        }
        const pending = pendingRequests
            .filter((candidate) => candidate.requestId!==requestId);
        if (pending.length===0) {
            this.pendingCreatedCommentFocusByUri.delete(uriKey);
        } else {
            this.pendingCreatedCommentFocusByUri.set(uriKey, pending);
        }
        this.recordCommentDebugEvent('comment_thread.pending_focus_removed', {
            reason,
            remainingPendingRequestCount: pending.length,
            requestId,
            requestReason: removedRequest.reason,
            snapshotThreadCountBeforeCreate: removedRequest.snapshotThreadCountBeforeCreate,
            uri: uriKey,
            ...this.formatSelectionForDiagnostics(removedRequest.selection),
        });
        this.logDiagnostic('comment_thread.pending_focus_removed', {
            reason,
            remainingPendingRequestCount: pending.length,
            requestId,
            requestReason: removedRequest.reason,
            snapshotThreadCountBeforeCreate: removedRequest.snapshotThreadCountBeforeCreate,
            uri: uriKey,
            ...this.formatSelectionForDiagnostics(removedRequest.selection),
        });
    }

    private async fulfillPendingCreatedCommentFocus(
        renderUri: vscode.Uri,
        reason: string,
        threadIds?: string[],
    ) {
        if (!this.isPendingCreatedCommentFocusReason(reason) || !threadIds || threadIds.length===0) {
            return;
        }

        const threadId = threadIds.find((candidate) => candidate.length > 0);
        if (!threadId) {
            return;
        }

        if (!this.hasRenderedThread(renderUri, threadId)) {
            const pendingRequestCount = this.getPendingCreatedCommentFocusRequests(renderUri).length;
            if (pendingRequestCount > 0) {
                this.recordCommentDebugEvent('comment_thread.pending_focus_waiting_for_render', {
                    eventReason: reason,
                    pendingRequestCount,
                    threadId,
                    uri: renderUri.toString(),
                });
                this.logDiagnostic('comment_thread.pending_focus_waiting_for_render', {
                    eventReason: reason,
                    pendingRequestCount,
                    threadId,
                    uri: renderUri.toString(),
                });
            }
            return;
        }

        const pendingRequests = this.getPendingCreatedCommentFocusRequests(renderUri);
        const request = pendingRequests[0];
        if (!request) {
            this.recordCommentDebugEvent('comment_thread.pending_focus_missing_request', {
                eventReason: reason,
                threadId,
                uri: renderUri.toString(),
            });
            this.logDiagnostic('comment_thread.pending_focus_missing_request', {
                eventReason: reason,
                threadId,
                uri: renderUri.toString(),
            });
            return;
        }

        this.recordCommentDebugEvent('comment_thread.pending_focus_fulfilling', {
            eventReason: reason,
            requestId: request.requestId,
            requestReason: request.reason,
            snapshotThreadCountBeforeCreate: request.snapshotThreadCountBeforeCreate,
            threadId,
            uri: renderUri.toString(),
            ...this.formatSelectionForDiagnostics(request.selection),
        });
        this.logDiagnostic('comment_thread.pending_focus_fulfilling', {
            eventReason: reason,
            requestId: request.requestId,
            requestReason: request.reason,
            snapshotThreadCountBeforeCreate: request.snapshotThreadCountBeforeCreate,
            threadId,
            uri: renderUri.toString(),
            ...this.formatSelectionForDiagnostics(request.selection),
        });
        const focusApplied = await this.focusCommentThread(renderUri, {
            reason: `comments_changed_event:${reason}_pending_create_focus`,
            selection: request.selection,
            threadId,
        });
        this.recordCommentDebugEvent('comment_thread.pending_focus_fulfilled', {
            eventReason: reason,
            focusApplied,
            requestId: request.requestId,
            requestReason: request.reason,
            threadId,
            uri: renderUri.toString(),
        });
        this.logDiagnostic('comment_thread.pending_focus_fulfilled', {
            eventReason: reason,
            focusApplied,
            requestId: request.requestId,
            requestReason: request.reason,
            threadId,
            uri: renderUri.toString(),
        });
        if (focusApplied) {
            this.removePendingCreatedCommentFocus(
                renderUri,
                request.requestId,
                'fulfilled_by_comments_changed_event',
            );
        }
    }

    private async refreshThreadFromLocalState(thread: OverleafCommentThreadHandle, vfs?: VirtualFileSystem) {
        if (!thread.overleafThreadId || !thread.overleafUri) {
            return false;
        }
        const renderUri = thread.uri;
        const uriKey = renderUri.toString();
        const readyVfs = vfs ?? await this.getReadyCommentVfs(thread.overleafUri, 'refresh_thread_from_local_state');
        const snapshot = await readyVfs.getCommentSnapshotFromLocalState(thread.overleafUri)
            ?? await readyVfs.getCommentSnapshot(thread.overleafUri);
        if (!snapshot) {
            return false;
        }
        const normalizedThreads = dedupeDocumentCommentSnapshotThreadsByThreadId(snapshot.threads);
        const entry = normalizedThreads.find(({range}) => range.op.t===thread.overleafThreadId);
        if (!entry?.thread || entry.thread.messages.length===0 || entry.thread.resolved) {
            return false;
        }

        const permissions = await this.getThreadPermissions(thread.overleafUri, thread.overleafThreadId);
        const comments = entry.thread.messages.map((message, index) => {
            const userColor = this.resolveCommentUserColor(snapshot.docId, message);
            return this.buildComment(renderUri, thread.overleafUri!, thread.overleafThreadId!, permissions, message, userColor.color, index===0);
        });

        this.snapshotsByUri.set(uriKey, {
            ...snapshot,
            threads: normalizedThreads,
        });
        this.transientRangesByUri.set(uriKey, normalizedThreads.map(({range}) => cloneCommentRange(range)));
        this.assignThreadCommentsIfChanged(thread, comments);
        if (thread.canReply!==permissions.permissions.comment) {
            thread.canReply = permissions.permissions.comment;
        }
        const contextValue = buildThreadContextValue(permissions.canResolveThread);
        if (thread.contextValue!==contextValue) {
            thread.contextValue = contextValue;
        }
        const label = formatCommentThreadPreview(entry.range.op.c);
        if (thread.label!==label) {
            thread.label = label;
        }
        if (thread.state!==vscode.CommentThreadState.Unresolved) {
            thread.state = vscode.CommentThreadState.Unresolved;
        }
        thread.overleafDocId = snapshot.docId;
        thread.overleafThreadId = entry.range.op.t;
        thread.overleafOptimisticCreateThreadId = undefined;

        this.logDiagnostic('reply.local_refresh_completed', {
            messageCount: comments.length,
            threadId: thread.overleafThreadId,
            uri: uriKey,
        });
        return true;
    }

    private normalizeTrackedHandleUriBucket(renderUri: vscode.Uri, reason: string, renderSequence: number) {
        const uriKey = renderUri.toString();
        const currentBucket = this.createdThreadHandlesByUri.get(uriKey) ?? new Set<OverleafCommentThreadHandle>();
        let migratedHandleCount = 0;
        for (const [candidateUriKey, candidateHandles] of this.createdThreadHandlesByUri.entries()) {
            if (candidateUriKey===uriKey) {
                continue;
            }
            for (const candidateThread of Array.from(candidateHandles)) {
                if (candidateThread.uri.toString()!==uriKey) {
                    continue;
                }
                candidateHandles.delete(candidateThread);
                currentBucket.add(candidateThread);
                migratedHandleCount += 1;
            }
            if (candidateHandles.size===0) {
                this.createdThreadHandlesByUri.delete(candidateUriKey);
            }
        }
        if (currentBucket.size > 0) {
            this.createdThreadHandlesByUri.set(uriKey, currentBucket);
        }
        if (migratedHandleCount > 0) {
            this.logDiagnostic('render.tracked_handle_uri_bucket_normalized', {
                migratedHandleCount,
                reason,
                renderSequence,
                uri: uriKey,
            });
        }
    }

    private async renderUri(
        renderUri: vscode.Uri,
        overleafUri: vscode.Uri,
        snapshot: OverleafDocumentCommentSnapshot,
        reason = 'unspecified',
        vfs?: VirtualFileSystem,
    ) {
        const uriKey = renderUri.toString();
        const document = this.getOpenDocument(renderUri);
        if (!document) {
            return;
        }
        const commentVfs = vfs ?? await this.getReadyCommentVfs(overleafUri, `render_uri:${reason}`);

        const renderSequence = (this.renderSequenceByUri.get(uriKey) ?? 0) + 1;
        this.renderSequenceByUri.set(uriKey, renderSequence);

        const snapshotThreads = snapshot.threads;
        const transientRanges = this.transientRangesByUri.get(uriKey) ?? snapshotThreads.map(({range}) => cloneCommentRange(range));
        const transientRangeByThreadId = new Map(transientRanges.map((range) => [range.op.t, range] as const));
        let existingThreads = this.threadsByUri.get(uriKey) ?? new Map<string, OverleafCommentThreadHandle>();
        this.normalizeTrackedHandleUriBucket(renderUri, reason, renderSequence);
        const existingThreadKeyCountBeforeRebuild = existingThreads.size;
        const trackedHandleCountBeforeRender = this.createdThreadHandlesByUri.get(uriKey)?.size ?? 0;
        const preserveMissingThreads = this.shouldPreserveExistingThreadsDuringRender(commentVfs, reason);
        const forceRebuild = this.shouldForceRemoteThreadRebuild(
            renderUri,
            reason,
            existingThreads.size,
            trackedHandleCountBeforeRender,
        );
        if (forceRebuild) {
            this.disposeKnownThreadHandlesForRenderUri(renderUri, existingThreads, reason, renderSequence);
            existingThreads = new Map<string, OverleafCommentThreadHandle>();
        }
        this.pruneTrackedThreadHandleDuplicatesByThreadId(existingThreads, renderUri, reason, renderSequence);
        this.pruneLeakedTrackedThreadHandles(existingThreads, renderUri, reason, renderSequence);
        const duplicateSummaryBeforePrune = this.summarizeDuplicateThreadHandles(existingThreads);
        this.logDiagnostic('render.lifecycle_started', {
            duplicateOverleafThreadIdCount: duplicateSummaryBeforePrune.length,
            existingThreadKeyCount: existingThreads.size,
            existingThreadKeyCountBeforeRebuild,
            forceRebuild,
            reason,
            renderSequence,
            snapshotThreadCount: snapshotThreads.length,
            trackedHandleCount: trackedHandleCountBeforeRender,
            uri: uriKey,
        });
        if (duplicateSummaryBeforePrune.length > 0) {
            this.logDiagnostic('render.lifecycle_started_with_duplicates', {
                duplicates: duplicateSummaryBeforePrune,
                reason,
                renderSequence,
                uri: uriKey,
            });
            logCommentDiagnostics('InlineComments', 'invariants', 'render.invariant_duplicate_thread_handles_detected', {
                duplicateOverleafThreadIdCount: duplicateSummaryBeforePrune.length,
                reason,
                renderSequence,
                uri: uriKey,
            });
        }
        this.pruneDuplicateExistingThreadsByThreadId(existingThreads, renderUri, reason, renderSequence);
        const existingThreadsByOverleafThreadId = new Map<string, OverleafCommentThreadHandle[]>();
        for (const candidate of existingThreads.values()) {
            if (!candidate.overleafThreadId) {
                continue;
            }
            const matches = existingThreadsByOverleafThreadId.get(candidate.overleafThreadId) ?? [];
            matches.push(candidate);
            existingThreadsByOverleafThreadId.set(candidate.overleafThreadId, matches);
        }
        const nextThreads = new Map<string, OverleafCommentThreadHandle>();
        const unresolvedDecorations: vscode.DecorationOptions[] = [];
        const resolvedDecorations: vscode.DecorationOptions[] = [];
        let hiddenResolvedThreadCount = 0;
        let hiddenEmptyThreadCount = 0;
        const anchorLineCounts = new Map<number, number>();
        const consumedExistingThreadHandles = new Set<OverleafCommentThreadHandle>();
        const duplicateThreadIds = new Set<string>();
        const newlyAssignedCommentUserColors = new Map<string, string>();
        let preservedMissingThreadDataCount = 0;
        let preservedMissingSnapshotThreadCount = 0;
        let rekeyedThreadHandleCount = 0;
        let replyCount = 0;

        for (const entry of snapshotThreads) {
            const threadId = entry.range.op.t;
            if (nextThreads.has(threadId)) {
                duplicateThreadIds.add(threadId);
                continue;
            }
            const range = transientRangeByThreadId.get(entry.range.op.t) ?? entry.range;
            const entryRange = this.createOffsetRange(document, range);
            const entryAnchorLine = resolveCommentThreadAnchorLine(entryRange);
            const rootCommentId = entry.thread?.messages[0]?.id ?? '';
            this.logTrace('render.thread_entry_received', {
                anchorLine: entryAnchorLine,
                rangeEndOffset: range.op.p + range.op.c.length,
                rangeStartOffset: range.op.p,
                reason,
                renderSequence,
                rootCommentId,
                threadId,
                uri: uriKey,
            });
            this.recordLifecycleObservation(uriKey, threadId, 'render', {
                reason,
                renderSequence,
                rootCommentId,
            });
            let existingThread = nextThreads.get(threadId) ?? existingThreads.get(threadId);
            if (existingThread && consumedExistingThreadHandles.has(existingThread)) {
                existingThread = undefined;
            }
            if (!existingThread) {
                const matchingThreadIdCandidates = (existingThreadsByOverleafThreadId.get(threadId) ?? [])
                    .filter((candidate) => {
                        if (consumedExistingThreadHandles.has(candidate)) {
                            return false;
                        }
                        if (this.isPendingDraftThread(candidate)) {
                            return false;
                        }
                        if (candidate.overleafDocId && candidate.overleafDocId!==snapshot.docId) {
                            return false;
                        }
                        return true;
                    });
                if (matchingThreadIdCandidates.length===1) {
                    existingThread = matchingThreadIdCandidates[0];
                    rekeyedThreadHandleCount += 1;
                    this.logDiagnostic('render.thread_handle_rekeyed_by_thread_id', {
                        docId: snapshot.docId,
                        fromThreadId: existingThread.overleafThreadId ?? '',
                        toThreadId: threadId,
                        uri: renderUri.toString(),
                    });
                } else if (matchingThreadIdCandidates.length > 1) {
                    this.logDiagnostic('render.thread_handle_rekey_skipped_ambiguous_identity', {
                        candidateCount: matchingThreadIdCandidates.length,
                        docId: snapshot.docId,
                        threadId,
                        uri: renderUri.toString(),
                    });
                }
            }
            const threadData = entry.thread;
            const rangeStateResolved = Boolean(threadData?.resolved ?? entry.range.resolved ?? entry.range.op.resolved);
            if (rangeStateResolved) {
                hiddenResolvedThreadCount += 1;
                continue;
            }
            if (!threadData || threadData.messages.length===0) {
                if (existingThread) {
                    const preservedRange = entryRange;
                    const preservedThreadRange = this.createThreadDisplayRange(document, preservedRange);
                    this.assignThreadDisplayBaseRangeIfChanged(
                        existingThread,
                        existingThread.overleafPinnedToStartAnchor
                            ? preservedThreadRange
                            : this.createThreadExtentRange(document, preservedRange),
                    );
                    this.assignThreadRangeIfChanged(existingThread, preservedThreadRange);
                    existingThread.overleafDocId = snapshot.docId;
                    existingThread.overleafUri = overleafUri;
                    existingThread.overleafThreadId = entry.range.op.t;
                    consumedExistingThreadHandles.add(existingThread);
                    nextThreads.set(threadId, existingThread);
                    anchorLineCounts.set(
                        preservedThreadRange.start.line,
                        (anchorLineCounts.get(preservedThreadRange.start.line) ?? 0) + 1,
                    );
                    preservedMissingThreadDataCount += 1;
                    continue;
                }
                hiddenEmptyThreadCount += 1;
                continue;
            }
            const commentRange = entryRange;
            const threadDisplayRange = this.createThreadDisplayRange(document, commentRange);
            const pinToStartAnchor = shouldPinCommentThreadToStartAnchor({
                isOfflineMode: Boolean(commentVfs?.isOfflineMode),
                reason,
                rootMessageId: rootCommentId,
                synchronizationMode: commentVfs?.synchronizationMode ?? 'online',
            });
            const threadExtentRange = pinToStartAnchor
                ? threadDisplayRange
                : this.createThreadExtentRange(document, commentRange);
            anchorLineCounts.set(
                threadDisplayRange.start.line,
                (anchorLineCounts.get(threadDisplayRange.start.line) ?? 0) + 1,
            );
            const permissions = await this.getThreadPermissions(overleafUri, entry.range.op.t);
            const comments = (threadData?.messages ?? []).map((message, index) => {
                const userColor = this.resolveCommentUserColor(snapshot.docId, message);
                if (userColor.isNew) {
                    newlyAssignedCommentUserColors.set(userColor.userIdentifier, userColor.color);
                }
                const isThreadRoot = index===0;
                if (!isThreadRoot) {
                    replyCount += 1;
                }
                return this.buildComment(renderUri, overleafUri, entry.range.op.t, permissions, message, userColor.color, isThreadRoot);
            });
            const thread = existingThread
                ?? this.createTrackedCommentThread(
                    renderUri,
                    threadDisplayRange,
                    comments,
                    'render_snapshot_create',
                    threadId,
                );
            if (existingThread) {
                consumedExistingThreadHandles.add(existingThread);
                this.recordLifecycleObservation(uriKey, threadId, 'reuse', {
                    reason,
                    renderSequence,
                    rootCommentId,
                });
            }

            const collapsibleStateKey = this.toLifecycleObservationKey(uriKey, threadId);
            const previousObservedCollapsibleState = this.collapsibleStateByUriThreadId.get(collapsibleStateKey);
            if (previousObservedCollapsibleState!==undefined
                && existingThread
                && previousObservedCollapsibleState!==existingThread.collapsibleState) {
                this.logTrace('thread.ui_collapsible_state_changed', {
                    fromState: previousObservedCollapsibleState,
                    reason,
                    renderSequence,
                    rootCommentId,
                    threadId,
                    toState: existingThread.collapsibleState,
                    uri: uriKey,
                });
            }

            this.assignThreadCommentsIfChanged(thread, comments);
            this.assignThreadDisplayBaseRangeIfChanged(thread, threadExtentRange);
            thread.overleafPinnedToStartAnchor = pinToStartAnchor;
            this.assignThreadRangeIfChanged(thread, threadDisplayRange);
            if (thread.canReply!==permissions.permissions.comment) {
                thread.canReply = permissions.permissions.comment;
            }
            const collapsibleState = existingThread?.collapsibleState
                ?? vscode.CommentThreadCollapsibleState.Collapsed;
            if (thread.collapsibleState!==collapsibleState) {
                thread.collapsibleState = collapsibleState;
            }
            this.collapsibleStateByUriThreadId.set(collapsibleStateKey, thread.collapsibleState);
            const contextValue = buildThreadContextValue(permissions.canResolveThread);
            if (thread.contextValue!==contextValue) {
                thread.contextValue = contextValue;
            }
            const label = formatCommentThreadPreview(entry.range.op.c);
            if (thread.label!==label) {
                thread.label = label;
            }
            if (thread.state!==vscode.CommentThreadState.Unresolved) {
                thread.state = vscode.CommentThreadState.Unresolved;
            }
            thread.overleafDocId = snapshot.docId;
            thread.overleafUri = overleafUri;
            thread.overleafThreadId = entry.range.op.t;
            thread.overleafOptimisticCreateThreadId = undefined;

            this.logTrace('render.thread_mounted', {
                anchorLine: threadDisplayRange.start.line,
                handleId: this.getThreadHandleId(thread),
                mountAction: existingThread ? 'reused' : 'created',
                reason,
                renderSequence,
                rootCommentId,
                threadId,
                uri: uriKey,
            });

            nextThreads.set(threadId, thread);
        }

        this.pruneDuplicateRenderedThreadsByRootCommentId(nextThreads, renderUri, reason, renderSequence);

        const retainedThreadHandles = new Set(nextThreads.values());
        for (const [threadId, thread] of existingThreads.entries()) {
            const nextThreadForKey = nextThreads.get(threadId);
            if (nextThreadForKey) {
                if (nextThreadForKey!==thread && !retainedThreadHandles.has(thread)) {
                    this.disposeTrackedThread(renderUri, thread, 'render_snapshot_replaced_same_thread_key', {
                        reason,
                        renderSequence,
                        threadId,
                    });
                }
                continue;
            }
            if (retainedThreadHandles.has(thread)) {
                continue;
            }
            if (this.isPendingDraftThread(thread)) {
                // Draft threads have no remote snapshot entry yet, so a normal
                // comment refresh must not dispose them before the real
                // Overleaf-backed thread has materialized inline.
                nextThreads.set(threadId, thread);
                continue;
            }
            if (this.isOptimisticCreateThread(thread)) {
                nextThreads.set(threadId, thread);
                this.logDiagnostic('render.optimistic_create_thread_preserved_local', {
                    reason,
                    renderSequence,
                    threadId,
                    uri: renderUri.toString(),
                });
                continue;
            }
            if (preserveMissingThreads) {
                nextThreads.set(threadId, thread);
                preservedMissingSnapshotThreadCount += 1;
                this.logDiagnostic('render.snapshot_missing_thread_preserved_local', {
                    reason,
                    renderSequence,
                    threadId,
                    uri: renderUri.toString(),
                });
                continue;
            }
            this.disposeTrackedThread(renderUri, thread, 'render_snapshot_removed_missing_in_next', {
                reason,
                renderSequence,
                threadId,
            });
        }

        this.threadsByUri.set(uriKey, nextThreads);
        const matchingEditors = vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString()===uriKey);
        const viewportEditor = matchingEditors.find((editor) => editor===vscode.window.activeTextEditor) ?? matchingEditors[0];
        if (viewportEditor) {
            this.updateRenderedThreadViewportRanges(viewportEditor, `render:${reason}`);
        }
        for (const editor of matchingEditors) {
            editor.setDecorations(this.unresolvedDecoration, unresolvedDecorations);
            editor.setDecorations(this.resolvedDecoration, resolvedDecorations);
        }
        if (newlyAssignedCommentUserColors.size > 0) {
            this.logDiagnostic('render.user_colors_assigned', {
                assignedCount: newlyAssignedCommentUserColors.size,
                docId: snapshot.docId,
                uri: renderUri.toString(),
                userColorCount: this.commentUserColorsByDocId.get(snapshot.docId)?.size ?? 0,
            });
        }
        this.logDiagnostic('render.thread_visibility_updated', {
            anchorLineCount: anchorLineCounts.size,
            duplicateThreadCount: duplicateThreadIds.size,
            hiddenEmptyThreadCount,
            hiddenResolvedThreadCount,
            multiThreadAnchorLineCount: [...anchorLineCounts.values()].filter((count) => count > 1).length,
            preservedMissingThreadDataCount,
            preservedMissingSnapshotThreadCount,
            rekeyedThreadHandleCount,
            renderedThreadCount: nextThreads.size,
            replyCount,
            topLevelCommentCount: nextThreads.size,
            userColorCount: this.commentUserColorsByDocId.get(snapshot.docId)?.size ?? 0,
            uri: renderUri.toString(),
        });
        if (preserveMissingThreads && preservedMissingSnapshotThreadCount > 0) {
            this.scheduleTransientRehydration(renderUri, reason);
        }
        this.logDiagnostic('render.lifecycle_completed', {
            duplicateOverleafThreadIdCount: this.summarizeDuplicateThreadHandles(nextThreads).length,
            reason,
            renderSequence,
            renderedThreadKeyCount: nextThreads.size,
            trackedHandleCount: this.createdThreadHandlesByUri.get(uriKey)?.size ?? 0,
            uri: uriKey,
        });
        this.pruneLeakedTrackedThreadHandles(nextThreads, renderUri, `post_render:${reason}`, renderSequence);
        const duplicateSummaryAfterRender = this.summarizeDuplicateThreadHandles(nextThreads);
        if (duplicateSummaryAfterRender.length > 0) {
            this.logDiagnostic('render.lifecycle_completed_with_duplicates', {
                duplicates: duplicateSummaryAfterRender,
                reason,
                renderSequence,
                uri: uriKey,
            });
            logCommentDiagnostics('InlineComments', 'invariants', 'render.invariant_duplicates_after_render', {
                duplicateOverleafThreadIdCount: duplicateSummaryAfterRender.length,
                reason,
                renderSequence,
                uri: uriKey,
            });
            if (!reason.includes('duplicate_rebuild:')) {
                this.disposeKnownThreadHandlesForRenderUri(
                    renderUri,
                    nextThreads,
                    `duplicate_rebuild:${reason}`,
                    renderSequence,
                );
                void this.syncUri(renderUri, `duplicate_rebuild:${reason}`);
            }
        }
        const trackedHandleCountAfterRender = this.createdThreadHandlesByUri.get(uriKey)?.size ?? 0;
        if (trackedHandleCountAfterRender > nextThreads.size + 2) {
            this.logDiagnostic('render.lifecycle_handle_drift_detected', {
                driftCount: trackedHandleCountAfterRender - nextThreads.size,
                reason,
                renderSequence,
                renderedThreadKeyCount: nextThreads.size,
                trackedHandleCount: trackedHandleCountAfterRender,
                uri: uriKey,
            });
            logCommentDiagnostics('InlineComments', 'invariants', 'render.invariant_handle_drift_detected', {
                driftCount: trackedHandleCountAfterRender - nextThreads.size,
                reason,
                renderSequence,
                renderedThreadKeyCount: nextThreads.size,
                trackedHandleCount: trackedHandleCountAfterRender,
                uri: uriKey,
            });
        }
    }

    private shouldForceRemoteThreadRebuild(
        renderUri: vscode.Uri,
        reason: string,
        existingThreadCount: number,
        trackedHandleCount: number,
    ) {
        const {baseReason} = this.getTransientRehydrationAttempt(reason);
        return shouldForceRemoteCommentThreadRebuild({
            existingThreadCount,
            isOfflineVisibilityPreservingReason: this.isOfflineVisibilityPreservingReason(baseReason),
            isRemoteScheme: renderUri.scheme===ROOT_NAME,
            reason: baseReason,
            trackedHandleCount,
        });
    }

    private disposeKnownThreadHandlesForRenderUri(
        renderUri: vscode.Uri,
        existingThreads: Map<string, OverleafCommentThreadHandle>,
        reason: string,
        renderSequence: number,
    ) {
        const uriKey = renderUri.toString();
        const trackedHandles = this.createdThreadHandlesByUri.get(uriKey);
        const disposedHandles = new Set<OverleafCommentThreadHandle>();
        let disposedThreadCount = 0;

        for (const [threadKey, thread] of existingThreads.entries()) {
            if (disposedHandles.has(thread)) {
                continue;
            }
            this.disposeTrackedThread(renderUri, thread, 'render_force_rebuild_existing_thread_disposed', {
                reason,
                renderSequence,
                threadKey,
            });
            disposedHandles.add(thread);
            disposedThreadCount += 1;
        }

        if (trackedHandles) {
            for (const trackedThread of Array.from(trackedHandles)) {
                if (disposedHandles.has(trackedThread)) {
                    continue;
                }
                this.disposeTrackedThread(renderUri, trackedThread, 'render_force_rebuild_tracked_thread_disposed', {
                    reason,
                    renderSequence,
                });
                disposedHandles.add(trackedThread);
                disposedThreadCount += 1;
            }
        }

        this.threadsByUri.delete(uriKey);
        this.createdThreadHandlesByUri.delete(uriKey);
        this.logDiagnostic('render.force_rebuild_applied', {
            disposedThreadCount,
            reason,
            renderSequence,
            uri: uriKey,
        });
    }

    private pruneDuplicateExistingThreadsByThreadId(
        existingThreads: Map<string, OverleafCommentThreadHandle>,
        renderUri: vscode.Uri,
        reason: string,
        renderSequence: number,
    ) {
        const entriesByThreadId = new Map<string, Array<{key: string, thread: OverleafCommentThreadHandle}>>();
        for (const [key, thread] of existingThreads.entries()) {
            if (!thread.overleafThreadId) {
                continue;
            }
            const entries = entriesByThreadId.get(thread.overleafThreadId) ?? [];
            entries.push({key, thread});
            entriesByThreadId.set(thread.overleafThreadId, entries);
        }

        let removedEntryCount = 0;
        let disposedThreadCount = 0;
        const disposedHandles = new Set<OverleafCommentThreadHandle>();

        for (const [threadId, entries] of entriesByThreadId.entries()) {
            if (entries.length <= 1) {
                continue;
            }
            const retained = entries.find((entry) => entry.key===threadId) ?? entries[0];
            for (const entry of entries) {
                if (entry===retained) {
                    continue;
                }
                existingThreads.delete(entry.key);
                removedEntryCount += 1;
                if (entry.thread===retained.thread || disposedHandles.has(entry.thread)) {
                    continue;
                }
                this.disposeTrackedThread(renderUri, entry.thread, 'render_duplicate_existing_thread_pruned', {
                    duplicateForThreadId: threadId,
                    reason,
                    renderSequence,
                });
                disposedHandles.add(entry.thread);
                disposedThreadCount += 1;
            }

            this.logDiagnostic('render.thread_duplicate_handle_pruned', {
                duplicateCount: entries.length - 1,
                retainedKey: retained.key,
                reason,
                renderSequence,
                threadId,
                uri: renderUri.toString(),
            });
        }

        if (removedEntryCount > 0) {
            this.logDiagnostic('render.thread_duplicate_handles_pruned_summary', {
                disposedThreadCount,
                removedEntryCount,
                uri: renderUri.toString(),
            });
        }
    }

    private pruneLeakedTrackedThreadHandles(
        existingThreads: Map<string, OverleafCommentThreadHandle>,
        renderUri: vscode.Uri,
        reason: string,
        renderSequence: number,
    ) {
        const uriKey = renderUri.toString();
        const trackedHandles = this.createdThreadHandlesByUri.get(uriKey);
        if (!trackedHandles || trackedHandles.size===0) {
            return;
        }

        const mappedHandles = new Set(existingThreads.values());
        let prunedHandleCount = 0;
        Array.from(trackedHandles).forEach((trackedThread) => {
            if (mappedHandles.has(trackedThread)) {
                return;
            }
            this.disposeTrackedThread(renderUri, trackedThread, 'render_unmapped_tracked_handle_pruned', {
                reason,
                renderSequence,
            });
            prunedHandleCount += 1;
        });

        if (prunedHandleCount > 0) {
            this.logDiagnostic('render.unmapped_tracked_handles_pruned', {
                prunedHandleCount,
                reason,
                renderSequence,
                uri: uriKey,
            });
        }
    }

    private pruneTrackedThreadHandleDuplicatesByThreadId(
        existingThreads: Map<string, OverleafCommentThreadHandle>,
        renderUri: vscode.Uri,
        reason: string,
        renderSequence: number,
    ) {
        const uriKey = renderUri.toString();
        const trackedHandles = this.createdThreadHandlesByUri.get(uriKey);
        if (!trackedHandles || trackedHandles.size < 2) {
            return;
        }

        const handlesByThreadId = new Map<string, OverleafCommentThreadHandle[]>();
        for (const trackedThread of trackedHandles) {
            if (!trackedThread.overleafThreadId) {
                continue;
            }
            const entries = handlesByThreadId.get(trackedThread.overleafThreadId) ?? [];
            entries.push(trackedThread);
            handlesByThreadId.set(trackedThread.overleafThreadId, entries);
        }

        const mappedHandles = new Set(existingThreads.values());
        let prunedHandleCount = 0;
        for (const [threadId, handles] of handlesByThreadId.entries()) {
            if (handles.length <= 1) {
                continue;
            }
            const retained = handles.find((handle) => mappedHandles.has(handle)) ?? handles[0];
            for (const trackedThread of handles) {
                if (trackedThread===retained) {
                    continue;
                }
                for (const [threadKey, mappedThread] of existingThreads.entries()) {
                    if (mappedThread===trackedThread) {
                        existingThreads.delete(threadKey);
                    }
                }
                this.disposeTrackedThread(renderUri, trackedThread, 'render_tracked_thread_duplicate_pruned', {
                    duplicateForThreadId: threadId,
                    reason,
                    renderSequence,
                });
                prunedHandleCount += 1;
            }
        }

        if (prunedHandleCount > 0) {
            this.logDiagnostic('render.tracked_thread_duplicate_handles_pruned', {
                prunedHandleCount,
                reason,
                renderSequence,
                uri: uriKey,
            });
        }
    }

    private pruneDuplicateRenderedThreadsByRootCommentId(
        renderedThreads: Map<string, OverleafCommentThreadHandle>,
        renderUri: vscode.Uri,
        reason: string,
        renderSequence: number,
    ) {
        const entriesByRootMessageId = new Map<string, Array<{threadKey: string, thread: OverleafCommentThreadHandle}>>();
        for (const [threadKey, thread] of renderedThreads.entries()) {
            const rootMessageId = (thread.comments[0] as OverleafVSCodeComment | undefined)?.overleafMessageId;
            if (!rootMessageId) {
                continue;
            }
            const entries = entriesByRootMessageId.get(rootMessageId) ?? [];
            entries.push({threadKey, thread});
            entriesByRootMessageId.set(rootMessageId, entries);
        }

        const disposedHandles = new Set<OverleafCommentThreadHandle>();
        for (const [rootMessageId, entries] of entriesByRootMessageId.entries()) {
            if (entries.length <= 1) {
                continue;
            }
            const retained = entries.find(({threadKey, thread}) => threadKey===thread.overleafThreadId)
                ?? entries[0];
            for (const entry of entries) {
                if (entry===retained) {
                    continue;
                }
                renderedThreads.delete(entry.threadKey);
                if (disposedHandles.has(entry.thread)) {
                    continue;
                }
                this.disposeTrackedThread(renderUri, entry.thread, 'render_duplicate_root_comment_id_pruned', {
                    reason,
                    renderSequence,
                    rootMessageId,
                });
                disposedHandles.add(entry.thread);
            }
            this.logDiagnostic('render.duplicate_root_comment_id_pruned', {
                duplicateCount: entries.length - 1,
                reason,
                renderSequence,
                retainedThreadKey: retained.threadKey,
                rootMessageId,
                uri: renderUri.toString(),
            });
            logCommentDiagnostics('InlineComments', 'invariants', 'render.invariant_duplicate_root_comment_id_pruned', {
                duplicateCount: entries.length - 1,
                reason,
                renderSequence,
                retainedThreadKey: retained.threadKey,
                rootMessageId,
                uri: renderUri.toString(),
            });
        }
    }

    private disposeRuntimeState(reason: string) {
        if (this.initialVisibleEditorsSyncTimer) {
            clearTimeout(this.initialVisibleEditorsSyncTimer);
            this.initialVisibleEditorsSyncTimer = undefined;
        }
        if (this.renderedThreadExpansionFocusScanTimer) {
            clearInterval(this.renderedThreadExpansionFocusScanTimer);
            this.renderedThreadExpansionFocusScanTimer = undefined;
        }
        if (this.inlineCommentClickFocusTimer) {
            clearTimeout(this.inlineCommentClickFocusTimer);
            this.inlineCommentClickFocusTimer = undefined;
        }
        if (this.startupPanelSuppressionTimer) {
            clearTimeout(this.startupPanelSuppressionTimer);
            this.startupPanelSuppressionTimer = undefined;
        }
        Array.from(this.suppressedReplyRefreshByUri.values()).forEach((suppression) => {
            clearTimeout(suppression.timeout);
        });
        this.suppressedReplyRefreshByUri.clear();
        Array.from(this.createdThreadHandlesByUri.entries()).forEach(([uriKey, handles]) => {
            const uri = vscode.Uri.parse(uriKey);
            Array.from(handles).forEach((thread) => {
                this.disposeTrackedThread(uri, thread, 'provider_runtime_dispose', {reason});
            });
        });
        this.threadsByUri.clear();
        this.createdThreadHandlesByUri.clear();
        this.snapshotsByUri.clear();
        this.transientRangesByUri.clear();
        this.overleafUriByRenderUri.clear();
        this.renderQueueByUri.clear();
        this.renderSequenceByUri.clear();
        this.refreshPromises.clear();
        this.queuedSyncReasonsByUri.clear();
        this.pendingLocalReplicaDraftsByUri.clear();
        this.temporaryLocalReplicaCommentingRangesByUri.clear();
        this.commentUserColorsByDocId.clear();
        this.authorBadgeIconByColor.clear();
        this.commentsChangedObservationBySequence.clear();
        this.collapsibleStateByUriThreadId.clear();
        this.lifecycleObservationByUriThreadId.clear();
        this.logDiagnostic('provider.runtime_disposed', {
            reason,
        });
        void this.setAddCommentContext(false, false, `disposed:${reason}`);
    }

    private onProviderDisposed(reason: string) {
        if (this.providerDisposed) {
            return;
        }
        const registrationCount = this.triggerRegistrations?.length ?? 0;
        this.providerDisposed = true;
        this.disposeRuntimeState(reason);
        if (InlineCommentProvider.activeProvider===this) {
            InlineCommentProvider.activeProvider = undefined;
        }
        const globalActiveProvider = getGlobalInlineCommentProviderHandle();
        if (globalActiveProvider && Object.is(globalActiveProvider.provider, this)) {
            setGlobalInlineCommentProviderHandle(undefined);
        }
        this.logTrace('provider.subscriptions_disposed', {
            reason,
            registrationCount,
        });
        this.triggerRegistrations = undefined;
    }

    private disposeSupersededProvider(reason: string) {
        this.logDiagnostic('provider.superseded_instance_detected', {
            reason,
            hasRegistrations: Boolean(this.triggerRegistrations),
        });
        if (this.triggerRegistrations && this.triggerRegistrations.length > 0) {
            this.logTrace('provider.subscriptions_dispose_requested', {
                reason,
                registrationCount: this.triggerRegistrations.length,
            });
            const registrations = [...this.triggerRegistrations];
            registrations.forEach((registration) => {
                registration.dispose();
            });
            return;
        }
        this.onProviderDisposed(reason);
    }

    private disposeThreadsForUri(uri: vscode.Uri) {
        const uriKey = uri.toString();
        const snapshot = this.snapshotsByUri.get(uriKey);
        this.clearReplyRefreshSuppression(uri);
        this.threadsByUri.get(uriKey)?.forEach((thread) => {
            this.disposeTrackedThread(uri, thread, 'dispose_threads_for_uri');
        });
        this.threadsByUri.delete(uriKey);
        this.createdThreadHandlesByUri.delete(uriKey);
        this.renderSequenceByUri.delete(uriKey);
        this.snapshotsByUri.delete(uriKey);
        this.transientRangesByUri.delete(uriKey);
        this.overleafUriByRenderUri.delete(uriKey);
        this.pendingCreatedCommentFocusByUri.delete(uriKey);
        this.pendingLocalReplicaDraftsByUri.delete(uriKey);
        this.queuedSyncReasonsByUri.delete(uriKey);
        this.temporaryLocalReplicaCommentingRangesByUri.delete(uriKey);
        for (const key of Array.from(this.collapsibleStateByUriThreadId.keys())) {
            if (!key.startsWith(`${uriKey}\u0000`)) {
                continue;
            }
            this.collapsibleStateByUriThreadId.delete(key);
        }
        for (const key of Array.from(this.lifecycleObservationByUriThreadId.keys())) {
            if (!key.startsWith(`${uriKey}\u0000`)) {
                continue;
            }
            this.lifecycleObservationByUriThreadId.delete(key);
        }
        if (snapshot) {
            this.commentUserColorsByDocId.delete(snapshot.docId);
        }
        for (const editor of vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString()===uriKey)) {
            editor.setDecorations(this.unresolvedDecoration, []);
            editor.setDecorations(this.resolvedDecoration, []);
        }
    }

    private async createCommentFromCommand(...args: unknown[]) {
        const invocationSource = this.inferAddCommentInvocationSource(args);
        this.logDiagnostic('create_command_started', {
            argumentTypes: this.describeCommandArguments(args),
            invocationSource,
        });
        this.logDiagnostic('shortcut_probe.command_invoked', {
            ...this.describeAddCommentEditorState(vscode.window.activeTextEditor),
            argumentTypes: this.describeCommandArguments(args),
            invocationSource,
        });

        const context = this.resolveAddCommentCommandContext(...args);
        if (!context) {
            this.logDiagnostic('shortcut_probe.command_blocked_invalid_context', {
                argumentTypes: this.describeCommandArguments(args),
                hasActiveEditor: Boolean(vscode.window.activeTextEditor),
                invocationSource,
            });
            vscode.window.showWarningMessage(vscode.l10n.t('Open an Overleaf editor and select text before creating a comment.'));
            return;
        }

        const {editor, selection, uri} = context;
        this.logDiagnostic('create_command_context_resolved', {
            argumentTypes: this.describeCommandArguments(args),
            nonEmptySelectionCount: context.nonEmptySelectionCount,
            selectionEmpty: selection.isEmpty,
            selectionSource: context.selectionSource,
            uri: uri.toString(),
        });

        if (selection.isEmpty) {
            this.logDiagnostic('shortcut_probe.command_blocked_empty_selection', {
                ...this.describeAddCommentEditorState(editor),
                invocationSource,
                selectionSource: context.selectionSource,
            });
            vscode.window.showWarningMessage(vscode.l10n.t('Select text before creating an Overleaf comment.'));
            return;
        }
        let binding: CommentUriBinding | undefined;
        try {
            binding = await this.resolveCommentDocumentBinding(uri);
            if (!binding) {
                this.logDiagnostic('shortcut_probe.command_blocked_unmapped_document', {
                    ...this.describeAddCommentEditorState(editor),
                    invocationSource,
                });
                vscode.window.showWarningMessage(vscode.l10n.t('Open an Overleaf-backed document before creating a comment.'));
                return;
            }
            this.logDiagnostic('shortcut_probe.command_binding_resolved', {
                ...this.describeAddCommentEditorState(editor, binding.mode==='localReplica'),
                invocationSource,
                overleafUri: binding.overleafUri.toString(),
                renderUri: binding.renderUri.toString(),
            });
            const content = await vscode.window.showInputBox({
                ignoreFocusOut: true,
                placeHolder: vscode.l10n.t('Write a comment'),
                prompt: vscode.l10n.t('Create Overleaf comment'),
                validateInput: (value) => value.trim().length===0 ? vscode.l10n.t('Comment text is required.') : undefined,
            });
            if (!content) {
                this.logDiagnostic('shortcut_probe.command_cancelled_input_box', {
                    ...this.describeAddCommentEditorState(editor, binding.mode==='localReplica'),
                    invocationSource,
                });
                return;
            }
            const selectedText = editor.document.getText(selection);
            const startOffset = editor.document.offsetAt(selection.start);
            const endOffset = editor.document.offsetAt(selection.end);
            const threadId = await this.createCommentThreadFromSelection(
                uri,
                binding,
                selection,
                content,
                {
                    endOffset,
                    selectedText,
                    startOffset,
                },
                binding.mode==='currentWindow'
                    ? 'create_comment_from_current_window_command'
                    : 'create_comment',
            );
            this.logDiagnostic('create_command_completed', {
                nonEmptySelectionCount: context.nonEmptySelectionCount,
                selectionLength: selectedText.length,
                selectionSource: context.selectionSource,
                threadId,
                uri: uri.toString(),
            });
            this.logDiagnostic('shortcut_probe.command_completed', {
                ...this.describeAddCommentEditorState(editor, binding.mode==='localReplica'),
                invocationSource,
                selectionLength: selectedText.length,
                selectionSource: context.selectionSource,
                threadId,
            });
        } catch (error) {
            this.logDiagnostic('shortcut_probe.command_failed', {
                ...this.describeAddCommentEditorState(editor, binding?.mode==='localReplica'),
                invocationSource,
                nonEmptySelectionCount: context.nonEmptySelectionCount,
                selectionSource: context.selectionSource,
                uri: uri.toString(),
            }, error);
            vscode.window.showErrorMessage(error instanceof Error
                ? error.message
                : vscode.l10n.t('Unable to create the Overleaf comment.'));
        }
    }

    private async replyToThread(reply: vscode.CommentReply) {
        const thread = reply.thread as OverleafCommentThreadHandle;
        const content = reply.text.trim();
        if (!content) {
            this.logDiagnostic('reply.skipped_empty', {
                threadId: thread.overleafThreadId,
                uri: thread.uri.toString(),
            });
            return;
        }
        if (!thread.overleafThreadId) {
            const binding = await this.resolveCommentDocumentBinding(thread.uri);
            if (binding?.mode==='localReplica') {
                this.adoptPendingLocalReplicaDraftThread(thread);
                try {
                    await this.submitLocalReplicaDraftThread(thread, content);
                    return;
                } catch (error) {
                    this.logDiagnostic('draft_thread.submit_failed', {
                        draftId: thread.overleafDraftId ?? '',
                        uri: thread.uri.toString(),
                    }, error);
                    vscode.window.showErrorMessage(error instanceof Error
                        ? error.message
                        : vscode.l10n.t('Unable to create the Overleaf comment.'));
                    throw error;
                }
            }
            if (binding?.mode==='currentWindow') {
                try {
                    await this.submitCurrentWindowDraftThread(thread, content);
                    return;
                } catch (error) {
                    this.logDiagnostic('draft_thread.submit_failed_current_window', {
                        uri: thread.uri.toString(),
                    }, error);
                    vscode.window.showErrorMessage(error instanceof Error
                        ? error.message
                        : vscode.l10n.t('Unable to create the Overleaf comment.'));
                    throw error;
                }
            }
            this.logDiagnostic('reply.skipped_invalid_thread', {
                hasThread: Boolean(reply.thread),
                uri: thread.uri?.toString() ?? '',
            });
            return;
        }
        this.logDiagnostic('reply.started', {
            contentLength: content.length,
            threadId: thread.overleafThreadId,
            uri: thread.uri.toString(),
        });
        try {
            const overleafUri = thread.overleafUri ?? await this.resolveOverleafProjectUri(thread.uri);
            if (!overleafUri) {
                throw new Error(vscode.l10n.t('Open an Overleaf-backed document before replying to a comment.'));
            }
            const vfs = await this.getReadyCommentVfs(overleafUri, 'reply_comment');
            await vfs.replyToComment(thread.overleafThreadId, content);
            const refreshedLocally = await this.refreshThreadFromLocalState(thread, vfs);
            await this.requestTargetedReviewRefreshForCommentMutation({
                overleafUri,
                reasonWhenOffline: 'comments_changed:thread_reply_created_offline',
                reasonWhenOnline: 'comments_changed:thread_reply_created',
                traceFields: {
                    overleafUri: overleafUri.toString(),
                    renderUri: thread.uri.toString(),
                },
                threadId: thread.overleafThreadId,
                vfs,
            });
            if (!refreshedLocally) {
                this.logDiagnostic('reply.local_refresh_fallback', {
                    threadId: thread.overleafThreadId,
                    uri: thread.uri.toString(),
                });
                await this.syncUri(thread.uri, 'reply_comment_fallback');
            }
            this.logDiagnostic('reply.completed', {
                contentLength: content.length,
                threadId: thread.overleafThreadId,
                uri: thread.uri.toString(),
            });
        } catch (error) {
            this.logDiagnostic('reply.failed', {
                contentLength: content.length,
                threadId: thread.overleafThreadId,
                uri: thread.uri.toString(),
            }, error);
            vscode.window.showErrorMessage(error instanceof Error
                ? error.message
                : vscode.l10n.t('Unable to reply to the Overleaf comment thread.'));
            throw error;
        }
    }

    private async editComment(comment: OverleafVSCodeComment) {
        if (!comment.overleafThreadId || !comment.overleafMessageId || !comment.overleafUri) {
            return;
        }
        const updatedContent = await vscode.window.showInputBox({
            ignoreFocusOut: true,
            placeHolder: vscode.l10n.t('Edit comment'),
            prompt: vscode.l10n.t('Update Overleaf comment'),
            value: typeof comment.body === 'string' ? comment.body : comment.body.value,
            validateInput: (value) => value.trim().length===0 ? vscode.l10n.t('Comment text is required.') : undefined,
        });
        if (!updatedContent) {
            return;
        }
        const vfs = await this.getReadyCommentVfs(comment.overleafUri, 'edit_comment');
        await vfs.editComment(comment.overleafThreadId, comment.overleafMessageId, updatedContent);
        EventBus.fire('reviewLocalMutationEvent', {
            content: updatedContent,
            kind: 'editMessage',
            messageId: comment.overleafMessageId,
            origin: vfs.origin.toString(),
            threadId: comment.overleafThreadId,
        });
        ReviewViewProvider.notifyLocalMutationForOrigin(vfs.origin.toString(), {
            content: updatedContent,
            kind: 'editMessage',
            messageId: comment.overleafMessageId,
            threadId: comment.overleafThreadId,
        });
        await this.projectReviewThreadEntryFromLocalState({
            messageId: comment.overleafMessageId,
            overleafUri: comment.overleafUri,
            threadId: comment.overleafThreadId,
            traceFields: {
                messageId: comment.overleafMessageId,
                overleafUri: comment.overleafUri.toString(),
            },
            vfs,
        });
        const renderUri = comment.overleafRenderUri ?? comment.overleafUri;
        const refreshedLocally = await this.refreshUriFromVfsState(renderUri, comment.overleafUri, vfs, 'edit_comment_local_state', {
            preferLocalSnapshot: true,
        });
        await this.requestTargetedReviewRefreshForCommentMutation({
            overleafUri: comment.overleafUri,
            reasonWhenOffline: 'comments_changed:thread_message_edited_offline',
            reasonWhenOnline: 'comments_changed:thread_message_edited',
            traceFields: {
                messageId: comment.overleafMessageId,
                overleafUri: comment.overleafUri.toString(),
                renderUri: renderUri.toString(),
            },
            threadId: comment.overleafThreadId,
            vfs,
        });
        if (!refreshedLocally) {
            await this.syncUri(renderUri, 'edit_comment_fallback');
        }
        await this.focusCommentThread(renderUri, {
            reason: 'edit_comment',
            threadId: comment.overleafThreadId,
        });
    }

    private async deleteComment(comment: OverleafVSCodeComment) {
        if (!comment.overleafThreadId || !comment.overleafMessageId || !comment.overleafUri) {
            return;
        }
        const vfs = await this.getReadyCommentVfs(comment.overleafUri, 'delete_comment');
        const permissions = vfs.getCommentThreadPermissions(comment.overleafThreadId);
        const canDeleteComment = permissions.canDeleteComment?.(comment.overleafUserId) ?? false;
        const ownOnly = !canDeleteComment || !permissions.resolveAllComments;
        const deleted = await vfs.deleteComment(comment.overleafThreadId, comment.overleafMessageId, ownOnly);
        EventBus.fire('reviewLocalMutationEvent', {
            kind: deleted==='thread' ? 'deleteThread' : 'deleteMessage',
            messageId: comment.overleafMessageId,
            origin: vfs.origin.toString(),
            threadId: comment.overleafThreadId,
        });
        ReviewViewProvider.notifyLocalMutationForOrigin(vfs.origin.toString(), {
            kind: deleted==='thread' ? 'deleteThread' : 'deleteMessage',
            messageId: comment.overleafMessageId,
            threadId: comment.overleafThreadId,
        });
        await this.projectReviewThreadEntryFromLocalState({
            messageId: comment.overleafMessageId,
            overleafUri: comment.overleafUri,
            threadId: comment.overleafThreadId,
            traceFields: {
                messageId: comment.overleafMessageId,
                overleafUri: comment.overleafUri.toString(),
            },
            vfs,
        });
        const renderUri = comment.overleafRenderUri ?? comment.overleafUri;
        const refreshedLocally = await this.refreshUriFromVfsState(renderUri, comment.overleafUri, vfs, 'delete_comment_local_state', {
            preferLocalSnapshot: true,
        });
        await this.requestTargetedReviewRefreshForCommentMutation({
            overleafUri: comment.overleafUri,
            reasonWhenOffline: 'comments_changed:thread_message_deleted_offline',
            reasonWhenOnline: 'comments_changed:thread_message_deleted',
            traceFields: {
                messageId: comment.overleafMessageId,
                overleafUri: comment.overleafUri.toString(),
                renderUri: renderUri.toString(),
            },
            threadId: comment.overleafThreadId,
            vfs,
        });
        if (!refreshedLocally) {
            await this.syncUri(renderUri, 'delete_comment_fallback');
        }
    }

    private async resolveComment(comment: OverleafVSCodeComment) {
        if (!comment.overleafThreadId || !comment.overleafUri) {
            return;
        }
        const vfs = await this.getReadyCommentVfs(comment.overleafUri, 'resolve_comment');
        const permissions = vfs.getCommentThreadPermissions(comment.overleafThreadId);
        if (!permissions.canResolveThread) {
            this.logDiagnostic('resolve_comment.skipped_forbidden', {
                threadId: comment.overleafThreadId,
                uri: comment.overleafUri.toString(),
            });
            return;
        }
        this.logDiagnostic('resolve_comment.started', {
            messageId: comment.overleafMessageId ?? '',
            threadId: comment.overleafThreadId,
            uri: comment.overleafUri.toString(),
        });
        await vfs.resolveCommentThread(comment.overleafUri, comment.overleafThreadId, true);
        const renderUri = comment.overleafRenderUri ?? comment.overleafUri;
        const refreshedLocally = await this.refreshUriFromVfsState(renderUri, comment.overleafUri, vfs, 'resolve_comment_local_state', {
            preferLocalSnapshot: true,
        });
        await this.requestTargetedReviewRefreshForCommentMutation({
            overleafUri: comment.overleafUri,
            reasonWhenOffline: 'comments_changed:thread_resolved',
            reasonWhenOnline: 'comments_changed:thread_resolved',
            traceFields: {
                messageId: comment.overleafMessageId ?? '',
                overleafUri: comment.overleafUri.toString(),
                renderUri: renderUri.toString(),
            },
            threadId: comment.overleafThreadId,
            vfs,
        });
        if (!refreshedLocally) {
            await this.syncUri(renderUri, 'resolve_comment_fallback');
        }
        this.logDiagnostic('resolve_comment.completed', {
            messageId: comment.overleafMessageId ?? '',
            threadId: comment.overleafThreadId,
            uri: comment.overleafUri.toString(),
        });
    }

    private async resolveThread(thread: OverleafCommentThreadHandle, resolved: boolean) {
        const traceContext = createDiagnosticTraceContext();
        const action = resolved ? 'resolve' : 'reopen';
        if (!thread.overleafThreadId) {
            this.logDiagnostic('thread_state_change.skipped_missing_thread_id', withDiagnosticTraceFields({
                action,
                uri: thread.uri.toString(),
            }, traceContext));
            return;
        }
        const threadStateBefore = this.collectUriThreadDebugState(thread.uri);
        this.logDiagnostic('thread_state_change.requested', withDiagnosticTraceFields({
            action,
            handleId: this.getThreadHandleId(thread),
            threadId: thread.overleafThreadId,
            threadStateBefore,
            uri: thread.uri.toString(),
        }, traceContext));
        const overleafUri = thread.overleafUri ?? await this.resolveOverleafProjectUri(thread.uri);
        if (!overleafUri) {
            throw new Error(vscode.l10n.t('Open an Overleaf-backed document before updating a comment thread.'));
        }
        try {
            const vfs = await this.getReadyCommentVfs(overleafUri, resolved ? 'resolve_thread' : 'reopen_thread');
            await vfs.resolveCommentThread(overleafUri, thread.overleafThreadId, resolved);
            const refreshedLocally = await this.refreshUriFromVfsState(
                thread.uri,
                overleafUri,
                vfs,
                resolved ? 'resolve_thread_local_state' : 'reopen_thread_local_state',
                {
                    preferLocalSnapshot: true,
                },
            );
            await this.requestTargetedReviewRefreshForCommentMutation({
                overleafUri,
                reasonWhenOffline: resolved ? 'comments_changed:thread_resolved' : 'comments_changed:thread_reopened',
                reasonWhenOnline: resolved ? 'comments_changed:thread_resolved' : 'comments_changed:thread_reopened',
                traceFields: withDiagnosticTraceFields({
                    action,
                    overleafUri: overleafUri.toString(),
                    renderUri: thread.uri.toString(),
                }, traceContext),
                threadId: thread.overleafThreadId,
                vfs,
            });
            if (!refreshedLocally) {
                await this.syncUri(thread.uri, resolved ? 'resolve_thread_fallback' : 'reopen_thread_fallback');
            }
            this.logDiagnostic('thread_state_change.completed', withDiagnosticTraceFields({
                action,
                refreshedLocally,
                threadId: thread.overleafThreadId,
                threadStateAfter: this.collectUriThreadDebugState(thread.uri),
                uri: thread.uri.toString(),
            }, traceContext));
        } catch (error) {
            this.logDiagnostic('thread_state_change.failed', withDiagnosticTraceFields({
                action,
                threadId: thread.overleafThreadId,
                threadStateAfter: this.collectUriThreadDebugState(thread.uri),
                uri: thread.uri.toString(),
            }, traceContext), error);
            throw error;
        }
    }

    private async deleteThread(thread: OverleafCommentThreadHandle) {
        if (!thread.overleafThreadId) {
            return;
        }
        const overleafUri = thread.overleafUri ?? await this.resolveOverleafProjectUri(thread.uri);
        if (!overleafUri) {
            throw new Error(vscode.l10n.t('Open an Overleaf-backed document before deleting a comment thread.'));
        }
        const vfs = await this.getReadyCommentVfs(overleafUri, 'delete_thread');
        await vfs.deleteCommentThread(overleafUri, thread.overleafThreadId);
        const refreshedLocally = await this.refreshUriFromVfsState(
            thread.uri,
            overleafUri,
            vfs,
            'delete_thread_local_state',
            {
                preferLocalSnapshot: true,
            },
        );
        await this.requestTargetedReviewRefreshForCommentMutation({
            overleafUri,
            reasonWhenOffline: 'comments_changed:thread_deleted_offline',
            reasonWhenOnline: 'comments_changed:thread_deleted',
            traceFields: {
                overleafUri: overleafUri.toString(),
                renderUri: thread.uri.toString(),
            },
            threadId: thread.overleafThreadId,
            vfs,
        });
        if (!refreshedLocally) {
            await this.syncUri(thread.uri, 'delete_thread_fallback');
        }
    }

    private collapseThreadsInActiveEditor() {
        const traceContext = createDiagnosticTraceContext();
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.isOverleafDocument(editor.document)) {
            this.logDiagnostic('collapse_active_thread.skipped_invalid_editor', withDiagnosticTraceFields({
                hasActiveEditor: Boolean(editor),
            }, traceContext));
            return;
        }
        const uri = editor.document.uri;
        const threads = this.threadsByUri.get(uri.toString());
        if (!threads || threads.size===0) {
            this.logDiagnostic('collapse_active_thread.skipped_no_threads', withDiagnosticTraceFields({
                uri: uri.toString(),
            }, traceContext));
            return;
        }
        const threadStateBefore = this.collectUriThreadDebugState(uri);
        const collapsedCount = collapseExpandedCommentThreads(threads.values());
        for (const thread of threads.values()) {
            this.recordObservedThreadCollapsibleState(uri, thread);
        }
        this.logDiagnostic(collapsedCount > 0 ? 'collapse_active_thread.completed' : 'collapse_active_thread.skipped_none_expanded', withDiagnosticTraceFields({
            collapsedCount,
            threadStateAfter: this.collectUriThreadDebugState(uri),
            threadStateBefore,
            threadCount: threads.size,
            uri: uri.toString(),
        }, traceContext));
    }

    private applyTransientDocumentChanges(event: vscode.TextDocumentChangeEvent) {
        if (!this.isOverleafDocument(event.document)) {
            return;
        }
        const uriKey = event.document.uri.toString();
        const transientRanges = this.transientRangesByUri.get(uriKey);
        if (!transientRanges || transientRanges.length===0) {
            return;
        }

        const ops = event.contentChanges.flatMap<OverleafTextOperation>((change) => {
            const changeOps: OverleafTextOperation[] = [];
            if (change.rangeLength > 0) {
                changeOps.push({
                    d: ' '.repeat(change.rangeLength),
                    p: change.rangeOffset,
                });
            }
            if (change.text.length > 0) {
                changeOps.push({
                    i: change.text,
                    p: change.rangeOffset,
                });
            }
            return changeOps;
        });
        if (ops.length===0) {
            return;
        }

        const result = applyTextOperationsToCommentRanges(transientRanges, ops);
        this.transientRangesByUri.set(uriKey, result.ranges);
        if (result.contentMismatchCount > 0) {
            this.logDiagnostic('render.transient_range_mismatch', {
                contentMismatchCount: result.contentMismatchCount,
                uri: uriKey,
            });
        }
        let snapshot = this.snapshotsByUri.get(uriKey);
        if (snapshot && result.removedThreadIds.length > 0) {
            const removedThreadIds = new Set(result.removedThreadIds);
            snapshot = {
                ...snapshot,
                threads: snapshot.threads.filter((entry) => !removedThreadIds.has(entry.range.op.t)),
            };
            this.snapshotsByUri.set(uriKey, snapshot);
            this.logDiagnostic('render.transient_threads_removed_after_anchor_delete', {
                removedThreadCount: removedThreadIds.size,
                removedThreadIds: Array.from(removedThreadIds).sort((left, right) => left.localeCompare(right)),
                uri: uriKey,
            });
        }
        if (snapshot) {
            const snapshotToRender = snapshot;
            void this.resolveOverleafProjectUri(event.document.uri).then((overleafUri) => {
                if (!overleafUri) {
                    return;
                }
                return this.runWithSerializedRender(event.document.uri, 'transient_document_change', () => {
                    return this.renderUri(event.document.uri, overleafUri, snapshotToRender, 'transient_document_change');
                });
            });
        }
    }

    get triggers() {
        if (this.triggerRegistrations) {
            return this.triggerRegistrations;
        }
        if (this.providerDisposed) {
            return [];
        }
        this.initialVisibleEditorsSyncTimer = setTimeout(() => {
            this.initialVisibleEditorsSyncTimer = undefined;
            void this.initialCommentsOpenViewSuppression.finally(() => {
                void this.syncVisibleEditors('initial_visible_editors');
            });
        }, 0);
        void this.updateAddCommentContext('initial');
        const addCommentCommandId = `${ROOT_NAME}.comments.addComment`;
        const addCommentFromSelectionCommandId = `${ROOT_NAME}.comments.addCommentFromSelection`;
        this.logDiagnostic('shortcut_probe.command_registration_started', {
            commandId: addCommentCommandId,
            manualCommandId: addCommentFromSelectionCommandId,
            localSelectionContextKey: LOCAL_REPLICA_ADD_COMMENT_SELECTION_CONTEXT,
            localSupportedEditorContextKey: LOCAL_REPLICA_ADD_COMMENT_SUPPORTED_EDITOR_CONTEXT,
        });
        void vscode.commands.getCommands(true)
            .then((commands) => {
                this.logDiagnostic('shortcut_probe.command_registration_lookup', {
                    commandId: addCommentCommandId,
                    registered: commands.includes(addCommentCommandId),
                });
            }, (error: unknown) => {
                this.logDiagnostic('shortcut_probe.command_registration_lookup_failed', {
                    commandId: addCommentCommandId,
                }, error);
            });
        const localReplicaSettingsWatcher = vscode.workspace.createFileSystemWatcher(
            `**/${LOCAL_REPLICA_SETTINGS_DIR_NAME}/${LOCAL_REPLICA_SETTINGS_FILE_NAME}`,
        );
        const registrations: vscode.Disposable[] = [
            this.controller,
            this.inlineDiagnosticsStateRegistration,
            this.unresolvedDecoration,
            this.resolvedDecoration,
            localReplicaSettingsWatcher,
            vscode.commands.registerCommand(addCommentCommandId, (...args: unknown[]) => {
                const invocationSource = this.inferAddCommentInvocationSource(args);
                this.logDiagnostic('shortcut_probe.command_handler_enter', {
                    ...this.describeAddCommentEditorState(vscode.window.activeTextEditor),
                    argumentTypes: this.describeCommandArguments(args),
                    commandId: addCommentCommandId,
                    invocationSource,
                });
                return Promise.resolve(this.createCommentFromCommand(...args))
                    .then((result) => {
                        this.logDiagnostic('shortcut_probe.command_handler_exit', {
                            commandId: addCommentCommandId,
                            invocationSource,
                        });
                        return result;
                    })
                    .catch((error: unknown) => {
                        this.logDiagnostic('shortcut_probe.command_handler_error', {
                            commandId: addCommentCommandId,
                            invocationSource,
                        }, error);
                        throw error;
                    });
            }),
            vscode.commands.registerCommand(addCommentFromSelectionCommandId, (...args: unknown[]) => {
                this.logDiagnostic('shortcut_probe.manual_command_handler_enter', {
                    ...this.describeAddCommentEditorState(vscode.window.activeTextEditor),
                    argumentTypes: this.describeCommandArguments(args),
                    commandId: addCommentFromSelectionCommandId,
                });
                return Promise.resolve(this.createCommentFromCommand(...args))
                    .then((result) => {
                        this.logDiagnostic('shortcut_probe.manual_command_handler_exit', {
                            commandId: addCommentFromSelectionCommandId,
                        });
                        return result;
                    })
                    .catch((error: unknown) => {
                        this.logDiagnostic('shortcut_probe.manual_command_handler_error', {
                            commandId: addCommentFromSelectionCommandId,
                        }, error);
                        throw error;
                    });
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.reply`, (reply: vscode.CommentReply) => {
                return this.replyToThread(reply);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.edit`, (...args: unknown[]) => {
                const comment = args.find((candidate) => candidate && typeof candidate === 'object' && 'overleafMessageId' in (candidate as object)) as OverleafVSCodeComment | undefined;
                return comment && this.editComment(comment);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.delete`, (...args: unknown[]) => {
                const comment = args.find((candidate) => candidate && typeof candidate === 'object' && 'overleafMessageId' in (candidate as object)) as OverleafVSCodeComment | undefined;
                return comment && this.deleteComment(comment);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.resolveComment`, (...args: unknown[]) => {
                const comment = args.find((candidate) => candidate && typeof candidate === 'object' && 'overleafMessageId' in (candidate as object)) as OverleafVSCodeComment | undefined;
                return comment && this.resolveComment(comment);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.resolveThread`, (...args: unknown[]) => {
                const thread = args.find((candidate) => candidate && typeof candidate === 'object' && 'overleafThreadId' in (candidate as object)) as OverleafCommentThreadHandle | undefined;
                return thread && this.resolveThread(thread, true);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.reopenThread`, (...args: unknown[]) => {
                const thread = args.find((candidate) => candidate && typeof candidate === 'object' && 'overleafThreadId' in (candidate as object)) as OverleafCommentThreadHandle | undefined;
                return thread && this.resolveThread(thread, false);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.deleteThread`, (...args: unknown[]) => {
                const thread = args.find((candidate) => candidate && typeof candidate === 'object' && 'overleafThreadId' in (candidate as object)) as OverleafCommentThreadHandle | undefined;
                return thread && this.deleteThread(thread);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.collapseThread`, () => {
                this.collapseThreadsInActiveEditor();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.focusThread`, (argument: {
                reason?: string,
                renderUri?: vscode.Uri,
                selection?: vscode.Selection,
                threadId?: string,
            }) => {
                if (!argument?.renderUri) {
                    return;
                }
                return this.focusCommentThread(argument.renderUri, {
                    reason: argument.reason ?? 'external_focus_thread',
                    selection: argument.selection,
                    threadId: argument.threadId,
                });
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.refresh`, async () => {
                await this.syncVisibleEditors('manual_refresh');
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.debug.dumpState`, async () => {
                await this.dumpCommentDiagnosticsState();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.debug.inspectListeners`, async () => {
                await this.inspectCommentEventListeners();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.comments.debug.forceReconcile`, async () => {
                await this.forceCommentReconciliation();
            }),
            vscode.window.onDidChangeVisibleTextEditors((editors) => {
                void this.updateAddCommentContext('visible_editors_changed');
                void this.syncVisibleEditors('visible_editors_changed', editors);
            }),
            vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
                if (!this.isOverleafDocument(event.textEditor.document)) {
                    return;
                }
                this.updateRenderedThreadViewportRanges(event.textEditor, 'visible_ranges_changed');
            }),
            vscode.workspace.onDidOpenTextDocument((document) => {
                if (document===vscode.window.activeTextEditor?.document) {
                    void this.updateAddCommentContext('document_opened');
                }
            }),
            vscode.window.onDidChangeActiveTextEditor(() => {
                void this.updateAddCommentContext('active_editor_changed');
            }),
            vscode.window.onDidChangeTextEditorSelection((event) => {
                if (event.textEditor===vscode.window.activeTextEditor) {
                    void this.updateAddCommentContext('selection_changed');
                    if (event.selections.length===1) {
                        this.scheduleInlineCommentClickFocus(
                            event.textEditor,
                            event.selections[0],
                            event.kind,
                        );
                    }
                }
            }),
            vscode.workspace.onDidCloseTextDocument((document) => {
                if (this.isOverleafDocument(document)) {
                    this.disposeThreadsForUri(document.uri);
                }
                void this.updateAddCommentContext('document_closed');
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                this.applyTransientDocumentChanges(event);
                if (event.document===vscode.window.activeTextEditor?.document) {
                    void this.updateAddCommentContext('document_changed');
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                void this.updateAddCommentContext('workspace_folders_changed');
                void this.syncVisibleEditors('workspace_folders_changed');
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('comments.openView')) {
                    void this.suppressAutomaticCommentsPanelActivation('configuration_changed');
                }
                if (didCommentUserPaletteChange(event)) {
                    void this.reloadCommentUserPalette('configuration_changed');
                }
                if (event.affectsConfiguration(`${ROOT_NAME}.comments.debug`)) {
                    this.logDiagnostic('debug.runtime_configuration_changed', {
                        runtimeConfiguration: getCommentDiagnosticsRuntimeConfiguration(),
                    });
                }
            }),
            localReplicaSettingsWatcher.onDidCreate(() => {
                void this.updateAddCommentContext('local_replica_settings_created');
                void this.syncVisibleEditors('local_replica_settings_created');
            }),
            localReplicaSettingsWatcher.onDidChange(() => {
                void this.updateAddCommentContext('local_replica_settings_changed');
                void this.syncVisibleEditors('local_replica_settings_changed');
            }),
            localReplicaSettingsWatcher.onDidDelete(() => {
                void this.updateAddCommentContext('local_replica_settings_deleted');
                void this.syncVisibleEditors('local_replica_settings_deleted');
            }),
            EventBus.on('commentsChangedEvent', ({origin, reason, sequence, emittedAtMs, threadIds, docIds}) => {
                const projectUri = vscode.Uri.parse(origin);
                const eventReceivedAtMs = Date.now();
                const eventEmittedAtMs = emittedAtMs ?? eventReceivedAtMs;
                const observation = this.recordCommentsChangedObservation(origin, reason, sequence, emittedAtMs);
                void this.collectCommentRefreshUris(projectUri, docIds).then((targetUris) => {
                    this.recordCommentDebugEvent('comments_changed_event_received', {
                        docCount: docIds?.length ?? 0,
                        origin,
                        reason,
                        sequence: sequence ?? -1,
                        targetUriCount: targetUris.length,
                        threadCount: threadIds?.length ?? 0,
                    });
                    this.logDiagnostic('render.comments_changed_event_received', {
                        docCount: docIds?.length ?? 0,
                        emittedAtMs: eventEmittedAtMs,
                        eventTransitMs: Math.max(0, eventReceivedAtMs - eventEmittedAtMs),
                        observationCount: observation.observationCount,
                        observationKey: observation.observationKey,
                        origin,
                        reason,
                        receivedAtMs: eventReceivedAtMs,
                        sequence: sequence ?? -1,
                        targetUriCount: targetUris.length,
                        threadCount: threadIds?.length ?? 0,
                    });
                    if (observation.observationCount > 1) {
                        this.logDiagnostic('render.comments_changed_event_observed_multiple_times', {
                            docCount: docIds?.length ?? 0,
                            emittedAtMs: eventEmittedAtMs,
                            observationCount: observation.observationCount,
                            observationKey: observation.observationKey,
                            origin,
                            reason,
                            sequence: sequence ?? -1,
                            targetUriCount: targetUris.length,
                            threadCount: threadIds?.length ?? 0,
                        });
                        if (targetUris.length===0 || this.isOfflineVisibilityPreservingReason(reason)) {
                            this.logDiagnostic('render.comments_changed_event_duplicate_ignored', {
                                docCount: docIds?.length ?? 0,
                                offlineVisibilityGuard: this.isOfflineVisibilityPreservingReason(reason),
                                observationCount: observation.observationCount,
                                observationKey: observation.observationKey,
                                origin,
                                reason,
                                sequence: sequence ?? -1,
                                targetUriCount: targetUris.length,
                                threadCount: threadIds?.length ?? 0,
                            });
                            return;
                        }
                        this.logDiagnostic('render.comments_changed_event_duplicate_processed_for_targets', {
                            docCount: docIds?.length ?? 0,
                            observationCount: observation.observationCount,
                            observationKey: observation.observationKey,
                            origin,
                            reason,
                            sequence: sequence ?? -1,
                            targetUriCount: targetUris.length,
                            threadCount: threadIds?.length ?? 0,
                        });
                    }
                    return Promise.all(targetUris.map((uri) => {
                        if (this.shouldSuppressCommentsChangedRefresh(uri, reason, threadIds)) {
                            this.logDiagnostic('render.skipped_suppressed_reply_refresh', {
                                reason,
                                threadCount: threadIds?.length ?? 0,
                                uri: uri.toString(),
                            });
                            return Promise.resolve();
                        }
                        const syncRequestedAtMs = Date.now();
                        return this.syncUri(uri, `comments_changed_event:${reason}`).then(async () => {
                            await this.fulfillPendingCreatedCommentFocus(uri, reason, threadIds);
                            const syncCompletedAtMs = Date.now();
                            this.logDiagnostic('render.comments_changed_latency_measured', {
                                docCount: docIds?.length ?? 0,
                                emittedAtMs: eventEmittedAtMs,
                                endToEndLatencyMs: Math.max(0, syncCompletedAtMs - eventEmittedAtMs),
                                eventTransitMs: Math.max(0, eventReceivedAtMs - eventEmittedAtMs),
                                queueToSyncMs: Math.max(0, syncRequestedAtMs - eventReceivedAtMs),
                                reason,
                                sequence: sequence ?? -1,
                                syncCompletedAtMs,
                                syncDurationMs: Math.max(0, syncCompletedAtMs - syncRequestedAtMs),
                                syncRequestedAtMs,
                                threadCount: threadIds?.length ?? 0,
                                uri: uri.toString(),
                            });
                        });
                    }));
                });
            }),
            EventBus.on('realtimeConnectionStateChangedEvent', ({origin, phase, reason}) => {
                this.logDiagnostic('render.realtime_state_changed_event_received', {
                    origin,
                    phase,
                    reason,
                });
                void this.syncVisibleEditorsForProject(origin, `realtime_state_changed:${reason}`);
            }),
            EventBus.on('offlineSynchronizationStateChangedEvent', ({mode, origin, reason}) => {
                this.logDiagnostic('render.offline_state_changed_event_received', {
                    mode,
                    origin,
                    reason,
                });
                void this.syncVisibleEditorsForProject(origin, `offline_state_changed:${reason}`);
            }),
            {
                dispose: () => {
                    this.onProviderDisposed('context_dispose');
                },
            },
        ];
        this.logTrace('provider.subscriptions_registered', {
            registrationCount: registrations.length,
        });
        this.triggerRegistrations = registrations;
        return registrations;
    }
}
