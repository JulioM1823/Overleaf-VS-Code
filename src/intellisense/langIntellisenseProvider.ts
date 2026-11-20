import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { RemoteFileSystemProvider } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';
import { logDiagnostic } from '../utils/diagnostics';
import { toOverleafProjectIdentityKey } from '../core/projectWorkspaceBindingHelpers';

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
    private statusRefreshRevision = 0;
    private disposed = false;
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
        void this.enableOptionalCSpellIntegration();
        
        this.scheduleStatusRefresh('constructor_initialized');
    }

    private async enableOptionalCSpellIntegration() {
        try {
            const config = vscode.workspace.getConfiguration('cSpell');
            // CSpell is optional. Writing an unregistered setting fails in a
            // fresh profile, and policy or filesystem permissions can also
            // prevent updates even when the setting is registered.
            if (!config.has('enabledSchemes')) { return; }
            const enabledSchemes = config.get<unknown>('enabledSchemes');
            let updatedSchemes: string[] | Record<string, unknown>;
            if (Array.isArray(enabledSchemes) && enabledSchemes.every(item => typeof item==='string')) {
                if (enabledSchemes.includes(ROOT_NAME)) { return; }
                updatedSchemes = [...enabledSchemes, ROOT_NAME];
            } else if (enabledSchemes && typeof enabledSchemes==='object' && !Array.isArray(enabledSchemes)) {
                if ((enabledSchemes as Record<string, unknown>)[ROOT_NAME]===true) { return; }
                updatedSchemes = {...enabledSchemes, [ROOT_NAME]:true};
            } else { return; }
            await config.update('enabledSchemes', updatedSchemes, vscode.ConfigurationTarget.Global);
        } catch (error) {
            logDiagnostic('Intellisense', 'cspell.configuration_update_failed', {}, error);
        }
    }

    private scheduleStatusRefresh(reason: string) {
        if (this.disposed) { return; }
        const revision = ++this.statusRefreshRevision;
        if (this.statusRefreshTimer) {
            clearTimeout(this.statusRefreshTimer);
        }
        this.statusRefreshTimer = setTimeout(() => {
            this.statusRefreshTimer = undefined;
            void this.refreshStatus(reason, revision).catch(error => {
                if (!this.disposed && revision===this.statusRefreshRevision) { this.status.hide(); }
                logDiagnostic('Intellisense', 'status.refresh_failed', {reason}, error);
            });
        }, LangIntellisenseProvider.STATUS_REFRESH_DEBOUNCE_MS);
    }

    private getStatusProjectUri() {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        return activeUri?.scheme===ROOT_NAME
            ? activeUri
            : vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme===ROOT_NAME)?.uri;
    }

    private matchesStatusProjectOrigin(origin: string) {
        const uri = this.getStatusProjectUri();
        if (!uri) { return false; }
        try {
            return toOverleafProjectIdentityKey(uri)===toOverleafProjectIdentityKey(vscode.Uri.parse(origin));
        } catch { return false; }
    }

    private async refreshStatus(_reason: string, revision = ++this.statusRefreshRevision) {
        if (this.disposed) { return; }
        const uri = this.getStatusProjectUri();
        if (uri?.scheme!==ROOT_NAME) {
            this.status.hide();
            return;
        }

        const vfs = uri && await this.vfsm.prefetch(uri);
        if (this.disposed || revision!==this.statusRefreshRevision) { return; }
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
                this.disposed = true;
                this.statusRefreshRevision++;
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
                if (!this.matchesStatusProjectOrigin(origin)) {
                    return;
                }
                this.scheduleStatusRefresh('offline_sync_state_changed');
            }),
            EventBus.on('realtimeConnectionStateChangedEvent', ({origin}) => {
                if (!this.matchesStatusProjectOrigin(origin)) {
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
