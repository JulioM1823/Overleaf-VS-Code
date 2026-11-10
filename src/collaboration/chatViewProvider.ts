import * as crypto from 'crypto';
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

type ChatWebviewMessage =
    | {type: 'chat-ready'}
    | {type: 'get-messages'}
    | {type: 'send-message', content: string}
    | {type: 'edit-message', content: string, messageId: string}
    | {type: 'delete-message', messageId: string};

const MAX_CHAT_WEBVIEW_CONTENT_LENGTH = 100_000;
const MAX_CHAT_WEBVIEW_ID_LENGTH = 1_024;

function createWebviewNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

function normalizeWebviewString(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== 'string' || value.length > maxLength) {
        return undefined;
    }
    return value;
}

function normalizeChatWebviewMessage(message: unknown): ChatWebviewMessage | undefined {
    if (message === null || typeof message !== 'object') {
        return undefined;
    }

    const candidate = message as Record<string, unknown>;
    switch (candidate.type) {
        case 'chat-ready':
        case 'get-messages':
            return {type: candidate.type};
        case 'send-message': {
            const content = normalizeWebviewString(candidate.content, MAX_CHAT_WEBVIEW_CONTENT_LENGTH);
            return content === undefined ? undefined : {type: 'send-message', content};
        }
        case 'edit-message': {
            const content = normalizeWebviewString(candidate.content, MAX_CHAT_WEBVIEW_CONTENT_LENGTH);
            const messageId = normalizeWebviewString(candidate.messageId, MAX_CHAT_WEBVIEW_ID_LENGTH);
            return content === undefined || messageId === undefined
                ? undefined
                : {type: 'edit-message', content, messageId};
        }
        case 'delete-message': {
            const messageId = normalizeWebviewString(candidate.messageId, MAX_CHAT_WEBVIEW_ID_LENGTH);
            return messageId === undefined ? undefined : {type: 'delete-message', messageId};
        }
        default:
            return undefined;
    }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private hasUnreadMessages = 0;
    private readonly diagnosticsStateRegistration: {dispose: () => void};
    private readonly providerInstanceIdValue = nextChatViewProviderInstanceId++;
    private triggerDisposables?: vscode.Disposable[];
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

    private clearTriggerDisposables() {
        const disposables = this.triggerDisposables;
        if (disposables===undefined) {
            return;
        }
        this.triggerDisposables = undefined;
        disposables.splice(0).forEach((disposable) => disposable.dispose());
    }

    dispose() {
        this.clearTriggerDisposables();
        this.clearWebviewDisposables();
        this.diagnosticsStateRegistration.dispose();
        this.webviewView = undefined;
    }

    async loadWebviewHtml(webview: vscode.Webview): Promise<string> {
        const rootFolder = 'views/chat-view/dist';
        const htmlPath = vscode.Uri.joinPath(this.extensionUri, rootFolder, 'index.html');
        const nonce = createWebviewNonce();
        const csp = [
            "default-src 'none'",
            `font-src ${webview.cspSource} data:`,
            `img-src ${webview.cspSource} data:`,
            `script-src 'nonce-${nonce}'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            "connect-src 'none'",
        ].join('; ');
        return (await vscode.workspace.fs.readFile(htmlPath)).toString()
            .replace(/<link rel="icon"[^>]*>\s*/i, '')
            .replace(/<head>/i, `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`)
            .replace(/<script\b(?![^>]*\bnonce=)/i, `<script nonce="${nonce}"`);
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext<unknown>,
        _token: vscode.CancellationToken,
    ): Thenable<void> {
        this.clearWebviewDisposables();
        this.webviewView = webviewView;
        return this.loadWebviewHtml(webviewView.webview).then((html) => {
            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'views/chat-view/dist')],
            };
            webviewView.webview.html = html;
            this.logDiagnostic('webview.resolved');
            this.webviewDisposables.push(
                webviewView.webview.onDidReceiveMessage((event) => {
                    const message = normalizeChatWebviewMessage(event);
                    if (message === undefined) {
                        this.logDiagnostic('webview.message_ignored', {
                            messageType: typeof event === 'object' && event !== null
                                ? String((event as Record<string, unknown>).type ?? '')
                                : typeof event,
                        });
                        return;
                    }
                    switch (message.type) {
                        case 'chat-ready':
                            this.logDiagnostic('webview.ready');
                            this.postCurrentMessages();
                            break;
                        case 'get-messages':
                            this.postCurrentMessages();
                            break;
                        case 'send-message':
                            void this.sendMessage(message.content);
                            break;
                        case 'edit-message':
                            void this.editMessage(message.messageId, message.content);
                            break;
                        case 'delete-message':
                            void this.deleteMessage(message.messageId);
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
        if (this.triggerDisposables!==undefined) {
            return this.triggerDisposables;
        }

        const disposables: vscode.Disposable[] = [];
        try {
            disposables.push(vscode.window.registerWebviewViewProvider(`${ROOT_NAME}.chatWebview`, this, {
                webviewOptions: {retainContextWhenHidden:true},
            }));
            disposables.push(EventBus.on('chatMessagesChangedEvent', ({origin, message}) => {
                if (origin!==this.vfs.origin.toString()) {
                    return;
                }
                if (message && !this.isViewVisible() && message.user_id!==this.vfs._userId) {
                    this.hasUnreadMessages += 1;
                    this.emitUnreadCountChanged('chat_message_unread_incremented');
                }
                this.postCurrentMessages();
            }));
            this.triggerDisposables = disposables;
            return disposables;
        } catch (error) {
            disposables.splice(0).forEach((disposable) => disposable.dispose());
            throw error;
        }
    }
}
