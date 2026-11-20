const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

class Disposable {
    constructor(callback = () => {}) { this.callback = callback; }
    dispose() { if (!this.disposed) { this.disposed = true; this.callback(); } }
}
const uri = (raw, scheme = 'file') => ({scheme, path: raw, toString: () => raw});
const diagnostics = [];
const notifications = [];
let persisted = {};
let stat = async () => ({type: 2});
let triggerFactory = () => [];
let constructions = 0;
class Replica {
    static label = 'Local Replica';
    constructor(vfs, baseUri) {
        constructions++;
        Object.assign(this, {vfs, baseUri, scmKey: baseUri.toString(), status: {status: 'idle'}, iconPath: {id: 'folder'}});
    }
    get triggers() { return triggerFactory(this); }
}
const vscode = {
    Disposable, FileType: {Directory: 2}, StatusBarAlignment: {Left: 1},
    Uri: {parse: raw => { if (raw==='bad-uri') { throw new Error('malformed persisted URI'); } return uri(raw, raw.startsWith('file:') ? 'file' : ''); }, file: raw => uri(raw)},
    l10n: {t: raw => raw},
    MarkdownString: class { appendMarkdown() {} },
    workspace: {getConfiguration: () => ({get: (_key, fallback) => fallback}), fs: {stat: value => stat(value)}},
    window: {
        createStatusBarItem: () => ({show() {}, dispose() {}}),
        showErrorMessage: async message => { notifications.push(message); },
    },
};
const original = Module._load;
Module._load = function(request, parent, main) {
    if (request==='vscode') { return vscode; }
    if (parent?.filename?.replace(/\\/g, '/').endsWith('/scm/scmCollectionProvider.js')) {
        if (request==='.') { return {BaseSCM: class {constructor(vfs, baseUri) { Object.assign(this, {vfs, baseUri}); }}}; }
        if (request==='./localReplicaSCM') { return {LocalReplicaSCMProvider: Replica}; }
        if (request==='./historyViewProvider') { return {HistoryViewProvider: class {get triggers() { return []; }}}; }
        if (request==='../utils/globalStateManager') { return {GlobalStateManager: {getServerProjectSCMPersists: () => persisted}}; }
        if (request==='../utils/eventBus') { return {EventBus: {on: () => new Disposable()}}; }
        if (request==='../utils/diagnostics') { return {logDiagnostic: (_scope, event, fields, error) => { diagnostics.push({event, fields, error}); }}; }
    }
    return original.call(this, request, parent, main);
};
const {SCMCollectionProvider} = require('../out/scm/scmCollectionProvider');

function fixture() {
    persisted = {}; stat = async () => ({type: 2}); triggerFactory = () => []; constructions = 0;
    diagnostics.length = 0; notifications.length = 0;
    const mutations = [];
    const provider = new SCMCollectionProvider({origin: uri('origin'), projectId: 'p', projectName: 'Project', serverName: 'server',
        setProjectSCMPersist: (...args) => { mutations.push(args); }}, {});
    return {provider, mutations};
}

test('one malformed or inaccessible persisted replica cannot reject other background restores', async () => {
    const {provider, mutations} = fixture();
    persisted = {
        malformed: {label: Replica.label, baseUri: 'bad-uri'},
        denied: {label: Replica.label, baseUri: 'file:///denied'},
        good: {label: Replica.label, baseUri: 'file:///good'},
    };
    stat = async value => { if (value.toString()==='file:///denied') { throw Object.assign(new Error('denied'), {code: 'EACCES'}); } return {type: 2}; };
    await provider.initSCMs();
    assert.equal(provider.scms.length, 1);
    assert.equal(provider.scms[0].scm.baseUri.toString(), 'file:///good');
    assert.equal(diagnostics.filter(entry => entry.event==='scm.restore_failed').length, 2);
    assert.deepEqual(mutations, []);
    assert.deepEqual(notifications, []);
    provider.dispose();
});

test('disposal during a persisted-root stat cannot start a late replica watcher or alter persisted settings', async () => {
    const {provider, mutations} = fixture();
    persisted = {pending: {label: Replica.label, baseUri: 'file:///pending'}};
    let finish;
    stat = () => new Promise(resolve => { finish = resolve; });
    const restoring = provider.initSCMs();
    provider.dispose();
    finish({type: 2});
    await restoring;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(constructions, 0);
    assert.equal(provider.scms.length, 0);
    assert.deepEqual(mutations, []);
});

test('watchers returned after disposal are all closed and never published or persisted', async () => {
    const {provider, mutations} = fixture();
    let finish;
    triggerFactory = () => new Promise(resolve => { finish = resolve; });
    const creation = provider.createSCM(Replica, uri('/pending'), true);
    provider.dispose();
    const closed = [];
    finish([{dispose() { closed.push('first'); throw new Error('failed dispose'); }}, {dispose() { closed.push('second'); }}]);
    assert.equal(await creation, undefined);
    assert.deepEqual(closed, ['first', 'second']);
    assert.deepEqual(mutations, []);
    assert.equal(provider.scms.length, 0);
    assert.equal(diagnostics.filter(entry => entry.event==='scm.trigger_dispose_failed').length, 1);
});

test('SCM constructor failure is handled by the same creation error path as trigger failure', async () => {
    const {provider} = fixture();
    class BrokenReplica {static label = 'Broken'; constructor() { throw new Error('constructor failed'); }}
    assert.equal(await provider.createSCM(BrokenReplica, uri('/broken')), undefined);
    assert.equal(diagnostics.filter(entry => entry.event==='scm.create_failed').length, 1);
    assert.deepEqual(notifications, []);
    provider.dispose();
});
