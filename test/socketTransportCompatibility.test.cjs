const test = require('node:test');
const assert = require('node:assert/strict');
const {once} = require('node:events');
const {WebSocketServer} = require('ws');
const io = require('socket.io-client');
const {execFileSync} = require('node:child_process');

test('legacy transport loads without touching VS Code\'s guarded navigator global', () => {
    execFileSync(process.execPath, ['-e',
        "Object.defineProperty(globalThis, 'navigator', {configurable: true, get() {throw new Error('VS Code navigator migration guard');}}); require('socket.io-client');"],
        {cwd: require('node:path').resolve(__dirname, '..')});
});

test('legacy Socket.IO transport works with patched ws for headers, Unicode messages and close', {timeout: 5000}, async t => {
    const server = new WebSocketServer({port: 0, host: '127.0.0.1'});
    await once(server, 'listening');
    t.after(() => { for (const peer of server.clients) peer.terminate(); return new Promise(resolve => server.close(resolve)); });
    const connection = once(server, 'connection');
    const transport = new io.Transport.websocket({options: {query: ''}});
    transport.prepareUrl = () => `ws://127.0.0.1:${server.address().port}/socket.io/1/websocket/session`;
    transport.socket.setBuffer = () => {};
    let opened; const open = new Promise(resolve => opened = resolve);
    transport.onOpen = opened; transport.onClose = () => {}; transport.onError = error => {throw error;};
    let received; const message = new Promise(resolve => received = resolve);
    transport.onData = received;
    transport.open({Cookie: 'session=test'});
    await open;
    const [peer, request] = await connection;
    assert.equal(request.headers.cookie, 'session=test');
    peer.send('5:::Unicode 漢字 😀');
    assert.equal(await message, '5:::Unicode 漢字 😀');
    const incoming = once(peer, 'message'); transport.send('3:::client');
    assert.equal(String((await incoming)[0]), '3:::client');
    const closed = once(peer, 'close'); transport.close(); await closed;
});
