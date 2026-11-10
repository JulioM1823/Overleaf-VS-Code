import * as vscode from 'vscode';
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { IntellisenseProvider } from '.';
import {
    TeXElement,
    TeXElementType,
    TeXLabelDefinition,
    genTexElements,
    genTexLabelDefinitions,
} from './texDocumentParseUtility';
import { findReferenceLabelAtOffset } from './referenceNavigation';
import { ROOT_NAME } from '../consts';
import { logDiagnostic } from '../utils/diagnostics';

type TexFileStruct = {
    texElements: TeXElement[],
    childrenPaths: string[],
    bibFilePaths: string[],
    labels: TeXLabelDefinition[],
};

function normalizeProjectPath(path: string): string {
    const segments = path.split('/');
    const stack: string[] = [];
    for (const segment of segments) {
        if (segment==='' || segment==='.') {
            continue;
        }
        if (segment==='..') {
            stack.pop();
            continue;
        }
        stack.push(segment);
    }
    return stack.join('/');
}

function resolvePathFromFile(sourcePath: string, targetPath: string, ext?: string): string {
    const cleaned = targetPath.trim().replace(/^['\"]|['\"]$/g, '');
    if (cleaned==='') {
        return '';
    }

    const withExt = ext && !cleaned.endsWith(ext) ? `${cleaned}${ext}` : cleaned;
    if (withExt.startsWith('/')) {
        return normalizeProjectPath(withExt);
    }

    const parentPath = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
    return normalizeProjectPath(`${parentPath}/${withExt}`);
}

function elementsTypeCast(section: TeXElement): vscode.SymbolKind {
    switch (section.type) {
        case TeXElementType.Section:
        case TeXElementType.SectionAst:
            return vscode.SymbolKind.Struct;
        case TeXElementType.Environment:
            return vscode.SymbolKind.Package;
        case TeXElementType.Command:
            return vscode.SymbolKind.Number;
        case TeXElementType.SubFile:
            return vscode.SymbolKind.File;
        case TeXElementType.BibItem:
            return vscode.SymbolKind.Class;
        case TeXElementType.BibField:
            return vscode.SymbolKind.Constant;
        default:
            return vscode.SymbolKind.String;
    }
}

function elementsToSymbols(sections: TeXElement[]): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = [];
    sections.forEach(section => {
        const range = new vscode.Range(section.lineFr, 0, section.lineTo, 65535);
        const symbol = new vscode.DocumentSymbol(
            section.label || 'empty',
            '',
            elementsTypeCast(section),
            range, range);
        symbols.push(symbol);
        if (section.children.length > 0) {
            symbol.children = elementsToSymbols(section.children);
        }
    });
    return symbols;
}

function elementsToFoldingRanges(sections: TeXElement[]): vscode.FoldingRange[] {
    const foldingRanges: vscode.FoldingRange[] = [];
    sections.forEach(section => {
        foldingRanges.push(new vscode.FoldingRange(section.lineFr, section.lineTo - 1)); // without the last line, e.g \end{document}
        if (section.children.length > 0) {
            foldingRanges.push(...elementsToFoldingRanges(section.children));
        }
    });
    return foldingRanges;
}

// Reference: https://github.com/James-Yu/LaTeX-Workshop/commit/d1a078d9b63a34c9cda9ff5d1042c8999030e6e1
function getEnvironmentFoldingRange(document: vscode.TextDocument){
    const ranges: vscode.FoldingRange[] = [];
    const opStack: { keyword: string, index: number }[] = [];
    const text: string =  document.getText();
    const envRegex: RegExp = /(\\(begin){(.*?)})|(\\(end){(.*?)})/g; //to match one 'begin' OR 'end'

    let match = envRegex.exec(text); // init regex search
    while (match) {
        //for 'begin': match[2] contains 'begin', match[3] contains keyword
        //fro 'end':   match[5] contains 'end',   match[6] contains keyword
        const item = {
            keyword: match[2] ? match[3] : match[6],
            index: match.index
        };
        const lastItem = opStack[opStack.length - 1];

        if (match[5] && lastItem && lastItem.keyword === item.keyword) { // match 'end' with its 'begin'
            opStack.pop();
            ranges.push(new vscode.FoldingRange(
                document.positionAt(lastItem.index).line,
                document.positionAt(item.index).line - 1
            ));
        } else {
            opStack.push(item);
        }

        match = envRegex.exec(text); //iterate regex search
    }
    //TODO: if opStack still not empty
    return ranges;
}

/*
    * Convert the file into the struct by:
    * 1. Construct child, named as Uri.path, from TeXElementType.SubFile
    * 2. Construct bibFile from TeXElementType.BibFile
    * 
    * @param fileContent: file content 
*/
async function parseTexFileStruct(fileContent:string): Promise<TexFileStruct>{ 
    const childrenPaths = [];
    const bibFilePaths = [];
    const texSymbols = await genTexElements(fileContent);
    const labels = genTexLabelDefinitions(fileContent);

    // BFS: Traverse the texElements and build fileSymbol
    const queue: TeXElement[] = [...texSymbols];
    for (let index = 0; index < queue.length; index++) {
        const symbol = queue[index];
        switch (symbol?.type) {
            case TeXElementType.BibFile:
                bibFilePaths.push(symbol.label);
                break;
            case TeXElementType.SubFile:
                const subFilePath = symbol.label?.endsWith('.tex') ? symbol.label : `${symbol.label}.tex`;
                childrenPaths.push(subFilePath);
                break;
            default:
                break;
        }
        // append children to queue
        symbol?.children.forEach( child => {
            queue.push(child);
        });
    }

    return {
        texElements: texSymbols,
        childrenPaths: childrenPaths,
        bibFilePaths: bibFilePaths,
        labels,
    };
}

export class ProjectStructRecord {
    private fileRecordMap: Map<string, TexFileStruct> = new Map<string, TexFileStruct>();
    private parseRequests = new Map<string, {sequence:number, promise:Promise<TexFileStruct>}>();
    private parseSequence = 0;
    private documentParses = new WeakMap<vscode.TextDocument, {version:number, sequence:number, promise:Promise<TexFileStruct>}>();

    constructor (private readonly vfs: VirtualFileSystem) {}

    get rootPath(): string {
        return normalizeProjectPath(this.vfs.getRootDocName());
    }

    async init() {
        const rootFileStruct = await this.refreshRecord( this.rootPath );
        const fileQueue: TexFileStruct[] = [ rootFileStruct ];
        const visited = new Set([this.rootPath]);

        // iteratively traverse file node tree
        for (let index = 0; index < fileQueue.length; index++) {
            const fileNode = fileQueue[index];
            const subFiles = fileNode.childrenPaths;
            for (const subFile of subFiles) {
                if (visited.has(subFile)) { continue; }
                visited.add(subFile);
                // Get fileStruct can be failed due to file not exist
                try {
                    const fileStruct = await this.refreshRecord(subFile);
                    fileQueue.push( fileStruct );
                } catch { continue; }
            };
        }
    }

    getTexFileStruct(document: vscode.TextDocument): TexFileStruct | undefined {
        const filePath = normalizeProjectPath(parseUri(document.uri).pathParts.join('/'));
        return this.fileRecordMap.get(filePath);
    }

    getLabelDefinitions(label: string): Array<TeXLabelDefinition & { filePath: string }> {
        return [...this.fileRecordMap.entries()].flatMap(([filePath, fileStruct]) => {
            return fileStruct.labels
                .filter(item => item.label === label)
                .map(item => ({...item, filePath}));
        });
    }

    refreshRecord(source: vscode.TextDocument | string): Promise<TexFileStruct> {
        const filePath = normalizeProjectPath(typeof source==='string' ? source : parseUri(source.uri).pathParts.join('/'));
        const previous = this.parseRequests.get(filePath);
        const cached = typeof source==='string' ? undefined : this.documentParses.get(source);
        if (typeof source!=='string' && cached && cached.version===source.version && cached.sequence===previous?.sequence) {
            return cached.promise;
        }
        const sequence = ++this.parseSequence;
        const version = typeof source==='string' ? undefined : source.version;
        const sourceText = typeof source==='string' ? undefined : source.getText();
        const promise = (async () => {
            const content = sourceText ?? new TextDecoder().decode(await this.vfs.openFile(this.vfs.pathToUri(filePath)));

            // Resolve references against the source document path.
            const rawFileStruct = await parseTexFileStruct(content);
            const fileStruct: TexFileStruct = {
                texElements: rawFileStruct.texElements,
                childrenPaths: rawFileStruct.childrenPaths
                    .map((childPath) => resolvePathFromFile(filePath, childPath, '.tex'))
                    .filter((childPath) => childPath!==''),
                bibFilePaths: rawFileStruct.bibFilePaths
                    .flatMap((name) => name.split(','))
                    .map((name) => resolvePathFromFile(filePath, name, '.bib'))
                    .filter((bibPath) => bibPath!==''),
                labels: rawFileStruct.labels,
            };

            // A slow disk read or parse must never replace a newer editor parse.
            const latest = this.parseRequests.get(filePath);
            if (latest?.sequence!==sequence) { return latest?.promise ?? fileStruct; }
            this.fileRecordMap.set(filePath, fileStruct);
            return fileStruct;
        })();
        this.parseRequests.set(filePath, {sequence, promise});
        if (typeof source!=='string' && version!==undefined) { this.documentParses.set(source, {version, sequence, promise}); }
        promise.catch(() => {
            if (this.parseRequests.get(filePath)?.promise===promise) { this.parseRequests.delete(filePath); }
            if (typeof source!=='string' && this.documentParses.get(source)?.promise===promise) { this.documentParses.delete(source); }
        });
        return promise;
    }

    getAllBibFilePaths(): string[] {
        const rootStruct = this.fileRecordMap.get( this.rootPath );
        if (rootStruct === undefined) { return []; }

        const queue = [rootStruct];
        const visited = new Set([this.rootPath]);
        const bibFilePaths = new Set<string>();
        // iteratively traverse file node tree
        for (let index = 0; index < queue.length; index++) {
            const item = queue[index];
            item.bibFilePaths.forEach((path) => {
                bibFilePaths.add(path);
            });
            // append children to queue
            item.childrenPaths.forEach( child => {
                if (visited.has(child)) { return; }
                visited.add(child);
                const childItem = this.fileRecordMap.get(child);
                childItem && queue.push(childItem);
            });
        }
        return [...bibFilePaths];
    }
}

export class TexDocumentSymbolProvider extends IntellisenseProvider implements vscode.DocumentSymbolProvider, vscode.FoldingRangeProvider, vscode.DefinitionProvider {
    protected readonly contextPrefix = [];

    private projectRecordMap = new Map<string, {vfs: VirtualFileSystem, record: Promise<ProjectStructRecord>, resolved?: ProjectStructRecord}>();

    private projectKey(uri: vscode.Uri) {
        const {serverName, userId, projectId} = parseUri(uri);
        return JSON.stringify([serverName, userId, projectId]);
    }

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('ReferenceNavigation', event, fields, error);
    }

    private async getProjectContext(document: vscode.TextDocument) {
        const vfs = await this.vfsm.prefetch(document.uri);
        const key = this.projectKey(document.uri);
        let entry = this.projectRecordMap.get(key);
        if (!entry || entry.vfs!==vfs) {
            const projectRecord = new ProjectStructRecord(vfs);
            const record = projectRecord.init().then(() => {
                const current = this.projectRecordMap.get(key);
                if (current?.record===record) { current.resolved = projectRecord; }
                return projectRecord;
            });
            entry = {vfs, record};
            this.projectRecordMap.set(key, entry);
            record.catch(() => {
                if (this.projectRecordMap.get(key)?.record===record) { this.projectRecordMap.delete(key); }
            });
        }
        return {vfs, projectRecord: await entry.record};
    }

    async provideFoldingRanges(document: vscode.TextDocument, context: vscode.FoldingContext, token: vscode.CancellationToken): Promise<vscode.FoldingRange[]> {
        const environmentRange = getEnvironmentFoldingRange(document);

        // Try get fileStruct
        const projectRecord = await this.projectRecordMap.get(this.projectKey(document.uri))?.record;
        const fileStruct = projectRecord?.getTexFileStruct(document);

        return environmentRange.concat( fileStruct ? elementsToFoldingRanges(fileStruct.texElements) : [] );
    }

    async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
        const {projectRecord} = await this.getProjectContext(document);

        // return symbols
        const fileStruct = await projectRecord.refreshRecord(document);
        return elementsToSymbols( fileStruct.texElements );
    }

    async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
        const labelMatch = findReferenceLabelAtOffset(document.getText(), document.offsetAt(position));
        if (labelMatch === undefined) {
            return;
        }

        try {
            const {vfs, projectRecord} = await this.getProjectContext(document);
            await projectRecord.refreshRecord(document);
            const locations = projectRecord.getLabelDefinitions(labelMatch.label);
            if (locations.length === 0) {
                this.logDiagnostic('definition.missing', {
                    label: labelMatch.label,
                    uri: document.uri.toString(),
                });
                return;
            }

            this.logDiagnostic('definition.resolved', {
                label: labelMatch.label,
                locationCount: locations.length,
                uri: document.uri.toString(),
            });
            return locations.map(location => {
                return new vscode.Location(
                    vfs.pathToUri(location.filePath),
                    new vscode.Range(location.line, location.column, location.endLine, location.endColumn),
                );
            });
        } catch (error) {
            this.logDiagnostic('definition.failed', {
                label: labelMatch.label,
                uri: document.uri.toString(),
            }, error);
            return;
        }
    }

    get currentBibPathArray(): string[] {
        // check if supported vfs
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (uri?.scheme !== ROOT_NAME) { return []; }
        // get bib file paths
        // This synchronous API exposes only a completed record.
        return this.projectRecordMap.get(this.projectKey(uri))?.resolved?.getAllBibFilePaths() ?? [];
    }

    async getBibFilePaths(document: vscode.TextDocument): Promise<string[]> {
        const {projectRecord} = await this.getProjectContext(document);
        await projectRecord.refreshRecord(document);
        return projectRecord.getAllBibFilePaths();
    }

    get triggers(): vscode.Disposable[] {
        const latexSelector = ['latex', 'latex-expl3', 'pweave', 'jlweave', 'rsweave'].map((id) => {
            return {...this.selector, language: id };
        });
        return [
            // register symbol provider
            vscode.languages.registerDocumentSymbolProvider(latexSelector, this),
            // register folding range provider
            vscode.languages.registerFoldingRangeProvider(latexSelector, this),
            // register definition provider
            vscode.languages.registerDefinitionProvider(latexSelector, this),
            // register file change listener
            vscode.workspace.onDidChangeTextDocument(async (e) => {
                if (e.document.uri.scheme!==ROOT_NAME || e.contentChanges.length===0) { return; }
                const entry = this.projectRecordMap.get(this.projectKey(e.document.uri));
                await entry?.record.then(record => record.refreshRecord(e.document)).catch(error => {
                    this.logDiagnostic('project_index.refresh_failed', {}, error);
                });
            }),
            new vscode.Disposable(() => this.projectRecordMap.clear()),
        ];
    }
}
