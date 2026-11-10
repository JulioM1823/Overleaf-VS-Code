const test = require('node:test');
const assert = require('node:assert/strict');

const {
    BaseAPI,
    extractAuthenticatedUserContext,
    normalizeBaseApiUrl,
    normalizeCompileResponsePayload,
} = require('../out/api/base.js');
const { MockOverleafHttpServer } = require('./support/mockOverleafHttpServer.cjs');

test('extractAuthenticatedUserContext prefers ol-user JSON meta', () => {
    const body = `
        <meta name="ol-user" content="{&quot;_id&quot;:&quot;user-123&quot;,&quot;email&quot;:&quot;julio@example.com&quot;}">
        <meta name="ol-csrfToken" content="csrf-456">
    `;

    assert.deepEqual(extractAuthenticatedUserContext(body), {
        userId: 'user-123',
        userEmail: 'julio@example.com',
        csrfToken: 'csrf-456',
    });
});

test('extractAuthenticatedUserContext falls back to legacy user id meta', () => {
    const body = `
        <meta name="ol-user_id" content="legacy-user">
        <meta name="ol-usersEmail" content="legacy@example.com">
        <meta name="ol-csrfToken" content="csrf-legacy">
    `;

    assert.deepEqual(extractAuthenticatedUserContext(body), {
        userId: 'legacy-user',
        userEmail: 'legacy@example.com',
        csrfToken: 'csrf-legacy',
    });
});

test('extractAuthenticatedUserContext returns undefined without user id or csrf token', () => {
    const body = `<meta name="ol-user" content="{&quot;email&quot;:&quot;missing@example.com&quot;}">`;
    assert.equal(extractAuthenticatedUserContext(body), undefined);
});

test('normalizeBaseApiUrl requires HTTPS except for loopback development servers', () => {
    assert.equal(normalizeBaseApiUrl('https://example.com/sharelatex?token=secret#hash'), 'https://example.com/sharelatex/');
    assert.equal(normalizeBaseApiUrl('http://localhost:8080'), 'http://localhost:8080/');
    assert.equal(normalizeBaseApiUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/');
    assert.equal(normalizeBaseApiUrl('http://[::1]:8080'), 'http://[::1]:8080/');

    assert.throws(
        () => new BaseAPI('http://example.com'),
        /must use HTTPS unless it targets localhost/,
    );
    assert.throws(
        () => normalizeBaseApiUrl('ftp://example.com'),
        /must use http or https/,
    );
});

test('authenticated URLs reject embedded Basic Authentication credentials', async () => {
    assert.throws(()=>normalizeBaseApiUrl('https://username:password@example.com'),/embedded credentials/);
    const api=new BaseAPI('https://example.com').setIdentity({cookies:'sid=fake',csrfToken:'fake'});
    await assert.rejects(api.download('https://user:secret@example.com/project'),/credentials/);
});

test('downloads follow same-origin redirects and reject credential-bearing destinations', async t => {
    const server=await new MockOverleafHttpServer().start();t.after(()=>server.stop());
    server.addRoute('GET','/redirect',()=>({status:302,headers:{location:'/pdf'},body:'redirect'}));
    server.addRoute('GET','/pdf',({headers})=>{
        assert.equal(headers.cookie,'sid=fake'); return {status:200,body:Buffer.from('PDF contents')};
    });
    server.addRoute('GET','/unsafe',()=>({status:302,headers:{location:'https://user:secret@example.com/private'},body:'redirect'}));
    const api=new BaseAPI(server.baseUrl).setIdentity({cookies:'sid=fake',csrfToken:'fake'});
    assert.equal((await api.downloadWithRedirects('redirect')).toString(),'PDF contents');
    await assert.rejects(api.downloadWithRedirects('unsafe'),/insecure|unsupported/);
});

test('normalizeCompileResponsePayload preserves failed compile metadata', () => {
    const response = normalizeCompileResponsePayload({
        buildId: 'build-123',
        clsiServerId: 'clsi-a',
        errors: [{message: 'TeX failed'}],
        outputFiles: [{path: 'output.log', type: 'log'}],
        status: 'failure',
        validationProblems: [{message: 'root document issue'}],
    });

    assert.equal(response.status, 'failure');
    assert.equal(response.buildId, 'build-123');
    assert.equal(response.clsiServerId, 'clsi-a');
    assert.deepEqual(response.outputFiles, [{path: 'output.log', type: 'log'}]);
    assert.deepEqual(response.errors, [{message: 'TeX failed'}]);
    assert.deepEqual(response.validationProblems, [{message: 'root document issue'}]);
});

test('passportLogin succeeds when captcha preflight allows password login', async () => {
    const server = await new MockOverleafHttpServer({
        projectPage: {
            csrfToken: 'csrf-project',
            projectName: 'Password Login Project',
            userEmail: 'julio@example.com',
            userId: 'user-password',
        },
    }).start();
    server.addRoute('POST', '/login/can-skip-captcha', () => ({
        body: true,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        status: 200,
    }), 'login_can_skip_captcha');
    server.addRoute('POST', '/login', ({ body, headers }) => {
        const payload = JSON.parse(body.toString('utf8'));
        assert.equal(payload.email, 'julio@example.com');
        assert.equal(payload.password, 'secret-password');
        return {
            body: { redir: '/project' },
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'set-cookie': ['sharelatex.sid=session-password; Path=/; HttpOnly'],
            },
            status: 200,
        };
    }, 'password_login');

    try {
        const api = new BaseAPI(server.baseUrl);
        const response = await api.passportLogin('julio@example.com', 'secret-password');
        assert.equal(response.type, 'success');
        assert.deepEqual(response.userInfo, {
            userEmail: 'julio@example.com',
            userId: 'user-password',
        });
        assert.match(response.identity?.cookies ?? '', /sharelatex\.sid=session-password/);
    } finally {
        await server.stop();
    }
});

test('passportLogin fails fast when captcha cannot be skipped', async () => {
    const server = await new MockOverleafHttpServer().start();
    server.addRoute('POST', '/login/can-skip-captcha', () => ({
        body: false,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        status: 200,
    }), 'login_captcha_blocked');

    try {
        const api = new BaseAPI(server.baseUrl);
        const response = await api.passportLogin('julio@example.com', 'secret-password');
        assert.equal(response.type, 'error');
        assert.match(response.message ?? '', /CAPTCHA/i);
        assert.equal(server.events.filter((event) => event.label === 'password_login').length, 0);
    } finally {
        await server.stop();
    }
});

test('passportLogin preserves legacy login flow when captcha preflight is unavailable', async () => {
    const server = await new MockOverleafHttpServer({
        projectPage: {
            csrfToken: 'csrf-legacy',
            projectName: 'Legacy Login Project',
            userEmail: 'legacy@example.com',
            userId: 'user-legacy',
        },
    }).start();
    server.addRoute('POST', '/login', () => ({
        body: 'Found. Redirecting to /project',
        headers: {
            location: '/project',
            'content-type': 'text/plain; charset=utf-8',
            'set-cookie': ['sharelatex.sid=session-legacy; Path=/; HttpOnly'],
        },
        status: 302,
    }), 'password_login_legacy');

    try {
        const api = new BaseAPI(server.baseUrl);
        const response = await api.passportLogin('legacy@example.com', 'secret-password');
        assert.equal(response.type, 'success');
        assert.deepEqual(response.userInfo, {
            userEmail: 'legacy@example.com',
            userId: 'user-legacy',
        });
        assert.ok(server.events.some((event) => event.event === 'request.unhandled' && event.pathname === '/login/can-skip-captcha'));
    } finally {
        await server.stop();
    }
});

test('createCommentMessage tolerates undefined success payloads from the backend', async () => {
    const server = await new MockOverleafHttpServer().start();
    server.addRoute('POST', '/project/project-1/thread/thread-1/messages', ({ body }) => {
        const payload = JSON.parse(body.toString('utf8'));
        assert.equal(payload.content, 'Comment body');
        return {
            body: 'undefined',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            status: 201,
        };
    }, 'create_comment_message_undefined');

    try {
        const api = new BaseAPI(server.baseUrl);
        api.setIdentity({
            cookies: 'sharelatex.sid=test-session',
            csrfToken: 'csrf-token',
        });

        const response = await api.createCommentMessage({
            cookies: 'sharelatex.sid=test-session',
            csrfToken: 'csrf-token',
        }, 'project-1', 'thread-1', 'Comment body');

        assert.equal(response.type, 'success');
        assert.equal(response.commentMessage, undefined);
    } finally {
        await server.stop();
    }
});

test('sendMessage matches the browser chat request shape', async () => {
    const server = await new MockOverleafHttpServer().start();
    server.addRoute('POST', '/project/project-1/messages', ({ body, headers }) => {
        const payload = JSON.parse(body.toString('utf8'));
        assert.deepEqual(payload, {
            content: 'Hello world',
        });
        assert.equal(headers.accept, 'application/json');
        assert.equal(headers['accept-encoding'], 'gzip, deflate, br, zstd');
        assert.match(headers['accept-language'] ?? '', /^[a-z]{2}(-[A-Z]{2})?,/);
        assert.equal(headers['content-type'], 'application/json');
        assert.equal(headers.origin, server.baseUrl.replace(/\/$/, ''));
        assert.equal(headers.priority, 'u=3, i');
        assert.equal(headers.referer, `${server.baseUrl}project/project-1`);
        assert.equal(headers['sec-fetch-dest'], 'empty');
        assert.equal(headers['sec-fetch-mode'], 'cors');
        assert.equal(headers['sec-fetch-site'], 'same-origin');
        assert.match(headers['user-agent'] ?? '', /^Mozilla\/5\.0/);
        assert.equal(headers['x-csrf-token'], 'csrf-token');
        return {
            body: '',
            status: 204,
        };
    }, 'send_global_message');

    try {
        const api = new BaseAPI(server.baseUrl);
        const response = await api.sendMessage({
            cookies: 'sharelatex.sid=test-session',
            csrfToken: 'csrf-token',
        }, 'project-1', 'client-123', 'Hello world');

        assert.equal(response.type, 'success');
        assert.equal(response.statusCode, 204);
    } finally {
        await server.stop();
    }
});

test('getMessages uses same-origin headers for global chat history fetches', async () => {
    const server = await new MockOverleafHttpServer().start();
    server.addRoute('GET', '/project/project-1/messages', ({ headers, searchParams }) => {
        assert.equal(searchParams.get('limit'), '25');
        assert.equal(searchParams.get('before'), '123');
        assert.equal(headers.accept, 'application/json');
        assert.equal(headers['accept-encoding'], 'gzip, deflate, br, zstd');
        assert.match(headers['accept-language'] ?? '', /^[a-z]{2}(-[A-Z]{2})?,/);
        assert.equal(headers['content-type'], 'application/json');
        assert.equal(headers.origin, server.baseUrl.replace(/\/$/, ''));
        assert.equal(headers.priority, 'u=3, i');
        assert.equal(headers.referer, `${server.baseUrl}project/project-1`);
        assert.equal(headers['sec-fetch-dest'], 'empty');
        assert.equal(headers['sec-fetch-mode'], 'cors');
        assert.equal(headers['sec-fetch-site'], 'same-origin');
        assert.match(headers['user-agent'] ?? '', /^Mozilla\/5\.0/);
        assert.equal(headers['x-csrf-token'], 'csrf-token');
        return {
            body: [{
                content: 'history',
                id: 'message-1',
                timestamp: 123,
                user: {
                    email: 'ada@example.com',
                    first_name: 'Ada',
                    id: 'user-1',
                    last_name: 'Lovelace',
                },
                user_id: 'user-1',
            }],
            headers: { 'content-type': 'application/json; charset=utf-8' },
            status: 200,
        };
    }, 'get_global_messages');

    try {
        const api = new BaseAPI(server.baseUrl);
        const response = await api.getMessages({
            cookies: 'sharelatex.sid=test-session',
            csrfToken: 'csrf-token',
        }, 'project-1', 25, 123);

        assert.equal(response.type, 'success');
        assert.equal(response.messages.length, 1);
        assert.equal(response.messages[0].id, 'message-1');
    } finally {
        await server.stop();
    }
});

test('downloads advance HTTP byte ranges and never duplicate a repeated partial response', async () => {
    const server = await new MockOverleafHttpServer().start();
    let calls = 0;
    server.addRoute('GET', '/partial', () => (++calls === 1
        ? {status: 206, headers: {'content-range': 'bytes 0-2/6'}, body: Buffer.from('abc')}
        : {status: 206, headers: {'content-range': 'bytes 3-5/6'}, body: Buffer.from('def')}));
    server.addRoute('GET', '/stuck', () => ({status: 206, headers: {'content-range': 'bytes 0-2/6'}, body: Buffer.from('abc')}));
    server.addRoute('GET', '/missing', () => ({status: 404, body: 'not a document'}));
    try {
        const api = new BaseAPI(server.baseUrl).setIdentity({cookies: 'session=test', csrfToken: 'test'});
        assert.equal((await api.download('partial')).toString(), 'abcdef');
        assert.equal(calls, 2);
        await assert.rejects(api.download('stuck'), /range/);
        await assert.rejects(api.download('missing'), /404/);
    } finally { await server.stop(); }
});
