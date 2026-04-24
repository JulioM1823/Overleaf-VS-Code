import * as vscode from 'vscode';
import { ProjectMessageResponseSchema } from '../api/base';
import {
    VirtualFileSystem,
} from '../core/remoteFileSystemProvider';
import { ROOT_NAME } from '../consts';
import { logDiagnostic, registerDiagnosticStateProvider } from '../utils/diagnostics';
import { EventBus } from '../utils/eventBus';
import { ChatViewMessageSchema, normalizeChatMessage } from './chatMessageFormatting';
import type { OverleafChatSendResult } from './chatSendResult';

let nextChatViewProviderInstanceId = 1;

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private hasUnreadMessages = 0;
    private readonly diagnosticsStateRegistration: {dispose: () => void};
    private readonly providerInstanceIdValue = nextChatViewProviderInstanceId++;
    private webviewDisposables: vscode.Disposable[] = [];
    private webviewView?: vscode.WebviewView;

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly extensionUri: vscode.Uri,
    ) {
        this.diagnosticsStateRegistration = registerDiagnosticStateProvider(
            `chatView:${this.vfs.serverName}/${this.vfs.projectId}`,
            () => this.collectChatViewDiagnosticsState(),
        );
    }

    get providerInstanceId() {
        return this.providerInstanceIdValue;
    }

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('ChatView', event, {
            connectionPhase: this.vfs.realtimeConnectionPhase,
            hasUnreadMessages: this.hasUnreadMessages,
            projectId: this.vfs.projectId,
            projectName: this.vfs.projectName,
            providerInstanceId: this.providerInstanceId,
            queueLength: this.vfs.chatQueueLength,
            serverName: this.vfs.serverName,
            syncMode: this.vfs.synchronizationMode,
            viewVisible: this.webviewView?.visible ?? false,
            webviewBound: this.webviewView !== undefined,
            ...fields,
        }, error);
    }

    private collectChatViewDiagnosticsState() {
        const deliveryCountByState = new Map<string, number>();
        this.vfs.cachedChatMessages.forEach((message) => {
            const deliveryState = this.vfs.getChatMessageDelivery(message.id).state;
            deliveryCountByState.set(deliveryState, (deliveryCountByState.get(deliveryState) ?? 0) + 1);
        });

        return {
            connectionPhase: this.vfs.realtimeConnectionPhase,
            deliveryCountByState: Object.fromEntries(
                Array.from(deliveryCountByState.entries())
                    .sort(([left], [right]) => left.localeCompare(right)),
            ),
            hasUnreadMessages: this.hasUnreadMessages,
            messageCount: this.vfs.cachedChatMessages.length,
            projectId: this.vfs.projectId,
            providerInstanceId: this.providerInstanceId,
            queueLength: this.vfs.chatQueueLength,
            syncMode: this.vfs.synchronizationMode,
            viewVisible: this.webviewView?.visible ?? false,
            webviewBound: this.webviewView !== undefined,
        };
    }

    private normalizeMessage(message: ProjectMessageResponseSchema): ChatViewMessageSchema {
        const normalized = normalizeChatMessage(message);
        const delivery = this.vfs.getChatMessageDelivery(message.id);
        return {
            ...normalized,
            deliveryDetail: delivery.detail,
            deliveryState: delivery.state,
        };
    }

    private postToWebview(message: Record<string, unknown>) {
        if (this.webviewView === undefined) {
            return false;
        }
        this.webviewView.webview.postMessage(message);
        return true;
    }

    private postCurrentMessages() {
        this.postToWebview({
            type: 'get-messages',
            content: this.vfs.cachedChatMessages.map((message) => this.normalizeMessage(message)),
            userId: this.vfs._userId,
        });
    }

    private emitUnreadCountChanged(reason: string) {
        EventBus.fire('chatUnreadCountChangedEvent', {
            origin: this.vfs.origin.toString(),
            projectId: this.vfs.projectId,
            reason,
            serverName: this.vfs.serverName,
            unreadCount: this.hasUnreadMessages,
        });
    }

    private clearWebviewDisposables() {
        this.webviewDisposables.forEach((disposable) => disposable.dispose());
        this.webviewDisposables = [];
    }

    dispose() {
        this.clearWebviewDisposables();
        this.diagnosticsStateRegistration.dispose();
        this.webviewView = undefined;
    }

    async loadWebviewHtml(webview: vscode.Webview): Promise<string> {
        const rootFolder = 'views/chat-view/dist';
        const htmlPath = vscode.Uri.joinPath(this.extensionUri, rootFolder, 'index.html');
        return (await vscode.workspace.fs.readFile(htmlPath)).toString();
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext<unknown>,
        _token: vscode.CancellationToken,
    ): Thenable<void> {
        this.clearWebviewDisposables();
        this.webviewView = webviewView;
        return this.loadWebviewHtml(webviewView.webview).then((html) => {
            webviewView.webview.options = {enableScripts:true};
            webviewView.webview.html = html;
            this.logDiagnostic('webview.resolved');
            this.webviewDisposables.push(
                webviewView.webview.onDidReceiveMessage((event) => {
                    switch (event.type) {
                        case 'chat-ready':
                            this.logDiagnostic('webview.ready');
                            this.postCurrentMessages();
                            break;
                        case 'get-messages':
                            this.postCurrentMessages();
                            break;
                        case 'send-message':
                            void this.sendMessage(event.content);
                            break;
                        case 'edit-message':
                            void this.editMessage(event.messageId, event.content);
                            break;
                        case 'delete-message':
                            void this.deleteMessage(event.messageId);
                            break;
                        default:
                            break;
                    }
                }),
                webviewView.onDidChangeVisibility(() => {
                    const visible = this.isViewVisible();
                    this.logDiagnostic('webview.visibility_changed', {visible});
                    if (visible) {
                        this.hasUnreadMessages = 0;
                        this.emitUnreadCountChanged('chat_view_visible');
                        this.postCurrentMessages();
                    }
                }),
                webviewView.onDidDispose(() => {
                    if (this.webviewView===webviewView) {
                        this.logDiagnostic('webview.disposed');
                        this.clearWebviewDisposables();
                        this.webviewView = undefined;
                    }
                }),
            );
            this.postCurrentMessages();
        });
    }

    private async sendMessage(content: string) {
        this.logDiagnostic('messages.send_started', {
            contentLength: content.trim().length,
        });
        try {
            const result = await this.vfs.sendMessage(this.vfs.currentPublicId ?? '', content);
            if (!result.ok) {
                this.logChatSendFailure(result, {
                    contentLength: content.trim().length,
                });
                void vscode.window.showErrorMessage(result.message);
                return;
            }
            this.logDiagnostic('messages.send_completed', {
                contentLength: content.trim().length,
                deliveryState: result.deliveryState,
                mode: result.mode,
                transport: result.transport,
            });
        } catch (error) {
            this.logDiagnostic('messages.send_failed', {
                contentLength: content.trim().length,
            }, error);
            void vscode.window.showErrorMessage(error instanceof Error
                ? error.message
                : vscode.l10n.t('Unable to send the Overleaf chat message.'));
        }
    }

    private async editMessage(messageId: string, content: string) {
        this.logDiagnostic('messages.edit_started', {
            contentLength: content.trim().length,
            messageId,
        });
        try {
            await this.vfs.editChatMessage(messageId, content);
        } catch (error) {
            this.logDiagnostic('messages.edit_failed', {
                contentLength: content.trim().length,
                messageId,
            }, error);
            void vscode.window.showErrorMessage(error instanceof Error
                ? error.message
                : vscode.l10n.t('Unable to edit the Overleaf chat message.'));
        }
    }

    private async deleteMessage(messageId: string) {
        this.logDiagnostic('messages.delete_started', {messageId});
        try {
            await this.vfs.deleteChatMessage(messageId);
        } catch (error) {
            this.logDiagnostic('messages.delete_failed', {messageId}, error);
            void vscode.window.showErrorMessage(error instanceof Error
                ? error.message
                : vscode.l10n.t('Unable to delete the Overleaf chat message.'));
        }
    }

    private logChatSendFailure(
        result: Extract<OverleafChatSendResult, {ok: false}>,
        fields: Record<string, unknown>,
    ) {
        this.logDiagnostic('messages.send_failed', {
            ...fields,
            chatSendErrorCode: result.code,
            responsePreview: result.responsePreview ?? '',
            route: result.route ?? '',
            statusCode: result.statusCode ?? 0,
            transport: result.transport,
        });
    }

    private isViewVisible() {
        return this.webviewView?.visible ?? false;
    }

    get hasUnread() {
        return this.hasUnreadMessages;
    }

    revealChatView() {
        void vscode.commands.executeCommand('setContext', `${ROOT_NAME}.chatViewEnabled`, true)
            .then(() => vscode.commands.executeCommand(`${ROOT_NAME}.chatWebview.focus`));
        this.hasUnreadMessages = 0;
        this.emitUnreadCountChanged('chat_view_revealed');
    }

    insertText(text = '') {
        this.revealChatView();
        if (this.webviewView === undefined) {
            setTimeout(() => this.insertText(text), 100);
            return;
        }
        this.logDiagnostic('composer.insert_requested', {
            textLength: text.length,
        });
        this.webviewView.webview.postMessage({
            type: 'insert-text',
            content: text,
        });
    }

    focusMainComposer() {
        this.revealChatView();
        if (this.webviewView === undefined) {
            setTimeout(() => this.focusMainComposer(), 100);
            return;
        }
        this.logDiagnostic('composer.focus_requested');
        this.webviewView.webview.postMessage({
            type: 'focus-root-input',
        });
    }

    get triggers() {
        return [
            EventBus.on('chatMessagesChangedEvent', ({origin, message}) => {
                if (origin!==this.vfs.origin.toString()) {
                    return;
                }
                if (message && !this.isViewVisible() && message.user_id!==this.vfs._userId) {
                    this.hasUnreadMessages += 1;
                    this.emitUnreadCountChanged('chat_message_unread_incremented');
                }
                this.postCurrentMessages();
            }),
            vscode.window.registerWebviewViewProvider(`${ROOT_NAME}.chatWebview`, this, {
                webviewOptions: {retainContextWhenHidden:true},
            }),
        ];
    }
}
