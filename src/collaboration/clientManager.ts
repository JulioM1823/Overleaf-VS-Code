/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { ELEGANT_NAME, ROOT_NAME } from '../consts';
import { SocketIOAPI, UpdateUserSchema } from '../api/socketio';
import {
    didCommentUserPaletteChange,
    getConfiguredCommentUserPalette,
} from '../comments/commentColorConfiguration';
import { ReviewViewProvider } from '../comments/reviewViewProvider';
import { VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { ChatViewProvider } from './chatViewProvider';
import {
    CollaboratorConnectionIndicatorState,
    CollaboratorCursorLocation,
    createCollaboratorQuickPickItem,
    didCollaboratorMove,
    escapeCollaboratorMarkdownText,
    formatCollaboratorCursorInfo,
    resolveCollaboratorCursorColor,
    resolveCollaboratorConnectionIndicatorState,
    resolveCollaboratorConnectionIndicatorVisualState,
    sortCollaboratorQuickPickItems,
} from './clientManagerHelpers';
import {
    isOwnCollaboratorPresence,
    resolveCollaboratorPresenceKey,
} from './collaboratorPresence';
import {
    resolveProjectDocumentBinding,
    resolveProjectRenderUriForPath,
} from '../core/projectWorkspaceBinding';
import { logDiagnostic, registerDiagnosticStateProvider } from '../utils/diagnostics';
import { EventBus } from '../utils/eventBus';

interface ExtendedUpdateUserSchema extends UpdateUserSchema {
    clientIds?: Set<string>,
    selection?: {
        color: string,
        hoverMessage: vscode.MarkdownString,
        decoration: vscode.TextEditorDecorationType,
        ranges: vscode.DecorationOptions[],
    },
}

function formatTime(timestamp:number) {
    timestamp = Math.floor(timestamp / 1000);
    const hours = Math.floor(timestamp / 3600);
    const minutes = Math.floor(timestamp / 60) % 60;
    const ten_seconds = Math.floor(timestamp % 60 / 10);
    const hoursStr = hours > 0 ? `${hours}h ` : '';
    const minutesStr = minutes > 0 ? `${minutes}m` : '';
    const secondsStr = minutesStr==='' && ten_seconds > 0 ? `${ten_seconds*10}s` : '';
    return `${hoursStr}${minutesStr}${secondsStr}`;
}

export class ClientManager {
    private static readonly STATUS_UPDATE_DEBOUNCE_MS = 50;
    private static readonly DISCONNECTED_STATUS_TEXT = '$(sync-ignored)';
    private activeExists?: string;
    private inactivateTask?: NodeJS.Timeout;
    private readonly status: vscode.StatusBarItem;
    private lastNonConnectedIndicatorAtMs?: number;
    private lastPresentedConnectionState?: CollaboratorConnectionIndicatorState;
    private lastStatusTooltipSignature?: string;
    private lastStatusVisualSignature?: string;
    private statusShown = false;
    private statusUpdateTimer?: NodeJS.Timeout;
    private readonly onlineUsers: {[K:string]:ExtendedUpdateUserSchema} = {};
    private readonly collaboratorAliases = new Map<string, string>();
    private readonly collaboratorColors = new Map<string, string>();
    private connectedFlag: boolean = false;
    private tetheredClientId?: string;
    private readonly chatViewer: ChatViewProvider;
    private readonly diagnosticsStateRegistration: {dispose: () => void};
    private readonly reviewViewer: ReviewViewProvider;
    private currentPublicId: string;
    private readonly selfUserId: string;

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly context: vscode.ExtensionContext,
        publicId: string,
        private readonly socket: SocketIOAPI,
        chatViewer: ChatViewProvider,
    ) {
        this.currentPublicId = publicId;
        this.selfUserId = this.vfs._userId;
        this.connectedFlag = this.socket.isConnected;
        this.socket.updateEventHandlers({
            onClientUpdated: (user:UpdateUserSchema) => {
                const presenceKey = this.resolvePresenceKey(user.id, user.user_id);
                if (this.isOwnPresence(user.id, user.user_id)) {
                    this.removePosition(presenceKey);
                    return;
                }
                this.setStatusActive(presenceKey);
                this.updatePosition(presenceKey, user.id, user.doc_id, user.row, user.column, user);
            },
            onClientDisconnected: (id:string) => {
                this.removePosition(id);
            },
            onDisconnected: () => {
                this.connectedFlag = false;
                this.scheduleStatusUpdate('socket_disconnected');
            },
            onConnectionAccepted: (publicId:string) => {
                this.connectedFlag = true;
                this.currentPublicId = publicId;
                Object.keys(this.onlineUsers).forEach((presenceKey) => {
                    const user = this.onlineUsers[presenceKey];
                    if (this.isOwnPresence(user.id, user.user_id)) {
                        this.removePosition(presenceKey);
                    }
                });
                this.refreshConnectedUsers('socket_connection_accepted');
                this.scheduleStatusUpdate('socket_connection_accepted');
            }
        });
        this.refreshConnectedUsers('constructor_initialized');

        this.chatViewer = chatViewer;
        this.reviewViewer = new ReviewViewProvider(this.vfs, this.context);
        this.diagnosticsStateRegistration = registerDiagnosticStateProvider(
            `collaboration:${this.vfs.serverName}/${this.vfs.projectId}`,
            () => this.collectCollaborationDiagnosticsState(),
        );
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        this.scheduleStatusUpdate('constructor_initialized');
    }

    private refreshConnectedUsers(reason: string) {
        void this.socket.getConnectedUsers()
            .then(users => {
                users.forEach(user => {
                    const onlineUser = {
                        id: user.client_id,
                        user_id: user.user_id,
                        name: [user.first_name, user.last_name].filter(Boolean).join(' '),
                        email: user.email,
                        doc_id: user.cursorData?.doc_id || '',
                        row: user.cursorData?.row || 0,
                        column: user.cursorData?.column || 0,
                        last_updated_at: Number(user.last_updated_at),
                    };
                    const presenceKey = this.resolvePresenceKey(user.client_id, onlineUser.user_id);
                    if (!this.isOwnPresence(user.client_id, onlineUser.user_id)) {
                        this.updatePosition(presenceKey, user.client_id, onlineUser.doc_id, onlineUser.row, onlineUser.column, onlineUser);
                    }
                });
                this.scheduleStatusUpdate('socket_connected_users_loaded');
            })
            .catch((error) => {
                this.logDiagnostic('collaborator.connected_users_load_failed', {
                    reason,
                }, error);
            });
    }

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('Collaboration', event, {
            connectionPhase: this.vfs.realtimeConnectionPhase,
            providerInstanceId: this.chatViewer.providerInstanceId,
            projectId: this.vfs.projectId,
            projectName: this.vfs.projectName,
            publicId: this.currentPublicId,
            queueLength: this.vfs.chatQueueLength,
            serverName: this.vfs.serverName,
            syncMode: this.vfs.synchronizationMode,
            tetheredClientId: this.tetheredClientId ?? '',
            ...fields,
        }, error);
    }

    private collectCollaborationDiagnosticsState() {
        const resolvedConnectionState = resolveCollaboratorConnectionIndicatorState({
            connectionPhase: this.vfs.realtimeConnectionPhase,
            synchronizationMode: this.vfs.synchronizationMode,
            transportConnected: this.connectedFlag,
        });
        const collaboratorSummaries = Object.entries(this.onlineUsers)
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, 20)
            .map(([presenceKey, user]) => ({
                activeClientIdCount: user.clientIds?.size ?? 0,
                cursorColumn: user.column ?? 0,
                cursorDocId: user.doc_id ?? '',
                cursorRow: user.row ?? 0,
                lastUpdatedAt: typeof user.last_updated_at === 'number'
                    ? new Date(user.last_updated_at).toISOString()
                    : '',
                name: user.name ?? '',
                presenceKey,
                userId: user.user_id ?? '',
            }));

        return {
            collaboratorAliasCount: this.collaboratorAliases.size,
            collaboratorCount: Object.keys(this.onlineUsers).length,
            collaboratorSummaries,
            connectedFlag: this.connectedFlag,
            currentPublicId: this.currentPublicId,
            hasInactivateTask: Boolean(this.inactivateTask),
            hasStatusUpdateTimer: Boolean(this.statusUpdateTimer),
            projectId: this.vfs.projectId,
            resolvedConnectionState,
            statusText: this.status.text,
            tetheredClientId: this.tetheredClientId ?? '',
        };
    }

    private resolvePresenceKey(clientId: string, userId?: string, existingUserId?: string) {
        return resolveCollaboratorPresenceKey({
            clientId,
            existingUserId,
            userId,
        });
    }

    private scheduleStatusUpdate(reason: string, delayMs = ClientManager.STATUS_UPDATE_DEBOUNCE_MS) {
        if (this.statusUpdateTimer) {
            clearTimeout(this.statusUpdateTimer);
        }
        this.statusUpdateTimer = setTimeout(() => {
            this.statusUpdateTimer = undefined;
            this.logDiagnostic('status.refresh_scheduled', {reason});
            this.updateStatus();
        }, delayMs);
    }

    private isOwnPresence(clientId: string, userId?: string) {
        return isOwnCollaboratorPresence({
            clientId,
            selfClientId: this.currentPublicId,
            selfUserId: this.selfUserId,
            userId,
        });
    }

    private attachCollaboratorAlias(clientId: string, presenceKey: string, user: ExtendedUpdateUserSchema) {
        const previousPresenceKey = this.collaboratorAliases.get(clientId);
        if (previousPresenceKey && previousPresenceKey!==presenceKey) {
            const previousUser = this.onlineUsers[previousPresenceKey];
            previousUser?.clientIds?.delete(clientId);
        }
        this.collaboratorAliases.set(clientId, presenceKey);
        if (!user.clientIds) {
            user.clientIds = new Set();
        }
        user.clientIds.add(clientId);
    }

    private detachCollaboratorAlias(clientId: string, presenceKey?: string) {
        const resolvedPresenceKey = presenceKey ?? this.collaboratorAliases.get(clientId);
        this.collaboratorAliases.delete(clientId);
        if (!resolvedPresenceKey) {
            return;
        }
        const user = this.onlineUsers[resolvedPresenceKey];
        user?.clientIds?.delete(clientId);
    }

    private remapCollaboratorAliases(fromPresenceKey: string, toPresenceKey: string) {
        if (fromPresenceKey===toPresenceKey) {
            return;
        }
        Array.from(this.collaboratorAliases.entries()).forEach(([clientId, presenceKey]) => {
            if (presenceKey===fromPresenceKey) {
                this.collaboratorAliases.set(clientId, toPresenceKey);
            }
        });
    }

    private resolveCollaboratorColor(presenceKey: string) {
        const existingColor = this.collaboratorColors.get(presenceKey);
        if (existingColor) {
            return existingColor;
        }

        const usedColors = new Set<string>();
        this.collaboratorColors.forEach((color, key) => {
            if (key!==presenceKey) {
                usedColors.add(color);
            }
        });

        const color = resolveCollaboratorCursorColor(
            presenceKey,
            usedColors,
            getConfiguredCommentUserPalette().palette,
        );
        this.collaboratorColors.set(presenceKey, color);
        return color;
    }

    private createCollaboratorCursorDecoration(color: string) {
        return vscode.window.createTextEditorDecorationType({
            overviewRulerColor: color,
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        });
    }

    private createCollaboratorCursorAttachment(color: string): vscode.ThemableDecorationAttachmentRenderOptions {
        return {
            border: `1px solid ${color}`,
            color: 'transparent',
            contentText: ' ',
            height: '1.2em',
            margin: '0 0 0 -1px',
            width: '0',
        };
    }

    private createCollaboratorHoverMessage(user: ExtendedUpdateUserSchema) {
        const hoverMessage = new vscode.MarkdownString();
        hoverMessage.appendMarkdown(`**${escapeCollaboratorMarkdownText(user.name)}**`);
        return hoverMessage;
    }

    private createCollaboratorCursorRanges(
        row: number,
        column: number,
        color: string,
        hoverMessage: vscode.MarkdownString,
        document?: vscode.TextDocument,
    ): vscode.DecorationOptions[] {
        const attachment = this.createCollaboratorCursorAttachment(color);
        if (document && document.lineCount > 0) {
            const lineNumber = Math.min(Math.max(0, row), document.lineCount - 1);
            const line = document.lineAt(lineNumber);
            const lineLength = line.text.length;
            const character = Math.min(Math.max(0, column), lineLength);

            if (lineLength > 0 && character < lineLength) {
                return [{
                    hoverMessage,
                    range: new vscode.Range(lineNumber, character, lineNumber, character + 1),
                    renderOptions: {before: attachment},
                }];
            }
            if (lineLength > 0) {
                return [{
                    hoverMessage,
                    range: new vscode.Range(lineNumber, character - 1, lineNumber, character),
                    renderOptions: {after: attachment},
                }];
            }

            return [{
                hoverMessage,
                range: new vscode.Range(lineNumber, 0, lineNumber, 0),
                renderOptions: {after: attachment},
            }];
        }

        const normalizedRow = Math.max(0, row);
        const normalizedColumn = Math.max(0, column);
        return [{
            hoverMessage,
            range: new vscode.Range(normalizedRow, normalizedColumn, normalizedRow, normalizedColumn),
            renderOptions: {after: attachment},
        }];
    }

    private async renderCursorDecoration(presenceKey: string, user: ExtendedUpdateUserSchema) {
        const newDoc = this.vfs._resolveById(user.doc_id);
        if (newDoc === undefined) { return; }

        const newUri = await resolveProjectRenderUriForPath(this.vfs.origin, newDoc.path);
        const newEditor = newUri && vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === newUri.toString());

        if (user.selection===undefined) {
            const color = this.resolveCollaboratorColor(presenceKey);
            const hoverMessage = this.createCollaboratorHoverMessage(user);
            user.selection = {
                color,
                decoration: this.createCollaboratorCursorDecoration(color),
                hoverMessage,
                ranges: this.createCollaboratorCursorRanges(user.row, user.column, color, hoverMessage, newEditor?.document),
            };
        } else {
            user.selection.hoverMessage = this.createCollaboratorHoverMessage(user);
            user.selection.ranges = this.createCollaboratorCursorRanges(
                user.row,
                user.column,
                user.selection.color,
                user.selection.hoverMessage,
                newEditor?.document,
            );
        }

        newEditor?.setDecorations(user.selection.decoration, user.selection.ranges);
    }

    private async reloadCollaboratorCursorColors(reason: string) {
        const entries = Object.entries(this.onlineUsers);
        await Promise.all(entries.map(([, user]) => this.clearSelectionDecoration(user)));
        this.collaboratorColors.clear();
        for (const [presenceKey, user] of entries) {
            await this.renderCursorDecoration(presenceKey, user);
        }
        this.scheduleStatusUpdate(reason);
    }

    private async clearSelectionDecoration(user: ExtendedUpdateUserSchema) {
        const selection = user.selection;
        if (!selection) {
            return;
        }

        const doc = this.vfs._resolveById(user.doc_id);
        const uri = doc && await resolveProjectRenderUriForPath(this.vfs.origin, doc.path);
        const editor = uri && vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
        editor?.setDecorations(selection.decoration, []);
        selection.decoration.dispose();
        user.selection = undefined;
    }

    private async migratePresenceKey(sourceClientId: string, nextPresenceKey: string) {
        const previousPresenceKey = this.collaboratorAliases.get(sourceClientId);
        if (!previousPresenceKey || previousPresenceKey===nextPresenceKey) {
            return;
        }

        const previousUser = this.onlineUsers[previousPresenceKey];
        if (!previousUser) {
            this.collaboratorAliases.set(sourceClientId, nextPresenceKey);
            return;
        }

        const nextUser = this.onlineUsers[nextPresenceKey];
        if (nextUser) {
            if (!nextUser.selection && previousUser.selection) {
                nextUser.selection = previousUser.selection;
                previousUser.selection = undefined;
            }
            if (previousUser.selection) {
                await this.clearSelectionDecoration(previousUser);
            }
            if (!nextUser.clientIds) {
                nextUser.clientIds = new Set<string>();
            }
            previousUser.clientIds?.forEach((clientId) => {
                nextUser.clientIds?.add(clientId);
            });
        } else {
            this.onlineUsers[nextPresenceKey] = previousUser;
        }

        delete this.onlineUsers[previousPresenceKey];
        this.remapCollaboratorAliases(previousPresenceKey, nextPresenceKey);

        const previousColor = this.collaboratorColors.get(previousPresenceKey);
        if (previousColor && !this.collaboratorColors.has(nextPresenceKey)) {
            this.collaboratorColors.set(nextPresenceKey, previousColor);
        }
        this.collaboratorColors.delete(previousPresenceKey);

        if (this.activeExists===previousPresenceKey) {
            this.activeExists = nextPresenceKey;
        }
        if (this.tetheredClientId===previousPresenceKey) {
            this.tetheredClientId = nextPresenceKey;
        }

        this.logDiagnostic('collaborator.presence_key_migrated', {
            clientId: sourceClientId,
            nextPresenceKey,
            previousPresenceKey,
        });
    }

    private getUserDocPath(user: ExtendedUpdateUserSchema) {
        return user.doc_id ? this.vfs._resolveById(user.doc_id)?.path : undefined;
    }

    private getUserCursorInfo(user: ExtendedUpdateUserSchema) {
        const cursorInfo = formatCollaboratorCursorInfo(this.getUserDocPath(user), user.row);
        return cursorInfo && vscode.l10n.t('At {docPath}, Line {row}', cursorInfo);
    }

    private getSortedOnlineUsers() {
        return sortCollaboratorQuickPickItems(Object.keys(this.onlineUsers).map(clientId => {
            const user = this.onlineUsers[clientId];
            return createCollaboratorQuickPickItem({
                clientId,
                cursorInfo: this.getUserCursorInfo(user),
                email: user.email,
                lastActive: user.last_updated_at!,
                name: user.name,
            });
        }));
    }

    private async resolveUserUri(user: ExtendedUpdateUserSchema) {
        const docPath = this.getUserDocPath(user);
        if (docPath === undefined) { return; }

        return resolveProjectRenderUriForPath(this.vfs.origin, docPath);
    }

    private async revealUserPosition(user: ExtendedUpdateUserSchema, preview: boolean = false) {
        const uri = await this.resolveUserUri(user);
        if (uri === undefined) {
            this.logDiagnostic('collaborator.reveal_unresolved', {
                collaboratorId: user.id,
                preview,
                reason: 'uri_unresolved',
            });
            return false;
        }

        const selection = new vscode.Selection(user.row, user.column, user.row, user.column);
        this.logDiagnostic('collaborator.reveal_started', {
            collaboratorId: user.id,
            preview,
            targetUri: uri.toString(),
        });
        try {
            const visibleEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());
            const editor = visibleEditor ?
                await vscode.window.showTextDocument(visibleEditor.document, {
                    preview,
                    selection,
                    viewColumn: visibleEditor.viewColumn,
                }) :
                await vscode.window.showTextDocument(uri, {
                    preview,
                    selection,
                });
            editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            this.logDiagnostic('collaborator.reveal_completed', {
                collaboratorId: user.id,
                preview,
                targetUri: uri.toString(),
            });
            return true;
        } catch (error) {
            this.logDiagnostic('collaborator.reveal_failed', {
                collaboratorId: user.id,
                preview,
                targetUri: uri.toString(),
            }, error);
            return false;
        }
    }

    private clearTetheredUser(
        options?: {
            notify?: boolean,
            reason?: 'manual' | 'offline',
        },
    ) {
        const tetheredUser = this.tetheredClientId ? this.onlineUsers[this.tetheredClientId] : undefined;
        const tetheredName = tetheredUser?.name;
        this.tetheredClientId = undefined;
        this.logDiagnostic('collaborator.follow_stopped', {
            collaboratorId: tetheredUser?.id ?? '',
            notify: options?.notify ?? false,
            reason: options?.reason ?? 'manual',
        });
        if (!options?.notify || tetheredName === undefined) { return; }

        switch (options.reason) {
            case 'offline':
                vscode.window.showInformationMessage(vscode.l10n.t('Stopped following {name} because they went offline.', {name: tetheredName}));
                break;
            default:
                vscode.window.showInformationMessage(vscode.l10n.t('Stopped following {name}.', {name: tetheredName}));
                break;
        }
    }

    private async jumpToUser(id?: string) {
        const selectedFromPicker = id === undefined;
        if (id === undefined) {
            const onlineUsers = Object.values(this.onlineUsers);
            if (onlineUsers.length === 0) {
                this.logDiagnostic('collaborator.selection_empty', {
                    action: 'jump',
                });
                vscode.window.showErrorMessage( vscode.l10n.t('No online Collaborators.') );
                return;
            }
            // select a user
            this.logDiagnostic('collaborator.selection_requested', {
                action: 'jump',
                onlineCount: onlineUsers.length,
            });
            const selectedUser = await vscode.window.showQuickPick(
                this.getSortedOnlineUsers(),
                {
                    placeHolder: vscode.l10n.t('Select a collaborator below to jump to.'),
                },
            );
            if (selectedUser === undefined) {
                this.logDiagnostic('collaborator.selection_cancelled', {
                    action: 'jump',
                    onlineCount: onlineUsers.length,
                });
                return;
            }
            id = selectedUser.clientId;
        }

        const user = this.onlineUsers[id];
        if (user === undefined) {
            this.logDiagnostic('collaborator.selection_missing', {
                action: 'jump',
                collaboratorId: id,
            });
            vscode.window.showWarningMessage(vscode.l10n.t('Collaborator is no longer online.'));
            return;
        }

        this.logDiagnostic('collaborator.selection_resolved', {
            action: 'jump',
            collaboratorId: id,
            cursorInfo: this.getUserCursorInfo(user) ?? '',
        });
        const revealed = await this.revealUserPosition(user, false);
        if (revealed && selectedFromPicker) {
            vscode.window.showInformationMessage(vscode.l10n.t('Jumped to {name}.', {name: user.name}));
        }
    }

    private async tetherToUser(id?: string) {
        const selectedFromPicker = id === undefined;
        if (id === undefined) {
            const onlineUsers = Object.values(this.onlineUsers);
            if (onlineUsers.length === 0) {
                this.logDiagnostic('collaborator.selection_empty', {
                    action: 'follow',
                });
                vscode.window.showErrorMessage( vscode.l10n.t('No online Collaborators.') );
                return;
            }
            this.logDiagnostic('collaborator.selection_requested', {
                action: 'follow',
                onlineCount: onlineUsers.length,
            });
            const selectedUser = await vscode.window.showQuickPick(
                this.getSortedOnlineUsers(),
                {
                    placeHolder: vscode.l10n.t('Select a collaborator below to follow.'),
                },
            );
            if (selectedUser === undefined) {
                this.logDiagnostic('collaborator.selection_cancelled', {
                    action: 'follow',
                    onlineCount: onlineUsers.length,
                });
                return;
            }
            id = selectedUser.clientId;
        }

        const user = this.onlineUsers[id];
        if (user === undefined) {
            this.logDiagnostic('collaborator.selection_missing', {
                action: 'follow',
                collaboratorId: id,
            });
            vscode.window.showWarningMessage(vscode.l10n.t('Collaborator is no longer online.'));
            return;
        }

        this.tetheredClientId = id;
        this.logDiagnostic('collaborator.selection_resolved', {
            action: 'follow',
            collaboratorId: id,
            cursorInfo: this.getUserCursorInfo(user) ?? '',
        });
        const revealed = await this.revealUserPosition(user, true);
        if (revealed) {
            this.logDiagnostic('collaborator.follow_started', {
                collaboratorId: id,
                selectedFromPicker,
            });
            vscode.window.showInformationMessage(vscode.l10n.t('Following {name}.', {name: user.name}));
        }
    }

    private refreshDecorations(visibleTextEditors: readonly vscode.TextEditor[]) {
        Object.values(this.onlineUsers).forEach(async user => {
            const docPath = this.vfs._resolveById(user.doc_id)?.path;
            if (docPath === undefined) { return; }

            const uri = await resolveProjectRenderUriForPath(this.vfs.origin, docPath);
            const editor = uri && visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
            const selection = user.selection;
            if (selection && editor) {
                selection.ranges = this.createCollaboratorCursorRanges(
                    user.row,
                    user.column,
                    selection.color,
                    selection.hoverMessage,
                    editor.document,
                );
                editor.setDecorations(selection.decoration, selection.ranges);
            }
        });
    }

    private async updatePosition(presenceKey:string, sourceClientId: string, docId: string, row: number, column: number, details?:UpdateUserSchema) {
        if (this.isOwnPresence(sourceClientId, details?.user_id)) { return; }

        await this.migratePresenceKey(sourceClientId, presenceKey);

        const existingUser = this.onlineUsers[presenceKey];
        const previousPosition: CollaboratorCursorLocation | undefined = existingUser && {
            docId: existingUser.doc_id,
            row: existingUser.row,
            column: existingUser.column,
        };
        const previousDocId = existingUser?.doc_id;

        // update record
        if (existingUser===undefined) {
            if (details === undefined) { return; }
            this.onlineUsers[presenceKey] = {
                clientIds: new Set<string>(),
                last_updated_at: Date.now(),
                ...details
            };
            this.attachCollaboratorAlias(sourceClientId, presenceKey, this.onlineUsers[presenceKey]);
        } else {
            existingUser.id = sourceClientId;
            existingUser.doc_id = docId;
            existingUser.row = row;
            existingUser.column = column;
            existingUser.last_updated_at = Date.now();
            if (details) {
                existingUser.user_id = details.user_id;
                existingUser.name = details.name;
                existingUser.email = details.email;
            }
            this.attachCollaboratorAlias(sourceClientId, presenceKey, existingUser);
        }

        const user = this.onlineUsers[presenceKey];
        const selection = user.selection;
        const moved = didCollaboratorMove(previousPosition, {docId, row, column});

        if (!moved && selection) {
            this.scheduleStatusUpdate('collaborator_position_updated');
            return;
        }

        // remove decoration
        const oldDoc = previousDocId ? this.vfs._resolveById(previousDocId) : undefined;
        if (oldDoc && oldDoc.fileEntity._id !== docId && selection) {
            const oldUri = await resolveProjectRenderUriForPath(this.vfs.origin, oldDoc.path);

            const oldEditor = oldUri && vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === oldUri.toString());
            oldEditor && oldEditor.setDecorations(selection.decoration, []);
        }

        // update decoration
        await this.renderCursorDecoration(presenceKey, user);

        if (
            this.tetheredClientId === presenceKey
            && moved
        ) {
            await this.revealUserPosition(user, true);
        }
        this.scheduleStatusUpdate('collaborator_position_updated');
    }

    private async removePosition(identifier:string) {
        const presenceKey = this.onlineUsers[identifier] ? identifier : this.collaboratorAliases.get(identifier) ?? identifier;
        const user = this.onlineUsers[presenceKey];
        if (user === undefined) { return; }
        const disconnectedClientId = identifier===presenceKey ? undefined : identifier;
        if (disconnectedClientId) {
            this.detachCollaboratorAlias(disconnectedClientId, presenceKey);
            if ((user.clientIds?.size ?? 0) > 0) {
                if (user.id===disconnectedClientId) {
                    user.id = Array.from(user.clientIds ?? [])[0] ?? user.id;
                }
                return;
            }
        }

        await this.clearSelectionDecoration(user);
        Array.from(user.clientIds ?? []).forEach((clientId) => {
            this.collaboratorAliases.delete(clientId);
        });

        if (this.activeExists === presenceKey) {
            this.activeExists = undefined;
        }
        if (this.tetheredClientId === presenceKey) {
            this.clearTetheredUser({notify: true, reason: 'offline'});
        }
        delete this.onlineUsers[presenceKey];
        this.collaboratorColors.delete(presenceKey);
        this.scheduleStatusUpdate('collaborator_removed');
    }

    private clearCollaboratorsForConnectionLoss() {
        const disconnectedUsers = Object.entries(this.onlineUsers);
        if (disconnectedUsers.length===0) {
            return;
        }
        const tetheredUser = this.tetheredClientId ? this.onlineUsers[this.tetheredClientId] : undefined;
        const tetheredName = tetheredUser?.name;
        this.tetheredClientId = undefined;
        this.activeExists = undefined;
        this.logDiagnostic('collaborator.connection_loss_cleared', {
            collaboratorCount: disconnectedUsers.length,
            hadTetheredUser: Boolean(tetheredName),
        });
        if (tetheredName) {
            vscode.window.showInformationMessage(
                vscode.l10n.t('Stopped following {name} because they went offline.', {name: tetheredName}),
            );
        }
        disconnectedUsers.forEach(([presenceKey, user]) => {
            void this.clearSelectionDecoration(user);
            Array.from(user.clientIds ?? []).forEach((clientId) => {
                this.collaboratorAliases.delete(clientId);
            });
            delete this.onlineUsers[presenceKey];
            this.collaboratorColors.delete(presenceKey);
        });
    }

    private applyStatusPresentation(options: {
        backgroundColorId?: string,
        color?: string,
        command: string,
        text: string,
        tooltip: string | vscode.MarkdownString,
        tooltipSignature: string,
    }) {
        const visualSignature = JSON.stringify({
            backgroundColorId: options.backgroundColorId ?? '',
            color: options.color ?? '',
            command: options.command,
            text: options.text,
        });
        if (this.lastStatusVisualSignature!==visualSignature) {
            this.status.backgroundColor = options.backgroundColorId
                ? new vscode.ThemeColor(options.backgroundColorId)
                : undefined;
            this.status.color = options.color;
            this.status.command = options.command;
            this.status.text = options.text;
            this.lastStatusVisualSignature = visualSignature;
        }
        if (this.lastStatusTooltipSignature!==options.tooltipSignature) {
            this.status.tooltip = options.tooltip;
            this.lastStatusTooltipSignature = options.tooltipSignature;
        }
        if (!this.statusShown) {
            this.status.show();
            this.statusShown = true;
        }
    }

    private updateStatus() {
        const count = Object.keys(this.onlineUsers).length;
        const requestedConnectionState = resolveCollaboratorConnectionIndicatorState({
            connectionPhase: this.vfs.realtimeConnectionPhase,
            synchronizationMode: this.vfs.synchronizationMode,
            transportConnected: this.connectedFlag,
        });
        const currentTimeMs = Date.now();
        if (requestedConnectionState!=='connected') {
            this.lastNonConnectedIndicatorAtMs = currentTimeMs;
        }
        const visualConnectionState = resolveCollaboratorConnectionIndicatorVisualState({
            currentTimeMs,
            lastNonConnectedAtMs: this.lastNonConnectedIndicatorAtMs,
            previousVisualState: this.lastPresentedConnectionState,
            requestedState: requestedConnectionState,
        });
        if (visualConnectionState.holdMs > 0) {
            this.scheduleStatusUpdate('connected_visual_hold_release', visualConnectionState.holdMs);
        }
        this.lastPresentedConnectionState = visualConnectionState.state;
        if (this.activeExists && this.onlineUsers[this.activeExists] === undefined) {
            this.activeExists = undefined;
        }
        if (this.tetheredClientId && this.onlineUsers[this.tetheredClientId] === undefined) {
            this.tetheredClientId = undefined;
        }
        if (requestedConnectionState==='disconnected') {
            this.clearCollaboratorsForConnectionLoss();
        }
        switch (visualConnectionState.state) {
            case 'disconnected':
                this.applyStatusPresentation({
                    color: 'red',
                    command: `${ROOT_NAME}.collaboration.settings`,
                    text: ClientManager.DISCONNECTED_STATUS_TEXT,
                    tooltip: `${ELEGANT_NAME}: ${vscode.l10n.t('Not connected')}`,
                    tooltipSignature: 'disconnected',
                });
                break;
            case 'reconnecting':
                this.applyStatusPresentation({
                    color: 'red',
                    command: `${ROOT_NAME}.collaboration.settings`,
                    text: ClientManager.DISCONNECTED_STATUS_TEXT,
                    tooltip: `${ELEGANT_NAME}: ${vscode.l10n.t('Reconnecting')}`,
                    tooltipSignature: 'reconnecting',
                });
                break;
            case 'connected':
            default:
                let prefixText = '';
                // notify unread messages
                if (this.chatViewer.hasUnread) {
                    prefixText = prefixText.concat(`$(bell-dot) ${this.chatViewer.hasUnread} `);
                }
                const command = this.chatViewer.hasUnread
                    ? `${ROOT_NAME}.collaboration.revealChatView`
                    : `${ROOT_NAME}.collaboration.settings`;
                const backgroundColorId = this.chatViewer.hasUnread ? 'statusBarItem.warningBackground' : undefined;
                // notify unSynced changes
                const unSynced = this.socket.unSyncFileChanges;
                if (unSynced) {
                    prefixText = prefixText.concat(`$(arrow-up) ${unSynced} `);
                }

                const isInvisible = this.socket.isUsingAlternativeConnectionScheme;
                const onlineIcon = isInvisible ? '$(person)' : '$(organization)';
                switch (count) {
                    case 0:
                        this.applyStatusPresentation({
                            backgroundColorId,
                            color: undefined,
                            command,
                            text: prefixText + `${onlineIcon} 0`,
                            tooltip: `${ELEGANT_NAME}: ${vscode.l10n.t('Online')}`,
                            tooltipSignature: `online:${prefixText}:${onlineIcon}:0`,
                        });
                        break;
                    default:
                        const color = this.activeExists ? this.onlineUsers[this.activeExists]?.selection?.color : undefined;
                        const text = prefixText + `${onlineIcon} ${count}`;
                        const tooltip = new vscode.MarkdownString();
                        const tetheredUser = this.tetheredClientId ? this.onlineUsers[this.tetheredClientId] : undefined;
                        const statusSummary = this.activeExists? vscode.l10n.t('Active'): vscode.l10n.t('Idle');
                        const tetheredSummary = tetheredUser ? ` (${vscode.l10n.t('Following {name}', {name: tetheredUser.name})})` : '';
                        tooltip.appendText(`${ELEGANT_NAME}: ${statusSummary}${tetheredSummary}`);
                        tooltip.appendMarkdown('\n\n');
                        const tooltipParts = [`summary:${statusSummary}${tetheredSummary}`];
                        const insertTextCommand = `${ROOT_NAME}.collaboration.insertText`;
                        const jumpToUserCommand = `${ROOT_NAME}.collaboration.jumpToUser`;

                        Object.values(this.onlineUsers).forEach(user => {
                            const userArgs = JSON.stringify([`@[[${user.name}#${user.user_id}]] `]);
                            const userCommandUri = vscode.Uri.parse(`command:${insertTextCommand}?${encodeURIComponent(userArgs)}`);
                            const userInfo = `[@${escapeCollaboratorMarkdownText(user.name)}](${userCommandUri})`;

                            const jumpArgs = JSON.stringify([user.id]);
                            const jumpCommandUri = vscode.Uri.parse(`command:${jumpToUserCommand}?${encodeURIComponent(jumpArgs)}`);
                            const cursorInfo = this.getUserCursorInfo(user);
                            const cursorMarkdown = cursorInfo ? ` at [${escapeCollaboratorMarkdownText(cursorInfo)}](${jumpCommandUri})` : '';
                
                            const since_last_update = user.last_updated_at ? formatTime(Date.now() - user.last_updated_at) : '';
                            const timeInfo = since_last_update==='' ? vscode.l10n.t('Just now') : vscode.l10n.t('{since_last_update} ago', {since_last_update});
                            tooltip.appendMarkdown(`${userInfo}${cursorMarkdown}`);
                            tooltip.appendText(` ${timeInfo}`);
                            tooltip.appendMarkdown('\n\n');
                            tooltipParts.push(`${user.id}:${cursorInfo ?? ''}:${timeInfo}:${user.selection?.color ?? ''}`);
                        });
                        tooltip.isTrusted = {
                            enabledCommands: [
                                insertTextCommand,
                                jumpToUserCommand,
                            ],
                        };
                        this.applyStatusPresentation({
                            backgroundColorId,
                            color,
                            command,
                            text,
                            tooltip,
                            tooltipSignature: tooltipParts.join('|'),
                        });
                        break;
                }
                break;
        }
    }

    setStatusActive(clientId:string, timeout:number=10) {
        this.inactivateTask && clearTimeout(this.inactivateTask);
        this.inactivateTask = setTimeout(() => {
            this.activeExists = undefined;
            this.scheduleStatusUpdate('activity_timeout_elapsed');
        }, timeout*1000);
        this.activeExists = clientId;
        this.scheduleStatusUpdate('activity_marked_active');
    }

    collaborationSettings() {
        const isInvisible = this.socket.isUsingAlternativeConnectionScheme;
        const useAction = isInvisible ? 'Exit' : 'Enter';
        const quickPickItems = [
            {id:'jump', label:vscode.l10n.t('Jump to Collaborator ...'), detail:''},
            {id:'tether', label:vscode.l10n.t('Follow Collaborator ...'), detail:vscode.l10n.t('Keep your editor synced to a collaborator\'s cursor.')},
            ...(this.tetheredClientId && this.onlineUsers[this.tetheredClientId] ? [{
                id:'untether',
                label:vscode.l10n.t('Stop Following {name}', {name: this.onlineUsers[this.tetheredClientId].name}),
                detail:vscode.l10n.t('Stop automatically jumping to that collaborator.'),
            }] : []),
            {label:'',kind:vscode.QuickPickItemKind.Separator},
        ];
        if (isInvisible && this.socket.unSyncFileChanges) {
            quickPickItems.push({id:'sync',label:vscode.l10n.t('Upload Unsaved {number} Change(s)', {number:this.socket.unSyncFileChanges}),detail:''});
        } else {
            const detail = !isInvisible ? vscode.l10n.t('Invisible Mode removes your presence from others\' view.') : vscode.l10n.t('Back to normal mode.');
            quickPickItems.push({id:'toggle',label:`${useAction} Invisible Mode`,detail});
        }
        // show quick pick
        this.logDiagnostic('settings.opened', {
            connectedFlag: this.connectedFlag,
            invisibleMode: isInvisible,
            onlineCount: Object.keys(this.onlineUsers).length,
            unsyncedChanges: this.socket.unSyncFileChanges,
        });
        vscode.window.showQuickPick(quickPickItems, {
            canPickMany: false,
        }).then(async item => {
            if (item === undefined) {
                this.logDiagnostic('settings.cancelled');
                return;
            }
            this.logDiagnostic('settings.selected', {
                action: item.id ?? 'separator',
            });
            switch (item.id) {
                case 'jump':
                    this.jumpToUser();
                    break;
                case 'tether':
                    this.tetherToUser();
                    break;
                case 'untether':
                    this.clearTetheredUser({notify: true, reason: 'manual'});
                    break;
                case 'toggle':
                    if (useAction==='Enter') {
                        vscode.window.showWarningMessage( vscode.l10n.t('(Experimental Feature) By entering Invisible Mode, the current connection to the server will be lost. Continue?'), 'Yes', 'No').then(async selection => {
                            if (selection === 'Yes') {
                                this.logDiagnostic('settings.toggle_invisible_confirmed', {
                                    action: useAction,
                                });
                                this.vfs.toggleInvisibleMode();
                            } else {
                                this.logDiagnostic('settings.toggle_invisible_cancelled', {
                                    action: useAction,
                                });
                            }
                        });
                    } else {
                        this.logDiagnostic('settings.toggle_invisible_confirmed', {
                            action: useAction,
                        });
                        this.vfs.toggleInvisibleMode();
                    }
                    break;
                case 'sync':
                    this.logDiagnostic('settings.sync_unsaved_requested', {
                        unsyncedChanges: this.socket.unSyncFileChanges,
                    });
                    await this.socket.syncFileChanges();
                    vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compile`);
                    break;
            }
        });
    }

    get triggers() {
        return [
            this.status,
            new vscode.Disposable(() => {
                this.diagnosticsStateRegistration.dispose();
                if (this.inactivateTask) {
                    clearTimeout(this.inactivateTask);
                }
                if (this.statusUpdateTimer) {
                    clearTimeout(this.statusUpdateTimer);
                }
            }),
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.insertText`, (text) => {
                this.chatViewer.insertText(text);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.jumpToUser`, (uid) => {
                this.jumpToUser(uid);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.tetherToUser`, (uid) => {
                this.tetherToUser(uid);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.revealChatView`, () => {
                this.chatViewer.focusMainComposer();
                this.scheduleStatusUpdate('chat_view_revealed');
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.composeChatMessage`, () => {
                this.chatViewer.focusMainComposer();
                this.scheduleStatusUpdate('chat_view_composer_focused');
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.settings`, () => {
                this.collaborationSettings();
            }),
            ...this.reviewViewer.triggers,
            EventBus.on('chatUnreadCountChangedEvent', ({origin}) => {
                if (origin!==this.vfs.origin.toString()) {
                    return;
                }
                this.scheduleStatusUpdate('chat_unread_count_changed');
            }),
            EventBus.on('offlineSynchronizationStateChangedEvent', ({origin}) => {
                if (origin!==this.vfs.origin.toString()) {
                    return;
                }
                this.scheduleStatusUpdate('offline_sync_state_changed');
            }),
            EventBus.on('realtimeConnectionStateChangedEvent', ({origin}) => {
                if (origin!==this.vfs.origin.toString()) {
                    return;
                }
                this.scheduleStatusUpdate('realtime_connection_state_changed');
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (didCommentUserPaletteChange(event)) {
                    void this.reloadCollaboratorCursorColors('comment_color_configuration_changed');
                }
            }),
            // update this client's position
            vscode.window.onDidChangeTextEditorSelection(async e => {
                if (e.kind===undefined) { return; }
                const binding = await resolveProjectDocumentBinding(e.textEditor.document.uri);
                if (!binding) {
                    return;
                }

                const doc = await this.vfs._resolveUri(binding.overleafUri);
                const docId = doc?.fileEntity?._id;
                if (docId) {
                    this.socket.updatePosition(docId, e.selections[0].active.line, e.selections[0].active.character);
                }
            }),
            // refresh decorations when editor is switched
            vscode.window.onDidChangeVisibleTextEditors(e => {
                this.refreshDecorations(e);
            }),
        ];
    }
}
