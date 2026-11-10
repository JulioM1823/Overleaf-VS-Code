const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {fetchWithLimits} = require('../out/api/httpTransport');
test('HTTP transport times out stalled responses and bounds decoded body size', {timeout: 2000}, async t => {
    const server = http.createServer((req, res) => {
        if (req.url === '/large') res.end('x'.repeat(1000));
        else if (req.url === '/body') {res.writeHead(200);res.write('partial');}
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => {server.closeAllConnections();return new Promise(resolve => server.close(resolve));});
    const url = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(fetchWithLimits(url, {timeout: 20}), /abort|timeout/);
    await assert.rejects((await fetchWithLimits(`${url}/large`, {size: 100})).text(), /over limit/);
    await assert.rejects((await fetchWithLimits(`${url}/body`, {timeout: 20})).text(), /abort|timeout/);
});
