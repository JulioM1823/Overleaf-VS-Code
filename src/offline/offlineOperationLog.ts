export type DeferredSyncOperation =
    | {
        createdAt: string,
        id: string,
        kind: 'chat.send',
        payload: {
            clientId?: string,
            content: string,
            localMessageId: string,
        },
    }
    | {
        createdAt: string,
        id: string,
        kind: 'chat.edit',
        payload: {
            content: string,
            messageId: string,
        },
    }
    | {
        createdAt: string,
        id: string,
        kind: 'chat.delete',
        payload: {
            messageId: string,
        },
    }
    | {
        createdAt: string,
        id: string,
        kind: 'comment.create',
        payload: {
            content: string,
            docId: string,
            filePath: string,
            localMessageId: string,
            selectedText: string,
            startOffset: number,
            threadId: string,
        },
    }
    | {
        createdAt: string,
        id: string,
        kind: 'comment.reply',
        payload: {
            content: string,
            localMessageId: string,
            threadId: string,
        },
    }
    | {
        createdAt: string,
        id: string,
        kind: 'comment.anchorExistingThread',
        payload: {
            content: string,
            docId: string,
            filePath: string,
            localMessageId: string,
            selectedText: string,
            serverMessageId?: string,
            startOffset: number,
            threadId: string,
        },
    }
    | {
        createdAt: string,
        id: string,
        kind: 'comment.edit',
        payload: {
            content: string,
            messageId: string,
            threadId: string,
        },
    }
    | {
        createdAt: string,
        id: string,
        kind: 'comment.deleteMessage',
        payload: {
            messageId: string,
            ownOnly: boolean,
            threadId: string,
        },
    }
    | {
        createdAt: string,
        id: string,
        kind: 'comment.deleteThread',
        payload: {
            docId: string,
            threadId: string,
        },
    }
    | {
        createdAt: string,
        id: string,
        kind: 'comment.resolveThread',
        payload: {
            docId: string,
            resolved: boolean,
            threadId: string,
        },
    }
    | {
        createdAt: string,
        id: string,
        kind: 'file.localReplicaChange',
        payload: {
            changeType: 'delete' | 'update',
            relPath: string,
        },
    }
    | {
        createdAt: string,
        id: string,
        kind: 'settings.update',
        payload: {
            setting: Record<string, unknown>,
        },
    };

export interface DeferredSyncQueueState {
    lastUpdatedAt: string,
    operations: DeferredSyncOperation[],
    version: 1,
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value==='object' && value!==null;
}

function isDeferredSyncOperation(value: unknown): value is DeferredSyncOperation {
    if (!isRecord(value) || typeof value.id!=='string' || typeof value.createdAt!=='string' || typeof value.kind!=='string') {
        return false;
    }
    if (!isRecord(value.payload)) {
        return false;
    }
    const payload = value.payload;
    switch (value.kind) {
        case 'chat.send':
            return (payload.clientId===undefined || typeof payload.clientId==='string')
                && typeof payload.content==='string'
                && typeof payload.localMessageId==='string';
        case 'chat.edit':
            return typeof payload.content==='string'
                && typeof payload.messageId==='string';
        case 'chat.delete':
            return typeof payload.messageId==='string';
        case 'comment.create':
            return typeof payload.content==='string'
                && typeof payload.docId==='string'
                && typeof payload.filePath==='string'
                && typeof payload.localMessageId==='string'
                && typeof payload.selectedText==='string'
                && typeof payload.startOffset==='number'
                && typeof payload.threadId==='string';
        case 'comment.reply':
            return typeof payload.content==='string'
                && typeof payload.localMessageId==='string'
                && typeof payload.threadId==='string';
        case 'comment.anchorExistingThread':
            return typeof payload.content==='string'
                && typeof payload.docId==='string'
                && typeof payload.filePath==='string'
                && typeof payload.localMessageId==='string'
                && typeof payload.selectedText==='string'
                && (payload.serverMessageId===undefined || typeof payload.serverMessageId==='string')
                && typeof payload.startOffset==='number'
                && typeof payload.threadId==='string';
        case 'comment.edit':
            return typeof payload.content==='string'
                && typeof payload.messageId==='string'
                && typeof payload.threadId==='string';
        case 'comment.deleteMessage':
            return typeof payload.messageId==='string'
                && typeof payload.ownOnly==='boolean'
                && typeof payload.threadId==='string';
        case 'comment.deleteThread':
            return typeof payload.docId==='string'
                && typeof payload.threadId==='string';
        case 'comment.resolveThread':
            return typeof payload.docId==='string'
                && typeof payload.resolved==='boolean'
                && typeof payload.threadId==='string';
        case 'file.localReplicaChange':
            return (payload.changeType==='delete' || payload.changeType==='update')
                && typeof payload.relPath==='string';
        case 'settings.update':
            return isRecord(payload.setting);
        default:
            return false;
    }
}

export function createDeferredSyncQueueState(
    operations: DeferredSyncOperation[] = [],
): DeferredSyncQueueState {
    return {
        lastUpdatedAt: new Date().toISOString(),
        operations,
        version: 1,
    };
}

export function parseDeferredSyncQueueState(raw: string): DeferredSyncQueueState {
    const parsed = JSON.parse(raw) as Partial<DeferredSyncQueueState>;
    return createDeferredSyncQueueState(
        Array.isArray(parsed.operations)
            ? parsed.operations.filter(isDeferredSyncOperation)
            : [],
    );
}

export function serializeDeferredSyncQueueState(
    state: DeferredSyncQueueState,
): string {
    return JSON.stringify({
        lastUpdatedAt: state.lastUpdatedAt,
        operations: [...state.operations].sort((left, right) => {
            if (left.createdAt===right.createdAt) {
                return left.id.localeCompare(right.id);
            }
            return left.createdAt.localeCompare(right.createdAt);
        }),
        version: 1,
    }, null, 4);
}

export function appendDeferredSyncOperation(
    state: DeferredSyncQueueState,
    operation: DeferredSyncOperation,
): DeferredSyncQueueState {
    return createDeferredSyncQueueState([
        ...state.operations,
        operation,
    ]);
}

export function removeDeferredSyncOperation(
    state: DeferredSyncQueueState,
    operationId: string,
): DeferredSyncQueueState {
    return createDeferredSyncQueueState(
        state.operations.filter((operation) => operation.id!==operationId),
    );
}

export function replaceDeferredSyncMessageId(
    state: DeferredSyncQueueState,
    threadId: string,
    previousMessageId: string,
    nextMessageId: string,
): DeferredSyncQueueState {
    const nextOperations = state.operations.map<DeferredSyncOperation>((operation) => {
        if (operation.kind==='comment.create') {
            if (operation.payload.threadId!==threadId || operation.payload.localMessageId!==previousMessageId) {
                return operation;
            }
            return {
                ...operation,
                payload: {
                    ...operation.payload,
                    localMessageId: nextMessageId,
                },
            };
        }
        if (operation.kind==='comment.anchorExistingThread') {
            if (operation.payload.threadId!==threadId || operation.payload.localMessageId!==previousMessageId) {
                return operation;
            }
            return {
                ...operation,
                payload: {
                    ...operation.payload,
                    localMessageId: nextMessageId,
                    serverMessageId: operation.payload.serverMessageId ?? nextMessageId,
                },
            };
        }
        if (operation.kind==='comment.reply') {
            if (operation.payload.threadId!==threadId || operation.payload.localMessageId!==previousMessageId) {
                return operation;
            }
            return {
                ...operation,
                payload: {
                    ...operation.payload,
                    localMessageId: nextMessageId,
                },
            };
        }
        if (operation.kind==='comment.edit') {
            if (operation.payload.threadId!==threadId || operation.payload.messageId!==previousMessageId) {
                return operation;
            }
            return {
                ...operation,
                payload: {
                    ...operation.payload,
                    messageId: nextMessageId,
                },
            };
        }
        if (operation.kind==='comment.deleteMessage') {
            if (operation.payload.threadId!==threadId || operation.payload.messageId!==previousMessageId) {
                return operation;
            }
            return {
                ...operation,
                payload: {
                    ...operation.payload,
                    messageId: nextMessageId,
                },
            };
        }
        return operation;
    });
    return createDeferredSyncQueueState(nextOperations);
}

export function foldPendingCommentMessageContentIntoDeferredOperations(
    state: DeferredSyncQueueState,
    threadId: string,
    localMessageId: string,
    content: string,
): {
    merged: boolean,
    state: DeferredSyncQueueState,
} {
    let merged = false;
    const nextOperations = state.operations.flatMap<DeferredSyncOperation>((operation) => {
        if (operation.kind==='comment.create' || operation.kind==='comment.anchorExistingThread') {
            if (operation.payload.threadId!==threadId || operation.payload.localMessageId!==localMessageId) {
                return [operation];
            }
            merged = true;
            return [{
                ...operation,
                payload: {
                    ...operation.payload,
                    content,
                },
            }];
        }
        if (operation.kind==='comment.reply') {
            if (operation.payload.threadId!==threadId || operation.payload.localMessageId!==localMessageId) {
                return [operation];
            }
            merged = true;
            return [{
                ...operation,
                payload: {
                    ...operation.payload,
                    content,
                },
            }];
        }
        if (operation.kind==='comment.edit') {
            if (operation.payload.threadId!==threadId || operation.payload.messageId!==localMessageId) {
                return [operation];
            }
            merged = true;
            return [];
        }
        return [operation];
    });
    return {
        merged,
        state: createDeferredSyncQueueState(nextOperations),
    };
}

export function replaceDeferredSyncChatMessageId(
    state: DeferredSyncQueueState,
    previousMessageId: string,
    nextMessageId: string,
): DeferredSyncQueueState {
    const nextOperations = state.operations.map<DeferredSyncOperation>((operation) => {
        if (operation.kind==='chat.send') {
            if (operation.payload.localMessageId!==previousMessageId) {
                return operation;
            }
            return {
                ...operation,
                payload: {
                    ...operation.payload,
                    localMessageId: nextMessageId,
                },
            };
        }
        if (operation.kind==='chat.edit') {
            if (operation.payload.messageId!==previousMessageId) {
                return operation;
            }
            return {
                ...operation,
                payload: {
                    ...operation.payload,
                    messageId: nextMessageId,
                },
            };
        }
        if (operation.kind==='chat.delete') {
            if (operation.payload.messageId!==previousMessageId) {
                return operation;
            }
            return {
                ...operation,
                payload: {
                    messageId: nextMessageId,
                },
            };
        }
        return operation;
    });
    return createDeferredSyncQueueState(nextOperations);
}

export function isDeferredSyncChatOperation(
    operation: DeferredSyncOperation,
): operation is Extract<DeferredSyncOperation, {kind: 'chat.send' | 'chat.edit' | 'chat.delete'}> {
    return operation.kind==='chat.send'
        || operation.kind==='chat.edit'
        || operation.kind==='chat.delete';
}

export function hasDeferredSyncOperations(state: DeferredSyncQueueState) {
    return state.operations.length > 0;
}

export function hasDeferredSyncOperationsForKind(
    state: DeferredSyncQueueState,
    kind: DeferredSyncOperation['kind'],
) {
    return state.operations.some((operation) => operation.kind===kind);
}

export function hasDeferredSyncOperationsExcludingKinds(
    state: DeferredSyncQueueState,
    excludedKinds: DeferredSyncOperation['kind'][],
) {
    const excludedKindSet = new Set(excludedKinds);
    return state.operations.some((operation) => !excludedKindSet.has(operation.kind));
}
