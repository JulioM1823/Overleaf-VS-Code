const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const original = Module._load;
test('login remains available without sidebar context in the Command Palette', () => {
    const manifest = require('../package.json');
    assert.equal(manifest.contributes.commands.find(command => command.command.endsWith('.projectManager.loginServer')).enablement, undefined);
    assert(manifest.contributes.menus['view/item/context'].some(item => item.command.endsWith('.projectManager.loginServer')
        && item.when.includes('viewItem == server_login')));
});
const events = [];
let picks = [], inputs = [], hosts = [];
const state = {
    getServers: () => hosts,
    loginServer: async (_context, api, name, auth) => { events.push({api, name, auth}); return true; },
};
const vscode = {
    TreeItem: class {}, ThemeIcon: class {}, EventEmitter: class {},
    TreeItemCollapsibleState: {None: 0},
    Uri: {file: path => path}, l10n: {t: value => value},
    window: {
        showQuickPick: async choices => {
            const pick = picks.shift();
            return typeof pick === 'number' ? choices[pick] : pick;
        },
        showInputBox: async options => { events.push({input: options}); return inputs.shift(); },
        showErrorMessage: async message => { events.push({error: message}); },
    },
};
Module._load = function(request, parent, main) {
    if (request === 'vscode') { return vscode; }
    if (parent?.filename.endsWith('/core/projectManagerProvider.js') && request.startsWith('.')) {
        if (request === '../utils/globalStateManager') { return {GlobalStateManager: state}; }
        return {};
    }
    return original.call(this, request, parent, main);
};
const {ProjectManagerProvider} = require('../out/core/projectManagerProvider');
function fixture() {
    events.length = 0;
    hosts = [{server: {name: 'test', url: 'https://example.com/'}, api: {url: 'https://example.com/'}}];
    picks = ['Login with Cookies']; inputs = ['sid=synthetic'];
    const provider = new ProjectManagerProvider({});
    provider.logActionCancelled = () => {};
    provider.refresh = () => {};
    provider.withActionProgress = async (_action, _options, _fields, callback) => callback();
    return provider;
}
test('palette login resolves the sole server and awaits a masked cookie prompt', async () => {
    const provider = fixture();
    await provider.loginServer();
    assert.equal(events[0].input.password, true);
    assert.equal(events[0].input.ignoreFocusOut, true);
    assert.deepEqual(events[1].auth, {cookies: 'sid=synthetic'});
    assert.equal(events[1].name, 'test');
    assert(!events.some(event => event.error));
});
test('multiple hosts are selected before the cookie flow and cancellation is quiet', async () => {
    const provider = fixture();
    hosts.push({server: {name: 'second'}, api: {url: 'https://second.example/'}});
    picks = [1, 'Login with Cookies'];
    await provider.loginServer();
    assert.equal(events[1].name, 'second');
    events.length = 0; picks = [undefined];
    await provider.loginServer(); assert.equal(events.length, 0);
});
test('password failures remain observable and cancelled input makes no authentication request', async () => {
    const provider = fixture();
    picks = ['Login with Password']; inputs = [undefined];
    await provider.loginServer(); assert.equal(events.length, 1);
    events.length = 0; picks = ['Login with Password']; inputs = ['synthetic@example.com', 'synthetic'];
    provider.withActionProgress = async () => { throw new Error('Expected failure'); };
    await provider.loginServer(); assert.equal(events.at(-1).error, 'Expected failure');
});
