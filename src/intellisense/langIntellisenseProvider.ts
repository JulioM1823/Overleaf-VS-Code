import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { RemoteFileSystemProvider } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';

import { IntellisenseProvider } from '.';
import { TexDocumentSymbolProvider } from './texDocumentSymbolProvider';
import { TexDocumentFormatProvider } from './texDocumentFormatProvider';
import { MisspellingCheckProvider } from './langMisspellingCheckProvider';
import { CommandCompletionProvider, ConstantCompletionProvider, FilePathCompletionProvider, ReferenceCompletionProvider } from './langCompletionProvider';
import { ProjectSearchProvider } from './projectSearchProvider';

export class LangIntellisenseProvider {
    private static readonly STATUS_REFRESH_DEBOUNCE_MS = 50;
    private status: vscode.StatusBarItem;
    private statusRefreshTimer?: NodeJS.Timeout;
    private providers: IntellisenseProvider[];
    private readonly projectSearchProvider: ProjectSearchProvider;

    constructor(context: vscode.ExtensionContext, private readonly vfsm: RemoteFileSystemProvider) {
        const texSymbolProvider = new TexDocumentSymbolProvider(vfsm);
        this.providers = [
            // document symbol provider
            texSymbolProvider,
            // document format provider
            new TexDocumentFormatProvider(vfsm),
            // completion provider
            new CommandCompletionProvider(vfsm, context.extensionUri),
            new ConstantCompletionProvider(vfsm, context.extensionUri),
            new FilePathCompletionProvider(vfsm),
            new ReferenceCompletionProvider(vfsm, texSymbolProvider),
            // misspelling check provider
            new MisspellingCheckProvider(vfsm),
        ];
        this.projectSearchProvider = new ProjectSearchProvider(vfsm);
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
        // Enable CSpell
        const config = vscode.workspace.getConfiguration("cSpell");
        const enabledSchemes = config.get<Record<string, boolean>>("enabledSchemes") || {}; 
        enabledSchemes[ROOT_NAME] = true; 
        config.update("enabledSchemes", enabledSchemes, vscode.ConfigurationTarget.Global);
        
        this.scheduleStatusRefresh('constructor_initialized');
    }

    private scheduleStatusRefresh(reason: string) {
        if (this.statusRefreshTimer) {
            clearTimeout(this.statusRefreshTimer);
        }
        this.statusRefreshTimer = setTimeout(() => {
            this.statusRefreshTimer = undefined;
            void this.refreshStatus(reason);
        }, LangIntellisenseProvider.STATUS_REFRESH_DEBOUNCE_MS);
    }

    private async refreshStatus(_reason: string) {
        const uri = vscode.workspace.workspaceFolders?.[0].uri;
        if (uri?.scheme!==ROOT_NAME) {
            this.status.hide();
            return;
        }

        const vfs = uri && await this.vfsm.prefetch(uri);
        const languageItem = vfs?.getSpellCheckLanguage();
        if (languageItem) {
            const {name, code} = languageItem;
            this.status.text = code===''? '$(eye-closed)' : '$(eye) ' + code.toLocaleUpperCase();
            this.status.tooltip = new vscode.MarkdownString(`${vscode.l10n.t('Spell Check')}: **${name}**`);
            this.status.tooltip.appendMarkdown(`\n\n*${vscode.l10n.t('Click to manage spell check.')}*`);
            this.status.command = 'langIntellisense.settings';
            this.status.show();
        } else {
            this.status.hide();
        }
    }

    get triggers() {
        return [
            this.status,
            new vscode.Disposable(() => {
                if (this.statusRefreshTimer) {
                    clearTimeout(this.statusRefreshTimer);
                }
            }),
            // register provider triggers
            ...this.providers.map(x => x.triggers).flat(),
            ...this.projectSearchProvider.triggers,
            EventBus.on('spellCheckLanguageUpdateEvent', () => {
                this.scheduleStatusRefresh('spellcheck_language_updated');
            }),
            EventBus.on('offlineSynchronizationStateChangedEvent', ({origin}) => {
                const workspaceOrigin = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
                if (workspaceOrigin!==origin) {
                    return;
                }
                this.scheduleStatusRefresh('offline_sync_state_changed');
            }),
            EventBus.on('realtimeConnectionStateChangedEvent', ({origin}) => {
                const workspaceOrigin = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
                if (workspaceOrigin!==origin) {
                    return;
                }
                this.scheduleStatusRefresh('realtime_connection_state_changed');
            }),
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.scheduleStatusRefresh('active_editor_changed');
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.scheduleStatusRefresh('workspace_folders_changed');
            }),
        ];
    }
}
