/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import {
    BaseAPI,
    Identity,
    MemberEntity,
    ProjectMessageResponseSchema,
} from '../api/base';
import {
    CHAT_HISTORY_PAGE_SIZE,
    resolveNextChatHistoryCursor,
    shouldContinueChatHistoryPagination,
} from './chatHistoryPagination';
import {
    buildOptimisticChatMessage,
    consumeOptimisticChatMessageId,
    discardOptimisticChatMessageId,
    PendingOptimisticChatMessages,
    pruneOptimisticChatMessages,
    recordOptimisticChatMessage,
} from './chatOptimisticMessages';
import {
    calculateChatRealtimeConfirmationRefreshDelayMs,
    calculateChatRateLimitRetryDelayMs,
    getChatRateLimitInlineRetryDelayMs,
} from './chatRetryPolicy';
import {
    isOwnChatMessageClient,
} from './chatClientId';
import {
    isTemporaryChatMessageId,
    resolveChatMessageDelivery,
    type ChatMessageDelivery,
} from './chatMessageDelivery';
import {
    buildOverleafChatSendFailure,
} from './chatSendResult';
import type { OverleafChatSendResult } from './chatSendResult';
import { isLikelyConnectivityFailure } from '../core/offlineSyncState';
import { startDiagnosticSpan } from '../utils/diagnostics';
import {
    DeferredSyncOperation,
    isDeferredSyncChatOperation,
} from '../offline/offlineOperationLog';

export type ProjectChatLoadResult =
    | {
        messages: ProjectMessageResponseSchema[],
        ok: true,
        source: 'offline-cache' | 'server',
    }
    | {
        message: string,
        messages?: ProjectMessageResponseSchema[],
        ok: false,
        retryable: boolean,
    };

export interface PersistedProjectChatState {
    historyComplete: boolean,
    messages: ProjectMessageResponseSchema[],
    savedAt?: string,
}

export interface ProjectChatSessionHost {
    api: BaseAPI,
    appendDeferredSyncOperation(operation: DeferredSyncOperation, reason: string): Promise<void>,
    canFetchRemoteHistory(): boolean,
    canSendLiveMessages(): boolean,
    getActiveChatClientId(): string | undefined,
    getAuthenticatedTransportIdentity(reason: string): Promise<Identity>,
    getDeferredSyncOperations(): DeferredSyncOperation[],
    isOfflineMode(): boolean,
    logDiagnostic(event: string, fields?: Record<string, unknown>, error?: unknown): void,
    onStateChanged(
        state: PersistedProjectChatState,
        reason: string,
        options?: {message?: ProjectMessageResponseSchema},
    ): void,
    projectId: string,
    removeDeferredSyncOperation(operationId: string, reason: string): Promise<void>,
    replaceDeferredSyncOperations(
        reason: string,
        updater: (operations: DeferredSyncOperation[]) => DeferredSyncOperation[],
    ): Promise<void>,
    resolveCurrentProjectMember(): MemberEntity | undefined,
    transitionToOffline(reason: string, error?: unknown, fields?: Record<string, unknown>): Promise<void>,
    userId: string,
}

type ChatQueueOperation = Extract<DeferredSyncOperation, {kind: 'chat.send' | 'chat.edit' | 'chat.delete'}>;

const CHAT_SNAPSHOT_MATCH_SKEW_MS = 2 * 60 * 1000;
const CHAT_ORPHANED_SENDING_STALE_MS = 2 * 60 * 1000;
const CHAT_MESSAGES_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

function cloneChatUser(user: ProjectMessageResponseSchema['user']) {
    return {
        email: user.email,
        first_name: user.first_name,
        id: user.id,
        last_name: user.last_name,
    };
}

function cloneChatMessage(message: ProjectMessageResponseSchema): ProjectMessageResponseSchema {
    return {
        ...message,
        user: cloneChatUser(message.user),
    };
}

function sortDeferredOperations(left: DeferredSyncOperation, right: DeferredSyncOperation) {
    if (left.createdAt===right.createdAt) {
        return left.id.localeCompare(right.id);
    }
    return left.createdAt.localeCompare(right.createdAt);
}

function normalizeChatMessageContentForComparison(content: string) {
    return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isChatOperationForMessage(operation: ChatQueueOperation, messageId: string) {
    switch (operation.kind) {
        case 'chat.send':
            return operation.payload.localMessageId===messageId;
        case 'chat.edit':
        case 'chat.delete':
            return operation.payload.messageId===messageId;
    }
}

function shouldForceReconnectCheckpoint(reason: string, hasQueuedOperations: boolean) {
    if (hasQueuedOperations) {
        return true;
    }
    if (reason==='socket_connection_accepted') {
        return true;
    }
    return reason.startsWith('initialization:')
        && reason!=='initialization:initial';
}

export function prependPaginatedChatPage(
    existingMessages: readonly ProjectMessageResponseSchema[],
    serverPage: readonly ProjectMessageResponseSchema[],
) {
    const knownIds = new Set(existingMessages.map((message) => message.id));
    const prependedMessages = [...serverPage]
        .reverse()
        .filter((message) => {
            return Boolean(message.id) && !knownIds.has(message.id);
        })
        .map((message) => {
            knownIds.add(message.id);
            return cloneChatMessage(message);
        });
    return [
        ...prependedMessages,
        ...existingMessages.map(cloneChatMessage),
    ];
}

export class ProjectChatSession {
    private awaitingRealtimeConfirmationMessageIds = new Set<string>();
    private chatRateLimitRetryAttempt = 0;
    private historyComplete = false;
    private historyLoadPromise?: Promise<ProjectChatLoadResult>;
    private messages: ProjectMessageResponseSchema[] = [];
    private pendingOptimisticChatMessages: PendingOptimisticChatMessages = new Map();
    private queuedReplayAttempt = 0;
    private queuedReplayPromise?: Promise<void>;
    private queuedReplayRetryDeadline?: number;
    private queuedReplayRetryTimer?: ReturnType<typeof setTimeout>;
    private realtimeConfirmationRefreshAttempt = 0;
    private realtimeConfirmationRefreshDeadline?: number;
    private realtimeConfirmationRefreshTimer?: ReturnType<typeof setTimeout>;
    private messagesRateLimitedUntil?: number;
    private disposed = false;

    constructor(private readonly host: ProjectChatSessionHost) {}

    get cachedMessages() {
        return this.messages.map(cloneChatMessage);
    }

    get hasLoadedHistory() {
        return this.historyComplete;
    }

    get hasQueuedOperations() {
        return this.chatQueueOperations.length > 0;
    }

    get queueLength() {
        return this.chatQueueOperations.length;
    }

    private summarizeQueuedOperations() {
        const operations = this.chatQueueOperations.slice().sort(sortDeferredOperations);
        const counts = new Map<string, number>();
        operations.forEach((operation) => {
            counts.set(operation.kind, (counts.get(operation.kind) ?? 0) + 1);
        });
        return {
            countsByKind: Object.fromEntries(
                Array.from(counts.entries())
                    .sort(([left], [right]) => left.localeCompare(right)),
            ),
            sample: operations.slice(0, 20).map((operation) => ({
                createdAt: operation.createdAt,
                id: operation.id,
                kind: operation.kind,
                messageId: operation.kind==='chat.send'
                    ? operation.payload.localMessageId
                    : operation.payload.messageId,
            })),
        };
    }

    getDiagnosticsState() {
        const queuedOperations = this.summarizeQueuedOperations();
        return {
            awaitingRealtimeConfirmationCount: this.awaitingRealtimeConfirmationMessageIds.size,
            chatRateLimitRetryAttempt: this.chatRateLimitRetryAttempt,
            disposed: this.disposed,
            hasHistoryLoadPromise: Boolean(this.historyLoadPromise),
            hasQueuedReplayPromise: Boolean(this.queuedReplayPromise),
            historyComplete: this.historyComplete,
            messageCount: this.messages.length,
            messagesRateLimitDelayMs: this.messagesRateLimitDelayMs,
            pendingOptimisticMessageCount: this.pendingOptimisticChatMessages.size,
            queueLength: this.queueLength,
            queuedOperationCountsByKind: queuedOperations.countsByKind,
            queuedOperationSample: queuedOperations.sample,
            queuedReplayAttempt: this.queuedReplayAttempt,
            queuedReplayRetryDeadline: this.queuedReplayRetryDeadline
                ? new Date(this.queuedReplayRetryDeadline).toISOString()
                : undefined,
            realtimeConfirmationRefreshAttempt: this.realtimeConfirmationRefreshAttempt,
            realtimeConfirmationRefreshDeadline: this.realtimeConfirmationRefreshDeadline
                ? new Date(this.realtimeConfirmationRefreshDeadline).toISOString()
                : undefined,
        };
    }

    reset(reason = 'chat_session_reset') {
        this.clearTimers();
        this.messages = [];
        this.historyComplete = false;
        this.historyLoadPromise = undefined;
        this.pendingOptimisticChatMessages.clear();
        this.awaitingRealtimeConfirmationMessageIds.clear();
        this.chatRateLimitRetryAttempt = 0;
        this.messagesRateLimitedUntil = undefined;
        this.queuedReplayAttempt = 0;
        this.emitState(reason);
    }

    restoreState(snapshot: PersistedProjectChatState, reason = 'chat_session_restored') {
        this.clearTimers();
        this.messages = this.mergeMessagesWithQueuedLocalState(snapshot.messages);
        this.historyComplete = snapshot.historyComplete;
        this.historyLoadPromise = undefined;
        this.pendingOptimisticChatMessages.clear();
        this.awaitingRealtimeConfirmationMessageIds.clear();
        this.chatRateLimitRetryAttempt = 0;
        this.messagesRateLimitedUntil = undefined;
        this.queuedReplayAttempt = 0;
        this.emitState(reason);
    }

    dispose() {
        this.disposed = true;
        this.clearTimers();
        this.historyLoadPromise = undefined;
        this.queuedReplayPromise = undefined;
    }

    exportState(): PersistedProjectChatState {
        return {
            historyComplete: this.historyComplete,
            messages: this.cachedMessages,
        };
    }

    getMessageDelivery(messageId: string): ChatMessageDelivery {
        return resolveChatMessageDelivery({
            isQueued: this.chatQueueOperations.some((operation) => isChatOperationForMessage(operation, messageId)),
            messageId,
        });
    }

    async ensureHistoryLoaded(reason: string, options: {force?: boolean} = {}): Promise<ProjectChatLoadResult> {
        if (!options.force && this.historyComplete) {
            return {
                messages: this.cachedMessages,
                ok: true,
                source: 'offline-cache',
            };
        }
        if (this.historyLoadPromise) {
            return this.historyLoadPromise;
        }
        this.historyLoadPromise = (async (): Promise<ProjectChatLoadResult> => {
            if (!this.host.canFetchRemoteHistory()) {
                this.host.logDiagnostic('chat.messages_fetch_skipped_offline', {
                    historyComplete: this.historyComplete,
                    messageCount: this.messages.length,
                    reason,
                });
                return {
                    message: vscode.l10n.t('Overleaf chat is temporarily unavailable while the project is offline.'),
                    messages: this.messages.length > 0 ? this.cachedMessages : undefined,
                    ok: false,
                    retryable: true,
                };
            }
            try {
                const identity = await this.host.getAuthenticatedTransportIdentity(`chat_history:${reason}`);
                const snapshot = await this.fetchAllMessages(identity, reason);
                this.applyServerSnapshot(snapshot, `${reason}_loaded`);
                return {
                    messages: this.cachedMessages,
                    ok: true,
                    source: 'server',
                };
            } catch (error) {
                if (isLikelyConnectivityFailure(error)) {
                    this.host.logDiagnostic('chat.messages_fetch_connectivity_failure', {reason}, error);
                    return {
                        message: vscode.l10n.t('Overleaf chat is temporarily offline. Showing cached messages while the extension reconnects.'),
                        messages: this.messages.length > 0 ? this.cachedMessages : undefined,
                        ok: false,
                        retryable: true,
                    };
                }
                this.host.logDiagnostic('chat.messages_fetch_failed_exception', {reason}, error);
                return {
                    message: error instanceof Error
                        ? error.message
                        : vscode.l10n.t('Unable to load Overleaf chat messages.'),
                    messages: this.messages.length > 0 ? this.cachedMessages : undefined,
                    ok: false,
                    retryable: true,
                };
            }
        })().finally(() => {
            this.historyLoadPromise = undefined;
        });
        return this.historyLoadPromise;
    }

    async sendMessage(publicId: string, content: string): Promise<OverleafChatSendResult> {
        const trimmedContent = content.trim();
        const sendSpan = startDiagnosticSpan('ProjectChat', 'chat.message_send', {
            hasQueuedOperations: this.hasQueuedOperations,
            historyComplete: this.historyComplete,
            messageCount: this.messages.length,
            publicId,
        }, {
            category: 'chat',
            level: 'info',
        });
        if (!trimmedContent) {
            sendSpan.end({
                failureClass: 'user-actionable',
                outcome: 'validation_empty_message',
            });
            return buildOverleafChatSendFailure({
                message: vscode.l10n.t('Unable to send an empty Overleaf chat message.'),
                translator: (message) => vscode.l10n.t(message),
            });
        }
        const messageClientId = this.activeChatClientId ?? uuidv4();

        if (this.host.isOfflineMode() || !this.host.canSendLiveMessages()) {
            const queuedResult = await this.queueOutgoingChatMessage(trimmedContent, 'chat_message_offline', undefined, messageClientId);
            sendSpan.end({
                outcome: 'queued_offline',
                queueLength: this.queueLength,
            });
            return queuedResult;
        }
        if (this.hasQueuedOperations) {
            const queuedResult = await this.queueOutgoingChatMessage(
                trimmedContent,
                'chat_message_ordered_after_queue',
                undefined,
                messageClientId,
            );
            this.scheduleQueuedReplayRetry('chat_message_ordered_after_queue_retry');
            sendSpan.end({
                outcome: 'queued_after_existing_backlog',
                queueLength: this.queueLength,
            });
            return queuedResult;
        }

        const optimisticMessage = this.buildPendingLiveChatMessage(trimmedContent, messageClientId);
        recordOptimisticChatMessage(this.pendingOptimisticChatMessages, optimisticMessage);
        this.appendMessage(optimisticMessage, 'chat_message_live_local_append');
        try {
            const result = await this.sendWithInlineRateLimitRetries(messageClientId, trimmedContent, 'chat_message_live_send');
            if (result.ok) {
                this.chatRateLimitRetryAttempt = 0;
                this.noteAwaitingRealtimeConfirmation(
                    optimisticMessage.id,
                    'chat_message_live_confirmation_pending',
                );
                sendSpan.end({
                    awaitingRealtimeConfirmationCount: this.awaitingRealtimeConfirmationMessageIds.size,
                    outcome: 'delivered',
                    queuedOperationsAfterSend: this.queueLength,
                });
                return result;
            }
            if (result.code==='rate-limited') {
                const queuedResult = await this.queueOutgoingChatMessage(
                    trimmedContent,
                    'chat_message_rate_limited',
                    optimisticMessage.id,
                    messageClientId,
                );
                this.scheduleQueuedReplayRetry('chat_message_rate_limited_retry');
                sendSpan.end({
                    failureClass: 'transient',
                    outcome: 'queued_after_rate_limit',
                    queueLength: this.queueLength,
                });
                return queuedResult;
            }
            this.removeMessage(optimisticMessage.id, 'chat_message_live_failed_removed');
            sendSpan.end({
                failureClass: 'persistent',
                outcome: 'send_rejected',
                rejectionCode: result.code ?? '',
            });
            return result;
        } catch (error) {
            if (!isLikelyConnectivityFailure(error)) {
                this.removeMessage(optimisticMessage.id, 'chat_message_live_exception_removed');
                sendSpan.fail(error, {
                    failureClass: 'internal',
                    outcome: 'send_exception',
                });
                throw error;
            }
            this.host.logDiagnostic('chat.message_connectivity_failure', {
                clientId: messageClientId,
                failureClass: 'transient',
            }, error);
            const queuedResult = await this.queueOutgoingChatMessage(
                trimmedContent,
                'chat_message_connectivity_failure',
                optimisticMessage.id,
                messageClientId,
            );
            this.scheduleQueuedReplayRetry('chat_message_connectivity_failure_retry');
            sendSpan.end({
                failureClass: 'transient',
                outcome: 'queued_after_connectivity_failure',
                queueLength: this.queueLength,
            });
            return queuedResult;
        }
    }

    async editMessage(messageId: string, content: string) {
        const trimmedContent = content.trim();
        if (!trimmedContent) {
            throw new Error(vscode.l10n.t('Chat messages cannot be empty.'));
        }
        const existingMessage = this.messages.find((message) => message.id===messageId);
        if (!existingMessage) {
            throw new Error(vscode.l10n.t('Unable to find the chat message to edit.'));
        }
        if (this.getMessageDelivery(messageId).state==='pending') {
            throw new Error(vscode.l10n.t('Only delivered chat messages can be edited.'));
        }

        const nextMessage = {
            ...existingMessage,
            content: trimmedContent,
            edited_at: Date.now(),
        };
        this.replaceMessage(messageId, nextMessage, 'chat_message_edit_local');

        if (this.host.isOfflineMode() || !this.host.canSendLiveMessages()) {
            await this.queueEditOperation(messageId, trimmedContent, 'chat_message_edit_offline');
            return;
        }

        try {
            const identity = await this.host.getAuthenticatedTransportIdentity('chat_edit');
            const response = await this.host.api.editChatMessage(identity, this.host.projectId, messageId, trimmedContent);
            if (response.type==='success') {
                return;
            }
            this.replaceMessage(messageId, existingMessage, 'chat_message_edit_reverted');
            throw new Error(response.message ?? vscode.l10n.t('Unable to edit the Overleaf chat message.'));
        } catch (error) {
            if (!isLikelyConnectivityFailure(error)) {
                this.replaceMessage(messageId, existingMessage, 'chat_message_edit_reverted');
                throw error;
            }
            this.host.logDiagnostic('chat.message_edit_connectivity_failure', {
                failureClass: 'transient',
                messageId,
            }, error);
            await this.queueEditOperation(messageId, trimmedContent, 'chat_message_edit_connectivity_failure');
            this.scheduleQueuedReplayRetry('chat_message_edit_connectivity_failure_retry');
        }
    }

    async deleteMessage(messageId: string) {
        const existingMessage = this.messages.find((message) => message.id===messageId);
        if (!existingMessage) {
            throw new Error(vscode.l10n.t('Unable to find the chat message to delete.'));
        }
        if (this.getMessageDelivery(messageId).state==='pending') {
            throw new Error(vscode.l10n.t('Only delivered chat messages can be deleted.'));
        }
        const existingIndex = this.messages.findIndex((message) => message.id===messageId);

        this.removeMessage(messageId, 'chat_message_delete_local');
        if (this.host.isOfflineMode() || !this.host.canSendLiveMessages()) {
            await this.queueDeleteOperation(messageId, 'chat_message_delete_offline');
            return;
        }

        try {
            const identity = await this.host.getAuthenticatedTransportIdentity('chat_delete');
            const response = await this.host.api.deleteChatMessage(identity, this.host.projectId, messageId);
            if (response.type==='success') {
                return;
            }
            const verifiedSnapshot = await this.fetchVerifiedDeleteSnapshot(
                identity,
                messageId,
                'chat_message_delete_failed_confirmation',
            );
            if (verifiedSnapshot) {
                this.applyServerSnapshot(verifiedSnapshot, 'chat_message_delete_verified');
                return;
            }
            throw new Error(response.message ?? vscode.l10n.t('Unable to delete the Overleaf chat message.'));
        } catch (error) {
            if (!isLikelyConnectivityFailure(error)) {
                this.restoreMessage(existingMessage, existingIndex, 'chat_message_delete_reverted');
                throw error;
            }
            this.host.logDiagnostic('chat.message_delete_connectivity_failure', {
                failureClass: 'transient',
                messageId,
            }, error);
            await this.queueDeleteOperation(messageId, 'chat_message_delete_connectivity_failure');
            this.scheduleQueuedReplayRetry('chat_message_delete_connectivity_failure_retry');
        }
    }

    handleIncomingMessage(message: ProjectMessageResponseSchema, reason = 'chat_message_received') {
        const pendingMessageId = consumeOptimisticChatMessageId(this.pendingOptimisticChatMessages, message);
        if (pendingMessageId) {
            this.replaceMessage(pendingMessageId, message, `${reason}_optimistic_confirmed`);
            return;
        }
        const locallySendingMessage = this.findLocalPendingMatch(message);
        if (locallySendingMessage) {
            this.replaceMessage(locallySendingMessage.id, message, `${reason}_optimistic_matched`);
            return;
        }

        const existingIndex = this.messages.findIndex((candidate) => candidate.id===message.id);
        if (existingIndex >= 0) {
            const nextMessages = this.messages.map((candidate, index) => index===existingIndex
                ? cloneChatMessage(message)
                : candidate);
            this.messages = nextMessages;
            this.emitState(reason, {message: cloneChatMessage(message)});
            return;
        }

        this.messages = [...this.messages, cloneChatMessage(message)];
        this.emitState(reason, {message: cloneChatMessage(message)});
    }

    handleIncomingEdit(messageId: string, _userId: string, content: string, reason = 'chat_message_edited') {
        const existingIndex = this.messages.findIndex((candidate) => candidate.id===messageId);
        if (existingIndex < 0) {
            void this.refreshFromServer(`${reason}_missing_message`);
            return;
        }
        const nextMessage = {
            ...this.messages[existingIndex],
            content,
            edited_at: Date.now(),
        };
        this.messages = this.messages.map((candidate, index) => index===existingIndex ? nextMessage : candidate);
        this.emitState(reason);
    }

    handleIncomingDelete(messageId: string, _userId: string, reason = 'chat_message_deleted') {
        const existingLength = this.messages.length;
        this.messages = this.messages.filter((candidate) => candidate.id!==messageId);
        if (this.messages.length===existingLength) {
            void this.refreshFromServer(`${reason}_missing_message`);
            return;
        }
        this.emitState(reason);
    }

    handleConnectionRestored(reason: string) {
        if (this.disposed || this.host.isOfflineMode()) {
            return;
        }
        const forceCheckpoint = shouldForceReconnectCheckpoint(reason, this.hasQueuedOperations);
        if (this.hasQueuedOperations) {
            void this.bootstrapQueuedRecovery(reason, {forceCheckpoint});
            return;
        }
        if (forceCheckpoint || !this.historyComplete) {
            void this.ensureHistoryLoaded(`${reason}_bootstrap`, {force: true});
            return;
        }
    }

    async refreshFromServer(reason: string) {
        if (this.disposed || !this.host.canFetchRemoteHistory()) {
            return;
        }
        const identity = await this.host.getAuthenticatedTransportIdentity(`chat_refresh:${reason}`);
        const snapshot = await this.fetchAllMessages(identity, reason);
        this.applyServerSnapshot(snapshot, `${reason}_refreshed`);
    }

    async replayQueuedOperations(reason: string) {
        if (this.disposed || this.host.isOfflineMode() || !this.host.canSendLiveMessages()) {
            return;
        }
        if (this.queuedReplayPromise) {
            return this.queuedReplayPromise;
        }

        this.queuedReplayPromise = (async () => {
            const operations = this.chatQueueOperations.slice().sort(sortDeferredOperations);
            if (operations.length===0) {
                this.queuedReplayAttempt = 0;
                return;
            }
            const replayedKinds = new Set<ChatQueueOperation['kind']>();

            for (const operation of operations) {
                try {
                    await this.replayQueuedOperation(operation, reason);
                    replayedKinds.add(operation.kind);
                } catch (error) {
                    if (isLikelyConnectivityFailure(error)) {
                        this.host.logDiagnostic('chat.queued_sync_connectivity_failure', {
                            failureClass: 'transient',
                            failedOperationId: operation.id,
                            failedOperationKind: operation.kind,
                        }, error);
                        this.scheduleQueuedReplayRetry(`${reason}_connectivity_failure`);
                        return;
                    }
                    this.host.logDiagnostic('chat.queued_sync_failed', {
                        failureClass: 'persistent',
                        failedOperationId: operation.id,
                        failedOperationKind: operation.kind,
                        reason,
                    }, error);
                    return;
                }
            }

            this.queuedReplayAttempt = 0;
            if (!this.hasQueuedOperations && !replayedKinds.has('chat.send')) {
                await this.refreshFromServer(`${reason}_checkpoint`);
            }
        })().finally(() => {
            this.queuedReplayPromise = undefined;
        });
        return this.queuedReplayPromise;
    }

    private clearTimers() {
        if (this.queuedReplayRetryTimer) {
            clearTimeout(this.queuedReplayRetryTimer);
            this.queuedReplayRetryTimer = undefined;
            this.queuedReplayRetryDeadline = undefined;
        }
        if (this.realtimeConfirmationRefreshTimer) {
            clearTimeout(this.realtimeConfirmationRefreshTimer);
            this.realtimeConfirmationRefreshTimer = undefined;
            this.realtimeConfirmationRefreshDeadline = undefined;
        }
    }

    private emitState(reason: string, options: {message?: ProjectMessageResponseSchema} = {}) {
        this.pruneOrphanedSendingMessages(reason);
        pruneOptimisticChatMessages(
            this.pendingOptimisticChatMessages,
            this.messages.map((message) => message.id),
        );
        this.pruneAwaitingRealtimeConfirmations(`${reason}_pre_emit`);
        this.host.onStateChanged(this.exportState(), reason, options.message
            ? {message: cloneChatMessage(options.message)}
            : undefined);
    }

    private get activeChatClientId() {
        return this.host.getActiveChatClientId()?.trim() || undefined;
    }

    private get chatQueueOperations() {
        return this.host.getDeferredSyncOperations()
            .filter(isDeferredSyncChatOperation);
    }

    private buildOfflineChatUser() {
        const member = this.host.resolveCurrentProjectMember();
        return {
            email: member?.email ?? '',
            first_name: member?.first_name ?? member?.email ?? this.host.userId,
            id: this.host.userId,
            last_name: member?.last_name,
        };
    }

    private buildOfflineChatMessage(
        content: string,
        messageId = `offline-chat-${uuidv4()}`,
        clientId = this.activeChatClientId ?? uuidv4(),
    ): ProjectMessageResponseSchema {
        return buildOptimisticChatMessage({
            clientId,
            content,
            id: messageId,
            timestamp: Date.now(),
            user: this.buildOfflineChatUser(),
            userId: this.host.userId,
        });
    }

    private buildPendingLiveChatMessage(content: string, clientId: string, messageId = `pending-chat-${uuidv4()}`) {
        return buildOptimisticChatMessage({
            clientId,
            content,
            id: messageId,
            user: this.buildOfflineChatUser(),
            userId: this.host.userId,
        });
    }

    private appendMessage(message: ProjectMessageResponseSchema, reason: string) {
        const existingIndex = this.messages.findIndex((candidate) => candidate.id===message.id);
        this.messages = existingIndex >= 0
            ? this.messages.map((candidate, index) => index===existingIndex ? cloneChatMessage(message) : candidate)
            : [...this.messages, cloneChatMessage(message)];
        this.emitState(reason, {message});
    }

    private restoreMessage(message: ProjectMessageResponseSchema, index: number, reason: string) {
        const nextMessage = cloneChatMessage(message);
        const existingIndex = this.messages.findIndex((candidate) => candidate.id===message.id);
        if (existingIndex >= 0) {
            this.messages = this.messages.map((candidate, currentIndex) => currentIndex===existingIndex ? nextMessage : candidate);
            this.emitState(reason);
            return;
        }
        const nextMessages = [...this.messages];
        if (index < 0 || index >= nextMessages.length) {
            nextMessages.push(nextMessage);
        } else {
            nextMessages.splice(index, 0, nextMessage);
        }
        this.messages = nextMessages;
        this.emitState(reason);
    }

    private replaceMessage(previousMessageId: string, nextMessage: ProjectMessageResponseSchema, reason: string) {
        const existingIndex = this.messages.findIndex((candidate) => candidate.id===previousMessageId);
        if (existingIndex < 0) {
            this.appendMessage(nextMessage, `${reason}_missing_local_message`);
            return;
        }
        discardOptimisticChatMessageId(this.pendingOptimisticChatMessages, previousMessageId);
        this.messages = this.messages.map((candidate, index) => index===existingIndex ? cloneChatMessage(nextMessage) : candidate);
        this.emitState(reason);
    }

    private removeMessage(messageId: string, reason: string) {
        const existingLength = this.messages.length;
        this.messages = this.messages.filter((candidate) => candidate.id!==messageId);
        if (this.messages.length===existingLength) {
            return;
        }
        discardOptimisticChatMessageId(this.pendingOptimisticChatMessages, messageId);
        this.emitState(reason);
    }

    private getLocalOnlyMessages() {
        return this.messages.filter((message) => {
            return isTemporaryChatMessageId(message.id)
                || this.awaitingRealtimeConfirmationMessageIds.has(message.id);
        });
    }

    private getLocallySendingMessages() {
        return this.getLocalOnlyMessages().filter((message) => {
            return this.getMessageDelivery(message.id).detail==='sending'
                || this.awaitingRealtimeConfirmationMessageIds.has(message.id);
        });
    }

    private pruneOrphanedSendingMessages(reason: string, now = Date.now()) {
        if (this.messages.length===0) {
            return;
        }
        const deliveredMessagesByUserId = new Map<string, ProjectMessageResponseSchema[]>();
        for (const message of this.messages) {
            if (isTemporaryChatMessageId(message.id) || this.getMessageDelivery(message.id).state!=='delivered') {
                continue;
            }
            const existingMessages = deliveredMessagesByUserId.get(message.user_id) ?? [];
            existingMessages.push(message);
            deliveredMessagesByUserId.set(message.user_id, existingMessages);
        }

        const orphanedMessageIds = this.messages
            .filter((message) => {
                if (!isTemporaryChatMessageId(message.id)) {
                    return false;
                }
                const delivery = this.getMessageDelivery(message.id);
                if (delivery.detail!=='sending') {
                    return false;
                }
                if (message.user_id!==this.host.userId) {
                    return false;
                }
                if ((now - message.timestamp) < CHAT_ORPHANED_SENDING_STALE_MS) {
                    return false;
                }
                const normalizedContent = normalizeChatMessageContentForComparison(message.content);
                return (deliveredMessagesByUserId.get(message.user_id) ?? []).some((deliveredMessage) => {
                    return deliveredMessage.timestamp >= message.timestamp
                        && normalizeChatMessageContentForComparison(deliveredMessage.content)===normalizedContent;
                });
            })
            .map((message) => message.id);

        if (orphanedMessageIds.length===0) {
            return;
        }

        const orphanedMessageIdSet = new Set(orphanedMessageIds);
        this.messages = this.messages.filter((message) => !orphanedMessageIdSet.has(message.id));
        orphanedMessageIds.forEach((messageId) => {
            discardOptimisticChatMessageId(this.pendingOptimisticChatMessages, messageId);
            this.awaitingRealtimeConfirmationMessageIds.delete(messageId);
        });
        this.host.logDiagnostic('chat.orphaned_sending_messages_pruned', {
            orphanedMessageIds,
            prunedCount: orphanedMessageIds.length,
            reason,
        });
    }

    private findLocalPendingMatch(serverMessage: ProjectMessageResponseSchema, excludedMessageIds = new Set<string>()) {
        if (serverMessage.user_id!==this.host.userId) {
            return undefined;
        }
        const locallySendingMessages = this.getLocallySendingMessages()
            .sort((left, right) => left.timestamp - right.timestamp)
            .filter((message) => {
                if (excludedMessageIds.has(message.id)) {
                    return false;
                }
                return serverMessage.timestamp >= (message.timestamp - CHAT_SNAPSHOT_MATCH_SKEW_MS);
            });
        const exactContentMatch = locallySendingMessages.find((message) => {
            return message.content===serverMessage.content;
        });
        if (exactContentMatch) {
            return exactContentMatch;
        }
        if (isOwnChatMessageClient(serverMessage.clientId, this.activeChatClientId)) {
            return locallySendingMessages[0];
        }
        return undefined;
    }

    private buildQueuedSendLocalMessage(
        operation: Extract<ChatQueueOperation, {kind: 'chat.send'}>,
    ): ProjectMessageResponseSchema {
        return buildOptimisticChatMessage({
            clientId: operation.payload.clientId ?? this.activeChatClientId ?? uuidv4(),
            content: operation.payload.content,
            id: operation.payload.localMessageId,
            timestamp: Number.isFinite(Date.parse(operation.createdAt))
                ? Date.parse(operation.createdAt)
                : Date.now(),
            user: this.buildOfflineChatUser(),
            userId: this.host.userId,
        });
    }

    private getMissingQueuedSendMessages(existingMessages: readonly ProjectMessageResponseSchema[]) {
        const existingMessageIds = new Set(existingMessages.map((message) => message.id));
        const missingQueuedMessages: ProjectMessageResponseSchema[] = [];
        for (const operation of this.chatQueueOperations.sort(sortDeferredOperations)) {
            if (operation.kind!=='chat.send' || existingMessageIds.has(operation.payload.localMessageId)) {
                continue;
            }
            const localMessage = this.buildQueuedSendLocalMessage(operation);
            existingMessageIds.add(localMessage.id);
            missingQueuedMessages.push(localMessage);
        }
        return missingQueuedMessages;
    }

    private applyQueuedEditDeleteMutations(messages: ProjectMessageResponseSchema[]) {
        let nextMessages = [...messages];
        for (const operation of this.chatQueueOperations.sort(sortDeferredOperations)) {
            if (operation.kind==='chat.edit') {
                nextMessages = nextMessages.map((message) => message.id===operation.payload.messageId
                    ? {
                        ...message,
                        content: operation.payload.content,
                        edited_at: message.edited_at ?? Date.now(),
                    }
                    : message);
            }
            if (operation.kind==='chat.delete') {
                nextMessages = nextMessages.filter((message) => message.id!==operation.payload.messageId);
            }
        }
        return nextMessages;
    }

    private mergeMessagesWithQueuedLocalState(messages: readonly ProjectMessageResponseSchema[]) {
        const mergedMessages = [
            ...messages.map(cloneChatMessage),
            ...this.getMissingQueuedSendMessages(messages),
        ];
        return this.applyQueuedEditDeleteMutations(mergedMessages);
    }

    private mergeServerSnapshot(serverMessages: ProjectMessageResponseSchema[]) {
        const localOnlyMessages = new Map(
            this.getLocalOnlyMessages().map((message) => [message.id, message] as const),
        );
        this.getMissingQueuedSendMessages(this.messages).forEach((message) => {
            localOnlyMessages.set(message.id, message);
        });
        const matchedPendingIds = new Set<string>();

        for (const serverMessage of serverMessages) {
            let pendingMessageId: string | undefined;
            pendingMessageId = consumeOptimisticChatMessageId(this.pendingOptimisticChatMessages, serverMessage);
            if (!pendingMessageId) {
                const matchedMessage = this.findLocalPendingMatch(serverMessage, matchedPendingIds);
                pendingMessageId = matchedMessage?.id;
            }
            if (!pendingMessageId) {
                continue;
            }
            matchedPendingIds.add(pendingMessageId);
            localOnlyMessages.delete(pendingMessageId);
        }

        const mergedServerMessages = this.applyQueuedEditDeleteMutations(
            serverMessages.map(cloneChatMessage),
        );
        const remainingPendingMessages = [...localOnlyMessages.values()];
        return [
            ...mergedServerMessages,
            ...remainingPendingMessages.map(cloneChatMessage),
        ];
    }

    private applyServerSnapshot(serverMessages: ProjectMessageResponseSchema[], reason: string) {
        this.historyComplete = true;
        this.messages = this.mergeServerSnapshot(serverMessages);
        this.emitState(reason);
    }

    private async fetchVerifiedDeleteSnapshot(identity: Identity, messageId: string, reason: string) {
        try {
            const snapshot = await this.fetchAllMessages(identity, reason);
            const deletedOnServer = snapshot.every((message) => message.id!==messageId);
            this.host.logDiagnostic('chat.message_delete_verified_from_server', {
                deletedOnServer,
                messageId,
                reason,
                serverMessageCount: snapshot.length,
            });
            return deletedOnServer ? snapshot : undefined;
        } catch (error) {
            this.host.logDiagnostic('chat.message_delete_verification_failed', {
                messageId,
                reason,
            }, error);
            return undefined;
        }
    }

    private async fetchAllMessages(identity: Identity, reason: string) {
        let before: number | undefined;
        let pageNumber = 1;
        let orderedMessages: ProjectMessageResponseSchema[] = [];

        while (true) {
            const response = await this.host.api.getMessages(
                identity,
                this.host.projectId,
                CHAT_HISTORY_PAGE_SIZE,
                before,
            );
            if (response.type!=='success') {
                if (response.statusCode===429) {
                    this.noteMessagesRateLimit(`${reason}_history_fetch`);
                }
                throw new Error(response.message ?? vscode.l10n.t('Unable to load Overleaf chat messages.'));
            }
            this.clearMessagesRateLimit(`${reason}_history_fetch_succeeded`);

            const page = response.messages ?? [];
            orderedMessages = prependPaginatedChatPage(orderedMessages, page);
            const nextBefore = resolveNextChatHistoryCursor(page);
            const shouldContinue = shouldContinueChatHistoryPagination({
                maxPages: Number.MAX_SAFE_INTEGER,
                nextBefore,
                pageMessageCount: page.length,
                pageNumber,
                pageSize: CHAT_HISTORY_PAGE_SIZE,
                previousBefore: before,
            });
            this.host.logDiagnostic('chat.messages_page_loaded', {
                before: before ?? '',
                messageCount: page.length,
                pageNumber,
                reason,
                shouldContinue,
            });
            if (!shouldContinue) {
                break;
            }
            before = nextBefore;
            pageNumber += 1;
        }

        return orderedMessages;
    }

    private async queueOutgoingChatMessage(
        content: string,
        reason: string,
        existingLocalMessageId?: string,
        clientId = uuidv4(),
    ): Promise<Extract<OverleafChatSendResult, {deliveryState: 'queued', ok: true}>> {
        const localMessage = existingLocalMessageId
            ? this.messages.find((message) => message.id===existingLocalMessageId) ?? this.buildOfflineChatMessage(content, existingLocalMessageId, clientId)
            : this.buildOfflineChatMessage(content, undefined, clientId);
        if (!existingLocalMessageId) {
            this.appendMessage(localMessage, `${reason}_local_appended`);
        }
        await this.host.appendDeferredSyncOperation({
            createdAt: new Date().toISOString(),
            id: `offline-op-${uuidv4()}`,
            kind: 'chat.send',
            payload: {
                clientId,
                content,
                localMessageId: localMessage.id,
            },
        }, `${reason}_queued`);
        this.emitState(`${reason}_queued_state`);
        return {
            ok: true,
            deliveryState: 'queued',
            mode: 'offline-queued',
            queuedMessageId: localMessage.id,
            transport: 'offline',
        };
    }

    private async queueEditOperation(messageId: string, content: string, reason: string) {
        await this.host.replaceDeferredSyncOperations(`${reason}_queued`, (operations) => {
            const nextOperations = operations.filter((operation) => {
                return !(operation.kind==='chat.edit' && operation.payload.messageId===messageId);
            });
            nextOperations.push({
                createdAt: new Date().toISOString(),
                id: `offline-op-${uuidv4()}`,
                kind: 'chat.edit',
                payload: {
                    content,
                    messageId,
                },
            });
            return nextOperations;
        });
        this.emitState(`${reason}_queued_state`);
    }

    private async queueDeleteOperation(messageId: string, reason: string) {
        await this.host.replaceDeferredSyncOperations(`${reason}_queued`, (operations) => {
            const nextOperations = operations.filter((operation) => {
                if (operation.kind==='chat.edit' && operation.payload.messageId===messageId) {
                    return false;
                }
                if (operation.kind==='chat.delete' && operation.payload.messageId===messageId) {
                    return false;
                }
                return true;
            });
            nextOperations.push({
                createdAt: new Date().toISOString(),
                id: `offline-op-${uuidv4()}`,
                kind: 'chat.delete',
                payload: {
                    messageId,
                },
            });
            return nextOperations;
        });
        this.emitState(`${reason}_queued_state`);
    }

    private async replayQueuedOperation(operation: ChatQueueOperation, reason: string) {
        switch (operation.kind) {
            case 'chat.send':
                return this.replayQueuedSend(operation, reason);
            case 'chat.edit':
                return this.replayQueuedEdit(operation);
            case 'chat.delete':
                return this.replayQueuedDelete(operation);
        }
    }

    private async replayQueuedSend(operation: Extract<ChatQueueOperation, {kind: 'chat.send'}>, reason: string) {
        let localMessage = this.messages.find((message) => message.id===operation.payload.localMessageId);
        if (!localMessage) {
            localMessage = this.buildQueuedSendLocalMessage(operation);
            this.appendMessage(localMessage, 'chat_queued_send_missing_local_restored');
        }
        const messageClientId = this.activeChatClientId ?? operation.payload.clientId ?? localMessage.clientId ?? uuidv4();
        if (localMessage.clientId!==messageClientId) {
            localMessage = {
                ...localMessage,
                clientId: messageClientId,
            };
            this.replaceMessage(localMessage.id, localMessage, 'chat_queued_send_client_id_updated');
        }

        recordOptimisticChatMessage(this.pendingOptimisticChatMessages, {
            clientId: messageClientId,
            content: localMessage.content,
            id: localMessage.id,
        });

        const result = await this.sendWithInlineRateLimitRetries(
            messageClientId,
            localMessage.content,
            `${reason}_queued_send`,
        );
        if (result.ok) {
            await this.host.removeDeferredSyncOperation(operation.id, 'chat_queued_send_replayed');
            this.noteAwaitingRealtimeConfirmation(localMessage.id, 'chat_queued_send_confirmation_pending');
            this.emitState('chat_queued_send_replayed_state');
            return;
        }
        if (result.code==='rate-limited') {
            this.scheduleQueuedReplayRetry('chat_queued_send_rate_limited');
            return;
        }
        throw new Error(result.message);
    }

    private async replayQueuedEdit(operation: Extract<ChatQueueOperation, {kind: 'chat.edit'}>) {
        const identity = await this.host.getAuthenticatedTransportIdentity('chat_replay_edit');
        const response = await this.host.api.editChatMessage(
            identity,
            this.host.projectId,
            operation.payload.messageId,
            operation.payload.content,
        );
        if (response.type!=='success') {
            throw new Error(response.message ?? 'Unable to replay chat edit');
        }
        await this.host.removeDeferredSyncOperation(operation.id, 'chat_queued_edit_replayed');
        this.emitState('chat_queued_edit_replayed_state');
    }

    private async replayQueuedDelete(operation: Extract<ChatQueueOperation, {kind: 'chat.delete'}>) {
        const identity = await this.host.getAuthenticatedTransportIdentity('chat_replay_delete');
        const response = await this.host.api.deleteChatMessage(
            identity,
            this.host.projectId,
            operation.payload.messageId,
        );
        if (response.type!=='success') {
            throw new Error(response.message ?? 'Unable to replay chat delete');
        }
        await this.host.removeDeferredSyncOperation(operation.id, 'chat_queued_delete_replayed');
        this.emitState('chat_queued_delete_replayed_state');
    }

    private scheduleQueuedReplayRetry(reason: string) {
        if (this.disposed || this.host.isOfflineMode() || !this.hasQueuedOperations) {
            return;
        }
        this.queuedReplayAttempt += 1;
        const delayMs = Math.max(
            calculateChatRateLimitRetryDelayMs(this.queuedReplayAttempt),
            this.messagesRateLimitDelayMs,
        );
        const nextDeadline = Date.now() + delayMs;
        if (this.queuedReplayRetryTimer) {
            if ((this.queuedReplayRetryDeadline ?? Number.POSITIVE_INFINITY) <= nextDeadline) {
                return;
            }
            clearTimeout(this.queuedReplayRetryTimer);
        }
        this.host.logDiagnostic('chat.queued_sync_retry_scheduled', {
            attempt: this.queuedReplayAttempt,
            delayMs,
            reason,
        });
        this.queuedReplayRetryDeadline = nextDeadline;
        this.queuedReplayRetryTimer = setTimeout(() => {
            this.queuedReplayRetryTimer = undefined;
            this.queuedReplayRetryDeadline = undefined;
            void this.replayQueuedOperations(`${reason}_retry`);
        }, delayMs);
    }

    private async bootstrapQueuedRecovery(reason: string, options: {forceCheckpoint?: boolean} = {}) {
        if (options.forceCheckpoint || !this.historyComplete) {
            try {
                await this.ensureHistoryLoaded(`${reason}_bootstrap`, {force: true});
            } catch {
                // Keep queued recovery moving even when bootstrap cannot refresh yet.
            }
        }
        await this.replayQueuedOperations(`${reason}_queued_replay`);
    }

    private pruneAwaitingRealtimeConfirmations(reason: string) {
        if (this.awaitingRealtimeConfirmationMessageIds.size===0) {
            return;
        }
        const activeMessageIds = new Set(this.messages.map((message) => message.id));
        let removedCount = 0;
        for (const messageId of [...this.awaitingRealtimeConfirmationMessageIds]) {
            if (activeMessageIds.has(messageId)) {
                continue;
            }
            this.awaitingRealtimeConfirmationMessageIds.delete(messageId);
            removedCount += 1;
        }
        if (removedCount > 0) {
            this.host.logDiagnostic('chat.realtime_confirmation_wait_pruned', {
                pendingConfirmationCount: this.awaitingRealtimeConfirmationMessageIds.size,
                prunedCount: removedCount,
                reason,
            });
        }
        if (this.awaitingRealtimeConfirmationMessageIds.size===0 && this.realtimeConfirmationRefreshTimer) {
            clearTimeout(this.realtimeConfirmationRefreshTimer);
            this.realtimeConfirmationRefreshTimer = undefined;
            this.realtimeConfirmationRefreshDeadline = undefined;
            this.realtimeConfirmationRefreshAttempt = 0;
        }
    }

    private noteAwaitingRealtimeConfirmation(messageId: string, reason: string) {
        const hasMessage = this.messages.some((message) => message.id===messageId);
        if (!hasMessage) {
            return;
        }
        this.awaitingRealtimeConfirmationMessageIds.add(messageId);
        this.scheduleRealtimeConfirmationRefresh(reason);
    }

    private scheduleRealtimeConfirmationRefresh(reason: string) {
        this.pruneAwaitingRealtimeConfirmations(`${reason}_preflight`);
        if (this.disposed || !this.host.canFetchRemoteHistory() || this.awaitingRealtimeConfirmationMessageIds.size===0) {
            return;
        }
        const attempt = this.realtimeConfirmationRefreshAttempt + 1;
        const delayMs = Math.max(
            calculateChatRealtimeConfirmationRefreshDelayMs(attempt),
            this.messagesRateLimitDelayMs,
        );
        const nextDeadline = Date.now() + delayMs;
        if (this.realtimeConfirmationRefreshTimer) {
            if ((this.realtimeConfirmationRefreshDeadline ?? Number.POSITIVE_INFINITY) <= nextDeadline) {
                return;
            }
            clearTimeout(this.realtimeConfirmationRefreshTimer);
        }
        this.realtimeConfirmationRefreshDeadline = nextDeadline;
        this.realtimeConfirmationRefreshTimer = setTimeout(() => {
            this.realtimeConfirmationRefreshTimer = undefined;
            this.realtimeConfirmationRefreshDeadline = undefined;
            void this.refreshAwaitingRealtimeConfirmations(reason);
        }, delayMs);
    }

    private async refreshAwaitingRealtimeConfirmations(reason: string) {
        this.pruneAwaitingRealtimeConfirmations(`${reason}_started`);
        if (!this.host.canFetchRemoteHistory() || this.awaitingRealtimeConfirmationMessageIds.size===0) {
            return;
        }
        this.realtimeConfirmationRefreshAttempt += 1;
        if (this.messagesRateLimitDelayMs > 0) {
            this.host.logDiagnostic('chat.realtime_confirmation_refresh_rate_limited', {
                attempt: this.realtimeConfirmationRefreshAttempt,
                delayMs: this.messagesRateLimitDelayMs,
                pendingConfirmationCount: this.awaitingRealtimeConfirmationMessageIds.size,
                reason,
            });
            this.scheduleRealtimeConfirmationRefresh(`${reason}_rate_limited_retry`);
            return;
        }
        try {
            await this.refreshFromServer(reason);
        } catch (error) {
            if (isLikelyConnectivityFailure(error)) {
                this.host.logDiagnostic('chat.realtime_confirmation_refresh_connectivity_failure', {
                    attempt: this.realtimeConfirmationRefreshAttempt,
                    pendingConfirmationCount: this.awaitingRealtimeConfirmationMessageIds.size,
                    reason,
                }, error);
                return;
            }
            this.host.logDiagnostic('chat.realtime_confirmation_refresh_failed', {
                attempt: this.realtimeConfirmationRefreshAttempt,
                pendingConfirmationCount: this.awaitingRealtimeConfirmationMessageIds.size,
                reason,
            }, error);
        } finally {
            this.pruneAwaitingRealtimeConfirmations(`${reason}_completed`);
            if (this.awaitingRealtimeConfirmationMessageIds.size > 0) {
                this.scheduleRealtimeConfirmationRefresh(`${reason}_retry`);
            }
        }
    }

    private async sendWithInlineRateLimitRetries(
        clientId: string,
        content: string,
        reason: string,
    ): Promise<OverleafChatSendResult> {
        let attempt = 0;
        while (true) {
            const result = await this.sendToServer(clientId, content);
            if (result.ok || result.code!=='rate-limited') {
                return result;
            }
            attempt += 1;
            const retryDelayMs = getChatRateLimitInlineRetryDelayMs(attempt);
            if (retryDelayMs===undefined) {
                return result;
            }
            this.host.logDiagnostic('chat.inline_rate_limit_retry_scheduled', {
                attempt,
                delayMs: retryDelayMs,
                reason,
            });
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
    }

    private async sendToServer(clientId: string, content: string): Promise<OverleafChatSendResult> {
        if (!clientId) {
            return buildOverleafChatSendFailure({
                code: 'missing-client-id',
                translator: (message) => vscode.l10n.t(message),
            });
        }
        try {
            const identity = await this.host.getAuthenticatedTransportIdentity('chat_send');
            const response = await this.host.api.sendMessage(
                identity,
                this.host.projectId,
                clientId,
                content,
            );
            if (response.type==='success') {
                this.clearMessagesRateLimit('chat_message_send_succeeded');
                return {
                    ok: true,
                    deliveryState: 'delivered',
                    mode: 'online',
                    transport: 'rest',
                };
            }
            if (response.statusCode===429 || response.chatSendErrorCode==='rate-limited') {
                this.noteMessagesRateLimit('chat_message_send_rate_limited');
            }
            return buildOverleafChatSendFailure({
                code: response.chatSendErrorCode,
                message: response.message,
                responseBody: response.responseBody,
                route: response.route,
                statusCode: response.statusCode,
                translator: (message) => vscode.l10n.t(message),
            });
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

    private noteMessagesRateLimit(reason: string) {
        const nextDeadline = Date.now() + CHAT_MESSAGES_RATE_LIMIT_COOLDOWN_MS;
        if ((this.messagesRateLimitedUntil ?? 0) >= nextDeadline) {
            return;
        }
        this.messagesRateLimitedUntil = nextDeadline;
        this.host.logDiagnostic('chat.messages_rate_limit_cooldown_started', {
            cooldownMs: CHAT_MESSAGES_RATE_LIMIT_COOLDOWN_MS,
            reason,
        });
    }

    private clearMessagesRateLimit(reason: string) {
        if (!this.messagesRateLimitedUntil) {
            return;
        }
        this.messagesRateLimitedUntil = undefined;
        this.host.logDiagnostic('chat.messages_rate_limit_cooldown_cleared', {reason});
    }

    private get messagesRateLimitDelayMs() {
        if (!this.messagesRateLimitedUntil) {
            return 0;
        }
        return Math.max(0, this.messagesRateLimitedUntil - Date.now());
    }
}
