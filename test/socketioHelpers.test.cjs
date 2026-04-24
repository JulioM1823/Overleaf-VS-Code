const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildRealtimeHandshakeUrl,
    buildRealtimeHandshakeQuery,
    getSocketTransportOptions,
    getJoinProjectStrategy,
    parseRealtimeHandshakeResponse,
    getPreferredConnectionScheme,
    getSocketEmitTimeoutMs,
    nextConnectionSchemeOnJoinFailure,
    resolveSocketConnectionTarget,
    shouldForcePollingTransport,
} = require('../out/api/socketioHelpers.js');

test('nextConnectionSchemeOnJoinFailure keeps the legacy client on connection rejection', () => {
    assert.equal(
        nextConnectionSchemeOnJoinFailure('v1', 'connectionRejected'),
        'v1',
    );
});

test('nextConnectionSchemeOnJoinFailure keeps the legacy client on connect_failed', () => {
    assert.equal(
        nextConnectionSchemeOnJoinFailure('v1', 'connect_failed'),
        'v1',
    );
});

test('nextConnectionSchemeOnJoinFailure keeps the scheme unchanged for timeouts', () => {
    assert.equal(
        nextConnectionSchemeOnJoinFailure('v1', 'timeout'),
        'v1',
    );
    assert.equal(
        nextConnectionSchemeOnJoinFailure('v2', 'connect_failed'),
        'v2',
    );
    assert.equal(
        nextConnectionSchemeOnJoinFailure('Alt', 'connectionRejected'),
        'Alt',
    );
});

test('getSocketEmitTimeoutMs gives joinProject a longer bootstrap window', () => {
    assert.equal(getSocketEmitTimeoutMs('default'), 5000);
    assert.equal(getSocketEmitTimeoutMs('joinProject'), 20000);
});

test('getPreferredConnectionScheme defaults to the legacy client protocol', () => {
    assert.equal(getPreferredConnectionScheme('https://www.overleaf.com/'), 'v1');
    assert.equal(getPreferredConnectionScheme('https://sharelatex.example.com/'), 'v1');
});

test('getJoinProjectStrategy matches the shipped client behavior', () => {
    assert.equal(getJoinProjectStrategy('Alt'), 'emit_callback');
    assert.equal(getJoinProjectStrategy('v1'), 'handshake_auto_join');
    assert.equal(getJoinProjectStrategy('v2'), 'handshake_auto_join');
});

test('shouldForcePollingTransport no longer forces xhr-polling up front', () => {
    assert.equal(shouldForcePollingTransport('https://www.overleaf.com/'), false);
    assert.equal(shouldForcePollingTransport('https://sharelatex.example.com/'), false);
});

test('getSocketTransportOptions prefers websocket first before degrading to polling only', () => {
    assert.deepEqual(
        getSocketTransportOptions('https://www.overleaf.com/', 0),
        {
            'auto connect': false,
            transports: ['websocket', 'xhr-polling'],
            'try multiple transports': true,
        },
    );
    assert.deepEqual(
        getSocketTransportOptions('https://www.overleaf.com/', 3),
        {
            'auto connect': false,
            transports: ['xhr-polling'],
            'try multiple transports': true,
        },
    );
});

test('resolveSocketConnectionTarget uses the site socket endpoint by default', () => {
    assert.deepEqual(
        resolveSocketConnectionTarget('https://www.overleaf.com/project/123'),
        {
            connectUrl: 'https://www.overleaf.com',
            resource: 'socket.io',
            socketScriptUrl: 'https://www.overleaf.com/socket.io/socket.io.js',
            query: '',
        },
    );
});

test('resolveSocketConnectionTarget preserves a custom ws origin, resource, and query', () => {
    assert.deepEqual(
        resolveSocketConnectionTarget(
            'https://www.overleaf.com/project/123',
            'https://realtime.overleaf.com/realtime/socket.io?foo=bar&baz=1',
        ),
        {
            connectUrl: 'https://realtime.overleaf.com',
            resource: 'realtime/socket.io',
            socketScriptUrl: 'https://realtime.overleaf.com/realtime/socket.io/socket.io.js',
            query: 'foo=bar&baz=1',
        },
    );
});

test('buildRealtimeHandshakeQuery includes the project id in the initial socket handshake', () => {
    assert.equal(
        buildRealtimeHandshakeQuery('679e9632c4e6d540dfe00800', 1234567890),
        'projectId=679e9632c4e6d540dfe00800',
    );
});

test('buildRealtimeHandshakeUrl matches the legacy socket.io v0 handshake route', () => {
    assert.equal(
        buildRealtimeHandshakeUrl(
            {
                connectUrl: 'https://www.overleaf.com',
                resource: 'socket.io',
                socketScriptUrl: 'https://www.overleaf.com/socket.io/socket.io.js',
                query: '',
            },
            'projectId=679e9632c4e6d540dfe00800',
            1234567890,
        ),
        'https://www.overleaf.com/socket.io/1/?projectId=679e9632c4e6d540dfe00800&t=1234567890',
    );
});

test('parseRealtimeHandshakeResponse extracts the session id and transports', () => {
    assert.deepEqual(
        parseRealtimeHandshakeResponse('abc123:15:60:websocket,xhr-polling'),
        {
            sessionId: 'abc123',
            heartbeatTimeoutSeconds: 15,
            closeTimeoutSeconds: 60,
            transports: ['websocket', 'xhr-polling'],
        },
    );
});

test('parseRealtimeHandshakeResponse returns undefined for unexpected payloads', () => {
    assert.equal(parseRealtimeHandshakeResponse(''), undefined);
    assert.equal(parseRealtimeHandshakeResponse('abc123:not-a-number:60:websocket'), undefined);
    assert.equal(parseRealtimeHandshakeResponse('abc123:15:60'), undefined);
});
