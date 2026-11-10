import * as vscode from 'vscode';
import {EventEmitter} from 'events';
import { PdfDocument } from '../core/pdfViewEditorProvider';
import { RealtimeConnectionPhase } from '../core/connectionPhase';
import { StatusInfo } from '../scm';
import { UpdateSchema } from '../api/socketio';
import { ProjectMessageResponseSchema } from '../api/base';
import { logCommentDiagnostics } from '../comments/commentDiagnostics';
import { DiagnosticCategory, logDiagnostic } from './diagnostics';

export type Events = {
    'serverSessionEndedEvent': {serverName: string},
    'fileWillOpenEvent': {uri: vscode.Uri},
    'pdfWillOpenEvent': {uri: vscode.Uri, doc:PdfDocument, webviewPanel:vscode.WebviewPanel},
    'spellCheckLanguageUpdateEvent': {language:string},
    'compilerUpdateEvent': {compiler:string},
    'rootDocUpdateEvent': {rootDocId:string},
    'scmStatusChangeEvent': {status:StatusInfo},
    'socketioConnectedEvent': {publicId:string},
    'realtimeConnectionStateChangedEvent': {
        origin: string,
        phase: RealtimeConnectionPhase,
        projectId: string,
        reason: string,
        retryConnection: number,
        serverName: string,
    },
    'commentsChangedEvent': {
        docIds?: string[],
        emittedAtMs?: number,
        origin: string,
        projectId: string,
        reason: string,
        sequence?: number,
        serverName: string,
        threadIds?: string[],
    },
    'chatMessagesChangedEvent': {
        message?: ProjectMessageResponseSchema,
        origin: string,
        projectId: string,
        reason: string,
        serverName: string,
    },
    'chatUnreadCountChangedEvent': {
        origin: string,
        projectId: string,
        reason: string,
        serverName: string,
        unreadCount: number,
    },
    'offlineSynchronizationStateChangedEvent': {
        hasPendingOperations: boolean,
        mode: 'offline' | 'online' | 'sync-recovery',
        origin: string,
        projectId: string,
        reason: string,
        serverName: string,
    },
    'reviewLocalMutationEvent': {
        content?: string,
        kind: 'deleteMessage' | 'deleteThread' | 'editMessage',
        messageId: string,
        origin: string,
        threadId: string,
    },
    'reviewThreadProjectionEvent': {
        entry?: unknown,
        messageId?: string,
        origin: string,
        threadId: string,
    },
    'documentRemoteTextUpdatedEvent': {
        docId: string,
        nextRemoteText: string,
        origin: string,
        overleafUri: string,
        previousRemoteText: string,
        update: UpdateSchema,
    },
};

type TrackedCommentEventName =
    | 'commentsChangedEvent'
    | 'offlineSynchronizationStateChangedEvent'
    | 'realtimeConnectionStateChangedEvent';

type TrackedDiagnosticEventName =
    | 'chatMessagesChangedEvent'
    | 'chatUnreadCountChangedEvent'
    | 'commentsChangedEvent'
    | 'compilerUpdateEvent'
    | 'documentRemoteTextUpdatedEvent'
    | 'offlineSynchronizationStateChangedEvent'
    | 'pdfWillOpenEvent'
    | 'realtimeConnectionStateChangedEvent'
    | 'rootDocUpdateEvent'
    | 'socketioConnectedEvent';

type EventListenerMetadata = {
    eventName: keyof Events,
    listenerId: number,
    registeredAtMs: number,
};

export class EventBus {
    private static _eventEmitter = new EventEmitter();
    private static listenerSequence = 0;
    private static listenerMetadataById = new Map<number, EventListenerMetadata>();
    private static listenerIdsByEventName = new Map<keyof Events, Set<number>>();
    private static readonly trackedCommentEvents = new Set<TrackedCommentEventName>([
        'commentsChangedEvent',
        'offlineSynchronizationStateChangedEvent',
        'realtimeConnectionStateChangedEvent',
    ]);
    private static readonly trackedDiagnosticEvents = new Set<TrackedDiagnosticEventName>([
        'chatMessagesChangedEvent',
        'chatUnreadCountChangedEvent',
        'commentsChangedEvent',
        'compilerUpdateEvent',
        'documentRemoteTextUpdatedEvent',
        'offlineSynchronizationStateChangedEvent',
        'pdfWillOpenEvent',
        'realtimeConnectionStateChangedEvent',
        'rootDocUpdateEvent',
        'socketioConnectedEvent',
    ]);

    private static toTrackedCommentEventName(eventName: keyof Events): TrackedCommentEventName | undefined {
        if (EventBus.trackedCommentEvents.has(eventName as TrackedCommentEventName)) {
            return eventName as TrackedCommentEventName;
        }
        return undefined;
    }

    private static toTrackedDiagnosticEventName(eventName: keyof Events): TrackedDiagnosticEventName | undefined {
        if (EventBus.trackedDiagnosticEvents.has(eventName as TrackedDiagnosticEventName)) {
            return eventName as TrackedDiagnosticEventName;
        }
        return undefined;
    }

    private static resolveDiagnosticEventCategory(eventName: TrackedDiagnosticEventName): DiagnosticCategory {
        if (eventName.startsWith('chat')) {
            return 'chat';
        }
        if (eventName.startsWith('comment')) {
            return 'comments';
        }
        if (eventName==='compilerUpdateEvent' || eventName==='rootDocUpdateEvent' || eventName==='pdfWillOpenEvent') {
            return 'compile';
        }
        if (eventName==='documentRemoteTextUpdatedEvent') {
            return 'sync';
        }
        if (eventName==='offlineSynchronizationStateChangedEvent') {
            return 'offline';
        }
        if (eventName==='realtimeConnectionStateChangedEvent' || eventName==='socketioConnectedEvent') {
            return 'network';
        }
        return 'core';
    }

    private static summarizeTrackedCommentEventPayload(
        eventName: TrackedCommentEventName,
        payload: Events[keyof Events],
    ): Record<string, unknown> {
        switch (eventName) {
            case 'commentsChangedEvent': {
                const eventPayload = payload as Events['commentsChangedEvent'];
                return {
                    docCount: eventPayload.docIds?.length ?? 0,
                    origin: eventPayload.origin,
                    projectId: eventPayload.projectId,
                    reason: eventPayload.reason,
                    sequence: eventPayload.sequence ?? -1,
                    threadCount: eventPayload.threadIds?.length ?? 0,
                };
            }
            case 'realtimeConnectionStateChangedEvent': {
                const eventPayload = payload as Events['realtimeConnectionStateChangedEvent'];
                return {
                    origin: eventPayload.origin,
                    phase: eventPayload.phase,
                    projectId: eventPayload.projectId,
                    reason: eventPayload.reason,
                };
            }
            case 'offlineSynchronizationStateChangedEvent': {
                const eventPayload = payload as Events['offlineSynchronizationStateChangedEvent'];
                return {
                    mode: eventPayload.mode,
                    origin: eventPayload.origin,
                    projectId: eventPayload.projectId,
                    reason: eventPayload.reason,
                };
            }
        }
    }

    private static summarizeTrackedDiagnosticEventPayload(
        eventName: TrackedDiagnosticEventName,
        payload: Events[keyof Events],
    ): Record<string, unknown> {
        switch (eventName) {
            case 'chatMessagesChangedEvent': {
                const eventPayload = payload as Events['chatMessagesChangedEvent'];
                return {
                    hasMessage: eventPayload.message !== undefined,
                    origin: eventPayload.origin,
                    projectId: eventPayload.projectId,
                    reason: eventPayload.reason,
                    serverName: eventPayload.serverName,
                };
            }
            case 'chatUnreadCountChangedEvent': {
                const eventPayload = payload as Events['chatUnreadCountChangedEvent'];
                return {
                    origin: eventPayload.origin,
                    projectId: eventPayload.projectId,
                    reason: eventPayload.reason,
                    serverName: eventPayload.serverName,
                    unreadCount: eventPayload.unreadCount,
                };
            }
            case 'commentsChangedEvent':
            case 'offlineSynchronizationStateChangedEvent':
            case 'realtimeConnectionStateChangedEvent':
                return EventBus.summarizeTrackedCommentEventPayload(eventName, payload);
            case 'compilerUpdateEvent': {
                const eventPayload = payload as Events['compilerUpdateEvent'];
                return {compiler: eventPayload.compiler};
            }
            case 'documentRemoteTextUpdatedEvent': {
                const eventPayload = payload as Events['documentRemoteTextUpdatedEvent'];
                return {
                    docId: eventPayload.docId,
                    nextLength: eventPayload.nextRemoteText.length,
                    operationCount: eventPayload.update.op?.length ?? 0,
                    origin: eventPayload.origin,
                    previousLength: eventPayload.previousRemoteText.length,
                    version: eventPayload.update.v ?? -1,
                };
            }
            case 'pdfWillOpenEvent': {
                const eventPayload = payload as Events['pdfWillOpenEvent'];
                return {uri: eventPayload.uri.toString()};
            }
            case 'rootDocUpdateEvent': {
                const eventPayload = payload as Events['rootDocUpdateEvent'];
                return {rootDocId: eventPayload.rootDocId};
            }
            case 'socketioConnectedEvent': {
                const eventPayload = payload as Events['socketioConnectedEvent'];
                return {publicId: eventPayload.publicId};
            }
        }
    }

    private static registerListener(eventName: keyof Events): number {
        EventBus.listenerSequence += 1;
        const listenerId = EventBus.listenerSequence;
        const metadata: EventListenerMetadata = {
            eventName,
            listenerId,
            registeredAtMs: Date.now(),
        };
        EventBus.listenerMetadataById.set(listenerId, metadata);
        const eventListeners = EventBus.listenerIdsByEventName.get(eventName) ?? new Set<number>();
        eventListeners.add(listenerId);
        EventBus.listenerIdsByEventName.set(eventName, eventListeners);
        return listenerId;
    }

    private static unregisterListener(eventName: keyof Events, listenerId: number) {
        EventBus.listenerMetadataById.delete(listenerId);
        const eventListeners = EventBus.listenerIdsByEventName.get(eventName);
        if (!eventListeners) {
            return;
        }
        eventListeners.delete(listenerId);
        if (eventListeners.size===0) {
            EventBus.listenerIdsByEventName.delete(eventName);
        }
    }

    static getDiagnosticsState() {
        const listenerCountByEvent = Object.fromEntries(
            Array.from(EventBus.listenerIdsByEventName.entries())
                .map(([eventName, listenerIds]) => [eventName, listenerIds.size] as const)
                .sort(([left], [right]) => left.localeCompare(right)),
        );
        const listeners = Array.from(EventBus.listenerMetadataById.values())
            .sort((left, right) => {
                if (left.eventName!==right.eventName) {
                    return left.eventName.localeCompare(right.eventName);
                }
                return left.listenerId - right.listenerId;
            })
            .map((listener) => ({
                eventName: listener.eventName,
                listenerId: listener.listenerId,
                registeredAtMs: listener.registeredAtMs,
            }));

        const totalListenerCount = listeners.length;
        return {
            listenerCountByEvent,
            listeners,
            totalListenerCount,
            trackedCommentEvents: Array.from(EventBus.trackedCommentEvents.values()).map((eventName) => ({
                eventName,
                listenerCount: (listenerCountByEvent[eventName] as number | undefined) ?? 0,
            })),
        };
    }

    static fire<T extends keyof Events>(eventName: T, arg: Events[T]): void {
        const listenerCount = EventBus._eventEmitter.listenerCount(eventName);
        const trackedEventName = EventBus.toTrackedCommentEventName(eventName);
        if (trackedEventName) {
            logCommentDiagnostics('EventBus', 'eventBus', 'comments.event_emitted', {
                eventName,
                listenerCount,
                ...EventBus.summarizeTrackedCommentEventPayload(trackedEventName, arg),
            });
        }
        const trackedDiagnosticEventName = EventBus.toTrackedDiagnosticEventName(eventName);
        if (trackedDiagnosticEventName) {
            logDiagnostic('EventBus', 'event.emitted', {
                eventName,
                listenerCount,
                ...EventBus.summarizeTrackedDiagnosticEventPayload(trackedDiagnosticEventName, arg),
            }, undefined, {
                category: EventBus.resolveDiagnosticEventCategory(trackedDiagnosticEventName),
                level: 'debug',
            });
        }
        EventBus._eventEmitter.emit(eventName, arg);
    }

    static on<T extends keyof Events>(eventName: T, cb: (arg: Events[T]) => void): vscode.Disposable {
        const listenerCountBefore = EventBus._eventEmitter.listenerCount(eventName);
        EventBus._eventEmitter.on(eventName, cb);
        const listenerId = EventBus.registerListener(eventName);
        const listenerCountAfter = EventBus._eventEmitter.listenerCount(eventName);
        const trackedEventName = EventBus.toTrackedCommentEventName(eventName);
        if (trackedEventName) {
            logCommentDiagnostics('EventBus', 'eventBus', 'comments.listener_registered', {
                eventName,
                listenerCountAfter,
                listenerCountBefore,
                listenerId,
            });
        }

        let disposed = false;
        const disposable = {
            dispose: () => {
                if (disposed) {
                    return;
                }
                disposed = true;
                EventBus._eventEmitter.removeListener(eventName, cb);
                EventBus.unregisterListener(eventName, listenerId);
                if (trackedEventName) {
                    logCommentDiagnostics('EventBus', 'eventBus', 'comments.listener_disposed', {
                        eventName,
                        listenerCountAfter: EventBus._eventEmitter.listenerCount(eventName),
                        listenerId,
                    });
                }
            }
        };
        return disposable;
    }
}
