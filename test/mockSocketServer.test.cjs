const test = require('node:test');
const assert = require('node:assert/strict');

const { BaseAPI } = require('../out/api/base.js');
const { MockSocketServer } = require('./support/mockSocketServer.cjs');

test('MockSocketServer provides a legacy v1 handshake probe target', async () => {
    const server = await new MockSocketServer({
        mode: 'v1',
        sessionId: 'legacy-session',
        transports: ['websocket', 'xhr-polling'],
    }).start();

    try {
        const api = new BaseAPI(server.baseUrl);
        const probe = await api.probeRealtimeHandshake(
            { cookies: 'sharelatex.sid=abc', csrfToken: 'csrf' },
            {
                connectUrl: server.baseUrl.replace(/\/$/, ''),
                query: '',
                resource: 'socket.io',
                socketScriptUrl: `${server.baseUrl}socket.io/socket.io.js`,
            },
            'projectId=demo-project',
        );

        assert.equal(probe.status, 200);
        assert.equal(probe.metadata?.sessionId, 'legacy-session');
        assert.deepEqual(probe.metadata?.transports, ['websocket', 'xhr-polling']);
        assert.ok(server.events.some((entry) => entry.event === 'handshake.response'));
    } finally {
        await server.stop();
    }
});

test('MockSocketServer provides an engine.io style v2 handshake endpoint', async () => {
    const server = await new MockSocketServer({
        engineIoSid: 'engine-123',
        mode: 'v2',
        transports: ['websocket', 'polling'],
    }).start();

    try {
        const response = await fetch(server.buildHandshakeUrl('projectId=demo-project'));
        const body = await response.text();
        assert.equal(response.status, 200);
        assert.match(body, /^0\{/);
        assert.match(body, /"sid":"engine-123"/);
        assert.ok(server.events.some((entry) => entry.mode === 'v2' && entry.event === 'handshake.response'));
    } finally {
        await server.stop();
    }
});
