const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const events=[];
const warnings=[];
Module._load=function(request,parent,main) {
    if (request==='vscode') return {workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback})},
        window:{showWarningMessage:message=>warnings.push(message),showErrorMessage:()=>{}},l10n:{t:message=>message}};
    if (parent?.filename.endsWith('/utils/globalStateManager.js')) {
        if (request==='../api/socketio' || request==='../api/extendedBase') return {};
        if (request==='./eventBus') return {EventBus:{fire:(name,payload)=>events.push({name,payload})}};
    }
    return originalLoad.call(this,request,parent,main);
};
const {GlobalStateManager} = require('../out/utils/globalStateManager');
function context() {
    const state={server:{url:'https://server/',login:{userId:'first',username:'example',identitySecretKey:'test-session'}}};
    const deleted=[];
    return {state,deleted,globalState:{get:()=>state,update:async()=>{}},
        secrets:{get:async()=>JSON.stringify({cookies:'sid=fake',csrfToken:'fake'}),delete:async key=>deleted.push(key)}};
}
test('logout closes live sessions and removes local credentials even when remote revocation fails', async()=>{
    const ctx=context();events.length=0;
    assert.equal(await GlobalStateManager.logoutServer(ctx,{logout:async()=>{throw new Error('offline');}},'server'),true);
    assert.equal(ctx.state.server.login,undefined);assert.deepEqual(ctx.deleted,['test-session']);
    assert.deepEqual(events,[{name:'serverSessionEndedEvent',payload:{serverName:'server'}}]);
    await assert.rejects(GlobalStateManager.authenticate(ctx,'server'),/sign in|authenticated|logged in/i);
});

function deferred() {
    let resolve;
    const promise = new Promise(done => {resolve=done;});
    return {promise, resolve};
}

test('delayed credential reads cannot authenticate after server removal', async () => {
    const ctx=context(); const gate=deferred();
    ctx.secrets.get=()=>gate.promise;
    const authentication=GlobalStateManager.authenticate(ctx,'server');
    const rejected=assert.rejects(authentication,/sign in|authenticated|logged in/i);
    assert.equal(GlobalStateManager.removeServer(ctx,'server'),true);
    gate.resolve(JSON.stringify({cookies:'sid=old-session',csrfToken:'old'}));
    await rejected;
    GlobalStateManager.addServer(ctx,'server','https://server/');
    ctx.state.server.login={userId:'first',username:'example',identitySecretKey:'test-session'};
    ctx.secrets.get=async()=>undefined;
    await assert.rejects(GlobalStateManager.authenticate(ctx,'server'),/sign in|authenticated|logged in/i);
});

test('logout rejects new authentication while remote revocation is pending', async () => {
    const ctx=context(); const entered=deferred(); const gate=deferred();
    const logout=GlobalStateManager.logoutServer(ctx,{logout:async()=>{entered.resolve();await gate.promise;}},'server');
    await entered.promise;
    await assert.rejects(GlobalStateManager.authenticate(ctx,'server'),/sign in|authenticated|logged in/i);
    assert.throws(()=>GlobalStateManager.assertActiveServerSession(ctx,'server','first'),/session has ended/);
    gate.resolve(); assert.equal(await logout,true);
});

test('delayed login responses do not recreate a removed server', async () => {
    const ctx=context(); delete ctx.state.server.login;
    const gate=deferred(); let stores=0;ctx.secrets.store=async()=>{stores++;};
    const login=GlobalStateManager.loginServer(ctx,{cookiesLogin:()=>gate.promise},'server',{cookies:'sid=login'});
    GlobalStateManager.removeServer(ctx,'server');
    gate.resolve({type:'success',identity:{cookies:'sid=login',csrfToken:'login'},userInfo:{userId:'first',userEmail:'example'}});
    assert.equal(await login,false);
    assert.equal(ctx.state.server,undefined); assert.equal(stores,0);
});

test('a credential store finishing after removal is cleaned up without resurrecting state', async () => {
    const ctx=context(); delete ctx.state.server.login;
    const entered=deferred();const gate=deferred();
    ctx.secrets.store=async()=>{entered.resolve();await gate.promise;};
    const login=GlobalStateManager.loginServer(ctx,{cookiesLogin:async()=>({type:'success',
        identity:{cookies:'sid=login',csrfToken:'login'},userInfo:{userId:'first',userEmail:'example'}})},'server',{cookies:'sid=login'});
    await entered.promise;
    const key=ctx.state.server.login.identitySecretKey;
    GlobalStateManager.removeServer(ctx,'server'); gate.resolve();
    assert.equal(await login,false); assert.equal(ctx.state.server,undefined);
    assert.equal(ctx.deleted.filter(candidate=>candidate===key).length,2);
});

test('late project list fetches do not restore removed session metadata', async () => {
    const ctx=context();const entered=deferred();const gate=deferred();
    const fetching=GlobalStateManager.fetchServerProjects(ctx,{getProjectsJson:async()=>{entered.resolve();return gate.promise;}},'server');
    await entered.promise;
    GlobalStateManager.removeServer(ctx,'server');
    gate.resolve({type:'success',projects:[{id:'private-project'}]});
    assert.deepEqual(await fetching,[]); assert.equal(ctx.state.server,undefined);
});

test('credential caches are isolated across extension contexts', async () => {
    const first=context(); const second=context();
    first.secrets.get=async()=>JSON.stringify({cookies:'sid=first',csrfToken:'first'});
    second.secrets.get=async()=>JSON.stringify({cookies:'sid=second',csrfToken:'second'});
    assert.equal((await GlobalStateManager.authenticate(first,'server')).cookies,'sid=first');
    assert.equal((await GlobalStateManager.authenticate(second,'server')).cookies,'sid=second');
});

test('failed secret deletion is visible while the local session remains ended', async () => {
    const ctx=context();warnings.length=0;
    ctx.secrets.delete=async()=>{throw new Error('keychain unavailable');};
    assert.equal(await GlobalStateManager.logoutServer(ctx,{logout:async()=>{}},'server'),true);
    assert.equal(ctx.state.server.login,undefined);
    assert.equal(warnings.length,1); assert.match(warnings[0],/could not delete its stored credentials/);
    await assert.rejects(GlobalStateManager.authenticate(ctx,'server'),/sign in|authenticated|logged in/i);
});

test('socket credentials cannot overwrite a different account session', async () => {
    const ctx=context();ctx.secrets.store=()=>assert.fail('must not store another account identity');
    assert.equal(await GlobalStateManager.updateServerIdentity(ctx,'server',{cookies:'sid=other',csrfToken:'other'},'second'),false);
});

test('SecretStorage failure preserves a memory-only session without storing plaintext in global state', async () => {
    const ctx=context();delete ctx.state.server.login;
    ctx.secrets.store=async()=>{throw new Error('keychain unavailable');};
    ctx.secrets.get=async()=>undefined;
    const login=await GlobalStateManager.loginServer(ctx,{cookiesLogin:async()=>({type:'success',
        identity:{cookies:'sid=memory',csrfToken:'memory'},userInfo:{userId:'first',userEmail:'example'}})},'server',{cookies:'sid=memory'});
    assert.equal(login,true);assert.equal(ctx.state.server.login.identity,undefined);
    assert.equal((await GlobalStateManager.authenticate(ctx,'server')).cookies,'sid=memory');
    assert.doesNotThrow(()=>GlobalStateManager.assertActiveServerSession(ctx,'server','first'));
});

test('a late logout cannot delete credentials belonging to a replacement session', async () => {
    const ctx=context();const entered=deferred();const gate=deferred();
    const logout=GlobalStateManager.logoutServer(ctx,{logout:async()=>{entered.resolve();await gate.promise;}},'server');
    await entered.promise;
    GlobalStateManager.removeServer(ctx,'server');
    GlobalStateManager.addServer(ctx,'server','https://server/');
    ctx.state.server.login={userId:'second',username:'new',identitySecretKey:'replacement-session'};
    gate.resolve();await logout;
    assert.equal(ctx.state.server.login.userId,'second');
    assert.equal(ctx.deleted.includes('replacement-session'),false);
});
test('HTTP and socket initialization reject another project account before loading secrets', async()=>{
    const ctx=context();ctx.secrets.get=()=>assert.fail('must not load credentials');
    await assert.rejects(GlobalStateManager.authenticate(ctx,'server','second'),/different signed-in account/);
    await assert.rejects(GlobalStateManager.initSocketIOAPI(ctx,'server','project','second'),/does not match/);
});

test('explicit cookie sign-in refreshes an existing session without revoking the browser session', async () => {
    const ctx=context();events.length=0;const stored=[];
    ctx.secrets.store=async(key,value)=>stored.push({key,value});
    assert.equal(await GlobalStateManager.loginServer(ctx,{cookiesLogin:async()=>({type:'success',
        identity:{cookies:'sid=fresh',csrfToken:'fresh'},userInfo:{userId:'first',userEmail:'example'}})},'server',{cookies:'sid=fresh'}),true);
    assert.equal(stored.length,1);assert.deepEqual(ctx.deleted,['test-session']);
    assert.notEqual(ctx.state.server.login.identitySecretKey,'test-session');
    assert.equal((await GlobalStateManager.authenticate(ctx,'server')).cookies,'sid=fresh');
    assert.deepEqual(events,[{name:'serverSessionEndedEvent',payload:{serverName:'server'}}]);
});
test('failed replacement credentials preserve the working session and stored secret', async () => {
    const ctx=context();events.length=0;
    ctx.secrets.store=()=>assert.fail('failed credentials must not be stored');
    assert.equal(await GlobalStateManager.loginServer(ctx,{cookiesLogin:async()=>({type:'error'})},'server',{cookies:'sid=invalid'}),false);
    assert.equal(ctx.state.server.login.identitySecretKey,'test-session');assert.deepEqual(ctx.deleted,[]);
    assert.deepEqual(events,[]);assert.equal((await GlobalStateManager.authenticate(ctx,'server')).cookies,'sid=fake');
});
test('pending and failed cookie refresh leave existing transport guards valid', async () => {
    const ctx=context(), gate=deferred();
    const guard=GlobalStateManager.sessionGuard(ctx,'server');
    const login=GlobalStateManager.loginServer(ctx,{cookiesLogin:()=>gate.promise},'server',{cookies:'sid=invalid'});
    assert.equal(guard(),true);
    assert.equal((await GlobalStateManager.authenticate(ctx,'server')).cookies,'sid=fake');
    gate.resolve({type:'error'});assert.equal(await login,false);assert.equal(guard(),true);
});
test('only the latest verified refresh replaces the session and invalidates its old guards', async () => {
    const ctx=context(), first=deferred(), second=deferred();ctx.secrets.store=async()=>{};
    const guard=GlobalStateManager.sessionGuard(ctx,'server');
    const older=GlobalStateManager.loginServer(ctx,{cookiesLogin:()=>first.promise},'server',{cookies:'sid=older'});
    const newer=GlobalStateManager.loginServer(ctx,{cookiesLogin:()=>second.promise},'server',{cookies:'sid=newer'});
    first.resolve({type:'success',identity:{cookies:'sid=older',csrfToken:'old'},userInfo:{userId:'first',userEmail:'example'}});
    assert.equal(await older,false);assert.equal(guard(),true);
    second.resolve({type:'success',identity:{cookies:'sid=newer',csrfToken:'new'},userInfo:{userId:'first',userEmail:'example'}});
    assert.equal(await newer,true);assert.equal(guard(),false);
    assert.equal((await GlobalStateManager.authenticate(ctx,'server')).cookies,'sid=newer');
});
test('a verified memory-only refresh removes the obsolete stored credential', async () => {
    const ctx=context();ctx.secrets.store=async()=>{throw new Error('keychain unavailable');};
    const result=await GlobalStateManager.loginServer(ctx,{cookiesLogin:async()=>({type:'success',
        identity:{cookies:'sid=memory',csrfToken:'memory'},userInfo:{userId:'first',userEmail:'example'}})},'server',{cookies:'sid=memory'});
    assert.equal(result,true);assert.deepEqual(ctx.deleted,['test-session']);
    assert.equal((await GlobalStateManager.authenticate(ctx,'server')).cookies,'sid=memory');
    assert.equal(ctx.state.server.login.identity,undefined);
});
test('a pending logout cannot remove credentials refreshed on the same server object', async () => {
    const ctx=context();const entered=deferred(),gate=deferred();ctx.secrets.store=async()=>{};
    const logout=GlobalStateManager.logoutServer(ctx,{logout:async()=>{entered.resolve();await gate.promise;}},'server');
    await entered.promise;
    await GlobalStateManager.loginServer(ctx,{cookiesLogin:async()=>({type:'success',
        identity:{cookies:'sid=new',csrfToken:'new'},userInfo:{userId:'first',userEmail:'example'}})},'server',{cookies:'sid=new'});
    const refreshed=ctx.state.server.login.identitySecretKey;gate.resolve();await logout;
    assert.equal(ctx.state.server.login.identitySecretKey,refreshed);assert(!ctx.deleted.includes(refreshed));
    assert.equal((await GlobalStateManager.authenticate(ctx,'server')).cookies,'sid=new');
});
