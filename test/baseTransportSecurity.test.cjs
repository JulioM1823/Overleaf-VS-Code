const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const {Response} = require('node-fetch');
const {Readable} = require('node:stream');
const response = (body, options) => new Response(Readable.from([Buffer.from(body)]), options);
let handler;
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
    if (parent?.filename.endsWith('/api/base.js') && request === './httpTransport') {
        return {fetchWithLimits: (url, options) => handler(url, options)};
    }
    return originalLoad.call(this, request, parent, main);
};
const {BaseAPI} = require('../out/api/base');
Module._load = originalLoad;

test('HTTPS archive redirects keep credentials at the configured origin', async () => {
    const calls = [];
    const redirect = response('redirect', {status:302, headers:{location:'https://assets.example/output.pdf?signature=download'}});
    handler = async (url, options) => {
        calls.push({url, options});
        return calls.length === 1 ? redirect : response('PDF contents');
    };
    const api = new BaseAPI('https://server.example').setIdentity({cookies:'sid=private',csrfToken:'private'});
    assert.equal((await api.downloadWithRedirects('archive')).toString(), 'PDF contents');
    assert.equal(calls[0].options.headers.Cookie, 'sid=private');
    assert.equal(calls[1].options.headers.Cookie, undefined);
    assert.equal(calls[1].options.headers.Authorization, undefined);
    assert.equal(calls[1].options.headers['X-Csrf-Token'], undefined);
    assert.equal(calls[1].options.agent, undefined); // Use the destination's normal verified TLS agent.
    assert.equal(calls[1].url, 'https://assets.example/output.pdf?signature=download');
    assert.equal(redirect.body.destroyed, true);
});

test('cross-origin bootstrap headers cannot replace session cookies and unused bodies are destroyed', async () => {
    const api = new BaseAPI('https://server.example');
    api.getUserId = async () => undefined;
    const bootstrapResponse = response('script body', {headers:{'set-cookie':'sid=attacker; Path=/'}});
    handler = async (url, options) => {
        assert.equal(url, 'https://assets.example/socket.io.js');
        assert.equal(options.headers.Cookie, undefined);
        assert.equal(options.agent, undefined);
        return bootstrapResponse;
    };
    const identity = await api.updateCookies({cookies:'sid=private',csrfToken:'private'}, 'https://assets.example/socket.io.js');
    assert.equal(identity.cookies, 'sid=private');
    assert.equal(bootstrapResponse.body.destroyed, true);
});

test('same-origin bootstrap retains cookie rotation and rejects unsafe custom URLs', async () => {
    const api = new BaseAPI('https://server.example');
    api.getUserId = async () => undefined;
    const bootstrapResponse = response('script body', {headers:{'set-cookie':'sid=rotated; Path=/'}});
    handler = async (_url, options) => {
        assert.equal(options.headers.Cookie, 'sid=private');return bootstrapResponse;
    };
    assert.equal((await api.updateCookies({cookies:'sid=private',csrfToken:'private'})).cookies, 'sid=rotated');
    assert.equal(bootstrapResponse.body.destroyed, true);
    handler = () => assert.fail('Unsafe URLs must not be requested');
    for (const url of ['http://assets.example/socket.io.js', 'https://user:password@server.example/socket.io.js', 'file:///private/socket.io.js']) {
        await assert.rejects(api.updateCookies({cookies:'sid=private',csrfToken:'private'}, url), /insecure|credential-bearing/);
    }
});

test('upload success requires a confirmed valid entity instead of accepting malformed HTTP 200 responses', async () => {
    const api=new BaseAPI('https://server.example');
    for (const payload of [{success:false}, {success:true,entity_id:'invalid',entity_type:'doc'},
        {success:true,entity_id:'123456789abcdef012345678',entity_type:'folder'}]) {
        handler=async()=>response(JSON.stringify(payload));
        const result=await api.uploadFile({cookies:'sid=private',csrfToken:'private'},'project','root','main.tex',Buffer.from('draft'));
        assert.equal(result.type,'error');assert.equal(result.entity,undefined);
    }
    handler=async()=>response(JSON.stringify({success:true,entity_id:'123456789abcdef012345678',entity_type:'doc'}));
    const result=await api.uploadFile({cookies:'sid=private',csrfToken:'private'},'project','root','main.tex',Buffer.from('draft'));
    assert.equal(result.type,'success');assert.equal(result.entity.name,'main.tex');
});

test('compile artifacts retain worker routing and existing parameters without exposing cookies to another origin', async () => {
    const api = new BaseAPI('https://server.example/overleaf/');
    const identity={cookies:'sid=private',csrfToken:'private'};
    handler=async()=>response(JSON.stringify({status:'success',compileGroup:'priority',clsiServerId:'worker-a',
        outputFiles:[{path:'output.pdf',url:'/project/p/build/b/output/output.pdf?existing=value'}]}));
    const result=await api.compile(identity,'p','main.tex');
    assert.equal(result.type,'success');
    const url=new URL(result.compile.outputFiles[0].url);
    assert.equal(url.searchParams.get('compileGroup'),'priority');
    assert.equal(url.searchParams.get('clsiserverid'),'worker-a');
    assert.equal(url.searchParams.get('existing'),'value');
    handler=async (url,options)=>{
        assert.equal(new URL(url).searchParams.get('clsiserverid'),'worker-a');
        assert.equal(new URL(url).searchParams.get('compileGroup'),'priority');
        assert.equal(options.headers.Cookie,identity.cookies);
        return response('%PDF-fixture');
    };
    await api.getFileFromClsi(identity,url.toString(),'standard');
    handler=async()=>assert.fail('Foreign artifact URLs must fail before a request');
    await assert.rejects(api.getFileFromClsi(identity,'//foreign.example/output.pdf','standard'),/different origin/);
});
test('cached compile artifacts route to the cache shard and legacy downloads receive their compile group', async () => {
    const api=new BaseAPI('https://server.example'),identity={cookies:'sid=private',csrfToken:'private'};
    handler=async()=>response(JSON.stringify({status:'success',fromCache:true,clsiCacheShard:'cache-a',
        outputFiles:[{path:'output.log',url:'/project/p/output.log'}]}));
    const result=await api.compile(identity,'p','main.tex');
    assert.equal(new URL(result.compile.outputFiles[0].url).searchParams.get('clsiserverid'),'cache-a');
    handler=async url=>{
        assert.equal(new URL(url).searchParams.get('compileGroup'),'standard');return response('compiler log');
    };
    await api.getFileFromClsi(identity,'/project/p/output.log','standard');
});
