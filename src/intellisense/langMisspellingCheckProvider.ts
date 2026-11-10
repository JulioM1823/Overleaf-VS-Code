import * as vscode from 'vscode';
import { IntellisenseProvider } from '.';
import { ROOT_NAME } from '../consts';
import { parseUri, VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';
import { logDiagnostic } from '../utils/diagnostics';

interface Verdict {suggestions: string[], misspelled: boolean}
interface SpellContext {
    vfs: VirtualFileSystem,
    learned: Set<string>,
    verdicts: Map<string, Verdict>,
    pending: Map<string, Promise<Map<string, Verdict>>>,
}
interface PendingScan {
    document: vscode.TextDocument,
    start: number,
    end: number,
    timer?: NodeJS.Timeout,
}

export class MisspellingCheckProvider extends IntellisenseProvider implements vscode.CodeActionProvider {
    private contexts = new Map<string, SpellContext>();
    private documentContexts = new Map<string, string>();
    private documentSuggestions = new Map<string, Map<string, string[]>>();
    private scans = new Map<string, PendingScan>();
    private running = new Set<string>();
    private generation = 0;
    private disposed = false;
    private diagnosticCollection = vscode.languages.createDiagnosticCollection(ROOT_NAME);
    protected readonly contextPrefix = [];

    private splitText(text: string) {
        return text.split(/([\P{L}\p{N}]*\\[a-zA-Z]*|[\P{L}\p{N}]+)/gu);
    }

    private contextKey(uri: vscode.Uri, language: string) {
        const {serverName, userId, projectId} = parseUri(uri);
        return JSON.stringify([serverName, userId, projectId, language]);
    }

    private async getContext(uri: vscode.Uri) {
        const vfs = await this.vfsm.prefetch(uri);
        const language = vfs.getSpellCheckLanguage()?.code ?? 'server-default';
        const key = this.contextKey(uri, language);
        let context = this.contexts.get(key);
        if (!context || context.vfs!==vfs) {
            context = {vfs, learned:new Set(vfs.getDictionary()||[]), verdicts:new Map(), pending:new Map()};
            if (!this.disposed) { this.contexts.set(key, context); }
        }
        return {key, context, language};
    }

    private async check(uri: vscode.Uri, text: string, context: SpellContext): Promise<Map<string, Verdict>> {
        const words = [...new Set(this.splitText(text).filter((word, index) => index%2===0 && word.length>1))];
        const results = new Map<string, Verdict>();
        const needed: string[] = [];
        const waiting = new Set<Promise<Map<string, Verdict>>>();
        for (const word of words) {
            if (context.learned.has(word)) { continue; }
            const cached = context.verdicts.get(word);
            if (cached!==undefined) {
                results.set(word, cached);
                context.verdicts.delete(word);
                context.verdicts.set(word, cached);
            } else if (context.pending.has(word)) {
                waiting.add(context.pending.get(word)!);
            } else { needed.push(word); }
        }
        // Bound request sizes and share in-flight word checks across documents.
        // Only confirmed responses enter the cache, including correct words.
        for (let offset=0; offset<needed.length; offset+=250) {
            const batch = needed.slice(offset, offset+250);
            const request = Promise.resolve().then(async () => {
                const response = await context.vfs.spellCheck(uri, batch);
                const verdicts = new Map<string, Verdict>();
                if (!Array.isArray(response) || response.some(item =>
                    !Number.isInteger(item.index) || item.index<0 || item.index>=batch.length
                    || !Array.isArray(item.suggestions) || item.suggestions.some(value => typeof value!=='string')
                )) { return verdicts; }
                batch.forEach(word => verdicts.set(word, {suggestions:[], misspelled:false}));
                response.forEach(item => verdicts.set(batch[item.index], {suggestions:item.suggestions, misspelled:true}));
                for (const [word, verdict] of verdicts) {
                    context.verdicts.set(word, verdict);
                    while (context.verdicts.size>1000) { context.verdicts.delete(context.verdicts.keys().next().value!); }
                }
                return verdicts;
            }).catch(error => {
                logDiagnostic('SpellChecker', 'check.failed', {}, error);
                return new Map<string, Verdict>();
            }).finally(() => batch.forEach(word => context.pending.delete(word)));
            batch.forEach(word => context.pending.set(word, request));
            waiting.add(request);
            // Large files must not start hundreds of simultaneous HTTP requests.
            for (const [word, verdict] of await request) { results.set(word, verdict); }
        }
        for (const request of waiting) {
            for (const [word, verdict] of await request) { results.set(word, verdict); }
        }
        return results;
    }

    private schedule(document: vscode.TextDocument, start=0, end=document.lineCount-1) {
        if (this.disposed || document.isClosed || document.uri.scheme!==ROOT_NAME) { return; }
        const key = document.uri.toString();
        const previous = this.scans.get(key);
        clearTimeout(previous?.timer);
        const scan: PendingScan = {document, start:Math.max(0, Math.min(previous?.start??start, start)),
            end:Math.max(previous?.end??end, end)};
        this.scans.set(key, scan);
        scan.timer = setTimeout(() => void this.runScan(key), 150);
    }

    private async runScan(key: string) {
        if (this.running.has(key)) { return; }
        const scan = this.scans.get(key);
        if (!scan || this.disposed) { return; }
        this.scans.delete(key);
        this.running.add(key);
        const {document} = scan;
        const version = document.version;
        const generation = this.generation;
        try {
            const {key:contextKey, context, language} = await this.getContext(document.uri);
            if (this.disposed || document.isClosed || generation!==this.generation) { return; }
            this.documentContexts.set(key, contextKey);
            if (!language) {
                this.diagnosticCollection.delete(document.uri);
                this.documentSuggestions.delete(key);
                return;
            }
            const start = Math.min(scan.start, document.lineCount-1);
            const end = Math.min(scan.end, document.lineCount-1);
            const lines: string[] = [];
            for (let line=start; line<=end; line++) { lines.push(document.lineAt(line).text); }
            const verdicts = await this.check(document.uri, lines.join(' '), context);
            if (this.disposed || document.isClosed || generation!==this.generation
                || this.contexts.get(contextKey)!==context) { return; }
            if (document.version!==version) {
                // Cover the stale range as well as any shifted lines on the next pass.
                this.schedule(document);
                return;
            }
            const affected = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
            const diagnostics = (this.diagnosticCollection.get(document.uri)||[])
                .filter(item => !item.range.intersection(affected));
            const suggestions = new Map(this.documentSuggestions.get(key));
            lines.forEach((line, index) => {
                let offset = 0;
                this.splitText(line).forEach((word, part) => {
                    if (part%2===0 && verdicts.get(word)?.misspelled && !context.learned.has(word)) {
                        const range = new vscode.Range(start+index, offset, start+index, offset+word.length);
                        const diagnostic = new vscode.Diagnostic(range, vscode.l10n.t('{word}: Unknown word.', {word}), vscode.DiagnosticSeverity.Information);
                        diagnostic.source = vscode.l10n.t('Spell Checker');
                        diagnostic.code = word;
                        diagnostics.push(diagnostic);
                        suggestions.set(word, verdicts.get(word)!.suggestions);
                    }
                    offset += word.length;
                });
            });
            const diagnosedWords = new Set(diagnostics.map(item => item.code));
            for (const word of suggestions.keys()) { if (!diagnosedWords.has(word)) { suggestions.delete(word); } }
            this.documentSuggestions.set(key, suggestions);
            this.diagnosticCollection.set(document.uri, diagnostics);
        } catch (error) { logDiagnostic('SpellChecker', 'diagnostics.failed', {}, error); }
        finally {
            this.running.delete(key);
            const pending = this.scans.get(key);
            if (pending && !this.disposed) {
                clearTimeout(pending.timer);
                pending.timer = setTimeout(() => void this.runScan(key), 150);
            }
        }
    }

    private resetDiagnosticCollection() {
        this.generation++;
        this.contexts.clear();
        this.documentContexts.clear();
        this.documentSuggestions.clear();
        this.diagnosticCollection.clear();
        vscode.workspace.textDocuments.forEach(document => this.schedule(document));
    }

    provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
        const diagnostic = context.diagnostics.find(item => item.source===vscode.l10n.t('Spell Checker') && typeof item.code==='string');
        if (!diagnostic) { return []; }
        const word = diagnostic.code as string;
        const key = this.documentContexts.get(document.uri.toString());
        const spelling = key ? this.contexts.get(key) : undefined;
        const verdict = spelling && key===this.contextKey(document.uri, spelling.vfs.getSpellCheckLanguage()?.code ?? 'server-default')
            ? spelling.verdicts.get(word) : undefined;
        const suggestions = spelling && key===this.contextKey(document.uri, spelling.vfs.getSpellCheckLanguage()?.code ?? 'server-default')
            ? this.documentSuggestions.get(document.uri.toString())?.get(word) ?? verdict?.suggestions : undefined;
        const actions = (suggestions||[]).slice(0,8).map(suggestion => {
            const action = new vscode.CodeAction(suggestion, vscode.CodeActionKind.QuickFix);
            action.diagnostics = [diagnostic];
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(document.uri, diagnostic.range, suggestion);
            return action;
        });
        const learnAction = new vscode.CodeAction(vscode.l10n.t('Add to Dictionary'), vscode.CodeActionKind.QuickFix);
        learnAction.diagnostics = [diagnostic];
        learnAction.command = {title:vscode.l10n.t('Add to Dictionary'), command:'langIntellisense.learnSpelling', arguments:[document.uri, word]};
        actions.push(learnAction);
        return actions;
    }

    async learnSpelling(uri: vscode.Uri, word: string) {
        if (uri.scheme!==ROOT_NAME || typeof word!=='string' || !word) { return; }
        const vfs = await this.vfsm.prefetch(uri);
        if (!await vfs.spellLearn(word)) { throw new Error('Dictionary update was not confirmed'); }
        this.resetDiagnosticCollection();
    }

    async dictionarySettings(vfs: VirtualFileSystem, dictionary: string[]=vfs.getDictionary()||[]) {
        let changed = false;
        try {
            while (!this.disposed) {
                const word = await vscode.window.showQuickPick(dictionary, {canPickMany:false, placeHolder:vscode.l10n.t('Select a word to unlearn')});
                if (!word) { break; }
                if (!await vfs.spellUnlearn(word)) { throw new Error('Dictionary update was not confirmed'); }
                changed = true;
                dictionary = dictionary.filter(item => item!==word);
            }
        } finally { if (changed) { this.resetDiagnosticCollection(); } }
    }

    async spellCheckSettings() {
        const uri = vscode.workspace.workspaceFolders?.[0].uri;
        const vfs = uri && await this.vfsm.prefetch(uri);
        if (!vfs) { return; }
        const currentLanguage = vfs.getSpellCheckLanguage();
        const items: (vscode.QuickPickItem & {id?:string})[] = [
            {id:'dictionary', label:vscode.l10n.t('Manage Dictionary'), iconPath:new vscode.ThemeIcon('book')},
            {label:'', kind:vscode.QuickPickItemKind.Separator},
            ...(vfs.getAllSpellCheckLanguages()||[]).map(item => ({label:item.name, description:item.code, picked:item.code===currentLanguage?.code})),
        ];
        const option = await vscode.window.showQuickPick(items, {placeHolder:vscode.l10n.t('Select spell check language'),
            canPickMany:false, ignoreFocusOut:true, matchOnDescription:true, matchOnDetail:true});
        if (option?.id==='dictionary') { await this.dictionarySettings(vfs); }
        else if (option) { await vfs.updateSettings({spellCheckLanguage:option.description}); }
    }

    get triggers() {
        return [
            this.diagnosticCollection,
            new vscode.Disposable(() => {
                this.disposed = true;
                this.generation++;
                this.scans.forEach(scan => clearTimeout(scan.timer));
                this.scans.clear();
                this.contexts.clear();
                this.documentContexts.clear();
                this.documentSuggestions.clear();
            }),
            vscode.languages.registerCodeActionsProvider(this.selector, this),
            vscode.commands.registerCommand('langIntellisense.learnSpelling', (uri: vscode.Uri, word: string) => this.learnSpelling(uri, word)),
            vscode.commands.registerCommand('langIntellisense.settings', () => this.spellCheckSettings()),
            EventBus.on('spellCheckLanguageUpdateEvent', () => this.resetDiagnosticCollection()),
            vscode.workspace.onDidOpenTextDocument(document => this.schedule(document)),
            vscode.workspace.onDidCloseTextDocument(document => {
                const key = document.uri.toString();
                clearTimeout(this.scans.get(key)?.timer);
                this.scans.delete(key);
                this.documentContexts.delete(key);
                this.documentSuggestions.delete(key);
                this.diagnosticCollection.delete(document.uri);
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (!event.contentChanges.length || event.document.uri.scheme!==ROOT_NAME) { return; }
                if (event.contentChanges.some(change => change.range.start.line!==change.range.end.line || /[\r\n]/.test(change.text))) {
                    this.schedule(event.document);
                } else {
                    this.schedule(event.document, Math.max(0, Math.min(...event.contentChanges.map(change => change.range.start.line))-1),
                        Math.max(...event.contentChanges.map(change => change.range.end.line))+1);
                }
            }),
        ];
    }
}
