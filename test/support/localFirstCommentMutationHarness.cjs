const {
    removeCommentRange,
    updateCommentRangeResolvedState,
    upsertCommentRange,
} = require('../../out/comments/commentRanges.js');
const {
    editCommentMessageInThread,
    mergeCommentMessageIntoThread,
    normalizeCommentThread,
    removeCommentMessageFromThread,
} = require('../../out/comments/commentThreads.js');

function cloneRanges(ranges) {
    return ranges.map((range) => ({
        ...range,
        metadata: range.metadata ? { ...range.metadata } : undefined,
        op: {
            ...range.op,
        },
    }));
}

function cloneThread(thread) {
    return thread ? normalizeCommentThread(thread) : undefined;
}

function defaultConnectivityPredicate(error) {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
    return code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
}

class LocalFirstCommentMutationHarness {
    constructor(options = {}) {
        this.userId = options.userId ?? 'user-1';
        this.connectivityPredicate = options.connectivityPredicate ?? defaultConnectivityPredicate;
        this.rangesByDocId = new Map();
        this.threadsById = new Map();
        this.queuedOperations = [];
        this.pendingMessageSequence = 0;
    }

    _nextPendingMessageId() {
        this.pendingMessageSequence += 1;
        return `pending-comment-${this.pendingMessageSequence}`;
    }

    _buildLocalMessage(content, messageId) {
        return {
            content,
            id: messageId ?? this._nextPendingMessageId(),
            timestamp: new Date().toISOString(),
            user: {
                id: this.userId,
                name: this.userId,
            },
            user_id: this.userId,
        };
    }

    _replaceMessageId(threadId, previousMessageId, nextMessageId) {
        const thread = this.threadsById.get(threadId);
        if (!thread) {
            return;
        }
        const nextThread = normalizeCommentThread({
            ...thread,
            messages: thread.messages.map((message) => {
                if (message.id !== previousMessageId) {
                    return message;
                }
                return {
                    ...message,
                    id: nextMessageId,
                };
            }),
        });
        this.threadsById.set(threadId, nextThread);
    }

    _getRanges(docId) {
        return cloneRanges(this.rangesByDocId.get(docId) ?? []);
    }

    _setRanges(docId, ranges) {
        this.rangesByDocId.set(docId, cloneRanges(ranges));
    }

    _removeThreadAcrossAllDocs(threadId) {
        this.threadsById.delete(threadId);
        for (const [docId, ranges] of this.rangesByDocId.entries()) {
            const nextRanges = removeCommentRange(ranges, threadId);
            this.rangesByDocId.set(docId, cloneRanges(nextRanges));
        }
    }

    _captureDocRangeSnapshotsForThread(threadId) {
        const snapshots = new Map();
        for (const [docId, ranges] of this.rangesByDocId.entries()) {
            if (!ranges.some((range) => range.op.t === threadId)) {
                continue;
            }
            snapshots.set(docId, cloneRanges(ranges));
        }
        return snapshots;
    }

    _restoreDocRangeSnapshots(snapshots) {
        for (const [docId, ranges] of snapshots.entries()) {
            this.rangesByDocId.set(docId, cloneRanges(ranges));
        }
    }

    _queueOperation(kind, payload) {
        this.queuedOperations.push({
            kind,
            payload,
        });
    }

    _isLocalPendingMessageId(messageId) {
        return typeof messageId === 'string'
            && (messageId.startsWith('pending-comment-') || messageId.startsWith('offline-comment-'));
    }

    _foldPendingMessageEditIntoQueuedOperation(threadId, messageId, content) {
        if (!this._isLocalPendingMessageId(messageId)) {
            return false;
        }

        let merged = false;
        this.queuedOperations = this.queuedOperations.filter((operation) => {
            if (operation.kind==='comment.edit'
                && operation.payload.threadId===threadId
                && operation.payload.messageId===messageId) {
                merged = true;
                return false;
            }
            if (operation.payload?.threadId!==threadId || operation.payload?.localMessageId!==messageId) {
                return true;
            }
            if (operation.kind==='comment.create' || operation.kind==='comment.reply') {
                operation.payload = {
                    ...operation.payload,
                    content,
                };
                merged = true;
            }
            return true;
        });
        return merged;
    }

    getThread(threadId) {
        return cloneThread(this.threadsById.get(threadId));
    }

    getRanges(docId) {
        return this._getRanges(docId);
    }

    getQueuedOperationKinds() {
        return this.queuedOperations.map((operation) => operation.kind);
    }

    getInlineSnapshot(docId) {
        const ranges = this._getRanges(docId)
            .sort((left, right) => left.op.p - right.op.p);
        const emittedThreadIds = new Set();
        const threads = [];
        for (const range of ranges) {
            const threadId = range.op.t;
            if (emittedThreadIds.has(threadId)) {
                continue;
            }
            emittedThreadIds.add(threadId);
            threads.push({
                range: {
                    ...range,
                    metadata: range.metadata ? {...range.metadata} : undefined,
                    op: {
                        ...range.op,
                    },
                },
                thread: cloneThread(this.threadsById.get(threadId)),
            });
        }
        return {
            docId,
            threads,
        };
    }

    getReviewEntries(docId) {
        const docIds = docId
            ? [docId]
            : Array.from(this.rangesByDocId.keys()).sort((left, right) => left.localeCompare(right));
        const entries = [];
        for (const currentDocId of docIds) {
            const ranges = this._getRanges(currentDocId)
                .sort((left, right) => left.op.p - right.op.p);
            const emittedThreadIds = new Set();
            for (const range of ranges) {
                const threadId = range.op.t;
                if (emittedThreadIds.has(threadId)) {
                    continue;
                }
                emittedThreadIds.add(threadId);
                const thread = cloneThread(this.threadsById.get(threadId));
                const messages = thread?.messages ?? [];
                if (messages.length===0) {
                    continue;
                }
                entries.push({
                    docId: currentDocId,
                    messageBodies: messages.map((message) => message.content),
                    messageIds: messages.map((message) => message.id),
                    resolved: Boolean(thread?.resolved ?? range.resolved ?? range.op.resolved),
                    selectedText: range.op.c,
                    threadId,
                });
            }
        }
        return entries;
    }

    seedThread(options) {
        const docId = options.docId;
        const threadId = options.threadId;
        const selectedText = options.selectedText ?? 'seeded selection';
        const startOffset = options.startOffset ?? 0;
        const messages = (options.messages ?? [
            {
                content: 'seed message',
                id: 'seed-message-1',
                timestamp: new Date().toISOString(),
                user: {
                    id: this.userId,
                    name: this.userId,
                },
                user_id: this.userId,
            },
        ]).map((message) => ({
            ...message,
            user: message.user
                ? {
                    ...message.user,
                }
                : undefined,
        }));

        const currentRanges = this._getRanges(docId);
        const nextRanges = upsertCommentRange(currentRanges, {
            c: selectedText,
            p: startOffset,
            t: threadId,
        }, {
            ts: new Date().toISOString(),
            user_id: messages[0]?.user_id ?? this.userId,
        });
        this._setRanges(docId, nextRanges);
        this.threadsById.set(threadId, normalizeCommentThread({
            messages,
        }));
    }

    async createComment(options) {
        const docId = options.docId;
        const threadId = options.threadId;
        const selectedText = options.selectedText;
        const startOffset = options.startOffset;
        const content = options.content;
        const persist = options.persist ?? (async () => ({}));

        const previousRanges = this._getRanges(docId);
        const previousThread = cloneThread(this.threadsById.get(threadId));
        const localMessage = this._buildLocalMessage(content, options.localMessageId);

        const nextRanges = upsertCommentRange(previousRanges, {
            c: selectedText,
            p: startOffset,
            t: threadId,
        }, {
            ts: new Date().toISOString(),
            user_id: this.userId,
        });
        this._setRanges(docId, nextRanges);
        this.threadsById.set(threadId, mergeCommentMessageIntoThread(undefined, localMessage));

        try {
            const persistResult = await persist({
                localMessageId: localMessage.id,
                threadId,
            });
            if (persistResult && typeof persistResult.serverMessageId === 'string') {
                this._replaceMessageId(threadId, localMessage.id, persistResult.serverMessageId);
            }
            return {
                localMessageId: localMessage.id,
                status: 'persisted',
            };
        } catch (error) {
            if (this.connectivityPredicate(error)) {
                this._queueOperation('comment.create', {
                    content,
                    docId,
                    localMessageId: localMessage.id,
                    selectedText,
                    startOffset,
                    threadId,
                });
                return {
                    localMessageId: localMessage.id,
                    status: 'queued',
                };
            }

            this._setRanges(docId, previousRanges);
            if (previousThread) {
                this.threadsById.set(threadId, previousThread);
            } else {
                this.threadsById.delete(threadId);
            }
            return {
                localMessageId: localMessage.id,
                status: 'rolled_back',
            };
        }
    }

    async replyComment(options) {
        const threadId = options.threadId;
        const content = options.content;
        const persist = options.persist ?? (async () => ({}));

        const previousThread = cloneThread(this.threadsById.get(threadId));
        const localMessage = this._buildLocalMessage(content, options.localMessageId);
        this.threadsById.set(
            threadId,
            mergeCommentMessageIntoThread(this.threadsById.get(threadId), localMessage),
        );

        try {
            const persistResult = await persist({
                localMessageId: localMessage.id,
                threadId,
            });
            if (persistResult && typeof persistResult.serverMessageId === 'string') {
                this._replaceMessageId(threadId, localMessage.id, persistResult.serverMessageId);
            }
            return {
                localMessageId: localMessage.id,
                status: 'persisted',
            };
        } catch (error) {
            if (this.connectivityPredicate(error)) {
                this._queueOperation('comment.reply', {
                    content,
                    localMessageId: localMessage.id,
                    threadId,
                });
                return {
                    localMessageId: localMessage.id,
                    status: 'queued',
                };
            }

            if (previousThread) {
                this.threadsById.set(threadId, previousThread);
            } else {
                this.threadsById.delete(threadId);
            }
            return {
                localMessageId: localMessage.id,
                status: 'rolled_back',
            };
        }
    }

    async editComment(options) {
        const threadId = options.threadId;
        const messageId = options.messageId;
        const content = options.content;
        const persist = options.persist ?? (async () => ({}));

        const previousThread = cloneThread(this.threadsById.get(threadId));
        this.threadsById.set(
            threadId,
            editCommentMessageInThread(this.threadsById.get(threadId), messageId, content),
        );

        try {
            await persist({
                messageId,
                threadId,
            });
            return {
                status: 'persisted',
            };
        } catch (error) {
            if (this.connectivityPredicate(error)) {
                const foldedIntoPendingMessage = this._foldPendingMessageEditIntoQueuedOperation(threadId, messageId, content);
                if (!foldedIntoPendingMessage) {
                    this._queueOperation('comment.edit', {
                        content,
                        messageId,
                        threadId,
                    });
                }
                return {
                    status: 'queued',
                };
            }

            if (previousThread) {
                this.threadsById.set(threadId, previousThread);
            } else {
                this.threadsById.delete(threadId);
            }
            return {
                status: 'rolled_back',
            };
        }
    }

    async deleteComment(options) {
        const threadId = options.threadId;
        const messageId = options.messageId;
        const ownOnly = Boolean(options.ownOnly);
        const persist = options.persist ?? (async () => ({}));

        const previousThread = cloneThread(this.threadsById.get(threadId));
        const previousRangeSnapshots = this._captureDocRangeSnapshotsForThread(threadId);
        const nextThread = removeCommentMessageFromThread(this.threadsById.get(threadId), messageId);

        if (nextThread && nextThread.messages.length > 0) {
            this.threadsById.set(threadId, nextThread);
        } else {
            this._removeThreadAcrossAllDocs(threadId);
        }

        try {
            await persist({
                messageId,
                ownOnly,
                threadId,
            });
            return {
                status: 'persisted',
            };
        } catch (error) {
            if (this.connectivityPredicate(error)) {
                this._queueOperation('comment.deleteMessage', {
                    messageId,
                    ownOnly,
                    threadId,
                });
                return {
                    status: 'queued',
                };
            }

            if (previousThread) {
                this.threadsById.set(threadId, previousThread);
            } else {
                this.threadsById.delete(threadId);
            }
            this._restoreDocRangeSnapshots(previousRangeSnapshots);
            return {
                status: 'rolled_back',
            };
        }
    }

    async resolveThread(options) {
        const threadId = options.threadId;
        const resolved = Boolean(options.resolved);
        const persist = options.persist ?? (async () => ({}));

        const previousThread = cloneThread(this.threadsById.get(threadId));
        const previousRangeSnapshots = this._captureDocRangeSnapshotsForThread(threadId);
        const nextThread = normalizeCommentThread({
            ...(this.threadsById.get(threadId) ?? {messages: []}),
            resolved: resolved || undefined,
            resolved_at: resolved ? new Date().toISOString() : undefined,
            resolved_by_user: resolved
                ? {
                    id: this.userId,
                    name: this.userId,
                }
                : undefined,
            resolved_by_user_id: resolved ? this.userId : undefined,
        });

        this.threadsById.set(threadId, nextThread);
        for (const [docId, ranges] of this.rangesByDocId.entries()) {
            this.rangesByDocId.set(docId, updateCommentRangeResolvedState(ranges, threadId, resolved));
        }

        try {
            await persist({
                resolved,
                threadId,
            });
            return {
                status: 'persisted',
            };
        } catch (error) {
            if (this.connectivityPredicate(error)) {
                this._queueOperation('comment.resolveThread', {
                    resolved,
                    threadId,
                });
                return {
                    status: 'queued',
                };
            }

            if (previousThread) {
                this.threadsById.set(threadId, previousThread);
            } else {
                this.threadsById.delete(threadId);
            }
            this._restoreDocRangeSnapshots(previousRangeSnapshots);
            return {
                status: 'rolled_back',
            };
        }
    }

    async replayQueuedCommentCreates(options = {}) {
        const persist = options.persist ?? (async () => ({}));
        const remainingOperations = [];
        const replayResults = [];

        for (const operation of this.queuedOperations) {
            if (operation.kind!=='comment.create') {
                remainingOperations.push(operation);
                continue;
            }

            const payload = operation.payload;
            const currentRanges = this._getRanges(payload.docId);
            const hasRange = currentRanges.some((range) => range.op.t===payload.threadId);
            if (!hasRange) {
                const restoredRanges = upsertCommentRange(currentRanges, {
                    c: payload.selectedText,
                    p: payload.startOffset,
                    t: payload.threadId,
                }, {
                    ts: new Date().toISOString(),
                    user_id: this.userId,
                });
                this._setRanges(payload.docId, restoredRanges);
            }

            try {
                const persistResult = await persist({
                    content: payload.content,
                    docId: payload.docId,
                    localMessageId: payload.localMessageId,
                    selectedText: payload.selectedText,
                    startOffset: payload.startOffset,
                    threadId: payload.threadId,
                });

                if (persistResult && typeof persistResult.serverMessageId==='string') {
                    this._replaceMessageId(payload.threadId, payload.localMessageId, persistResult.serverMessageId);
                }

                replayResults.push({
                    status: 'replayed',
                    threadId: payload.threadId,
                });
            } catch (error) {
                remainingOperations.push(operation);
                replayResults.push({
                    status: 'queued',
                    threadId: payload.threadId,
                });
            }
        }

        this.queuedOperations = remainingOperations;
        return replayResults;
    }

    reconcileThreadId(options) {
        const docId = options.docId;
        const localThreadId = options.localThreadId;
        const serverThreadId = options.serverThreadId;
        const previousThread = cloneThread(this.threadsById.get(localThreadId));
        if (previousThread && !this.threadsById.has(serverThreadId)) {
            this.threadsById.set(serverThreadId, previousThread);
        }
        this.threadsById.delete(localThreadId);

        const currentRanges = this._getRanges(docId);
        const reconciledRanges = currentRanges.map((range) => {
            if (range.op.t!==localThreadId) {
                return range;
            }
            return {
                ...range,
                op: {
                    ...range.op,
                    t: serverThreadId,
                },
            };
        });
        this._setRanges(docId, reconciledRanges);

        this.queuedOperations = this.queuedOperations.map((operation) => {
            if (!operation.payload || operation.payload.threadId!==localThreadId) {
                return operation;
            }
            return {
                ...operation,
                payload: {
                    ...operation.payload,
                    threadId: serverThreadId,
                },
            };
        });
        return serverThreadId;
    }

    hydrateServerRangesDuringRecovery(docId, ranges) {
        const serverRanges = cloneRanges(ranges ?? []);
        const currentRanges = this._getRanges(docId);
        for (const operation of this.queuedOperations) {
            if (operation.kind!=='comment.create' || operation.payload.docId!==docId) {
                continue;
            }
            if (serverRanges.some((range) => range.op.t===operation.payload.threadId)) {
                continue;
            }
            const existingRange = currentRanges.find((range) => range.op.t===operation.payload.threadId);
            serverRanges.push(existingRange ?? {
                id: operation.payload.threadId,
                metadata: {
                    ts: new Date().toISOString(),
                    user_id: this.userId,
                },
                op: {
                    c: operation.payload.selectedText,
                    p: operation.payload.startOffset,
                    t: operation.payload.threadId,
                },
                resolved: undefined,
            });
        }
        this._setRanges(docId, serverRanges);
    }

    hydrateServerThreadsDuringRecovery(serverThreads = {}) {
        const nextThreads = new Map(
            Object.entries(serverThreads).map(([threadId, thread]) => [threadId, cloneThread(thread)]),
        );
        for (const [threadId, thread] of this.threadsById.entries()) {
            if (nextThreads.has(threadId)) {
                continue;
            }
            const hasQueuedCreate = this.queuedOperations.some((operation) => {
                return operation.kind==='comment.create' && operation.payload.threadId===threadId;
            });
            const hasRange = Array.from(this.rangesByDocId.values()).some((ranges) => {
                return ranges.some((range) => range.op.t===threadId);
            });
            if (hasQueuedCreate || hasRange) {
                nextThreads.set(threadId, cloneThread(thread));
            }
        }
        this.threadsById = nextThreads;
    }
}

module.exports = {
    LocalFirstCommentMutationHarness,
};
