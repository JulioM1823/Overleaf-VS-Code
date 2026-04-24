import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import { GlobalStateManager } from '../utils/globalStateManager';
import { logDiagnostic } from '../utils/diagnostics';
import {
    isLikelyPdfPayload,
    resolvePdfUpdateDeliveryAction,
    shouldPreservePdfCacheOnReadFailure,
} from './pdfReliability';

export class PdfDocument implements vscode.CustomDocument {
    cache: Uint8Array = new Uint8Array(0);

    private readonly _onDidChange = new vscode.EventEmitter<{}>();
    readonly onDidChange = this._onDidChange.event;

    constructor(readonly uri: vscode.Uri) {
        if (uri.scheme !== ROOT_NAME) {
            throw new Error(`Invalid uri scheme: ${uri}`);
        }
        this.uri = uri;
    }

    dispose() { }

    async refresh(): Promise<Uint8Array> {
        const previousCache = this.cache;
        try {
            this.cache = new Uint8Array(await vscode.workspace.fs.readFile(this.uri));
            logDiagnostic('PdfDocument', 'refresh.succeeded', {
                bytes: this.cache.byteLength,
                payloadType: isLikelyPdfPayload(this.cache) ? 'pdf' : 'non_pdf',
                uri: this.uri.toString(),
            });
            if (!isLikelyPdfPayload(this.cache)) {
                logDiagnostic('PdfDocument', 'refresh.suspicious_payload', {
                    bytes: this.cache.byteLength,
                    uri: this.uri.toString(),
                });
            }
        } catch (error) {
            const preserveCache = shouldPreservePdfCacheOnReadFailure(previousCache.byteLength);
            this.cache = preserveCache ? previousCache : new Uint8Array();
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
        return this.cache;
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

        const deliverPdfUpdate = async (reason: 'document_change' | 'ready' | 'initial') => {
            const action = resolvePdfUpdateDeliveryAction(doc.cache.byteLength, webviewReady, webviewDisposed);
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
                    return await this.postWebviewMessage(webviewPanel, {type:'update', content:doc.cache.buffer}, {
                        messageType: 'update',
                        reason,
                        uri: doc.uri.toString(),
                    });
            }
        };

        const docOnDidChangeListener = doc.onDidChange(() => {
            void deliverPdfUpdate('document_change');
        });

        webviewPanel.onDidDispose(() => {
            webviewDisposed = true;
            pendingUpdate = false;
            this.logDiagnostic('webview.disposed', {
                uri: doc.uri.toString(),
            });
            docOnDidChangeListener.dispose();
        });

        webviewPanel.webview.options = {enableScripts:true};
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
            switch (e.type) {
                case 'syncPdf':
                    vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.syncPdf`, e.content);
                    break;
                case 'saveState':
                    GlobalStateManager.updatePdfViewPersist(this.context, doc.uri.toString(), e.content);
                    this.logDiagnostic('webview.state_saved', {
                        uri: doc.uri.toString(),
                    });
                    break;
                case 'ready':
                    webviewReady = true;
                    this.logDiagnostic('webview.ready', {
                        hadPendingUpdate: pendingUpdate,
                        uri: doc.uri.toString(),
                    });
                    {
                        const state = GlobalStateManager.getPdfViewPersist(this.context, doc.uri.toString());
                        const config = vscode.workspace.getConfiguration('overleaf-workshop.pdfViewer');
                        const colorThemes = config.get('themes', undefined);
                        const defaults = {
                            scrollMode: config.get('defaultScrollMode', 'vertical'),
                            spreadMode: config.get('defaultSpreadMode', 'none'),
                        };
                        void this.postWebviewMessage(webviewPanel, {type:'initState', content:state, colorThemes, defaults}, {
                            messageType: 'initState',
                            uri: doc.uri.toString(),
                        }).then(() => deliverPdfUpdate(pendingUpdate ? 'ready' : 'initial'));
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

        // adjust original path
        html = html.replace('../build/pdf.js', patchPath('vendor','build','pdf.js'));
        html = html.replace('viewer.css', patchPath('vendor','web','viewer.css'));
        html = html.replace('viewer.js',  patchPath('vendor','web','viewer.js'));

        // patch custom files
        const workerScript = `<script src="${patchPath('vendor','build','pdf.worker.js')}"></script>`;
        const syncHighlightScript = `<script src="${patchPath('syncHighlight.js')}"></script>`;
        const customScript = `<script src="${patchPath('index.js')}"></script>`;
        const customStyle = `<link rel="stylesheet" href="${patchPath('index.css')}" />`;
        html = html.replace(/\<\/head\>/, `${workerScript}\n${syncHighlightScript}\n${customScript}\n${customStyle}\n</head>`);

        return html;
    }

    private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer/vendor/web/viewer.html');
        let html = (await vscode.workspace.fs.readFile(htmlPath)).toString();
        return this.patchViewerHtml(webview, html);
    }

}
