const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

class Uri {
    constructor(scheme, authority, pathname, query = '') { Object.assign(this, {scheme, authority, path: pathname, query}); }
    static parse(value) { const url = new URL(value); return new Uri(url.protocol.slice(0, -1), url.host, decodeURIComponent(url.pathname), url.search.slice(1)); }
    static file(value) { return new Uri('file', '', value); }
    static joinPath(base, ...parts) { return base.with({path: path.posix.join(base.path, ...parts)}); }
    with(changes) { return Object.assign(new Uri(this.scheme, this.authority, this.path, this.query), changes); }
    toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ''}`; }
}
const first = Uri.file('/work/first');
const second = Uri.file('/work/second');
const firstProject = Uri.parse('overleaf-workshop://server/First?user=u&project=first');
const secondProject = Uri.parse('overleaf-workshop://server/Second?user=u&project=second');
const settings = new Map([[first.path, firstProject], [second.path, secondProject]]);
const reads = [];
const vscode = {Uri, window: {}, workspace: {
    workspaceFolders: [{uri: first}, {uri: second}],
    getConfiguration: () => ({get: (_key, fallback) => fallback}),
    fs: {readFile: async uri => {
        if (uri.path.endsWith('/.overleaf/settings.json')) {
            const origin = settings.get(uri.path.slice(0, -'/.overleaf/settings.json'.length));
            if (!origin) { throw new Error('not a replica'); }
            return Buffer.from(JSON.stringify({uri: origin.toString()}));
        }
        reads.push(uri.toString()); return Buffer.from(uri.path);
    }},
}};
const original = Module._load;
Module._load = function(request, parent, main) {
    if (request === 'vscode') { return vscode; }
    if (request === '../utils/diagnostics') { return {logDiagnostic() {}}; }
    if (request === '../scm/localReplicaSCM') { return {LocalReplicaSCMProvider: {
        readSettings: async root => ({uri: settings.get((root ?? vscode.workspace.workspaceFolders[0].uri).path)?.toString()}),
        pathToUri: (relative, root) => require('../out/scm/localReplicaWorkspace').mapOverleafPathToLocalReplicaFileUri(relative, root),
    }}; }
    return original.call(this, request, parent, main);
};
const {ProjectSearchProvider} = require('../out/intellisense/projectSearchProvider');
const provider = new ProjectSearchProvider({prefetch: async uri => ({projectName: uri.path, serverName: uri.authority,
    pathToUri: relative => Uri.joinPath(uri, relative), openFile: async () => Buffer.from('remote')})});

test('project search reads and opens files in the active second replica of a multi-root workspace', async () => {
    vscode.workspace.workspaceFolders = [{uri: first}, {uri: second}];
    vscode.window.activeTextEditor = {document: {uri: Uri.joinPath(second, 'main.tex')}};
    const context = await provider.resolveSearchContext();
    assert.equal(context.vfs.projectName, '/Second');
    assert.equal(context.rootUri.toString(), second.toString());
    assert.equal((await context.resolveUri('/main.tex')).toString(), 'file:///work/second/main.tex');
    assert.equal((await context.readFile('/main.tex')).toString(), '/work/second/main.tex');
    assert.equal(reads.at(-1), 'file:///work/second/main.tex');
    // An editor/workspace switch while results are displayed cannot redirect them.
    vscode.window.activeTextEditor = {document: {uri: Uri.joinPath(first, 'main.tex')}};
    vscode.workspace.workspaceFolders = [{uri: first}];
    assert.equal((await context.resolveUri('/main.tex')).toString(), 'file:///work/second/main.tex');
});

test('project search finds a linked workspace after an unrelated first root', async () => {
    vscode.workspace.workspaceFolders = [{uri: Uri.file('/work/unrelated')}, {uri: second}];
    vscode.window.activeTextEditor = undefined;
    const context = await provider.resolveSearchContext();
    assert.equal(context.vfs.projectName, '/Second');
    assert.equal((await context.resolveUri('/main.tex')).toString(), 'file:///work/second/main.tex');
});
