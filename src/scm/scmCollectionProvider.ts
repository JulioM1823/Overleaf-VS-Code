import * as vscode from 'vscode';
import * as path from 'path';
import { VirtualFileSystem } from '../core/remoteFileSystemProvider';

import { BaseSCM, CommitItem, SettingItem } from ".";
import { LocalReplicaSCMProvider } from './localReplicaSCM';
import { LocalGitBridgeSCMProvider } from './localGitBridgeSCM'; 
import { HistoryViewProvider } from './historyViewProvider';
import { GlobalStateManager } from '../utils/globalStateManager';
import { EventBus } from '../utils/eventBus';
import { ROOT_NAME } from '../consts';
import { logDiagnostic } from '../utils/diagnostics';

const supportedSCMs = [
    LocalReplicaSCMProvider,
    // LocalGitBridgeSCMProvider,
];
type SupportedSCM = typeof supportedSCMs[number];

// Older releases persisted local file-system SCM roots as bare paths instead of
// URI strings. Recover them as file: URIs so background SCM restoration does
// not misclassify valid local replicas as creation failures.
function revivePersistedSCMBaseUri(rawBaseUri: string) {
    const parsed = vscode.Uri.parse(rawBaseUri);
    if (parsed.scheme) {
        return parsed;
    }
    if (path.isAbsolute(rawBaseUri) || /^[a-zA-Z]:[\\/]/.test(rawBaseUri)) {
        return vscode.Uri.file(rawBaseUri);
    }
    return parsed;
}

async function shouldSkipMissingLocalReplicaRestore(baseUri: vscode.Uri, scmLabel: string) {
    if (scmLabel!==LocalReplicaSCMProvider.label || baseUri.scheme!=='file') {
        return false;
    }
    try {
        // Auto-restoring a deleted local replica would recreate the folder and
        // resume mirroring unexpectedly. Missing local replicas should stay
        // detached until the user explicitly links a folder again.
        const stat = await vscode.workspace.fs.stat(baseUri);
        return stat.type!==vscode.FileType.Directory;
    } catch (error) {
        const maybeError = error as Error & {code?: string};
        const code = maybeError?.code;
        const name = maybeError?.name ?? '';
        if (code==='ENOENT' || code==='FileNotFound' || name.includes('FileNotFound') || name.includes('EntryNotFound')) {
            return true;
        }
        throw error;
    }
}

class CoreSCMProvider extends BaseSCM {
    constructor(protected readonly vfs: VirtualFileSystem) {
        super(vfs, vfs.origin);
    }

    validateBaseUri() { return Promise.resolve(true); }
    async syncFromSCM() {}
    async apply(commitItem: CommitItem) {};
    get triggers() { return Promise.resolve([]); }
    get settingItems() { return[]; }

    writeFile(path: string, content: Uint8Array): Thenable<void> {
        const uri = this.vfs.pathToUri(path);
        return vscode.workspace.fs.writeFile(uri, content);
    }

    readFile(path: string): Thenable<Uint8Array> {
        const uri = this.vfs.pathToUri(path);
        return vscode.workspace.fs.readFile(uri);
    }

    list(): Iterable<CommitItem> {
        return [];
    }
}

interface SCMRecord {
    scm: BaseSCM;
    enabled: boolean;
    triggers: vscode.Disposable[];
}

type DiagnosticsAwareSCM = BaseSCM & {
    getDiagnosticsState?: () => Record<string, unknown>,
};

export class SCMCollectionProvider extends vscode.Disposable {
    private readonly core: CoreSCMProvider;
    private readonly scms: SCMRecord[] = [];
    private readonly statusBarItem: vscode.StatusBarItem;
    private readonly statusListener: vscode.Disposable;
    private historyDataProvider: HistoryViewProvider;

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly context: vscode.ExtensionContext,
    ) {
        // define the dispose behavior
        super(() => {
            this.scms.forEach(scm => scm.triggers.forEach(t => t.dispose()));
        });

        this.core = new CoreSCMProvider( vfs );
        this.historyDataProvider = new HistoryViewProvider( vfs );
        this.initSCMs();

        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.statusBarItem.command = `${ROOT_NAME}.projectSCM.configSCM`;
        this.statusListener = EventBus.on('scmStatusChangeEvent', () => {this.updateStatus();});
    }

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('SCMCollection', event, {
            projectId: this.vfs.projectId,
            projectName: this.vfs.projectName,
            scmCount: this.scms.length,
            serverName: this.vfs.serverName,
            ...fields,
        }, error);
    }

    private updateStatus() {
        if (!this.statusBarItem) { return; }

        let numPush = 0, numPull = 0;
        let tooltip = new vscode.MarkdownString(`**${vscode.l10n.t('Project Source Control')}**\n\n`);
        tooltip.supportHtml = true;
        tooltip.supportThemeIcons = true;

        // update status bar item tooltip
        if (this.scms.length===0) {
            tooltip.appendMarkdown(`*${vscode.l10n.t('Click to configure.')}*\n\n`);
        } else {
            for (const {scm,enabled} of this.scms) {
                const icon = scm.iconPath.id;
                const label = (scm.constructor as any).label;
                const uri = scm.baseUri.toString();
                const slideUri = uri.length<=30? uri : uri.replace(/^(.{15}).*(.{15})$/, '$1...$2');
                tooltip.appendMarkdown(`----\n\n$(${icon}) **${label}**: [${slideUri}](${uri})\n\n`);
                //
                if (!enabled) {
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;*${vscode.l10n.t('Disabled')}.*\n\n`);
                } else if (scm.status.status==='idle') {
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;*${vscode.l10n.t('Synced')}.*\n\n`);
                } else {
                    // show status message
                    tooltip.appendMarkdown(`&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;***${scm.status.message}***\n\n`);
                    // update counters
                    switch (scm.status.status) {
                        case 'push': numPush++; break;
                        case 'pull': numPull++; break;
                    }
                }
            }   
        }
        this.statusBarItem.tooltip = tooltip;

        // update status bar item text
        if (numPush!==0) {
            this.statusBarItem.text = `$(cloud-upload)`;
        } else if (numPull!==0) {
            this.statusBarItem.text = `$(cloud-download)`;
        } else {
            this.statusBarItem.text = `$(cloud)`;
        }

        this.statusBarItem.show();
    }

    getDiagnosticsState() {
        return {
            enabledScmCount: this.scms.filter((item) => item.enabled).length,
            scmCount: this.scms.length,
            scms: this.scms.map(({enabled, scm, triggers}) => ({
                baseUri: scm.baseUri.toString(),
                diagnosticsState: (scm as DiagnosticsAwareSCM).getDiagnosticsState?.(),
                enabled,
                label: (scm.constructor as typeof BaseSCM & {label?: string}).label ?? scm.constructor.name,
                status: scm.status.status,
                statusMessage: scm.status.message ?? '',
                triggerCount: triggers.length,
            })),
            statusBarText: this.statusBarItem.text,
        };
    }

    private initSCMs() {
        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, this.vfs.serverName, this.vfs.projectId);
        this.logDiagnostic('scm.init_from_persist_started', {
            persistCount: Object.keys(scmPersists).length,
        });
        Object.entries(scmPersists).forEach(async ([scmKey, scmPersist]) => {
            const scmProto = supportedSCMs.find(scm => scm.label===scmPersist.label);
            if (scmProto!==undefined) {
                const enabled = scmPersist.enabled ?? true;
                const baseUri = revivePersistedSCMBaseUri(scmPersist.baseUri);
                if (await shouldSkipMissingLocalReplicaRestore(baseUri, scmPersist.label)) {
                    this.logDiagnostic('scm.restore_skipped_missing_local_replica', {
                        baseUri: baseUri.toString(),
                        scmKey,
                        scmLabel: scmPersist.label,
                    });
                    this.vfs.setProjectSCMPersist(scmKey, {
                        ...scmPersist,
                        enabled: false,
                    });
                    return;
                }
                await this.createSCM(scmProto, baseUri, false, enabled);
            }
        });
    }

    private async createSCM(scmProto: SupportedSCM, baseUri: vscode.Uri, newSCM=false, enabled=true) {
        this.logDiagnostic('scm.create_started', {
            baseUri: baseUri.toString(),
            enabled,
            newSCM,
            scmLabel: scmProto.label,
        });
        const scm = new scmProto(this.vfs, baseUri);
        // insert into collection
        try {
            const triggers = enabled ? await scm.triggers : [];
            if (newSCM) {
                this.vfs.setProjectSCMPersist(scm.scmKey, {
                    enabled: enabled,
                    label: scmProto.label,
                    baseUri: scm.baseUri.toString(),
                    settings: {} as JSON,
                });
            }
            this.scms.push({scm,enabled,triggers});
            this.updateStatus();
            this.logDiagnostic('scm.create_completed', {
                baseUri: baseUri.toString(),
                enabled,
                newSCM,
                scmLabel: scmProto.label,
                triggerCount: triggers.length,
            });
            return scm;
        } catch (error) {
            // permanently remove failed scm
            // this.vfs.setProjectSCMPersist(scm.scmKey, undefined);
            this.logDiagnostic('scm.create_failed', {
                baseUri: baseUri.toString(),
                enabled,
                newSCM,
                scmLabel: scmProto.label,
            }, error);
            // Persisted SCMs are restored automatically during project init and
            // recovery. If that background restore fails while the user is
            // simply live-editing, keep the failure in diagnostics and avoid a
            // noisy popup. Explicit user-created SCMs should still report the
            // failure immediately.
            if (newSCM) {
                vscode.window.showErrorMessage( vscode.l10n.t('"{scm}" creation failed.', {scm:scmProto.label}) );
            } else {
                this.logDiagnostic('scm.create_failed_notification_suppressed', {
                    baseUri: baseUri.toString(),
                    scmLabel: scmProto.label,
                });
            }
            return undefined;
        }
    }

    private removeSCM(item: SCMRecord) {
        const index = this.scms.indexOf(item);
        if (index!==-1) {
            this.logDiagnostic('scm.remove_started', {
                baseUri: item.scm.baseUri.toString(),
                scmLabel: (item.scm.constructor as any).label,
            });
            // remove from collection
            item.triggers.forEach(trigger => trigger.dispose());
            this.scms.splice(index, 1);
            // remove from global state
            this.vfs.setProjectSCMPersist(item.scm.scmKey, undefined);
            this.updateStatus();
            this.logDiagnostic('scm.remove_completed', {
                baseUri: item.scm.baseUri.toString(),
                scmLabel: (item.scm.constructor as any).label,
            });
        }
    }

    private createNewSCM(scmProto: SupportedSCM) {
        return new Promise(resolve => {
            const inputBox = scmProto.baseUriInputBox;
            inputBox.ignoreFocusOut = true;
            inputBox.title = vscode.l10n.t('Create Source Control: {scm}', {scm:scmProto.label});
            inputBox.buttons = [{iconPath: new vscode.ThemeIcon('check')}];
            inputBox.show();
            //
            inputBox.onDidTriggerButton(() => {
                inputBox.hide();
                resolve(inputBox.value);
            });
            inputBox.onDidAccept(() => {
                if (inputBox.activeItems.length===0) {
                    inputBox.hide();
                    resolve(inputBox.value);
                }
            });
        })
        .then((uri) => scmProto.validateBaseUri(uri as string || '', this.vfs.projectName))
        .then(async (baseUri) => {
            if (baseUri) {
                const scm = await this.createSCM(scmProto, baseUri, true);
                if (scm) {
                    vscode.window.showInformationMessage( vscode.l10n.t('"{scm}" created: {uri}.', {scm:scmProto.label, uri: decodeURI(scm.baseUri.toString()) }) );
                }
            } else {
                this.logDiagnostic('scm.create_cancelled', {
                    scmLabel: scmProto.label,
                });
            }
        });
    }

    private configSCM(scmItem: SCMRecord) {
        const baseUri = scmItem.scm.baseUri.toString();
        const settingItems = scmItem.scm.settingItems as SettingItem[];
        const status = scmItem.enabled? scmItem.scm.status.status : 'disabled';
        const quickPickItems = [
            {label:scmItem.enabled?'Disable':'Enable', description:`Status: ${status}`},
            {label:'Remove', description:`${baseUri}`},
            {label:'', kind:vscode.QuickPickItemKind.Separator},
            ...settingItems,
        ];

        return vscode.window.showQuickPick(quickPickItems, {
            ignoreFocusOut: true,
            title: vscode.l10n.t('Project Source Control Management'),
        }).then(async (select) => {
            if (select===undefined) { return; }
            switch (select.label) {
                case 'Enable':
                case 'Disable':
                    {
                        const persist = this.vfs.getProjectSCMPersist(scmItem.scm.scmKey);
                        const nextEnabled = !(persist.enabled ?? true);
                        this.logDiagnostic('scm.toggle_started', {
                            baseUri,
                            nextEnabled,
                            scmLabel: (scmItem.scm.constructor as any).label,
                        });
                        try {
                            persist.enabled = nextEnabled;
                            this.vfs.setProjectSCMPersist(scmItem.scm.scmKey, persist);
                            //
                            const scmIndex = this.scms.indexOf(scmItem);
                            this.scms[scmIndex].enabled = persist.enabled;
                            if (persist.enabled) {
                                scmItem.triggers = await scmItem.scm.triggers;
                            } else {
                                scmItem.triggers.forEach(trigger => trigger.dispose());
                                scmItem.triggers = [];
                            }
                            this.updateStatus();
                            this.logDiagnostic('scm.toggle_completed', {
                                baseUri,
                                nextEnabled,
                                scmLabel: (scmItem.scm.constructor as any).label,
                                triggerCount: scmItem.triggers.length,
                            });
                            vscode.window.showWarningMessage(`"${(scmItem.scm.constructor as any).label}" ${persist.enabled?'enabled':'disabled'}: ${baseUri}.`);
                        } catch (error) {
                            persist.enabled = !nextEnabled;
                            this.vfs.setProjectSCMPersist(scmItem.scm.scmKey, persist);
                            const scmIndex = this.scms.indexOf(scmItem);
                            this.scms[scmIndex].enabled = persist.enabled ?? true;
                            this.logDiagnostic('scm.toggle_failed', {
                                baseUri,
                                nextEnabled,
                                scmLabel: (scmItem.scm.constructor as any).label,
                            }, error);
                            vscode.window.showErrorMessage( vscode.l10n.t('"{scm}" update failed.', {scm:(scmItem.scm.constructor as any).label}) );
                        }
                    }
                    break;
                case 'Remove':
                    vscode.window.showWarningMessage(`${vscode.l10n.t('Remove')} ${baseUri}?`, 'Yes', 'No')
                    .then((select) => {
                        if (select==='Yes') {
                            this.removeSCM(scmItem);
                        } else if (select==='No') {
                            this.logDiagnostic('scm.remove_cancelled', {
                                baseUri,
                                scmLabel: (scmItem.scm.constructor as any).label,
                            });
                        }
                    });
                    break;
                default:
                    const settingItem = settingItems.find(item => item.label===select.label);
                    this.logDiagnostic('scm.setting_selected', {
                        baseUri,
                        scmLabel: (scmItem.scm.constructor as any).label,
                        settingLabel: select.label,
                    });
                    settingItem?.callback();
                    break;
            }
        });
    }

    showSCMConfiguration() {
        // group 1: show existing scms
        const scmItems: vscode.QuickPickItem[] = this.scms.map((item) => {
            const { scm } = item;
            return {
                label: (scm.constructor as any).label,
                iconPath: scm.iconPath,
                description: scm.baseUri.toString(),
                item,
            };
        });
        if (scmItems.length!==0) {
            scmItems.push({kind:vscode.QuickPickItemKind.Separator, label:''});
        }
        // group 2: create new scm
        const createItems: vscode.QuickPickItem[] = supportedSCMs.map((scmProto) => {
            return {
                label: vscode.l10n.t('Create Source Control: {scm}', {scm:scmProto.label}),
                scmProto,
            };
        });

        // show quick pick
        vscode.window.showQuickPick([...scmItems, ...createItems], {
            ignoreFocusOut: true,
            title: vscode.l10n.t('Project Source Control Management'),
        }).then((select) => {
            if (select) {
                const _select = select as any;
                // configure existing scm
                if (_select.item) {
                    this.configSCM( _select.item as SCMRecord );
                }
                // create new scm
                if ( _select.scmProto ) {
                    this.createNewSCM(_select.scmProto as SupportedSCM );
                }
            } else {
                this.logDiagnostic('scm.quick_pick_cancelled');
            }
        });
    }

    get triggers() {
        return [
            // Register: HistoryViewProvider
            ...this.historyDataProvider.triggers,
            // register status bar item
            this.statusBarItem,
            this.statusListener,
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectSCM.configSCM`, () => {
                return this.showSCMConfiguration();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectSCM.newSCM`, (scmProto) => {
                return this.createNewSCM(scmProto);
            }),
            this as vscode.Disposable,
        ];
    }
    
}
