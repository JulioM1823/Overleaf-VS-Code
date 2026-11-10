import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import { GlobalStateManager } from '../utils/globalStateManager';
import { logDiagnostic } from '../utils/diagnostics';
import {
    isLikelyPdfPayload,
    getPdfReadFailureMessage,
    resolvePdfUpdateDeliveryAction,
    shouldPreservePdfCacheOnReadFailure,
} from './pdfReliability';

type PdfSyncMessageContent = {page: number, h: number, v: number, identifier: string};

type PdfWebviewMessage =
    | {type: 'ready'}
    | {type: 'saveState', content: Record<string, unknown>}
    | {type: 'syncPdf', content: PdfSyncMessageContent};

function normalizeFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeBoundedString(value: unknown, maxLength: number): string | undefined {
    return typeof value === 'string' && value.length <= maxLength ? value : undefined;
}

function normalizePdfViewState(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const input = value as Record<string, unknown>;
    const state: Record<string, unknown> = {};
    for (const key of [
        'colorTheme',
        'containerScrollLeft',
        'containerScrollTop',
        'currentScaleValue',
        'pdfCursorTools',
        'pdfViewerScrollMode',
        'pdfViewerSpreadMode',
        'pdfSidebarView',
    ]) {
        const item = input[key];
        if (typeof item === 'number' && Number.isFinite(item)) {
            state[key] = item;
        } else if (typeof item === 'string' && item.length <= 128) {
            state[key] = item;
        }
    }
    return state;
}

function normalizeSyncPdfMessageContent(value: unknown): PdfSyncMessageContent | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const input = value as Record<string, unknown>;
    const page = normalizeFiniteNumber(input.page);
    const h = normalizeFiniteNumber(input.h);
    const v = normalizeFiniteNumber(input.v);
    const identifier = normalizeBoundedString(input.identifier, 256) ?? '';
    if (page === undefined || h === undefined || v === undefined || page < 1) {
        return undefined;
    }
    return {page, h, v, identifier};
}

function normalizePdfWebviewMessage(message: unknown): PdfWebviewMessage | undefined {
    if (message === null || typeof message !== 'object') {
        return undefined;
    }

    const input = message as Record<string, unknown>;
    switch (input.type) {
        case 'ready':
            return {type: 'ready'};
        case 'saveState': {
            const content = normalizePdfViewState(input.content);
            return content === undefined ? undefined : {type: 'saveState', content};
        }
        case 'syncPdf': {
            const content = normalizeSyncPdfMessageContent(input.content);
            return content === undefined ? undefined : {type: 'syncPdf', content};
        }
        default:
            return undefined;
    }
}

export class PdfDocument implements vscode.CustomDocument {
    cache: Uint8Array = new Uint8Array(0);
    loadError?: string;
    private disposed = false;
    private refreshRequested = false;
    private refreshPromise?: Promise<Uint8Array>;

    private readonly _onDidChange = new vscode.EventEmitter<{}>();
    readonly onDidChange = this._onDidChange.event;

    constructor(readonly uri: vscode.Uri) {
        if (uri.scheme !== ROOT_NAME) {
            throw new Error(`Invalid uri scheme: ${uri}`);
        }
        this.uri = uri;
    }

    dispose() {
        this.disposed = true;
        this.refreshRequested = false;
        this.cache = new Uint8Array(0);
        this.loadError = undefined;
        this._onDidChange.dispose();
    }

    refresh(): Promise<Uint8Array> {
        if (this.disposed) { return Promise.resolve(this.cache); }
        this.refreshRequested = true;
        if (!this.refreshPromise) {
            this.refreshPromise = (async () => {
                while (this.refreshRequested && !this.disposed) {
                    this.refreshRequested = false;
                    await this.refreshOnce();
                }
                return this.cache;
            })().finally(() => { this.refreshPromise = undefined; });
        }
        return this.refreshPromise;
    }

    private async refreshOnce(): Promise<void> {
        const previousCache = this.cache;
        try {
            const nextCache = new Uint8Array(await vscode.workspace.fs.readFile(this.uri));
            if (this.disposed || this.refreshRequested) { return; }
            if (!isLikelyPdfPayload(nextCache)) {
                throw new Error('Downloaded content is not a PDF.');
            }
            this.cache = nextCache;
            this.loadError = undefined;
            logDiagnostic('PdfDocument', 'refresh.succeeded', {
                bytes: this.cache.byteLength,
                payloadType: isLikelyPdfPayload(this.cache) ? 'pdf' : 'non_pdf',
                uri: this.uri.toString(),
            });
        } catch (error) {
            if (this.disposed || this.refreshRequested) { return; }
            const preserveCache = shouldPreservePdfCacheOnReadFailure(previousCache.byteLength);
            this.cache = preserveCache ? previousCache : new Uint8Array();
            this.loadError = getPdfReadFailureMessage(error);
            logDiagnostic(
                'PdfDocument',
                preserveCache ? 'refresh.failed_preserved_cache' : 'refresh.failed_cleared_cache',
                {
                    bytes: this.cache.byteLength,
                    uri: this.uri.toString(),
                },
                error,
            );
        }
        this._onDidChange.fire({content:this.cache});
    }
}

export class PdfViewEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly context:vscode.ExtensionContext) {
        this.context = context;
    }

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('PdfView', event, fields, error);
    }

    private async postWebviewMessage(webviewPanel: vscode.WebviewPanel, message: unknown, fields: Record<string, unknown>) {
        try {
            const delivered = await webviewPanel.webview.postMessage(message);
            if (!delivered) {
                this.logDiagnostic('webview.message_rejected', fields);
                return false;
            }
            return true;
        } catch (error) {
            this.logDiagnostic('webview.message_failed', fields, error);
            return false;
        }
    }

    public saveCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public saveCustomDocumentAs(document: PdfDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public revertCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public backupCustomDocument(document: PdfDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
        return Promise.resolve({id: '', delete: () => {}});
    }

    public async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
        const doc = new PdfDocument(uri);
        await doc.refresh();
        this.logDiagnostic('document.opened', {
            uri: uri.toString(),
        });
        return doc;
    }

    public async resolveCustomEditor(doc: PdfDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        EventBus.fire('pdfWillOpenEvent', {uri: doc.uri, doc, webviewPanel});
        this.logDiagnostic('webview.resolve_started', {
            uri: doc.uri.toString(),
        });

        let webviewReady = false;
        let webviewDisposed = false;
        let pendingUpdate = false;
        let deliveredCache: Uint8Array | undefined;
        let deliverySequence = 0;
        let deliveryPromise: Promise<boolean> = Promise.resolve(false);
        let readySequence = 0;

        const deliverPdfUpdate = (reason: 'document_change' | 'ready' | 'initial') => {
            const sequence = ++deliverySequence;
            deliveryPromise = deliveryPromise.then(async () => {
                if (sequence!==deliverySequence) { return false; }
                const cache = doc.cache;
                const loadError = doc.loadError;
                if (webviewReady && !webviewDisposed && loadError) {
                    if (cache.byteLength > 0 && deliveredCache!==cache) {
                        const delivered = await this.postWebviewMessage(webviewPanel, {type:'update', content:cache.buffer}, {messageType:'update', reason});
                        if (delivered) { deliveredCache = cache; }
                    }
                    if (sequence!==deliverySequence || webviewDisposed) { return false; }
                    return this.postWebviewMessage(webviewPanel, {type:'loadError', content:loadError}, {messageType:'loadError', reason});
                }
                const action = resolvePdfUpdateDeliveryAction(cache.byteLength, webviewReady, webviewDisposed);
                switch (action) {
                    case 'skip_disposed':
                        this.logDiagnostic('webview.update_skipped', {
                            reason,
                            skipReason: 'disposed',
                            uri: doc.uri.toString(),
                        });
                        return false;
                    case 'skip_empty':
                        this.logDiagnostic('webview.update_skipped', {
                            reason,
                            skipReason: 'empty_cache',
                            uri: doc.uri.toString(),
                        });
                        return false;
                    case 'queue_until_ready':
                        if (!pendingUpdate) {
                            this.logDiagnostic('webview.update_queued', {
                                reason,
                                uri: doc.uri.toString(),
                            });
                        }
                        pendingUpdate = true;
                        return false;
                    case 'post':
                        pendingUpdate = false;
                        const delivered = await this.postWebviewMessage(webviewPanel, {type:'update', content:cache.buffer}, {
                            messageType: 'update',
                            reason,
                            uri: doc.uri.toString(),
                        });
                        if (delivered) { deliveredCache = cache; }
                        return delivered;
                }
            });
            return deliveryPromise;
        };

        const docOnDidChangeListener = doc.onDidChange(() => {
            void deliverPdfUpdate('document_change');
        });
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(doc.uri, '..'), '*'));
        const refreshChangedPdf = (uri: vscode.Uri) => {
            // VS Code may omit the query on file watcher events. A different
            // explicit project query must never refresh this document.
            if (uri.scheme===doc.uri.scheme && uri.authority===doc.uri.authority
                && uri.path===doc.uri.path && (!uri.query || uri.query===doc.uri.query)) {
                void doc.refresh();
            }
        };
        const watcherSubscriptions = [watcher.onDidChange(refreshChangedPdf), watcher.onDidCreate(refreshChangedPdf), watcher.onDidDelete(refreshChangedPdf)];

        webviewPanel.onDidDispose(() => {
            webviewDisposed = true;
            deliverySequence++;
            pendingUpdate = false;
            this.logDiagnostic('webview.disposed', {
                uri: doc.uri.toString(),
            });
            docOnDidChangeListener.dispose();
            watcherSubscriptions.forEach(subscription => subscription.dispose());
            watcher.dispose();
        });

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer')],
        };
        try {
            webviewPanel.webview.html = await this.getHtmlForWebview(webviewPanel.webview);
            this.logDiagnostic('webview.html_loaded', {
                uri: doc.uri.toString(),
            });
        } catch (error) {
            this.logDiagnostic('webview.html_failed', {
                uri: doc.uri.toString(),
            }, error);
            throw error;
        }

        // register event listeners
        webviewPanel.onDidChangeViewState((e) => {
            if (e.webviewPanel.active) {
                EventBus.fire('fileWillOpenEvent', {uri: doc.uri});
                this.logDiagnostic('webview.activated', {
                    uri: doc.uri.toString(),
                });
            }
        });
        webviewPanel.webview.onDidReceiveMessage((e) => {
            const message = normalizePdfWebviewMessage(e);
            if (message === undefined) {
                this.logDiagnostic('webview.message_ignored', {
                    messageType: typeof e === 'object' && e !== null
                        ? String((e as Record<string, unknown>).type ?? '')
                        : typeof e,
                    uri: doc.uri.toString(),
                });
                return;
            }

            switch (message.type) {
                case 'syncPdf':
                    vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.syncPdf`, message.content);
                    break;
                case 'saveState':
                    GlobalStateManager.updatePdfViewPersist(this.context, doc.uri.toString(), message.content);
                    this.logDiagnostic('webview.state_saved', {
                        uri: doc.uri.toString(),
                    });
                    break;
                case 'ready':
                    webviewReady = false;
                    deliveredCache = undefined;
                    this.logDiagnostic('webview.ready', {
                        hadPendingUpdate: pendingUpdate,
                        uri: doc.uri.toString(),
                    });
                    {
                        const sequence = ++readySequence;
                        const state = GlobalStateManager.getPdfViewPersist(this.context, doc.uri.toString());
                        const config = vscode.workspace.getConfiguration('overleaf-workshop.pdfViewer');
                        const colorThemes = config.get('themes', undefined);
                        const defaults = {
                            scrollMode: config.get('defaultScrollMode', 'vertical'),
                            spreadMode: config.get('defaultSpreadMode', 'none'),
                        };
                        const cMapUrl = `${webviewPanel.webview.asWebviewUri(
                            vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer/vendor/web/cmaps'),
                        ).toString()}/`;
                        void this.postWebviewMessage(webviewPanel, {type:'initState', content:state, colorThemes, defaults}, {
                            messageType: 'initState',
                            uri: doc.uri.toString(),
                        }).then(() => this.postWebviewMessage(webviewPanel, {type:'configure', cMapUrl}, {
                            messageType: 'configure',
                            uri: doc.uri.toString(),
                        })).then(() => {
                            if (sequence!==readySequence || webviewDisposed) { return false; }
                            webviewReady = true;
                            return deliverPdfUpdate(pendingUpdate ? 'ready' : 'initial');
                        });
                    }
                    break;
                default:
                    this.logDiagnostic('webview.message_ignored', {
                        messageType: e.type,
                        uri: doc.uri.toString(),
                    });
                    break;
            }
        });
    }

    public get triggers(): vscode.Disposable[] {
        return [
            vscode.window.registerCustomEditorProvider(`${ROOT_NAME}.pdfViewer`, this, {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }),
        ];
    }

    private patchViewerHtml(webview: vscode.Webview, html: string): string {
        const patchPath = (...path:string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer', ...path)).toString();
        const csp = [
            "default-src 'none'",
            "base-uri 'none'",
            "object-src 'none'",
            `connect-src ${webview.cspSource}`,
            `font-src ${webview.cspSource}`,
            `img-src ${webview.cspSource} data: blob:`,
            `script-src ${webview.cspSource}`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `worker-src ${webview.cspSource} blob:`,
        ].join('; ');

        // adjust original path
        html = html.replace(/<head>/i, `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`);
        html = html.replace('../build/pdf.js', patchPath('vendor','build','pdf.js'));
        html = html.replace('viewer.css', patchPath('vendor','web','viewer.css'));
        html = html.replace('viewer.js',  patchPath('vendor','web','viewer.js'));

        // patch custom files
        const workerScript = `<script src="${patchPath('vendor','build','pdf.worker.js')}"></script>`;
        const syncHighlightScript = `<script src="${patchPath('syncHighlight.js')}"></script>`;
        const documentLoaderScript = `<script src="${patchPath('documentLoader.js')}"></script>`;
        const customScript = `<script src="${patchPath('index.js')}"></script>`;
        const customStyle = `<link rel="stylesheet" href="${patchPath('index.css')}" />`;
        html = html.replace(/\<\/head\>/, `${workerScript}\n${syncHighlightScript}\n${documentLoaderScript}\n${customScript}\n${customStyle}\n</head>`);

        return html;
    }

    private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer/vendor/web/viewer.html');
        let html = (await vscode.workspace.fs.readFile(htmlPath)).toString();
        return this.patchViewerHtml(webview, html);
    }

}
