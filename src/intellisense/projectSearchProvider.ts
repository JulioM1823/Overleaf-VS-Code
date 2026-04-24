import * as path from 'path';
import * as vscode from 'vscode';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { RemoteFileSystemProvider, VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { logDiagnostic } from '../utils/diagnostics';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import {
    decodeSearchableTextContent,
    findProjectSearchMatches,
    isSearchableProjectPath,
    normalizeProjectSearchQuery,
    ProjectSearchMatch,
} from './projectSearch';

type SearchContextMode = 'localReplica' | 'remote';

interface ProjectSearchContext {
    mode: SearchContextMode,
    projectName: string,
    readFile: (relPath: string) => Promise<Uint8Array | undefined>,
    resolveUri: (relPath: string) => Promise<vscode.Uri | undefined>,
    rootUri: vscode.Uri,
    serverName: string,
    vfs: VirtualFileSystem,
}

interface ProjectSearchResult extends ProjectSearchMatch {
    relPath: string,
}

interface ProjectSearchQuickPickItem extends vscode.QuickPickItem {
    result: ProjectSearchResult,
}

export class ProjectSearchProvider {
    private readonly maxPerFile = 20;
    private readonly maxResults = 200;

    constructor(private readonly vfsm: RemoteFileSystemProvider) {}

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('ProjectSearch', event, fields, error);
    }

    private async resolveRemoteSearchContext(uri: vscode.Uri): Promise<ProjectSearchContext> {
        const vfs = await this.vfsm.prefetch(uri);
        return {
            mode: 'remote',
            projectName: vfs.projectName,
            readFile: async (relPath: string) => vfs.openFile(vfs.pathToUri(relPath)),
            resolveUri: async (relPath: string) => vfs.pathToUri(relPath),
            rootUri: uri,
            serverName: vfs.serverName,
            vfs,
        };
    }

    private async resolveLocalReplicaSearchContext(): Promise<ProjectSearchContext | undefined> {
        const settings = await LocalReplicaSCMProvider.readSettings();
        if (!settings?.uri) {
            return undefined;
        }

        const originUri = vscode.Uri.parse(settings.uri);
        const vfs = await this.vfsm.prefetch(originUri);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        return {
            mode: 'localReplica',
            projectName: vfs.projectName,
            readFile: async (relPath: string) => {
                const localUri = await LocalReplicaSCMProvider.pathToUri(relPath);
                if (localUri) {
                    try {
                        return await vscode.workspace.fs.readFile(localUri);
                    } catch (error) {
                        this.logDiagnostic('search.local_read_failed', {
                            localUri: localUri.toString(),
                            relPath,
                        }, error);
                    }
                }
                return vfs.openFile(vfs.pathToUri(relPath));
            },
            resolveUri: async (relPath: string) => await LocalReplicaSCMProvider.pathToUri(relPath) ?? vfs.pathToUri(relPath),
            rootUri: workspaceRoot ?? originUri,
            serverName: vfs.serverName,
            vfs,
        };
    }

    private async resolveSearchContext() {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri?.scheme === ROOT_NAME) {
            return this.resolveRemoteSearchContext(activeUri);
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (workspaceRoot?.scheme === ROOT_NAME) {
            return this.resolveRemoteSearchContext(workspaceRoot);
        }

        return this.resolveLocalReplicaSearchContext();
    }

    private async promptQuery() {
        return vscode.window.showInputBox({
            placeHolder: vscode.l10n.t('Search the current Overleaf project. Use /pattern/flags for regex.'),
            prompt: vscode.l10n.t('Search project files by text or regular expression.'),
        });
    }

    private buildQuickPickItem(result: ProjectSearchResult): ProjectSearchQuickPickItem {
        const relPath = result.relPath.startsWith('/') ? result.relPath.slice(1) : result.relPath;
        const fileName = path.basename(relPath);
        return {
            description: relPath,
            detail: vscode.l10n.t('Line {line}, Column {column}: {preview}', {
                column: result.startColumn + 1,
                line: result.line + 1,
                preview: result.preview,
            }),
            label: `${fileName}:${result.line + 1}`,
            result,
        };
    }

    private async revealResult(context: ProjectSearchContext, result: ProjectSearchResult) {
        const targetUri = await context.resolveUri(result.relPath);
        if (targetUri === undefined) {
            this.logDiagnostic('search.result_open_failed', {
                mode: context.mode,
                relPath: result.relPath,
                reason: 'uri_unresolved',
            });
            vscode.window.showWarningMessage(vscode.l10n.t('Unable to open "{path}".', {
                path: result.relPath.startsWith('/') ? result.relPath.slice(1) : result.relPath,
            }));
            return;
        }

        const selection = new vscode.Selection(result.line, result.startColumn, result.line, result.endColumn);
        const editor = await vscode.window.showTextDocument(targetUri, {
            preview: false,
            selection,
        });
        editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.logDiagnostic('search.result_opened', {
            column: result.startColumn + 1,
            line: result.line + 1,
            mode: context.mode,
            relPath: result.relPath,
            targetUri: targetUri.toString(),
        });
    }

    private async executeSearch(context: ProjectSearchContext, input: string) {
        const normalizedQuery = normalizeProjectSearchQuery(input);
        const projectFiles = context.vfs.walk(entity => entity._type === 'doc' || entity._type === 'file');
        const searchableFiles = projectFiles.filter(item => isSearchableProjectPath(item.path, OUTPUT_FOLDER_NAME));
        this.logDiagnostic('search.scan_started', {
            fileCount: searchableFiles.length,
            mode: context.mode,
            projectName: context.projectName,
            query: normalizedQuery.display,
            queryFlags: normalizedQuery.flags,
            queryMode: normalizedQuery.mode,
            serverName: context.serverName,
        });

        const results: ProjectSearchResult[] = [];
        let matchedFileCount = 0;
        let readFailureCount = 0;
        let skippedBinaryCount = 0;
        let truncated = false;

        for (const item of searchableFiles) {
            try {
                const content = await context.readFile(item.path);
                if (content === undefined) {
                    readFailureCount += 1;
                    continue;
                }
                const decoded = decodeSearchableTextContent(content);
                if (decoded === undefined) {
                    skippedBinaryCount += 1;
                    continue;
                }
                const matches = findProjectSearchMatches(decoded, normalizedQuery.regex, this.maxPerFile);
                if (matches.length === 0) {
                    continue;
                }
                matchedFileCount += 1;
                results.push(...matches.map(match => ({...match, relPath: item.path})));
                if (results.length >= this.maxResults) {
                    results.splice(this.maxResults);
                    truncated = true;
                    break;
                }
            } catch (error) {
                readFailureCount += 1;
                this.logDiagnostic('search.file_read_failed', {
                    mode: context.mode,
                    projectName: context.projectName,
                    relPath: item.path,
                }, error);
            }
        }

        this.logDiagnostic('search.scan_completed', {
            fileCount: searchableFiles.length,
            matchedFileCount,
            mode: context.mode,
            projectName: context.projectName,
            readFailureCount,
            resultCount: results.length,
            skippedBinaryCount,
            truncated,
        });

        return {normalizedQuery, results, truncated};
    }

    private async searchProject() {
        const context = await this.resolveSearchContext();
        if (context === undefined) {
            this.logDiagnostic('search.context_unavailable');
            vscode.window.showWarningMessage(vscode.l10n.t('Open an Overleaf project or a linked local replica to search.'));
            return;
        }

        this.logDiagnostic('search.command_started', {
            mode: context.mode,
            projectName: context.projectName,
            rootUri: context.rootUri.toString(),
            serverName: context.serverName,
        });

        const input = await this.promptQuery();
        if (input === undefined) {
            this.logDiagnostic('search.query_cancelled', {
                mode: context.mode,
                projectName: context.projectName,
            });
            return;
        }

        let searchResult;
        try {
            searchResult = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Searching Overleaf project'),
            }, async () => this.executeSearch(context, input));
        } catch (error) {
            this.logDiagnostic('search.query_invalid', {
                input,
                mode: context.mode,
                projectName: context.projectName,
            }, error);
            vscode.window.showErrorMessage(vscode.l10n.t('Invalid search query: {message}', {
                message: error instanceof Error ? error.message : String(error),
            }));
            return;
        }

        if (searchResult.results.length === 0) {
            this.logDiagnostic('search.results_empty', {
                mode: context.mode,
                projectName: context.projectName,
                query: searchResult.normalizedQuery.display,
            });
            vscode.window.showInformationMessage(vscode.l10n.t('No matches found in the current Overleaf project.'));
            return;
        }

        const selected = await vscode.window.showQuickPick(
            searchResult.results.map(result => this.buildQuickPickItem(result)),
            {
                matchOnDescription: true,
                matchOnDetail: true,
                placeHolder: searchResult.truncated
                    ? vscode.l10n.t('Showing the first {count} matches for {query}.', {
                        count: searchResult.results.length,
                        query: searchResult.normalizedQuery.display,
                    })
                    : vscode.l10n.t('{count} matches for {query}.', {
                        count: searchResult.results.length,
                        query: searchResult.normalizedQuery.display,
                    }),
            },
        );

        if (selected === undefined) {
            this.logDiagnostic('search.result_selection_cancelled', {
                mode: context.mode,
                projectName: context.projectName,
                resultCount: searchResult.results.length,
            });
            return;
        }

        this.logDiagnostic('search.result_selected', {
            line: selected.result.line + 1,
            mode: context.mode,
            projectName: context.projectName,
            relPath: selected.result.relPath,
            resultCount: searchResult.results.length,
        });
        await this.revealResult(context, selected.result);
    }

    get triggers(): vscode.Disposable[] {
        return [
            vscode.commands.registerCommand(`${ROOT_NAME}.projectSearch.searchProject`, () => {
                void this.searchProject();
            }),
        ];
    }
}
