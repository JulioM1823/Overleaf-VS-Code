import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { RemoteFileSystemProvider, VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import type { ProjectSessionCoordinator } from '../core/documentSessionManager';
import { ROOT_NAME, OUTPUT_FOLDER_NAME } from '../consts';
import { PdfDocument } from '../core/pdfViewEditorProvider';
import { LatexParser, ErrorSchema } from './compileLogParser';
import { EventBus } from '../utils/eventBus';
import { logDiagnostic, registerDiagnosticStateProvider, startDiagnosticSpan } from '../utils/diagnostics';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { resolveCompileRenderStatus, CompileRenderStatus, CompileTerminalStatus } from './compileStatus';
import {
    normalizeCompileArtifactPath,
    normalizeSyncResultFilePath,
} from './compileArtifacts';
import { isLikelyPdfPayload } from '../core/pdfReliability';

// map string level to severity
const severityMap: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
};

// Match the document class in the tex file
const documentClassRegex = new RegExp(/\\documentclass(?:\[[^\[\]\{\}]*\])?\{([^\[\]\{\}]+)\}/);

const pdfViewRecord: {
    [key: string]: {
        [key: string]: { doc: PdfDocument, webviewPanel: vscode.WebviewPanel }
    }
} = {};

type CompileInvocationSource = 'automatic' | 'command' | 'save';

interface CompileInvocationOptions {
    source?: CompileInvocationSource,
    targetUri?: vscode.Uri,
}

interface QueuedCompileRequest {
    force: boolean,
    notBefore: number,
    options: CompileInvocationOptions,
}

function unregisterPdfViewRecord(identifier: string, filePath: string) {
    if (!pdfViewRecord[identifier]) {
        return false;
    }
    delete pdfViewRecord[identifier][filePath];
    if (Object.keys(pdfViewRecord[identifier]).length===0) {
        delete pdfViewRecord[identifier];
    }
    return true;
}

class CompileDiagnosticProvider {
    private diagnosticCollection = vscode.languages.createDiagnosticCollection(ROOT_NAME);
    private publishedUris = new Set<string>();
    constructor(private readonly vfsm: RemoteFileSystemProvider) {};

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('CompileDiagnostics', event, fields, error);
    }

    private async getRange(log: ErrorSchema, path: string, vfs: any) {
        let textDoc: vscode.TextDocument;
        try {
            textDoc = (await vscode.workspace.openTextDocument(vfs.pathToUri(path)));
        }
        catch (error) {
            this.logDiagnostic('range_resolution_failed', {
                line: log.line ?? -1,
                path,
            }, error);
            return null;
        }
        if (log.line !== null) {
            const _range = new vscode.Range(
                new vscode.Position(log.line - 1, 0),
                new vscode.Position(log.line, 0),
            );
            const lineContent = textDoc.getText(_range);
            const lineMatch = lineContent.match(/^\s*(.*?)\s*$/)?.[1] || '';
            const lineStart = lineContent.indexOf(lineMatch);
            const lineEnd = lineStart + lineMatch.length;
            return new vscode.Range(
                new vscode.Position(log.line - 1, lineStart),
                new vscode.Position(log.line - 1, lineEnd),
            );
        }
        else {
            return new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(1, 0),
            );
        }
    }
    private normalizeDiagnosticPath(path: string) {
        const normalizedPath = normalizeCompileArtifactPath(path);
        const outputRegex = new RegExp(/\.\/(output.(aux|bbl|toc|lof|lot|bbl|bst|ttt|fff))\b/);
        const match = outputRegex.exec(path);
        if (match) {
            return normalizedPath.replace(match[1], `${OUTPUT_FOLDER_NAME}/${match[1]}`);
        }
        if (/^output\.(aux|bbl|toc|lof|lot|bst|ttt|fff)$/i.test(normalizedPath)) {
            return `${OUTPUT_FOLDER_NAME}/${normalizedPath}`;
        }
        return normalizedPath;
    }

    private publishDiagnostics(vfs: VirtualFileSystem, diagnosticsRecorder: { [key: string]: vscode.Diagnostic[] }, fields: Record<string, unknown>) {
        const nextPublishedUris = new Set<string>();
        for (const file in diagnosticsRecorder) {
            const diagnostics = diagnosticsRecorder[file];
            const _uri = vfs.pathToUri(file);
            this.diagnosticCollection.set(_uri, diagnostics);
            nextPublishedUris.add(_uri.toString());
            this.logDiagnostic('diagnostics.file_published', {
                count: diagnostics.length,
                path: file,
                uri: _uri.toString(),
            });
        }
        for (const staleUri of this.publishedUris) {
            if (!nextPublishedUris.has(staleUri)) {
                this.diagnosticCollection.delete(vscode.Uri.parse(staleUri));
            }
        }
        this.publishedUris = nextPublishedUris;
        this.logDiagnostic('diagnostics.published', {
            diagnosticFileCount: nextPublishedUris.size,
            ...fields,
        });
    }

    private async updateDiagnostics(uri: vscode.Uri) {
        const logPath = `${OUTPUT_FOLDER_NAME}/output.log`;
        this.logDiagnostic('diagnostics.update_started', {
            logPath,
            uri: uri.toString(),
        });
        const vfs = await this.vfsm.prefetch(uri);
        const _uri = vfs.pathToUri(logPath);
        let content ='';
        try {
            content = new TextDecoder().decode(await vfs.openFile(_uri));
        } catch (error) {
            this.logDiagnostic('diagnostics.log_load_failed', {
                logPath,
                uri: _uri.toString(),
            }, error);
            return false;
        }
        this.logDiagnostic('diagnostics.log_loaded', {
            contentLength: content.length,
            logUri: _uri.toString(),
        });
        const logs = new LatexParser(content).parse();
        if (logs === undefined) {
            if (content === '') {
                this.diagnosticCollection.clear();
                this.publishedUris.clear();
                this.logDiagnostic('diagnostics.cleared', {
                    reason: 'empty_log',
                    uri: uri.toString(),
                });
                return false;
            }
            this.logDiagnostic('diagnostics.parse_failed', {
                contentLength: content.length,
                logUri: _uri.toString(),
            });
            return false;
        }
        let hasError = false;
        const diagnosticsRecorder: { [key: string]: vscode.Diagnostic[] } = {};
        let skippedNonWorkspaceFiles = 0;
        let unresolvedRanges = 0;
        this.logDiagnostic('diagnostics.parse_completed', {
            errorCount: logs.errors.length,
            informationCount: logs.information.length,
            logEntryCount: logs.all.length,
            warningCount: logs.warnings.length,
        });
        for (const log of logs.all) {
            if (!log.file.startsWith('./')) {
                skippedNonWorkspaceFiles += 1;
                continue;
            }
            const path = this.normalizeDiagnosticPath(log.file);
            const range = await this.getRange(log, path, vfs);
            if (range === null) {
                unresolvedRanges += 1;
                continue;
            }
            if (!diagnosticsRecorder[path]) {
                diagnosticsRecorder[path] = [];
            }
            const diagnostic = new vscode.Diagnostic(range, log.message, severityMap[log.level]);
            diagnostic.source = vscode.l10n.t('Compile Checker');
            diagnosticsRecorder[path].push(diagnostic);

            if (log.level === 'error') {
                hasError = true;
            }
        }
        this.publishDiagnostics(vfs, diagnosticsRecorder, {
            hasError,
            skippedNonWorkspaceFiles,
            unresolvedRanges,
            uri: uri.toString(),
        });
        this.logDiagnostic('diagnostics.update_completed', {
            diagnosticFileCount: Object.keys(diagnosticsRecorder).length,
            hasError,
            skippedNonWorkspaceFiles,
            unresolvedRanges,
            uri: uri.toString(),
        });
        return hasError;
    }

    get triggers() {
        return [
            this.diagnosticCollection,
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compileErrorCheck`, async (uri) => {
                return await this.updateDiagnostics(uri);
            }),
        ];
    }
}

export class CompileManager {
    private static readonly SAVE_TRIGGER_COMPILE_DEBOUNCE_MS = 100;
    private static readonly COMPILE_RETRY_DELAY_MS = 500;
    private static readonly COMPILE_REQUEST_TIMEOUT_MS = 60_000;
    readonly status: vscode.StatusBarItem;
    public inCompiling: boolean = false;
    private diagnosticProvider: CompileDiagnosticProvider;
    private compileAsDraft: boolean = false;
    private compileStopOnFirstError: boolean = false;
    private compileOnSaveTimer?: ReturnType<typeof setTimeout>;
    private pendingCompileOnSaveUri?: vscode.Uri;
    private pendingCompileRequest?: QueuedCompileRequest;
    private pendingCompileRetryTimer?: ReturnType<typeof setTimeout>;
    private lastTerminalStatus: CompileTerminalStatus = 'success';
    private statusRenderRevision = 0;
    private readonly diagnosticsStateRegistration: {dispose: () => void};

    constructor(
        private vfsm: RemoteFileSystemProvider,
        private readonly sessionCoordinator?: ProjectSessionCoordinator,
    ) {
        this.vfsm = vfsm;
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
        this.status.command = `${ROOT_NAME}.compilerManager.settings`;
        this.diagnosticProvider = new CompileDiagnosticProvider(vfsm);
        this.diagnosticsStateRegistration = registerDiagnosticStateProvider(
            'compileManager',
            () => this.collectDiagnosticsState(),
        );
        // listen pdf open event
        EventBus.on('pdfWillOpenEvent', ({uri, doc, webviewPanel}) => {
            const {identifier,pathParts} = parseUri(uri);
            const filePath = pathParts.join('/');
            const replacedExisting = Boolean(pdfViewRecord[identifier]?.[filePath]);
            if (pdfViewRecord[identifier]) {
                pdfViewRecord[identifier][filePath] = {doc, webviewPanel};
            } else {
                pdfViewRecord[identifier] = {[filePath]:{doc, webviewPanel}};
            }
            this.logDiagnostic('pdf_view.registered', {
                filePath,
                identifier,
                replacedExisting,
                uri: uri.toString(),
            });
            webviewPanel.onDidDispose(() => {
                const removed = unregisterPdfViewRecord(identifier, filePath);
                this.logDiagnostic('pdf_view.disposed', {
                    filePath,
                    identifier,
                    removed,
                    uri: uri.toString(),
                });
            });
        });
    }

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('CompileManager', event, fields, error);
    }

    private collectPdfViewDiagnosticsState() {
        return Object.entries(pdfViewRecord)
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, 20)
            .map(([identifier, views]) => ({
                identifier,
                pdfPaths: Object.keys(views).sort(),
                viewCount: Object.keys(views).length,
            }));
    }

    private collectDiagnosticsState() {
        const pendingRequest = this.pendingCompileRequest;
        const pdfViews = this.collectPdfViewDiagnosticsState();
        return {
            compileAsDraft: this.compileAsDraft,
            compileStopOnFirstError: this.compileStopOnFirstError,
            inCompiling: this.inCompiling,
            lastTerminalStatus: this.lastTerminalStatus,
            pendingCompileOnSaveScheduled: Boolean(this.compileOnSaveTimer),
            pendingCompileOnSaveUri: this.pendingCompileOnSaveUri?.toString() ?? '',
            pendingCompileRequest: pendingRequest
                ? {
                    force: pendingRequest.force,
                    notBeforeDelayMs: Math.max(0, pendingRequest.notBefore - Date.now()),
                    source: pendingRequest.options.source ?? '',
                    targetUri: pendingRequest.options.targetUri?.toString() ?? '',
                }
                : null,
            pendingCompileRetryScheduled: Boolean(this.pendingCompileRetryTimer),
            pdfViewCount: pdfViews.reduce((count, project) => count + project.viewCount, 0),
            pdfViewProjectCount: Object.keys(pdfViewRecord).length,
            pdfViews,
            statusRenderRevision: this.statusRenderRevision,
        };
    }

    static async check(uri?: vscode.Uri) {
        // check if supported vfs
        uri = uri || vscode.window.activeTextEditor?.document.uri;
        uri = uri || vscode.workspace.workspaceFolders?.[0].uri;
        if (uri?.scheme === ROOT_NAME) {
            return uri;
        }
        // check if supported local replica
        const localSetting = await LocalReplicaSCMProvider.readSettings();
        if (localSetting?.uri) {
            return vscode.Uri.parse(localSetting.uri);
        }
        // otherwise return undefined
        return undefined;
    }

    private rememberCompileStatus(status?: CompileTerminalStatus | 'compiling') {
        if (status===undefined) {
            return;
        }
        this.inCompiling = status === 'compiling';
        if (status!=='compiling') {
            this.lastTerminalStatus = status;
        }
    }

    private async getRenderableStatusContext(uri: vscode.Uri) {
        const vfs = await this.vfsm.prefetch(uri);
        const renderStatus = resolveCompileRenderStatus({
            connectionPhase: vfs.realtimeConnectionPhase,
            hasProject: true,
            inCompiling: this.inCompiling,
            lastTerminalStatus: this.lastTerminalStatus,
        });
        return {renderStatus, vfs};
    }

    private async prepareForRemoteCompile(uri: vscode.Uri) {
        if (!this.sessionCoordinator) {
            return 'ready' as const;
        }
        const result = await this.sessionCoordinator.prepareProjectForRemoteOperation(uri, 'compile_preflight');
        this.logDiagnostic(result==='ready'
            ? 'compile.preflight_ready'
            : 'compile.preflight_blocked', {
            uri: uri.toString(),
        });
        return result;
    }

    private getRequestedCompileTargetUri(options: CompileInvocationOptions) {
        return options.targetUri
            ?? vscode.window.activeTextEditor?.document.uri
            ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    }

    private isUriWithinConnectionOrigin(uri: vscode.Uri, origin: string) {
        const [uriBase, uriQuery = ''] = uri.toString().split('?');
        const [originBase, originQuery = ''] = origin.split('?');
        const pathMatches = uriBase===originBase || uriBase.startsWith(`${originBase}/`);
        if (!pathMatches) {
            return false;
        }
        const uriParams = new URLSearchParams(uriQuery);
        const originParams = new URLSearchParams(originQuery);
        for (const key of ['project', 'user']) {
            const uriValue = uriParams.get(key);
            const originValue = originParams.get(key);
            if (uriValue && originValue && uriValue!==originValue) {
                return false;
            }
        }
        return true;
    }

    private async shouldPreferLocalReplicaCompileTarget(targetUri?: vscode.Uri) {
        if (targetUri?.scheme!=='file') {
            return false;
        }
        const localReplicaSettings = await LocalReplicaSCMProvider.readSettings();
        return localReplicaSettings?.uri !== undefined;
    }

    private shouldSaveAllBeforeCompile(source: CompileInvocationSource, targetUri?: vscode.Uri) {
        return !(source==='save' && targetUri?.scheme===ROOT_NAME);
    }

    private async tryOfflineLocalReplicaCompileFallback(targetUri?: vscode.Uri) {
        const fallbackUri = targetUri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (fallbackUri?.scheme!=='file') {
            return false;
        }

        const localReplicaSettings = await LocalReplicaSCMProvider.readSettings();
        if (!localReplicaSettings?.uri) {
            return false;
        }

        const availableCommands = await vscode.commands.getCommands(true);
        if (!availableCommands.includes('latex-workshop.build')) {
            return false;
        }

        await vscode.commands.executeCommand('latex-workshop.build');
        return true;
    }

    private shouldQueueCompileRequest(source: CompileInvocationSource) {
        return source==='automatic' || source==='save';
    }

    private coalesceQueuedCompileSource(current?: CompileInvocationSource, next?: CompileInvocationSource): CompileInvocationSource | undefined {
        const priority: Record<CompileInvocationSource, number> = {
            automatic: 1,
            save: 2,
            command: 3,
        };
        if (!current) {
            return next;
        }
        if (!next) {
            return current;
        }
        return priority[next] >= priority[current] ? next : current;
    }

    private queueCompileRequest(force: boolean, options: CompileInvocationOptions, reason: string, retryDelayMs = 0) {
        const existing = this.pendingCompileRequest;
        this.pendingCompileRequest = {
            force: existing?.force === true || force,
            notBefore: Math.max(existing?.notBefore ?? 0, Date.now() + retryDelayMs),
            options: {
                source: this.coalesceQueuedCompileSource(existing?.options.source, options.source),
                targetUri: options.targetUri ?? existing?.options.targetUri,
            },
        };
        this.logDiagnostic('compile.request_queued', {
            force: this.pendingCompileRequest.force,
            notBeforeDelayMs: Math.max(0, this.pendingCompileRequest.notBefore - Date.now()),
            reason,
            source: this.pendingCompileRequest.options.source ?? '',
            targetUri: this.pendingCompileRequest.options.targetUri?.toString() ?? '',
        });
        this.schedulePendingCompileRequestDrain();
    }

    private schedulePendingCompileRequestDrain() {
        if (!this.pendingCompileRequest) {
            if (this.pendingCompileRetryTimer) {
                clearTimeout(this.pendingCompileRetryTimer);
                this.pendingCompileRetryTimer = undefined;
            }
            return;
        }
        if (this.pendingCompileRetryTimer) {
            clearTimeout(this.pendingCompileRetryTimer);
        }
        const delayMs = Math.max(0, this.pendingCompileRequest.notBefore - Date.now());
        this.pendingCompileRetryTimer = setTimeout(() => {
            this.pendingCompileRetryTimer = undefined;
            void this.drainPendingCompileRequest('timer');
        }, delayMs);
    }

    private async drainPendingCompileRequest(trigger: string) {
        if (this.inCompiling || !this.pendingCompileRequest) {
            return false;
        }
        if (this.pendingCompileRequest.notBefore > Date.now()) {
            this.schedulePendingCompileRequestDrain();
            return false;
        }
        const request = this.pendingCompileRequest;
        this.pendingCompileRequest = undefined;
        if (this.pendingCompileRetryTimer) {
            clearTimeout(this.pendingCompileRetryTimer);
            this.pendingCompileRetryTimer = undefined;
        }
        this.logDiagnostic('compile.request_drained', {
            force: request.force,
            source: request.options.source ?? '',
            targetUri: request.options.targetUri?.toString() ?? '',
            trigger,
        });
        await this.compile(request.force, request.options);
        return true;
    }

    private clearPendingCompileRequests() {
        this.pendingCompileRequest = undefined;
        if (this.pendingCompileRetryTimer) {
            clearTimeout(this.pendingCompileRetryTimer);
            this.pendingCompileRetryTimer = undefined;
        }
    }

    private clearPendingCompileOnSave() {
        if (this.compileOnSaveTimer) {
            clearTimeout(this.compileOnSaveTimer);
            this.compileOnSaveTimer = undefined;
        }
        this.pendingCompileOnSaveUri = undefined;
        this.clearPendingCompileRequests();
    }

    private scheduleCompileOnSave(uri: vscode.Uri) {
        this.pendingCompileOnSaveUri = uri;
        if (this.compileOnSaveTimer) {
            clearTimeout(this.compileOnSaveTimer);
        }
        this.logDiagnostic('compile.save_scheduled', {
            delayMs: CompileManager.SAVE_TRIGGER_COMPILE_DEBOUNCE_MS,
            uri: uri.toString(),
        });
        this.compileOnSaveTimer = setTimeout(() => {
            const targetUri = this.pendingCompileOnSaveUri;
            this.compileOnSaveTimer = undefined;
            this.pendingCompileOnSaveUri = undefined;
            if (!targetUri) {
                return;
            }
            void this.compile(false, {
                source: 'save',
                targetUri,
            });
        }, CompileManager.SAVE_TRIGGER_COMPILE_DEBOUNCE_MS);
    }

    private async runCompileWithTimeout<T>(promise: Promise<T>, onTimeout?: () => void) {
        return await new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                onTimeout?.();
                reject(new Error(`Compile timed out after ${CompileManager.COMPILE_REQUEST_TIMEOUT_MS}ms`));
            }, CompileManager.COMPILE_REQUEST_TIMEOUT_MS);
            void promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
    }

    private isCompileTimeoutError(error: unknown) {
        return error instanceof Error
            && error.message.startsWith('Compile timed out after ');
    }

    private async resolveRootDocIdForCompile(
        vfs: VirtualFileSystem,
        compileUri: vscode.Uri,
        assertCompileStillActive: () => void,
    ) {
        try {
            const content = new TextDecoder().decode(await vfs.openFile(compileUri));
            assertCompileStillActive();
            const match = RegExp(documentClassRegex).exec(content);
            if (!match) {
                return undefined;
            }
            const fileId = (await vfs._resolveUri(compileUri)).fileId;
            assertCompileStillActive();
            return fileId;
        } catch (error) {
            assertCompileStillActive();
            this.logDiagnostic('compile.root_doc_probe_failed', {
                compileUri: compileUri.toString(),
            }, error);
            return undefined;
        }
    }

    private normalizeCompilePath(pathname: string) {
        return pathname.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    }

    private shouldProbeRootDocIdForCompile(vfs: VirtualFileSystem, compileUri: vscode.Uri) {
        const configuredRootPath = this.normalizeCompilePath(vfs.getRootDocName());
        if (!configuredRootPath) {
            return true;
        }
        const { pathParts } = parseUri(compileUri);
        const compilePath = this.normalizeCompilePath(pathParts.join('/'));
        return compilePath!==configuredRootPath;
    }

    private async checkCompileDiagnostics(uri: vscode.Uri) {
        try {
            return await vscode.commands.executeCommand<boolean>(`${ROOT_NAME}.compileManager.compileErrorCheck`, uri) === true;
        } catch (error) {
            this.logDiagnostic('compile.diagnostics_check_failed', {
                uri: uri.toString(),
            }, error);
            return false;
        }
    }

    async update(status?: 'success'|'compiling'|'failed'|'alert') {
        const renderRevision = ++this.statusRenderRevision;
        this.rememberCompileStatus(status);
        const uri = await CompileManager.check();
        if (renderRevision!==this.statusRenderRevision) {
            return uri;
        }
        if (uri) {
            const {renderStatus, vfs} = await this.getRenderableStatusContext(uri);
            if (renderRevision!==this.statusRenderRevision) {
                return uri;
            }
            if (renderStatus==='hidden') {
                this.status.hide();
                return uri;
            }
            const rootDocName = vfs.getRootDocName().slice(1);
            const compilerName = vfs.getCompiler()?.name || '';
            this.logDiagnostic('status.render', {
                connectionPhase: vfs.realtimeConnectionPhase,
                renderStatus,
                requestedStatus: status ?? '',
                rootDocName,
                uri: uri.toString(),
            });
            this.status.tooltip = new vscode.MarkdownString();
            switch (renderStatus as CompileRenderStatus) {
                case 'success':
                    this.status.text = `${compilerName}`;
                    this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compile Success')}**`);
                    this.status.backgroundColor = undefined;
                    break;
                case 'compiling':
                    this.status.text = `${compilerName} $(sync~spin)`;
                    this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compiling')}**`);
                    this.status.backgroundColor = undefined;
                    break;
                case 'failed':
                    this.status.text = `${compilerName} $(x)`;
                    this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compile Failed')}**`);
                    this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                    break;
                case 'recovering':
                    this.status.text = `${compilerName} $(sync~spin)`;
                    this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Recovering connection')}**`);
                    this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    break;
                case 'fallback':
                    this.status.text = `${compilerName} $(alert)`;
                    this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Fallback read-only mode')}**`);
                    this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    break;
                case 'alert':
                    this.status.text = `$(alert)`;
                    this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compile status unavailable')}**`);
                    this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    break;
            }
            this.status.tooltip.appendMarkdown(`\n\n*${vscode.l10n.t('Click to manage compile settings.')}*`);
            this.status.show();
        } else {
            this.status.hide();
        }
        return uri;
    }

    private refreshPdfViews(uri: vscode.Uri) {
        const { identifier } = parseUri(uri);
        const pdfViews = pdfViewRecord[identifier] ? Object.values(pdfViewRecord[identifier]) : [];
        this.logDiagnostic('pdf_view.refresh_requested', {
            identifier,
            viewCount: pdfViews.length,
        });
        pdfViews.forEach((record) => {
            void record.doc.refresh();
        });
    }

    private async getResolvedPdfTarget(uri: vscode.Uri) {
        const vfs = await this.vfsm.prefetch(uri);
        const pdfPath = vfs.getPrimaryPdfOutputPath();
        if (!pdfPath) {
            return {pdfPath: undefined, pdfUri: undefined, vfs};
        }
        const { projectName } = parseUri(uri);
        return {
            pdfPath,
            pdfUri: uri.with({path: `/${projectName}/${pdfPath}`}),
            vfs,
        };
    }

    private getPdfViewRecord(identifier: string, preferredPdfPath?: string) {
        const records = pdfViewRecord[identifier];
        if (!records) {
            return undefined;
        }
        if (preferredPdfPath && records[preferredPdfPath]) {
            return {pdfPath: preferredPdfPath, record: records[preferredPdfPath]};
        }
        const firstEntry = Object.entries(records)[0];
        if (!firstEntry) {
            return undefined;
        }
        const [pdfPath, record] = firstEntry;
        return {pdfPath, record};
    }

    async compile(force:boolean=false, options: CompileInvocationOptions = {}) {
        const source = options.source ?? 'command';
        const requestedTargetUri = this.getRequestedCompileTargetUri(options);
        if (this.inCompiling) {
            this.logDiagnostic('compile.command.skipped_busy', {
                force,
                source,
            });
            if (this.shouldQueueCompileRequest(source)) {
                this.queueCompileRequest(force, options, 'busy');
            }
            return;
        }
        if (this.shouldSaveAllBeforeCompile(source, requestedTargetUri)) {
            await vscode.workspace.saveAll(); // save all dirty files for command/local-disk compile paths.
        } else {
            this.logDiagnostic('compile.save_all_skipped', {
                reason: 'current_window_save',
                targetUri: requestedTargetUri?.toString() ?? '',
            });
        }

        const shouldPreferLocalReplicaCompile = await this.shouldPreferLocalReplicaCompileTarget(requestedTargetUri);
        if (shouldPreferLocalReplicaCompile) {
            const usedLocalReplicaBuild = await this.tryOfflineLocalReplicaCompileFallback(requestedTargetUri);
            if (usedLocalReplicaBuild) {
                await this.update();
                this.logDiagnostic('compile.command.local_replica_build', {
                    force,
                    source,
                    targetUri: requestedTargetUri?.toString() ?? '',
                });
                return;
            }
        }

        const uri = await CompileManager.check(options.targetUri);
        if (!uri) {
            this.logDiagnostic('compile.command.skipped_no_uri', {
                force,
                source,
            });
            return;
        }

        const compileSpan = startDiagnosticSpan('CompileManager', 'compile.pipeline', {
            force,
            source,
            uri: uri.toString(),
        }, {
            category: 'compile',
            level: 'info',
        });

        this.logDiagnostic('compile.command.start', {
            draft: this.compileAsDraft,
            force,
            stopOnFirstError: this.compileStopOnFirstError,
            source,
            uri: uri.toString(),
        });

        let compileResult: boolean | undefined;
        let activeVfs: VirtualFileSystem | undefined;
        let compileTimedOut = false;
        const assertCompileStillActive = () => {
            if (compileTimedOut) {
                throw new Error('Compile pipeline cancelled after timeout');
            }
        };
        try {
            const preflight = await this.prepareForRemoteCompile(uri);
            if (preflight==='blocked') {
                const blockedProjectVfs = await this.vfsm.prefetch(uri).catch(() => undefined);
                const blockedByOfflineMode = blockedProjectVfs?.isOfflineMode===true;
                if (source==='command' && blockedByOfflineMode) {
                    const usedLocalFallback = await this.tryOfflineLocalReplicaCompileFallback(requestedTargetUri);
                    if (usedLocalFallback) {
                        await this.update();
                        this.logDiagnostic('compile.command.offline_local_fallback', {
                            force,
                            source,
                            targetUri: requestedTargetUri?.toString() ?? '',
                            uri: uri.toString(),
                        });
                        compileSpan.end({
                            outcome: 'offline_local_fallback',
                        });
                        return;
                    }
                }
                await this.update();
                if (source==='command') {
                    vscode.window.showWarningMessage(blockedByOfflineMode
                        ? vscode.l10n.t('Overleaf server compilation is unavailable while offline. Reconnect to compile on Overleaf, or use a local LaTeX build in the local replica.')
                        : vscode.l10n.t('Overleaf is still synchronizing open documents. Please wait a moment and try again.'));
                } else if (this.shouldQueueCompileRequest(source)) {
                    this.queueCompileRequest(force, options, 'blocked_preflight', CompileManager.COMPILE_RETRY_DELAY_MS);
                }
                this.logDiagnostic(source==='command'
                    ? 'compile.command.blocked_preflight'
                    : 'compile.command.blocked_preflight_suppressed', {
                    blockedByOfflineMode,
                    force,
                    source,
                    uri: uri.toString(),
                });
                compileSpan.end({
                    failureClass: blockedByOfflineMode ? 'user-actionable' : 'transient',
                    outcome: blockedByOfflineMode ? 'blocked_offline' : 'blocked_preflight',
                });
                return;
            }

            void this.update('compiling').catch((error) => {
                this.logDiagnostic('status.render_failed', {
                    requestedStatus: 'compiling',
                    uri: uri.toString(),
                }, error);
            });
            const pipelineResult = await this.runCompileWithTimeout((async () => {
                const vfs = await this.vfsm.prefetch(uri);
                assertCompileStillActive();
                activeVfs = vfs;
                const { pathParts } = parseUri(uri);
                const isTexSource = pathParts.length > 0 && /\.tex$/i.test(pathParts[pathParts.length - 1]);
                const compileUri = (() => {
                    if (isTexSource) {
                        return uri;
                    }
                    const rootDocPath = vfs.getRootDocName().slice(1);
                    return rootDocPath ? vfs.pathToUri(rootDocPath) : uri;
                })();

                const shouldProbeRootDocId = isTexSource && this.shouldProbeRootDocIdForCompile(vfs, compileUri);
                const rootDocId = shouldProbeRootDocId
                    ? await this.resolveRootDocIdForCompile(
                        vfs,
                        compileUri,
                        assertCompileStillActive,
                    )
                    : undefined;
                compileResult = await vfs.compile(force, this.compileAsDraft, this.compileStopOnFirstError, rootDocId);
                assertCompileStillActive();
                if (compileResult===true) {
                    const hasError = await this.checkCompileDiagnostics(uri);
                    assertCompileStillActive();
                    return {compileResult, hasError};
                }
                return {compileResult, hasError: undefined};
            })(), () => {
                compileTimedOut = true;
            });

            switch (pipelineResult.compileResult) {
                case undefined:
                    await this.update('success');
                    this.logDiagnostic('compile.command.completed', {
                        compileResult: 'noop',
                        force,
                        uri: uri.toString(),
                    });
                    compileSpan.end({
                        outcome: 'noop',
                    });
                    return;
                case false:
                    await this.update('failed');
                    this.logDiagnostic('compile.command.completed', {
                        compileResult: 'failed',
                        force,
                        uri: uri.toString(),
                    });
                    compileSpan.end({
                        failureClass: 'persistent',
                        outcome: 'compile_failed',
                    });
                    return;
                case true: {
                    const hasError = pipelineResult.hasError===true;
                    await this.update(hasError ? 'failed' : 'success');
                    this.refreshPdfViews(uri);
                    this.logDiagnostic('compile.command.completed', {
                        compileResult: hasError ? 'diagnostics_failed' : 'success',
                        force,
                        hasError,
                        uri: uri.toString(),
                    });
                    compileSpan.end({
                        failureClass: hasError ? 'user-actionable' : undefined,
                        outcome: hasError ? 'diagnostics_failed' : 'success',
                    });
                    return;
                }
                default:
                    await this.update('alert');
                    this.logDiagnostic('compile.command.completed', {
                        compileResult: 'alert',
                        force,
                        uri: uri.toString(),
                    });
                    compileSpan.end({
                        failureClass: 'internal',
                        outcome: 'alert',
                    });
                    return;
            }
        } catch (error) {
            if (this.isCompileTimeoutError(error)) {
                if (compileResult!==true) {
                    try {
                        await activeVfs?.stopCompile();
                    } catch (stopError) {
                        this.logDiagnostic('compile.command.stop_after_timeout_failed', {
                            force,
                            source,
                            uri: uri.toString(),
                        }, stopError);
                    }
                }
                await this.update('failed');
                vscode.window.showErrorMessage(vscode.l10n.t('Compilation timed out. Please try again.'));
                this.logDiagnostic('compile.command.timed_out', {
                    force,
                    source,
                    uri: uri.toString(),
                }, error);
                compileSpan.fail(error, {
                    failureClass: 'transient',
                    outcome: 'timeout',
                });
                return;
            }
            const connectionPhase = await this.vfsm.prefetch(uri)
                .then((vfs) => vfs.realtimeConnectionPhase)
                .catch(() => undefined);
            if (connectionPhase==='recovering' || connectionPhase==='fallback' || connectionPhase==='initializing') {
                await this.update();
            } else {
                await this.update('alert');
            }
            const failureClass = connectionPhase==='recovering'
                || connectionPhase==='fallback'
                || connectionPhase==='initializing'
                ? 'transient'
                : 'internal';
            this.logDiagnostic('compile.command.failed', {
                compileResult: compileResult ?? 'error',
                connectionPhase: connectionPhase ?? 'unknown',
                failureClass,
                force,
                uri: uri.toString(),
            }, error);
            compileSpan.fail(error, {
                connectionPhase: connectionPhase ?? 'unknown',
                failureClass,
                outcome: 'failed',
            });
        } finally {
            this.schedulePendingCompileRequestDrain();
        }
    }

    async stopCompile() {
        const uri = await CompileManager.check();
        if (uri && this.inCompiling) {
            const vfs = await this.vfsm.prefetch(uri);
            await vfs.stopCompile();
            await this.update('failed');
        }
    }

    async openPdf() {
        const uri = await CompileManager.check();
        if (uri) {
            const {pdfPath, pdfUri} = await this.getResolvedPdfTarget(uri);
            if (!pdfUri || !pdfPath) {
                this.logDiagnostic('pdf.open_missing_output', {
                    uri: uri.toString(),
                });
                vscode.window.showWarningMessage(vscode.l10n.t('No compiled PDF output is available yet.'));
                return;
            }
            this.logDiagnostic('pdf.open_requested', {
                pdfPath,
                uri: pdfUri.toString(),
            });
            vscode.commands.executeCommand('vscode.openWith', pdfUri,
                `${ROOT_NAME}.pdfViewer`,
                { preview: false, viewColumn: vscode.ViewColumn.Beside }
            );
        }
    }

    async openPdfExternally() {
        const uri = await CompileManager.check();
        if (!uri) {
            this.logDiagnostic('pdf.external_open_skipped_no_uri');
            return;
        }
        const { identifier } = parseUri(uri);
        try {
            const {pdfPath, pdfUri, vfs} = await this.getResolvedPdfTarget(uri);
            if (!pdfUri || !pdfPath) {
                this.logDiagnostic('pdf.external_open_missing_output', {
                    identifier,
                    uri: uri.toString(),
                });
                vscode.window.showWarningMessage(vscode.l10n.t('No compiled PDF output is available yet.'));
                return;
            }
            this.logDiagnostic('pdf.external_open_started', {
                identifier,
                pdfPath,
                uri: pdfUri.toString(),
            });
            const content = await vfs.openFile(pdfUri);
            const tempDir = vscode.Uri.file(path.join(os.tmpdir(), ROOT_NAME, 'compiled-pdf', identifier.replace(/[^\w.-]+/g, '_')));
            const tempFile = vscode.Uri.file(path.join(tempDir.fsPath, path.basename(pdfPath)));
            await vscode.workspace.fs.createDirectory(tempDir);
            await vscode.workspace.fs.writeFile(tempFile, content);
            const opened = await vscode.env.openExternal(tempFile);
            if (!opened) {
                this.logDiagnostic('pdf.external_open_rejected', {
                    bytes: content.length,
                    identifier,
                    isLikelyPdf: isLikelyPdfPayload(content),
                    pdfPath,
                    tempUri: tempFile.toString(),
                });
                return;
            }
            this.logDiagnostic('pdf.external_open_completed', {
                bytes: content.length,
                identifier,
                isLikelyPdf: isLikelyPdfPayload(content),
                pdfPath,
                tempUri: tempFile.toString(),
            });
        } catch (error) {
            this.logDiagnostic('pdf.external_open_failed', {
                identifier,
                uri: uri.toString(),
            }, error);
            vscode.window.showErrorMessage(vscode.l10n.t('Unable to open the compiled PDF externally.'));
        }
    }

    async syncCode() {
        const uri = await CompileManager.check();
        if (uri && vscode.window.activeTextEditor) {
            const { identifier, pathParts } = parseUri(uri);
            const startPoint = vscode.window.activeTextEditor.selection.start;
            const filePath = pathParts.join('/');
            const line = startPoint.line;
            const column = startPoint.character;
            try {
                const vfs = await this.vfsm.prefetch(uri);
                const res = await vfs.syncCode(filePath, line, column);
                if (!res) {
                    this.logDiagnostic('sync_code.no_result', {
                        filePath,
                        identifier,
                        line,
                    });
                    return;
                }
                const pdfPath = vfs.getPrimaryPdfOutputPath();
                const pdfViewRecordEntry = this.getPdfViewRecord(identifier, pdfPath);
                this.logDiagnostic('sync_code.result_received', {
                    filePath,
                    highlightCount: res.pdf?.length ?? 0,
                    identifier,
                    pdfPath: pdfPath ?? '',
                });
                if (!pdfViewRecordEntry) {
                    this.logDiagnostic('sync_code.pdf_view_missing', {
                        availablePdfViewCount: Object.keys(pdfViewRecord[identifier] ?? {}).length,
                        filePath,
                        identifier,
                        pdfPath: pdfPath ?? '',
                    });
                    return;
                }
                const delivered = await pdfViewRecordEntry.record.webviewPanel.webview.postMessage({
                    type: 'syncCode',
                    content: res
                });
                if (!delivered) {
                    this.logDiagnostic('sync_code.pdf_message_rejected', {
                        filePath,
                        identifier,
                        pdfPath: pdfViewRecordEntry.pdfPath,
                    });
                }
            } catch (error) {
                this.logDiagnostic('sync_code.failed', {
                    filePath,
                    identifier,
                    line,
                }, error);
            }
        }
    }

    private _revealSelectionInEditor(editor: vscode.TextEditor, targetLine: number, identifier: string) {
        const _identifier = identifier.replace(/\s+/g, '\\s+');
        // targetLine is 1-based from the syncTeX result
        const lineIndex = targetLine - 1;

        if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
            this.logDiagnostic('sync_pdf.invalid_line', {
                documentLineCount: editor.document.lineCount,
                editorUri: editor.document.uri.toString(),
                identifier,
                targetLine,
            });
            // Optionally, just focus the editor if the line is invalid
            vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
            return;
        }

        const lineText = editor.document.lineAt(lineIndex).text;
        const match = lineText.match(_identifier);
        const matchIndex = match?.index ?? 0;

        let newSelections: vscode.Selection[];
        const newSelection = new vscode.Selection(lineIndex, matchIndex, lineIndex, matchIndex);
        if (editor.selections.length > 0) {
            newSelections = editor.selections.map((sel, index) =>
                index === 0 ? newSelection : sel
            );
        } else {
            newSelections = [newSelection];
        }
        editor.selections = newSelections;

        editor.revealRange(new vscode.Range(lineIndex, matchIndex, lineIndex, matchIndex), vscode.TextEditorRevealType.InCenter);
    }

    async syncPdf(r: { page: number, h: number, v: number, identifier: string }) {
        const uri = await CompileManager.check();
        if (uri) {
            this.vfsm.prefetch(uri)
                .then((vfs) => vfs.syncPdf(r.page, r.h, r.v))
                .then((res) => {
                    if (res) {
                        const { projectName } = parseUri(uri);
                        const { file, line, column } = res;
                        const _file = normalizeSyncResultFilePath(file, OUTPUT_FOLDER_NAME);
                        this.logDiagnostic('sync_pdf.result_received', {
                            column,
                            file,
                            identifier: r.identifier,
                            line,
                            normalizedFile: _file,
                            page: r.page,
                        });
                        if (!_file) {
                            this.logDiagnostic('sync_pdf.invalid_target_file', {
                                column,
                                file,
                                identifier: r.identifier,
                                line,
                                page: r.page,
                            });
                            return;
                        }
                        const fileUri = uri.with({ path: `/${projectName}/${_file}` });

                        let viewColumnToUse: vscode.ViewColumn | undefined;
                        const existingEditor = vscode.window.visibleTextEditors.find(
                            e => e.document.uri.toString() === fileUri.toString()
                        );

                        if (existingEditor) {
                            viewColumnToUse = existingEditor.viewColumn;
                        } else {
                            viewColumnToUse = vscode.window.visibleTextEditors.at(-1)?.viewColumn || vscode.ViewColumn.Beside;
                        }

                        vscode.window.showTextDocument(fileUri, { viewColumn: viewColumnToUse, preserveFocus: false })
                            .then(
                                (openedEditor) => {
                                    if (openedEditor) {
                                        this._revealSelectionInEditor(openedEditor, line, r.identifier);
                                    }
                                },
                                (error) => {
                                    this.logDiagnostic('sync_pdf.open_document_failed', {
                                        fileUri: fileUri.toString(),
                                        identifier: r.identifier,
                                        page: r.page,
                                    }, error);
                                }
                            );
                    }
                })
                .catch(error => {
                    this.logDiagnostic('sync_pdf.chain_failed', {
                        identifier: r.identifier,
                        page: r.page,
                    }, error);
                });
        }
    }

    async setCompiler() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const compilers = vfs?.getAllCompilers();
        compilers && vscode.window.showQuickPick(compilers.map((item) => {
            return {
                label: item.name,
                description: item.code,
                picked: item.code === currentCompiler?.code,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Compiler'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ compiler: option.description }) && this.compile(true);
        });
    }

    async setRootDoc() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentRootDoc = vfs?.getRootDocName();
        const rootDocs = vfs?.getValidMainDocs();
        rootDocs && vscode.window.showQuickPick(rootDocs.map((item) => {
            return {
                id: item.entity._id,
                label: item.path,
                picked: item.path === currentRootDoc,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Main Document'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ rootDocId: option.id }) && this.compile(true);
        });
    }

    async compileSettings() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const currentRootDoc = vfs?.getRootDocName();

        const currentDraftMode = this.compileAsDraft ? vscode.l10n.t('Draft Mode') : vscode.l10n.t('Normal Mode');
        const currentStopOnError = this.compileStopOnFirstError ? vscode.l10n.t('Stop on first error') : vscode.l10n.t('Try to compile despite errors');
        const settingItems = [
            {label: vscode.l10n.t('Compile Mode'), description: currentDraftMode},
            {label: vscode.l10n.t('Compile Error Handling'), description: currentStopOnError},
            {label: '', kind: vscode.QuickPickItemKind.Separator},
            {label: vscode.l10n.t('Setting: Compiler'), description: currentCompiler?.name, },
            {label: vscode.l10n.t('Setting: Main Document'), description: currentRootDoc, },
        ];
        if (this.inCompiling) {
            settingItems.unshift({label: vscode.l10n.t('Stop compilation'), description: undefined});
        }

        const setting = await vscode.window.showQuickPick(settingItems);
        switch (setting?.label) {
            case vscode.l10n.t('Setting: Compiler'):
                this.setCompiler();
                break;
            case vscode.l10n.t('Setting: Main Document'):
                this.setRootDoc();
                break;
            case vscode.l10n.t('Stop compilation'):
                this.logDiagnostic('compile.settings.stop_requested');
                this.stopCompile();
                break;
            case vscode.l10n.t('Compile Mode'):
                this.compileAsDraft = !this.compileAsDraft;
                this.logDiagnostic('compile.settings.draft_mode_changed', {
                    compileAsDraft: this.compileAsDraft,
                });
                this.compileSettings();
                break;
            case vscode.l10n.t('Compile Error Handling'):
                this.compileStopOnFirstError = !this.compileStopOnFirstError;
                this.logDiagnostic('compile.settings.stop_on_first_error_changed', {
                    compileStopOnFirstError: this.compileStopOnFirstError,
                });
                this.compileSettings();
                break;
            default:
                break;
        }
    }

    get triggers() {
        return [
            // register status bar
            this.status,
            // register compile commands
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compile`, () => this.compile(true)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.viewPdf`, () =>  this.openPdf()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.openPdfExternal`, () => this.openPdfExternally()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncCode`, () => this.syncCode()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncPdf`, (r) => this.syncPdf(r)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compilerManager.settings`, ()=> this.compileSettings()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setCompiler`, () => this.setCompiler()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setRootDoc`, () => this.setRootDoc()),
            // register compile conditions
            vscode.workspace.onDidSaveTextDocument(async (e) => {
                const projectUri = await CompileManager.check(e.uri);
                const vfs = projectUri && await this.vfsm.prefetch(projectUri);
                const compileCondition = vscode.workspace.getConfiguration(`${ROOT_NAME}.compileOnSave`).get('enabled', true);
                const postfixCondition = e.fileName.match(/\.tex$|\.sty$|\.cls$|\.bib$/i);
                if (projectUri && compileCondition && postfixCondition && vfs) {
                    this.scheduleCompileOnSave(e.uri);
                }
            }),
            EventBus.on('compilerUpdateEvent', () => {
                this.compile(true, {source: 'automatic'});
            }),
            EventBus.on('rootDocUpdateEvent', () => {
                this.compile(true, {source: 'automatic'});
            }),
            {dispose: () => this.clearPendingCompileOnSave()},
            this.diagnosticsStateRegistration,
            EventBus.on('realtimeConnectionStateChangedEvent', ({origin, phase, projectId, reason, retryConnection, serverName}) => {
                void (async () => {
                    const uri = await CompileManager.check();
                    if (!uri || !this.isUriWithinConnectionOrigin(uri, origin)) {
                        return;
                    }
                    this.logDiagnostic('status.connection_state_changed', {
                        origin,
                        phase,
                        projectId,
                        reason,
                        retryConnection,
                        serverName,
                    });
                    await this.update();
                })();
            }),
            // register diagnostics triggers
            ...this.diagnosticProvider.triggers,
        ];
    }
}
