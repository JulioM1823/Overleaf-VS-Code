const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
    constructor(value) { this.scheme = 'file'; this.fsPath = value; this.path = value; }
    toString() { return `file://${this.path}`; }
    static file(value) { return new Uri(value); }
    static joinPath(root, ...parts) { return new Uri(path.join(root.fsPath, ...parts)); }
}
Module._load = function(request, parent, main) {
    if (request === 'vscode') return {Uri, workspace: {getConfiguration: () => ({get: (_key, fallback) => fallback}), fs: {
        readFile: uri => fs.readFile(uri.fsPath), writeFile: (uri, bytes) => fs.writeFile(uri.fsPath, bytes),
        createDirectory: uri => fs.mkdir(uri.fsPath, {recursive: true}),
    }}};
    return originalLoad.call(this, request, parent, main);
};
const {DocumentSyncJournal} = require('../out/offline/documentSyncJournal');
const {createBlobId} = require('../out/offline/documentSyncJournalState');
const {writePrivateFile, assertSafeLocalPath} = require('../out/utils/safeFile');
const {ensureLocalReplicaMetadataDirectory} = require('../out/scm/localReplicaWorkspace');
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-recovery-audit-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const uri = Uri.file(path.join(root, '.overleaf'));
    return {root, uri, journal: new DocumentSyncJournal(DocumentSyncJournal.createStorageResolver(uri))};
}
test('concurrent journal transactions retain every document and readers see the committed state', async t => {
    const {journal} = await fixture(t);
    await Promise.all(Array.from({length: 30}, (_, i) => journal.withState(async state => {
        await new Promise(resolve => setImmediate(resolve));
        state.records[`/${i}.tex`] = {relPath: `/${i}.tex`, localDirty: true};
    })));
    assert.equal(Object.keys((await journal.loadState()).records).length, 30);
});
test('failed transaction does not poison the queue or modify its durable state', async t => {
    const {journal} = await fixture(t);
    await assert.rejects(journal.withState(state => { state.records.bad = {}; throw new Error('abort'); }));
    await journal.withState(state => { state.records.good = {relPath: 'good', localDirty: true}; });
    assert.deepEqual(Object.keys((await journal.loadState()).records), ['good']);
});
test('corrupt journal is preserved and never replaced with an empty recovery state', async t => {
    const {journal, uri} = await fixture(t);
    await fs.mkdir(uri.fsPath);
    const target = path.join(uri.fsPath, 'document-sync-state.json');
    await fs.writeFile(target, '{partial');
    await assert.rejects(journal.withState(() => {}));
    assert.equal(await fs.readFile(target, 'utf8'), '{partial');
});
test('blob identifiers cannot traverse paths, and corrupted content is rejected', async t => {
    const {journal, uri} = await fixture(t);
    await assert.rejects(journal.readBlob('../../secret'), /identifier/);
    const content = Buffer.from('private manuscript');
    const id = await journal.writeBlob(content);
    assert.deepEqual(await journal.readBlob(id), content);
    await fs.writeFile(path.join(uri.fsPath, 'blobs', id), 'wrong');
    await assert.rejects(journal.readBlob(id), /checksum/);
    assert.equal(id, createBlobId(content));
});
test('private atomic writes preserve old data when rename fails and clean temporary files', async t => {
    const {root} = await fixture(t);
    const uri = Uri.file(path.join(root, 'state'));
    await writePrivateFile(uri, Buffer.from('old'));
    const originalRename = fs.rename;
    fs.rename = async () => { throw new Error('injected rename failure'); };
    try { await assert.rejects(writePrivateFile(uri, Buffer.from('new')), /injected/); }
    finally { fs.rename = originalRename; }
    assert.equal(await fs.readFile(uri.fsPath, 'utf8'), 'old');
    assert.deepEqual(await fs.readdir(root), ['state']);
    if (process.platform !== 'win32') assert.equal((await fs.stat(uri.fsPath)).mode & 0o777, 0o600);
});
test('concurrent atomic saves retain invocation order and copy mutable input', async t => {
    const {root} = await fixture(t);
    const uri = Uri.file(path.join(root, 'state'));
    const bytes = Buffer.from('last');
    const promises = Array.from({length: 20}, (_, i) => writePrivateFile(uri, Buffer.from(String(i))));
    promises.push(writePrivateFile(uri, bytes));
    bytes.fill(0);
    await Promise.all(promises);
    assert.equal(await fs.readFile(uri.fsPath, 'utf8'), 'last');
});
test('symlinked metadata and descendants cannot redirect storage outside the project', async t => {
    const {root, uri} = await fixture(t);
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, uri.fsPath, 'dir');
    await assert.rejects(ensureLocalReplicaMetadataDirectory(uri), /symbolic link/);
    await assert.rejects(assertSafeLocalPath(Uri.file(root), Uri.joinPath(uri, 'new')), /symbolic link/);
    await fs.writeFile(path.join(outside, 'secret'), 'keep');
    const link = Uri.file(path.join(root, 'link'));
    await fs.symlink(path.join(outside, 'secret'), link.fsPath);
    await assert.rejects(writePrivateFile(link, Buffer.from('overwrite')), /symbolic link/);
    assert.equal(await fs.readFile(path.join(outside, 'secret'), 'utf8'), 'keep');
});

test('global offline storage separates accounts and ambiguous legacy pending work is preserved', async t => {
    const {root} = await fixture(t);
    const {ProjectOfflineStore} = require('../out/offline/projectOfflineStore');
    const make = user => new ProjectOfflineStore({globalStorageUri: Uri.file(root)}, {query: `user=${user}&project=p`, scheme: 'overleaf-workshop'}, 'p', 'Project', 'server');
    const alice = (await make('alice').describeStorage()).storageRoot.fsPath;
    const bob = (await make('bob').describeStorage()).storageRoot.fsPath;
    assert.notEqual(alice, bob);
    const legacy = path.join(root, 'offline-projects', 'server', 'p');
    await fs.mkdir(legacy, {recursive: true});
    const raw = JSON.stringify({version: 1, operations: [{kind: 'chat.send'}]});
    await fs.writeFile(path.join(legacy, 'offline-operations.json'), raw);
    await assert.rejects(make('alice').describeStorage(), /pending work without an account/);
    assert.equal(await fs.readFile(path.join(legacy, 'offline-operations.json'), 'utf8'), raw);
});
test('project snapshot bursts persist only the active and newest pending snapshot without changing caller data',async t=>{
    const {root,uri}=await fixture(t);
    const {ProjectOfflineStore}=require('../out/offline/projectOfflineStore');
    const store=new ProjectOfflineStore({}, {},'p','Project','server');
    let release;const gate=new Promise(resolve=>{release=resolve;});let resolves=0;
    store.resolveStorage=async()=>{
        resolves++;if(resolves===1)await gate;
        return {storageRoot:uri,snapshotUri:Uri.joinPath(uri,'offline-project-state.json')};
    };
    const state={version:1,savedAt:new Date().toISOString(),bootstrapSource:'socket',permissionsLevel:'readAndWrite',
        readonlyMode:false,chatHistoryComplete:false,chatMessages:[],commentRangesByDocId:{},commentThreads:{},project:{name:'first'}};
    const first=store.saveProjectState(state);
    await new Promise(resolve=>setImmediate(resolve));
    const burst=Array.from({length:200},(_,i)=>store.saveProjectState({...state,project:{name:String(i)}}));
    const last={...state,project:{name:'last'}};burst.push(store.saveProjectState(last));last.project.name='mutated after call';
    release();await Promise.all([first,...burst]);await store.flush();
    assert.equal(resolves,2);
    const persisted=JSON.parse(await fs.readFile(path.join(root,'.overleaf','offline-project-state.json'),'utf8'));
    assert.equal(persisted.project.name,'last');
    if(process.platform!=='win32')assert.equal((await fs.stat(path.join(root,'.overleaf','offline-project-state.json'))).mode&0o777,0o600);
});
