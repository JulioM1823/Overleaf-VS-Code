const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const actualMinimatch = require('minimatch');
const calls = [];
const original = Module._load;
Module._load = function(request, parent, main) {
    if (request==='vscode') { return {l10n: {t: value => value}, ThemeIcon: class {},
        workspace: {getConfiguration: () => ({get: (_key, fallback) => fallback})}}; }
    if (parent?.filename?.replace(/\\/g, '/').endsWith('/scm/localReplicaSCM.js')) {
        if (request==='.') { return {BaseSCM: class {}}; }
        if (request==='../core/remoteFileSystemProvider') { return {}; }
        if (request==='../utils/eventBus') { return {EventBus: {}}; }
        if (request==='../utils/diagnostics') { return {logDiagnostic() {}}; }
        if (request==='minimatch') { return {minimatch: (value, pattern, options) => {
            calls.push({pattern, options});
            return actualMinimatch.minimatch(value, pattern, options);
        }}; }
    }
    return original.call(this, request, parent, main);
};
const {LocalReplicaSCMProvider} = require('../out/scm/localReplicaSCM');

test('replica ignore patterns retain normal glob semantics with the vulnerable optimization path disabled', () => {
    const provider = Object.create(LocalReplicaSCMProvider.prototype);
    provider.ignorePatterns = ['**/.*', '**/.*/**', '**/*.aux'];
    provider.getSetting = () => undefined;
    assert.equal(provider.matchIgnorePatterns('/main.aux'), true);
    assert.equal(provider.matchIgnorePatterns('/.overleaf/settings.json'), true);
    assert.equal(provider.matchIgnorePatterns('/sections/chapter.tex'), false);
    provider.getSetting = () => [`**/${'a/**/../'.repeat(100)}missing.tex`];
    assert.equal(provider.matchIgnorePatterns('/safe/main.tex'), false);
    assert(calls.length>0);
    assert(calls.every(call => call.options.optimizationLevel===1 && call.options.dot===true));
});
