/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { EventBus } from '../utils/eventBus';
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { ProjectLabelResponseSchema } from '../api/base';
import { logDiagnostic } from '../utils/diagnostics';
import {
    collectHistoryContributorOptions,
    filterHistoryVersionsByContributor,
    HistoryContributorOption,
} from './historyFilters';

const HISTORY_CONTRIBUTOR_FILTER_CONTEXT = `${ROOT_NAME}.projectHistory.hasContributorFilter`;

interface HistoryRecord {
    before?: number,
    currentVersion?: number,
    keyVersions: number[], //array of all `toV` values
    revisions: {
        [toV:number]: {
            fromV: number,
            timestamp: number,
            users: {
                id: string,
                first_name: string,
                last_name?: string,
                email: string,
            }[]
        }
    },
    labels: {[version:number]: ProjectLabelResponseSchema[]},
    diff: {
        [path:string] : number[] //array of version numbers
    }
}

function formatTime(timestamp:number) {
    const msPerMinute = 60 * 1000;
    const msPerHour = msPerMinute * 60;
    const msPerDay = msPerHour * 24;
    const msPerMonth = msPerDay * 30;
    const msPerYear = msPerDay * 365;

    const elapsed = Date.now() - timestamp;

    if (elapsed < msPerMinute) {
        const elapsedSeconds = Math.round(elapsed/1000);
        return elapsedSeconds===0 ? 'now' : elapsedSeconds + 's';
    } else if (elapsed < msPerHour) {
        const elapsedMinutes = Math.round(elapsed/msPerMinute);
        return elapsedMinutes===1 ? '1 min' : elapsedMinutes + ' mins';
    } else if (elapsed < msPerDay ) {
        const elapsedHours = Math.round(elapsed/msPerHour );
        return elapsedHours===1 ? '1 hour' : elapsedHours + ' hours';
    } else if (elapsed < msPerMonth) {
        const elapsedDays = Math.round(elapsed/msPerDay);
        return elapsedDays===1 ? '1 day' : elapsedDays + ' days';
    } else if (elapsed < msPerYear) {
        const elapsedMonths = Math.round(elapsed/msPerMonth);
        return elapsedMonths===1 ? '1 month' : elapsedMonths + ' months';
    } else {
        const elapsedYears = Math.round(elapsed/msPerYear );
        return elapsedYears===1 ? '1 year' : elapsedYears + ' years';
    }
}

class HistoryItem extends vscode.TreeItem {
    constructor(
        label: string,
        readonly version: number,
        readonly prevVersion: number,
        readonly tags?: ProjectLabelResponseSchema[]
    ) {
        const _tag = tags?.map(t=>t.comment).join(' | ');
        const _label = _tag? `${label} (${_tag})` : label;
        super(_label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = _tag?.length? new vscode.ThemeIcon('tag') : new vscode.ThemeIcon('history');
        this.contextValue = _tag ? 'historyItemLabelled' : 'historyItem';
    }
}

class HistoryDataProvider implements vscode.TreeDataProvider<HistoryItem>, vscode.TextDocumentContentProvider {
    private _path?: string;
    private _history?: HistoryRecord;
    private contributorFilter?: HistoryContributorOption;
    private readonly refreshTimer: NodeJS.Timeout;
    private historyRequestSequence = 0;
    private refreshSequence = 0;

    constructor(private readonly vfs: VirtualFileSystem) {
        this.refreshTimer = setInterval(this.refresh.bind(this), 30*1000);
        void this.updateContributorFilterContext('init');
    }

    private _onDidChangeTreeData: vscode.EventEmitter<HistoryItem | undefined | void> = new vscode.EventEmitter<HistoryItem | undefined | void>();

    readonly onDidChangeTreeData: vscode.Event<HistoryItem | undefined | void> = this._onDidChangeTreeData.event;

    logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('HistoryView', event, {
            hasHistory: this._history!==undefined,
            path: this._path,
            projectId: this.vfs.projectId,
            projectName: this.vfs.projectName,
            refreshSequence: this.refreshSequence,
            serverName: this.vfs.serverName,
            contributorFilterKey: this.contributorFilter?.key ?? '',
            contributorFilterLabel: this.contributorFilter?.label ?? '',
            ...fields,
        }, error);
    }

    private async withProgress<T>(action: string, title: string, fields: Record<string, unknown>, task: () => Promise<T>): Promise<T> {
        this.logDiagnostic('action.started', {action, ...fields});
        try {
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                cancellable: false,
                title,
            }, async () => task());
            this.logDiagnostic('action.completed', {action, ...fields});
            return result;
        } catch (error) {
            this.logDiagnostic('action.failed', {action, ...fields}, error);
            throw error;
        }
    }

    refresh(): void {
        this.refreshSequence += 1;
        this.logDiagnostic('tree.refresh');
        this._onDidChangeTreeData.fire();
    }

    get selectedContributorLabel() {
        return this.contributorFilter?.label;
    }

    private async updateContributorFilterContext(reason: string) {
        const hasContributorFilter = this.contributorFilter !== undefined;
        this.logDiagnostic('filter.context_updated', {
            hasContributorFilter,
            reason,
        });
        await vscode.commands.executeCommand('setContext', HISTORY_CONTRIBUTOR_FILTER_CONTEXT, hasContributorFilter);
    }

    async getContributorOptions() {
        this.logDiagnostic('filter.options_requested');
        const history = await this.getHistory();
        const contributors = collectHistoryContributorOptions(history.revisions);
        this.logDiagnostic('filter.options_resolved', {
            contributorCount: contributors.length,
        });
        return contributors;
    }

    applyContributorFilter(contributor?: HistoryContributorOption) {
        this.contributorFilter = contributor;
        if (contributor) {
            this.logDiagnostic('filter.applied', {
                contributorKey: contributor.key,
                contributorLabel: contributor.label,
                versionCount: contributor.versionCount,
            });
        } else {
            this.logDiagnostic('filter.cleared');
        }
        void this.updateContributorFilterContext(contributor ? 'apply' : 'clear');
        this.refresh();
    }

    async refreshData(path?:string, force:boolean=false) {
        this.logDiagnostic('history.refresh_data_started', {force, nextPath: path});
        this._path = path;
        if (force) {
            this._history = undefined;
        }
        try {
            await this.getHistory();
            this.logDiagnostic('history.refresh_data_completed', {force, nextPath: path});
            this.refresh();
        } catch (error) {
            this.logDiagnostic('history.refresh_data_failed', {force, nextPath: path}, error);
            throw error;
        }
    }

    async openDiffEditor(originVersion:number, targetVersion:number) {
        this.logDiagnostic('diff.open_started', {originVersion, targetVersion});
        if (this._path===undefined) {
            const args: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
            const {diff} = (await this.vfs.getFileTreeDiff(originVersion, targetVersion))!;
            for (const change of diff) {
                if (change.operation===undefined) { continue; }
                const newPathname = change.newPathname || change.pathname;
                let originUri: vscode.Uri | undefined = vscode.Uri.parse(`${ROOT_NAME}-diff:${change.pathname}?${originVersion}`);
                let targetUri: vscode.Uri | undefined = vscode.Uri.parse(`${ROOT_NAME}-diff:${newPathname}?${targetVersion}`);
                let labelUri = targetUri;
                // handle removed/added files
                switch (change.operation) {
                    case 'added':
                        labelUri = targetUri;
                        originUri = undefined;
                        break;
                    case 'removed':
                        labelUri = originUri;
                        targetUri = undefined;
                        break;
                    case 'edited':
                    case 'renamed':
                    default:
                        break;
                }
                args.push([labelUri, originUri, targetUri]);
            }
            vscode.commands.executeCommand('vscode.changes', `v${originVersion} vs v${targetVersion}`, args);
        } else {
            vscode.commands.executeCommand('vscode.diff',
                vscode.Uri.parse(`${ROOT_NAME}-diff:${this._path}?${originVersion}`),
                vscode.Uri.parse(`${ROOT_NAME}-diff:${this._path}?${targetVersion}`),
                `${this._path} (v${originVersion} vs v${targetVersion})`,
            );
        }
        this.logDiagnostic('diff.open_completed', {originVersion, targetVersion});
    }

    getTreeItem(element: HistoryItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: HistoryItem): Thenable<HistoryItem[]> {
        if (element !== undefined) { return Promise.resolve([]); }
        if (!this._history) { return Promise.resolve([]); }

        const _history = this._history;
        const versions = this._path ? this._history.diff[this._path] : this._history.keyVersions;
        const filteredVersions = versions
            ? filterHistoryVersionsByContributor(versions, this._history.revisions, this.contributorFilter?.key)
            : [];
        this.logDiagnostic('children.resolved', {
            filteredVersionCount: filteredVersions.length,
            versionCount: versions?.length ?? 0,
        });
        const historyItems = filteredVersions.map(v => {
            const _version = Number( Object.keys(_history.revisions).find(fromV => v<=Number(fromV)) );

            const item = new HistoryItem(
                `Version ${_version}`,
                _version,
                //prevVersion
                _history.revisions[_version].fromV || _version,
                _history.labels[_version],
            );
            const revision = _history.revisions[_version];
            item.description = '\t'+formatTime(revision.timestamp);
            item.tooltip = new vscode.MarkdownString(`$(history) ${new Date(revision.timestamp).toDateString()}\n\n`);
            item.tooltip.appendMarkdown(`**Participants**\n\n`);
            for (const user of revision.users) {
                item.tooltip.appendMarkdown(`$(account) ${user.first_name} ${user.last_name?user.last_name:''} (${user.email})\n`);
            }
            _history.labels[_version].length && item.tooltip.appendMarkdown(`\n**Comments**\n\n`);
            for (const label of _history.labels[_version]) {
                item.tooltip.appendMarkdown(`\`$(tag) ${label.comment}\` \n`);
            }
            item.tooltip.supportThemeIcons = true;
            item.command = {
                command: `projectHistory.comparePrevious`,
                title: vscode.l10n.t('Compare with Previous Version'),
                arguments: [item],
            };
            return item;
        });

        if (this._history.before) {
            const item = new HistoryItem(vscode.l10n.t('Load More ...'), NaN,NaN);
            item.iconPath = undefined;
            item.command = {
                command: `${ROOT_NAME}.projectHistory.loadMore`,
                title: vscode.l10n.t('Load More ...'),
                arguments: [this],
            };
            historyItems.push(item);
        }
        return Promise.resolve(historyItems);
    }

    provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {
        const [pathname, version] = [uri.path, uri.query];
        const _uri = vscode.workspace.workspaceFolders?.[0].uri;
        this.logDiagnostic('diff.content_requested', {pathname, version});
        if (!_uri) {
            const error = new Error('No workspace folder available for diff content');
            this.logDiagnostic('diff.content_failed', {pathname, version}, error);
            return Promise.reject(error);
        }

        return this.vfs.getFileDiff(pathname, Number(version), Number(version))
        .then(diff => {
            const text = diff?.diff[0]?.u;
            this.logDiagnostic('diff.content_resolved', {
                hasText: text!==undefined,
                pathname,
                version,
            });
            return Promise.resolve(text);
        });
    }

    get triggers() {
        return [
            vscode.workspace.registerTextDocumentContentProvider(`${ROOT_NAME}-diff`, this),
            new vscode.Disposable(() => clearInterval(this.refreshTimer)),
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.refresh`, async () => {
                await this.withProgress(
                    'history_refresh',
                    vscode.l10n.t('Refreshing project history'),
                    {path: this._path},
                    async () => {
                        await this.refreshData(this._path, true);
                    }
                );
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.loadMore`, async (provider: HistoryDataProvider) => {
                await provider.withProgress(
                    'history_load_more',
                    vscode.l10n.t('Loading older history'),
                    {before: provider._history?.before, path: provider._path},
                    async () => {
                        await provider.getHistory(provider._history?.before);
                        provider.refresh();
                    }
                );
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.createLabel`, async (item: HistoryItem) => {
                const label = await vscode.window.showInputBox({
                    prompt: vscode.l10n.t('Create a new label'),
                    placeHolder: vscode.l10n.t('Enter a label name'),
                });
                if (!label) {
                    this.logDiagnostic('action.cancelled', {
                        action: 'history_create_label',
                        version: item.version,
                    });
                    return;
                }

                const uri = vscode.workspace.workspaceFolders?.[0].uri;
                if (!uri) {
                    this.logDiagnostic('action.failed', {
                        action: 'history_create_label',
                        version: item.version,
                    }, new Error('No workspace folder available for label creation'));
                    return;
                }

                await this.withProgress(
                    'history_create_label',
                    vscode.l10n.t('Creating history label'),
                    {label, version: item.version},
                    async () => {
                        const res = await this.vfs.createLabel(label, item.version);
                        if (res) {
                            this._history?.labels[item.version].push(res);
                            this.refresh();
                            return;
                        }
                        throw new Error(vscode.l10n.t('Failed to create history label.'));
                    }
                );
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.deleteLabel`, async (item: HistoryItem) => {
                const label = await vscode.window.showQuickPick(
                    item.tags?.map(t=>t.comment) || [],
                    { placeHolder: vscode.l10n.t('Select a label to delete') }
                );
                if (!label) {
                    this.logDiagnostic('action.cancelled', {
                        action: 'history_delete_label',
                        version: item.version,
                    });
                    return;
                }

                const uri = vscode.workspace.workspaceFolders?.[0].uri;
                if (!uri) {
                    this.logDiagnostic('action.failed', {
                        action: 'history_delete_label',
                        version: item.version,
                    }, new Error('No workspace folder available for label deletion'));
                    return;
                }

                const version = item.version;
                const labelId = item.tags?.find(t=>t.comment===label)?.id;
                await this.withProgress(
                    'history_delete_label',
                    vscode.l10n.t('Deleting history label'),
                    {label, labelId, version},
                    async () => {
                        const res = labelId && await this.vfs.deleteLabel(labelId);
                        if (res) {
                            this._history?.labels[version].splice(
                                this._history?.labels[version].findIndex(t=>t.id===labelId), 1
                            );
                            this.refresh();
                            return;
                        }
                        throw new Error(vscode.l10n.t('Failed to delete history label.'));
                    }
                );
            }),
            vscode.commands.registerCommand('projectHistory.comparePrevious', async (item: HistoryItem) => {
                vscode.commands.executeCommand(`${ROOT_NAME}.projectHistory.comparePrevious`, item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.comparePrevious`, async (item: HistoryItem) => {
                this.openDiffEditor(item.prevVersion, item.version);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.compareCurrent`, async (item: HistoryItem) => {
                this.openDiffEditor(item.version, this._history?.currentVersion || NaN);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.compareOthers`, async (item: HistoryItem) => {
                const otherVersions = this._history?.keyVersions.filter(v=>v!==item.version);
                if (!otherVersions) { return; }

                vscode.window.showQuickPick(otherVersions.map(v => {
                    return {
                        label: `version ${v}`,
                        description: formatTime(this._history?.revisions[v].timestamp || 0),
                        version: v,
                    };
                }), {
                    placeHolder: vscode.l10n.t('Select a version to compare'),
                }).then(async (select) => {
                    if (!select) {
                        this.logDiagnostic('action.cancelled', {
                            action: 'history_compare_others',
                            version: item.version,
                        });
                        return;
                    }
                    this.openDiffEditor(item.version, select.version);
                });
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.downloadProject`, async (item:HistoryItem) => {
                const uri = vscode.workspace.workspaceFolders?.[0].uri;
                if (!uri) { return; }
                const version = item.version;
                const filename = `${this.vfs.projectName}-v${version}.zip`;

                const savePath = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(filename),
                    filters: { 'Zip Archive': ['zip'] },
                });
                if (!savePath) {
                    this.logDiagnostic('action.cancelled', {
                        action: 'history_download_project',
                        version,
                    });
                    return;
                }
                await this.withProgress(
                    'history_download_project',
                    vscode.l10n.t('Downloading project archive'),
                    {savePath: savePath.fsPath, version},
                    async () => {
                        const content = await this.vfs.downloadProjectArchive(version);
                        await vscode.workspace.fs.writeFile(savePath, content);
                        vscode.window.showInformationMessage( vscode.l10n.t('Project v{version} saved to {path}',  {version, path:savePath.fsPath}) );
                    }
                );
            }),
        ];
    }

    private async getHistory(before?:number): Promise<HistoryRecord> {
        const requestId = ++this.historyRequestSequence;
        this.logDiagnostic('history.fetch_started', {before, requestId});
        const uri = vscode.workspace.workspaceFolders?.[0].uri;
        if (!uri) {
            const error = new Error('No workspace folder available for history');
            this.logDiagnostic('history.fetch_failed', {before, requestId}, error);
            return Promise.reject(error);
        }

        if (this._history===undefined) { // first time load
            this._history = {
                before: undefined,
                keyVersions: [], revisions: {},
                labels: {}, diff: {},
            };
        } else if (before===undefined) { // don't have to load
            this.logDiagnostic('history.fetch_cached', {requestId});
            return Promise.resolve(this._history);
        }

        const updates = await this.vfs.getUpdates(before);
        this._history.before = updates?.nextBeforeTimestamp;
        
        // parse updates
        if (updates?.updates) {
            this._history.currentVersion = updates.updates[0].toV;
            // iterate all `toV`
            for (const update of updates.updates) {
                const version = update.toV;
                // update `keyVersions`, `revisions` and `labels`
                this._history.keyVersions.push(version);
                this._history.revisions[version] = {
                    fromV: update.fromV,
                    timestamp: update.meta.end_ts,
                    users: update.meta.users,
                };
                this._history.labels[version] = update.labels;
                // update path-related versions
                for (const path of update.pathnames) {
                    this._history.diff[path] ?
                    this._history.diff[path].push(version)
                    : this._history.diff[path] = [version];
                }
                // record updates
                for (const op of update.project_ops) {
                    if (op.add) {
                        this._history.diff[op.add.pathname] ?
                        this._history.diff[op.add.pathname].push(op.atV)
                        : this._history.diff[op.add.pathname] = [op.atV];
                    } else if (op.remove) {
                        this._history.diff[op.remove.pathname] ?
                        this._history.diff[op.remove.pathname].push(op.atV)
                        : this._history.diff[op.remove.pathname] = [op.atV];
                    }
                }
            }
        }

        this.logDiagnostic('history.fetch_completed', {
            before: this._history.before,
            keyVersionCount: this._history.keyVersions.length,
            requestId,
            updateCount: updates?.updates?.length ?? 0,
        });
        return Promise.resolve(this._history);
    }
}

export class HistoryViewProvider {
    private treeDataProvider: HistoryDataProvider;
    private historyView: vscode.TreeView<HistoryItem>;
    private pathParts?: string[];

    constructor(vfs: VirtualFileSystem) {
        const treeDataProvider = new HistoryDataProvider(vfs);
        this.historyView = vscode.window.createTreeView(`${ROOT_NAME}.projectHistory`, {treeDataProvider});
        this.treeDataProvider = treeDataProvider;
        this.updateView();
    }

    private updateDescription() {
        const pathLabel = this.pathParts?.at(-1);
        const contributorLabel = this.treeDataProvider.selectedContributorLabel;
        this.historyView.description = [pathLabel, contributorLabel ? `Author: ${contributorLabel}` : undefined]
            .filter(Boolean)
            .join(' • ');
    }

    updateView(pathParts?: string[]) {
        this.pathParts = pathParts;
        this.updateDescription();
        this.treeDataProvider.refreshData( pathParts?.join('/') );
    }

    get triggers() {
        return [
            // register tree view
            ...this.treeDataProvider.triggers,
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.clearSelection`, async() => {
                this.updateView(undefined);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.filterContributor`, async() => {
                this.treeDataProvider.logDiagnostic('filter.selection_requested');
                const contributors = await this.treeDataProvider.getContributorOptions();
                if (contributors.length===0) {
                    this.treeDataProvider.logDiagnostic('filter.selection_empty');
                    vscode.window.showInformationMessage(vscode.l10n.t('No contributor metadata is available for the current history range.'));
                    return;
                }
                const selection = await vscode.window.showQuickPick(
                    contributors.map(contributor => ({
                        label: contributor.label,
                        description: contributor.description,
                        detail: vscode.l10n.t('{count} versions', {count: contributor.versionCount}),
                        contributor,
                    })),
                    {
                        placeHolder: vscode.l10n.t('Filter history by contributor'),
                    },
                );
                if (!selection) {
                    this.treeDataProvider.logDiagnostic('filter.selection_cancelled');
                    return;
                }
                this.treeDataProvider.logDiagnostic('filter.selection_resolved', {
                    contributorKey: selection.contributor.key,
                    contributorLabel: selection.contributor.label,
                    versionCount: selection.contributor.versionCount,
                });
                this.treeDataProvider.applyContributorFilter(selection.contributor);
                this.updateDescription();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.clearContributorFilter`, async() => {
                this.treeDataProvider.logDiagnostic('filter.clear_requested');
                this.treeDataProvider.applyContributorFilter(undefined);
                this.updateDescription();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.revealHistoryView`, async() => {
                vscode.commands.executeCommand(`${ROOT_NAME}.projectHistory.focus`);
            }),
            // on vfs file open
            EventBus.on('fileWillOpenEvent', async ({uri}) => {
                setTimeout(() => {
                    // filter noise read events
                    const activeTextUri = vscode.window.activeTextEditor?.document.uri;
                    if (activeTextUri && activeTextUri.path!==uri.path) { return; }
                    if (!activeTextUri && vscode.workspace.textDocuments.map(d=>d.uri.path).includes(uri.path)) { return; }

                    // filter output folder
                    const {pathParts} = parseUri(uri);
                    if (pathParts[0]===OUTPUT_FOLDER_NAME) { return; }

                    this.updateView( pathParts );
                }, 100);
            }),
            //FIXME: on "file://" uri open
        ];
    }
}
