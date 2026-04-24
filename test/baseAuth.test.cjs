const test = require('node:test');
const assert = require('node:assert/strict');

const { BaseAPI, extractAuthenticatedUserContext } = require('../out/api/base.js');
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
