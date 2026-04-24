const test = require('node:test');
const assert = require('node:assert/strict');

const { BaseAPI } = require('../out/api/base.js');
const { MockOverleafHttpServer } = require('./support/mockOverleafHttpServer.cjs');

test('MockOverleafHttpServer drives cookie login through the real BaseAPI parser', async () => {
    const server = await new MockOverleafHttpServer({
        projectPage: {
            csrfToken: 'csrf-mock',
            projectName: 'Harness Project',
            userEmail: 'julio@example.com',
            userId: 'user-789',
        },
    }).start();

    try {
        const api = new BaseAPI(server.baseUrl);
        const response = await api.cookiesLogin('sharelatex.sid=session-abc');
        assert.equal(response.type, 'success');
        assert.deepEqual(response.userInfo, {
            userEmail: 'julio@example.com',
            userId: 'user-789',
        });
        assert.equal(response.identity?.csrfToken, 'csrf-mock');

        const events = server.events.map((entry) => entry.event);
        assert.ok(events.includes('server.started'));
        assert.ok(events.includes('request.received'));
        assert.ok(events.includes('request.responded'));
    } finally {
        await server.stop();
    }
});

test('MockOverleafHttpServer supports custom routes with binary responses', async () => {
    const server = await new MockOverleafHttpServer().start();
    server.addRoute('GET', '/project/demo/download/zip', () => ({
        body: Buffer.from([1, 2, 3, 4]),
        headers: { 'content-type': 'application/zip' },
        status: 200,
    }), 'download_zip');

    try {
        const response = await fetch(`${server.baseUrl}project/demo/download/zip`);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(response.status, 200);
        assert.deepEqual(Array.from(bytes), [1, 2, 3, 4]);
        assert.ok(server.events.some((entry) => entry.label === 'download_zip'));
    } finally {
        await server.stop();
    }
});
