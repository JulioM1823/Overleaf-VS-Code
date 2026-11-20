const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const events = [];
const vscode = {
    TreeItem: class {}, ThemeIcon: class {},
    TreeItemCollapsibleState: {None: 0, Collapsed: 1, Expanded: 2},
    EventEmitter: class { fire() {} },
    Uri: {file: value => value}, l10n: {t: value => value},
    workspace: {getConfiguration: () => ({get: (_key, fallback) => fallback})},
    window: {showErrorMessage() {}, showWarningMessage() {}},
};
Module._load = function(request, parent, main) {
    if (request === 'vscode') { return vscode; }
    const filename = parent?.filename.replace(/\\/g, '/');
    if (filename?.endsWith('/core/projectManagerProvider.js') && request.startsWith('.')) {
        if (request === '../utils/globalStateManager') { return originalLoad.call(this, request, parent, main); }
        if (request === '../utils/diagnostics') { return {logDiagnostic() {}}; }
        if (request === '../consts') { return {ROOT_NAME: 'overleaf-workshop'}; }
        return {};
    }
    if (filename?.endsWith('/utils/globalStateManager.js')) {
        if (request === '../api/socketio' || request === '../api/extendedBase' || request === '../api/base') { return {}; }
        if (request === './diagnostics') { return {logDiagnostic() {}}; }
        if (request === './eventBus') { return {EventBus: {fire: (name, payload) => events.push({name, payload})}}; }
    }
    return originalLoad.call(this, request, parent, main);
};
const {ProjectManagerProvider} = require('../out/core/projectManagerProvider');
const {GlobalStateManager, ServerSessionExpiredError} = require('../out/utils/globalStateManager');
GlobalStateManager.getServers = context => [{server: context.state.server, api: context.api}];

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}
async function fixture() {
    events.length = 0;
    const state = {server: {name: 'server', url: 'https://server/',
        login: {userId: 'owner', username: 'synthetic', identitySecretKey: 'original-session'}}};
    const secrets = new Map([['original-session', JSON.stringify({cookies: 'sid=synthetic', csrfToken: 'synthetic'})]]);
    const deleted = [], revocations = [];
    const api = {url: 'https://server/', getProjectsJson: async () => ({type: 'success', projects: []}),
        getAllTags: async () => ({type: 'success', tags: []}),
        logout: async identity => { revocations.push(identity); }};
    const context = {state, api, globalState: {get: () => state, update: async () => {}},
        secrets: {get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value),
            delete: async key => { deleted.push(key); secrets.delete(key); }}};
    const provider = new ProjectManagerProvider(context);
    const [server] = await provider.getChildren();
    return {provider, server, context, api, secrets, deleted, revocations};
}
const settled = () => new Promise(resolve => setImmediate(resolve));

test('a transport failure while refreshing projects preserves the active session and permits retry', async () => {
    const f = await fixture();
    f.api.getProjectsJson = async () => { throw new Error('Synthetic network timeout'); };
    await assert.rejects(f.provider.getChildren(f.server));
    await settled();
    assert.equal(f.revocations.length, 0, 'A network failure must not revoke a working browser session');
    assert.deepEqual(f.deleted, [], 'A network failure must retain SecretStorage credentials');
    assert.equal(f.context.state.server.login.userId, 'owner');
    assert.deepEqual(events, []);
    f.api.getProjectsJson = async () => ({type: 'success', projects: []});
    assert.deepEqual(await f.provider.getChildren(f.server), []);
});

test('a rejected tag request preserves the active session and its secret', async () => {
    const f = await fixture();
    f.api.getAllTags = async () => { throw new Error('Synthetic tag endpoint unavailable'); };
    await assert.rejects(f.provider.getChildren(f.server));
    await settled();
    assert.equal(f.revocations.length, 0);
    assert.deepEqual(f.deleted, []);
    assert.equal(f.context.state.server.login.identitySecretKey, 'original-session');
    assert.deepEqual(events, []);
});

test('an older failed project refresh cannot revoke a successfully refreshed login', async () => {
    const f = await fixture(), entered = deferred(), response = deferred();
    f.api.getProjectsJson = async () => { entered.resolve(); return response.promise; };
    const refreshing = f.provider.getChildren(f.server);
    const rejected = assert.rejects(refreshing);
    await entered.promise;
    assert.equal(await GlobalStateManager.loginServer(f.context, {cookiesLogin: async () => ({type: 'success',
        identity: {cookies: 'sid=new-synthetic', csrfToken: 'new'}, userInfo: {userId: 'owner', userEmail: 'synthetic'}})},
    'server', {cookies: 'sid=new-synthetic'}), true);
    const replacementKey = f.context.state.server.login.identitySecretKey;
    const eventCountAfterLogin = events.length;
    response.reject(new Error('Synthetic stale network failure'));
    await rejected; await settled();
    assert.equal(f.revocations.length, 0, 'An obsolete request must not revoke the replacement credentials');
    assert(!f.deleted.includes(replacementKey));
    assert.equal(f.context.state.server.login.identitySecretKey, replacementKey);
    assert.equal(events.length, eventCountAfterLogin);
});

test('a logged-out tree refresh cannot invalidate a first login while its SecretStorage write is pending', async () => {
    const f = await fixture(), entered = deferred(), stored = deferred();
    delete f.context.state.server.login;
    f.context.secrets.store = async (key, value) => { entered.resolve(); await stored.promise; f.secrets.set(key, value); };
    const rejected = assert.rejects(f.provider.getChildren(f.server));
    const login = GlobalStateManager.loginServer(f.context, {cookiesLogin: async () => ({type: 'success',
        identity: {cookies: 'sid=first-synthetic', csrfToken: 'first'}, userInfo: {userId: 'owner', userEmail: 'synthetic'}})},
    'server', {cookies: 'sid=first-synthetic'});
    await entered.promise; await rejected; await settled(); stored.resolve();
    assert.equal(await login, true, 'A tree request must not turn successful first-login HTTP into a false login result');
    assert.equal(f.context.state.server.login.userId, 'owner');
    assert.equal(f.revocations.length, 0);
});

test('explicit authentication expiry for the unchanged session still signs out and deletes only its secret', async () => {
    const f = await fixture();
    f.api.getProjectsJson = f.api.userProjectsJson = async () => ({type: 'error', statusCode: 401, authenticationRequired: true});
    await assert.rejects(f.provider.getChildren(f.server), error => error.code === 'SERVER_SESSION_EXPIRED');
    await settled();
    assert.equal(f.revocations.length, 1);
    assert.deepEqual(f.deleted, ['original-session']);
    assert.equal(f.context.state.server.login, undefined);
});

test('a 302-looking error message is not explicit authentication expiry', async () => {
    const f = await fixture();
    f.api.getProjectsJson = f.api.userProjectsJson = async () => ({type: 'error', statusCode: 503, message: '302 upstream requests timed out'});
    assert.deepEqual(await f.provider.getChildren(f.server), []);
    assert.equal(f.revocations.length, 0); assert.deepEqual(f.deleted, []);
});

test('a typed expiry from an obsolete session cannot sign out its replacement', async () => {
    const f = await fixture(), response = deferred();
    const expired = new ServerSessionExpiredError('server', GlobalStateManager.captureServerSessionGuard(f.context, 'server'));
    f.provider.getServerTreeData = () => response.promise;
    const rejected = assert.rejects(f.provider.getChildren(f.server));
    await GlobalStateManager.loginServer(f.context, {cookiesLogin: async () => ({type: 'success',
        identity: {cookies: 'sid=replacement', csrfToken: 'replacement'}, userInfo: {userId: 'owner', userEmail: 'synthetic'}})},
    'server', {cookies: 'sid=replacement'});
    const replacement = f.context.state.server.login.identitySecretKey;
    response.reject(expired); await rejected; await settled();
    assert.equal(f.context.state.server.login.identitySecretKey, replacement);
    assert(!f.deleted.includes(replacement)); assert.equal(f.revocations.length, 0);
});

test('an invalidated older request cannot cache stale projects or remove a newer pending refresh', async t => {
    const f = await fixture(), first = deferred(), second = deferred(), enteredFirst = deferred(), enteredSecond = deferred();
    const result = name => ({type: 'success', projects: [{id: name, name}]});
    t.after(() => second.resolve(result('new')));
    let calls = 0;
    f.api.getProjectsJson = () => {
        calls++;
        if (calls === 1) { enteredFirst.resolve(); return first.promise; }
        enteredSecond.resolve(); return second.promise;
    };
    const old = f.provider.getChildren(f.server).then(value => ({value}), error => ({error}));
    await enteredFirst.promise; f.provider.refresh();
    const fresh = f.provider.getChildren(f.server); await enteredSecond.promise;
    first.resolve(result('old'));
    assert((await old).error, 'A superseded result must not publish stale project data');
    const shared = f.provider.getChildren(f.server);
    await settled(); assert.equal(calls, 2, 'The old finally must not evict the newer pending request');
    second.resolve(result('new'));
    for (const items of await Promise.all([fresh, shared])) { assert.equal(items[0].projectLabel, 'new'); }
    assert.equal((await f.provider.getChildren(f.server))[0].projectLabel, 'new');
    assert.equal(calls, 2);
});

test('cached projects from the previous account are never reused after a new verified login', async () => {
    const f = await fixture(); let calls = 0;
    f.api.getProjectsJson = async () => ({type: 'success', projects: [{id: ++calls === 1 ? 'old' : 'new', name: calls === 1 ? 'old' : 'new'}]});
    assert.equal((await f.provider.getChildren(f.server))[0].projectLabel, 'old');
    await GlobalStateManager.loginServer(f.context, {cookiesLogin: async () => ({type: 'success',
        identity: {cookies: 'sid=other-account', csrfToken: 'other'}, userInfo: {userId: 'other', userEmail: 'synthetic'}})},
    'server', {cookies: 'sid=other-account'});
    const items = await f.provider.getChildren(f.server);
    assert.equal(items[0].projectLabel, 'new'); assert.equal(calls, 2);
    assert.match(items[0].uri, /user=other&/);
});

test('an invalidated per-server request cannot repopulate the cache even without a global refresh', async () => {
    const f = await fixture(), response = deferred(), entered = deferred();
    f.api.getProjectsJson = () => { entered.resolve(); return response.promise; };
    const rejected = assert.rejects(f.provider.getChildren(f.server), /superseded/);
    await entered.promise;
    f.provider.clearServerTreeData('test-server-invalidation', 'server');
    response.resolve({type: 'success', projects: [{id: 'old', name: 'old'}]});
    await rejected;
    assert.equal(f.provider.serverTreeDataCache.size, 0);
    assert.equal(f.revocations.length, 0);
});

test('account changes during asynchronous icon resolution cannot render old-account projects', async () => {
    const f = await fixture(), icon = deferred(), entered = deferred();
    f.api.getProjectsJson = async () => ({type: 'success', projects: [{id: 'private-old', name: 'private-old'}]});
    f.provider.getOpenFolderIconPath = () => { entered.resolve(); return icon.promise; };
    const rejected = assert.rejects(f.provider.getChildren(f.server), /superseded/);
    await entered.promise;
    await GlobalStateManager.loginServer(f.context, {cookiesLogin: async () => ({type: 'success',
        identity: {cookies: 'sid=other-account', csrfToken: 'other'}, userInfo: {userId: 'other', userEmail: 'synthetic'}})},
    'server', {cookies: 'sid=other-account'});
    icon.resolve(); await rejected;
    assert.equal(f.server.tags, undefined);
    assert.equal(f.revocations.length, 0);
});

test('malformed tag responses retain authentication and are evicted so a valid retry can succeed', async () => {
    const f = await fixture();
    f.api.getAllTags = async () => ({type: 'success'});
    await assert.rejects(f.provider.getChildren(f.server), /invalid tag list/);
    assert.equal(f.provider.serverTreeDataCache.size, 0);
    assert.equal(f.revocations.length, 0); assert.deepEqual(f.deleted, []);
    f.api.getAllTags = async () => ({type: 'success', tags: []});
    assert.deepEqual(await f.provider.getChildren(f.server), []);
});

test('the final synchronous tree builder rechecks an account change after the icon callback', async () => {
    const f = await fixture(); let replacement;
    f.api.getProjectsJson = async () => ({type: 'success', projects: [{id: 'old', name: 'old'}]});
    const icon = Promise.resolve();
    icon.then = callback => Promise.prototype.then.call(icon, value => {
        const mapped = callback(value);
        replacement = GlobalStateManager.loginServer(f.context, {cookiesLogin: async () => ({type: 'success',
            identity: {cookies: 'sid=other', csrfToken: 'other'}, userInfo: {userId: 'other', userEmail: 'synthetic'}})},
        'server', {cookies: 'sid=other'});
        return mapped;
    });
    f.provider.getOpenFolderIconPath = () => icon;
    await assert.rejects(f.provider.getChildren(f.server), /superseded/);
    assert.equal(await replacement, true);
    assert.equal(f.server.tags, undefined);
});

test('same-user credentials replaced externally while a refresh is pending cannot be revoked by that request', async () => {
    const f = await fixture(), entered = deferred(), response = deferred();
    f.api.getProjectsJson = () => { entered.resolve(); return response.promise; };
    f.api.userProjectsJson = async () => ({type: 'error', authenticationRequired: true, statusCode: 401});
    const rejected = assert.rejects(f.provider.getChildren(f.server), /superseded/);
    await entered.promise;
    f.context.state.server.login = {userId: 'owner', username: 'synthetic', identitySecretKey: 'other-window-session'};
    f.secrets.set('other-window-session', JSON.stringify({cookies: 'sid=other-window', csrfToken: 'other'}));
    response.resolve({type: 'error', authenticationRequired: true, statusCode: 401});
    await rejected; await settled();
    assert.equal(f.context.state.server.login.identitySecretKey, 'other-window-session');
    assert(!f.deleted.includes('other-window-session')); assert.equal(f.revocations.length, 0);
});

test('the captured session remains valid during its own legacy identity migration', async () => {
    const f = await fixture();
    f.context.state.server.login = {userId: 'owner', username: 'synthetic', identity: {cookies: 'sid=legacy', csrfToken: 'legacy'}};
    const current = GlobalStateManager.captureServerSessionGuard(f.context, 'server');
    assert.equal((await GlobalStateManager.authenticate(f.context, 'server')).cookies, 'sid=legacy');
    assert.equal(current(), true);
    assert.equal(f.context.state.server.login.identity, undefined);
    assert.equal(f.context.state.server.login.identitySecretKey, 'overleaf-workshop.serverIdentity.server');
});

test('pending logout preserves same-user credentials replaced externally before revocation completes', async () => {
    const f = await fixture(), entered = deferred(), response = deferred();
    f.api.logout = async () => { entered.resolve(); await response.promise; };
    const logout = GlobalStateManager.logoutServer(f.context, f.api, 'server');
    await entered.promise;
    f.context.state.server.login = {userId: 'owner', username: 'synthetic', identitySecretKey: 'other-window-session'};
    f.secrets.set('other-window-session', JSON.stringify({cookies: 'sid=other-window', csrfToken: 'other'}));
    response.resolve(); await logout;
    assert.equal(f.context.state.server.login.identitySecretKey, 'other-window-session');
    assert(!f.deleted.includes('other-window-session'));
    assert.equal((await GlobalStateManager.authenticate(f.context, 'server')).cookies, 'sid=other-window');
});

test('an old tree expiry yields to a newer pending login, while transport guards remain valid', async () => {
    const f = await fixture(), entered = deferred(), projects = deferred(), credentials = deferred();
    f.api.getProjectsJson = () => { entered.resolve(); return projects.promise; };
    f.api.userProjectsJson = async () => ({type: 'error', authenticationRequired: true, statusCode: 401});
    const treeFailure = assert.rejects(f.provider.getChildren(f.server));
    await entered.promise;
    const transportCurrent = GlobalStateManager.sessionGuard(f.context, 'server');
    const login = GlobalStateManager.loginServer(f.context, {cookiesLogin: () => credentials.promise}, 'server', {cookies: 'sid=new'});
    assert.equal(transportCurrent(), true, 'A pending refresh must not terminate an existing transport');
    projects.resolve({type: 'error', authenticationRequired: true, statusCode: 401});
    await treeFailure; await settled();
    credentials.resolve({type: 'success', identity: {cookies: 'sid=new', csrfToken: 'new'},
        userInfo: {userId: 'owner', userEmail: 'synthetic'}});
    assert.equal(await login, true, 'An obsolete tree must not cancel the newer verified sign-in');
    assert.equal(f.revocations.length, 0);
    assert.equal((await GlobalStateManager.authenticate(f.context, 'server')).cookies, 'sid=new');
});

test('explicit logout still cancels an in-flight replacement login', async () => {
    const f = await fixture(), credentials = deferred();
    const login = GlobalStateManager.loginServer(f.context, {cookiesLogin: () => credentials.promise}, 'server', {cookies: 'sid=new'});
    assert.equal(await GlobalStateManager.logoutServer(f.context, f.api, 'server'), true);
    credentials.resolve({type: 'success', identity: {cookies: 'sid=new', csrfToken: 'new'},
        userInfo: {userId: 'owner', userEmail: 'synthetic'}});
    assert.equal(await login, false);
    assert.equal(f.context.state.server.login, undefined);
});

test('a tree started during a pending login also yields instead of revoking the old session', async () => {
    const f = await fixture(), credentials = deferred();
    f.api.getProjectsJson = f.api.userProjectsJson = async () => ({type: 'error', statusCode: 401, authenticationRequired: true});
    const login = GlobalStateManager.loginServer(f.context, {cookiesLogin: () => credentials.promise}, 'server', {cookies: 'sid=new'});
    await assert.rejects(f.provider.getChildren(f.server)); await settled();
    credentials.resolve({type: 'success', identity: {cookies: 'sid=new', csrfToken: 'new'},
        userInfo: {userId: 'owner', userEmail: 'synthetic'}});
    assert.equal(await login, true);
    assert.equal(f.revocations.length, 0);
    assert.equal((await GlobalStateManager.authenticate(f.context, 'server')).cookies, 'sid=new');
});

test('failed login HTTP releases its pending intent so fresh confirmed expiry can still sign out', async () => {
    const f = await fixture();
    await assert.rejects(GlobalStateManager.loginServer(f.context, {cookiesLogin: async () => {throw new Error('Synthetic offline login');}},
        'server', {cookies: 'sid=new'}), /Synthetic offline login/);
    f.api.getProjectsJson = f.api.userProjectsJson = async () => ({type: 'error', statusCode: 401, authenticationRequired: true});
    await assert.rejects(f.provider.getChildren(f.server), error => error.code === 'SERVER_SESSION_EXPIRED');
    await settled(); assert.equal(f.revocations.length, 1);
    assert.equal(f.context.state.server.login, undefined);
});

test('explicit logout cancels a pending first login even before session metadata exists', async () => {
    const f = await fixture(), credentials = deferred();
    delete f.context.state.server.login;
    const login = GlobalStateManager.loginServer(f.context, {cookiesLogin: () => credentials.promise}, 'server', {cookies: 'sid=first'});
    assert.equal(await GlobalStateManager.logoutServer(f.context, f.api, 'server'), false);
    credentials.resolve({type: 'success', identity: {cookies: 'sid=first', csrfToken: 'first'},
        userInfo: {userId: 'owner', userEmail: 'synthetic'}});
    assert.equal(await login, false);
    assert.equal(f.context.state.server.login, undefined);
});
