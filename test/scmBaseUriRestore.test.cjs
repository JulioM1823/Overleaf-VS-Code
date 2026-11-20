const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const original = Module._load;
Module._load = function(request, parent, main) {
    if (request==='vscode') { return {Disposable: class {}, workspace: {getConfiguration: () => ({get: (_key, fallback) => fallback})}, Uri: {
        // VS Code's URI parser recognizes the drive letter as a URI scheme;
        // these spies verify which actual URI factory the restore helper uses.
        parse: raw => ({scheme: /^([a-z][a-z\d+.-]*):/i.exec(raw)?.[1].toLowerCase() ?? '', raw, factory: 'parse'}),
        file: raw => ({scheme: 'file', raw, factory: 'file'}),
    }}; }
    if (parent?.filename?.replace(/\\/g, '/').endsWith('/scm/scmCollectionProvider.js')) {
        if (request==='.') { return {BaseSCM: class {}}; }
        if (request==='./localReplicaSCM') { return {LocalReplicaSCMProvider: class {}}; }
        if (request==='./historyViewProvider' || request==='../utils/globalStateManager' || request==='../utils/eventBus') { return {}; }
        if (request==='../utils/diagnostics') { return {logDiagnostic() {}}; }
    }
    return original.call(this, request, parent, main);
};
const {revivePersistedSCMBaseUri} = require('../out/scm/scmCollectionProvider');

test('legacy Windows drive roots are restored as local paths before URI scheme parsing', () => {
    for (const raw of ['C:\\Users\\example\\My Project', 'd:/Projects/Thesis']) {
        assert.deepEqual(revivePersistedSCMBaseUri(raw), {scheme: 'file', raw, factory: 'file'});
    }
});

test('legacy UNC roots preserve the full host and share path for the file URI factory', () => {
    for (const raw of ['\\\\fileserver\\share\\My Project', '//fileserver/share/My Project']) {
        assert.deepEqual(revivePersistedSCMBaseUri(raw), {scheme: 'file', raw, factory: 'file'});
    }
});

test('explicit file and custom URI roots retain URI parsing behavior', () => {
    for (const raw of ['file:///C:/Projects/Thesis', 'file://server/share/project', 'vscode-remote://ssh-remote+host/home/project']) {
        const result = revivePersistedSCMBaseUri(raw);
        assert.equal(result.factory, 'parse');
        assert.equal(result.raw, raw);
    }
});

test('POSIX absolute roots use the local file URI factory and relative roots retain prior behavior', () => {
    assert.deepEqual(revivePersistedSCMBaseUri('/home/example/My Project'), {scheme: 'file', raw: '/home/example/My Project', factory: 'file'});
    assert.equal(revivePersistedSCMBaseUri('relative-project').factory, 'parse');
});
