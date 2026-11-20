const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const io = require('socket.io-client');
const {XMLHttpRequest} = require('xmlhttprequest');
const tlsFixture = require('./support/legacyXhrTls.cjs');

async function serve(t, handler, host = '127.0.0.1', tlsOptions) {
    const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, resolve);
    });
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    return {server, origin: `${tlsOptions ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`};
}

function request(url, {method = 'GET', body, onRequest, headers = {}} = {}) {
    const xhr = new XMLHttpRequest();
    const done = new Promise(resolve => {
        xhr.onreadystatechange = () => {
            if (xhr.readyState===xhr.DONE) { resolve(xhr); }
        };
    });
    xhr.open(method, url, true);
    xhr.setDisableHeaderCheck(true);
    xhr.setRequestHeader('Cookie', 'sid=synthetic-security-fixture');
    for (const [name, value] of Object.entries(headers)) { xhr.setRequestHeader(name, value); }
    xhr.send(body);
    onRequest?.(xhr);
    return done;
}

test('legacy XHR refuses to forward a session cookie to a different origin port', {timeout: 5000}, async t => {
    const received = [];
    const destination = await serve(t, (req, res) => {
        received.push(req.headers.cookie);
        res.end('foreign response');
    });
    const source = await serve(t, (req, res) => {
        res.writeHead(Number(new URL(req.url, 'http://fixture').searchParams.get('status')), {Location: `${destination.origin}/collect`});
        res.end('redirect body');
    });
    for (const status of [301, 302, 303, 307, 308]) {
        const result = await request(`${source.origin}/socket.io/1/?status=${status}`);
        assert.equal(received.length, 0, 'the redirect destination must receive no authenticated request');
        assert.equal(result.status, 0);
        assert.match(String(result.statusText), /redirect/i);
    }
});

test('legacy XHR preserves authenticated same-origin absolute redirects', {timeout: 5000}, async t => {
    let source;
    const received = [];
    source = await serve(t, (req, res) => {
        received.push({url: req.url, cookie: req.headers.cookie, host: req.headers.host});
        if (req.url==='/start') {
            res.writeHead(302, {Location: `${source.origin}/finish`});
            res.end('redirect body');
        } else { res.end('same-origin response'); }
    });
    const result = await request(`${source.origin}/start`);
    assert.equal(result.status, 200);
    assert.equal(result.responseText, 'same-origin response');
    assert.deepEqual(received.map(item => item.url), ['/start', '/finish']);
    assert(received.every(item => item.cookie==='sid=synthetic-security-fixture'));
    assert(received.every(item => item.host===new URL(source.origin).host));
});

test('the installed Socket.IO handshake cannot bypass the dependency redirect boundary', {timeout: 5000}, async t => {
    let foreignRequests = 0;
    const destination = await serve(t, (_req, res) => {
        foreignRequests++;
        res.end('session:15:60:xhr-polling');
    });
    const source = await serve(t, (req, res) => {
        assert.equal(req.headers.cookie, 'sid=synthetic-security-fixture');
        res.writeHead(302, {Location: `${destination.origin}/collect`});
        res.end();
    });
    const socket = new io.Socket({host: '127.0.0.1', port: source.server.address().port,
        'auto connect': false, extraHeaders: {Cookie: 'sid=synthetic-security-fixture'}});
    const failed = new Promise(resolve => socket.on('error', resolve));
    socket.handshake(() => assert.fail('the redirected handshake must not succeed'));
    assert.match(String(await failed), /redirect/i);
    assert.equal(foreignRequests, 0);
});

test('relative redirects resolve against each preceding URL and retain canonical Host', {timeout: 5000}, async t => {
    const received = [];
    const source = await serve(t, (req, res) => {
        received.push({url: req.url, host: req.headers.host});
        const locations = {'/folder/start': '../next/step', '/next/step': 'finish?value=1#ignored'};
        if (locations[req.url]) { res.writeHead(302, {Location: locations[req.url]}); }
        res.end('response');
    });
    const result = await request(`${source.origin}/folder/start`);
    assert.equal(result.status, 200);
    assert.deepEqual(received.map(item => item.url), ['/folder/start', '/next/step', '/next/finish?value=1']);
    assert(received.every(item => item.host===new URL(source.origin).host));
});

test('canonical equivalent hostname and port spellings remain same-origin', {timeout: 5000}, async t => {
    let source;
    source = await serve(t, (req, res) => {
        assert.equal(req.headers.host, new URL(source.origin).host);
        if (req.url==='/start') {
            res.writeHead(302, {Location: `http://2130706433:00${source.server.address().port}/finish`});
        }
        res.end('response');
    });
    assert.equal((await request(`${source.origin}/start`)).status, 200);
});

test('unsafe redirect destinations fail before another HTTP request is made', {timeout: 5000}, async t => {
    const received = [];
    let source;
    const destinations = [
        () => `https://127.0.0.1:${source.server.address().port}/finish`,
        () => `http://user:password@127.0.0.1:${source.server.address().port}/finish`,
        () => `http://%75ser@127.0.0.1:${source.server.address().port}/finish`,
        () => 'file:///private/security-fixture',
        () => 'data:text/plain,security-fixture',
        () => 'http://[invalid',
        () => '',
    ];
    source = await serve(t, (req, res) => {
        received.push(req.url);
        const index = Number(req.url.slice(1));
        res.writeHead(302, {Location: destinations[index]()});
        res.end();
    });
    for (let index = 0; index < destinations.length; index++) {
        const result = await request(`${source.origin}/${index}`);
        assert.equal(result.status, 0, `destination ${index} must fail closed`);
        assert.match(String(result.statusText), /redirect|invalid url/i);
    }
    assert.deepEqual(received, destinations.map((_item, index) => `/${index}`));
});

test('a real HTTPS-to-HTTP downgrade fails before a redirected request', {timeout: 5000}, async t => {
    let destinationRequests = 0;
    const destination = await serve(t, (_req, res) => {
        destinationRequests++;
        res.end();
    });
    let sourceRequests = 0;
    const source = await serve(t, (_req, res) => {
        sourceRequests++;
        res.writeHead(302, {Location: `${destination.origin}/finish`});
        res.end();
    }, '127.0.0.1', tlsFixture);
    const originalRequest = https.request;
    t.mock.method(https, 'request', (options, callback) => originalRequest({...options, ca: tlsFixture.cert}, callback));
    const result = await request(`${source.origin}/start`);
    assert.equal(result.status, 0);
    assert.match(String(result.statusText), /cross-origin.*redirect/i);
    assert.equal(sourceRequests, 1);
    assert.equal(destinationRequests, 0);
});

for (const status of [301, 302, 303, 307, 308]) {
    test(`same-origin HTTP ${status} redirects preserve appropriate POST semantics`, {timeout: 5000}, async t => {
        let received;
        const source = await serve(t, (req, res) => {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                if (req.url==='/start') { res.writeHead(status, {Location: '/finish'}); }
                else { received = {method: req.method, body: Buffer.concat(chunks).toString(), length: req.headers['content-length']}; }
                res.end('response');
            });
        });
        const result = await request(`${source.origin}/start`, {method: 'POST', body: 'Unicode 漢字 😀'});
        assert.equal(result.status, 200);
        if (status===307 || status===308) {
            assert.equal(received.method, 'POST');
            assert.equal(received.body, 'Unicode 漢字 😀');
            assert.equal(Number(received.length), Buffer.byteLength(received.body));
        } else {
            assert.equal(received.method, 'GET');
            assert.equal(received.body, '');
            assert.equal(received.length, undefined);
        }
    });
}

test('redirect loops stop after five hops', {timeout: 5000}, async t => {
    let requests = 0;
    const source = await serve(t, (_req, res) => {
        requests++;
        res.writeHead(302, {Location: '/loop'});
        res.end();
    });
    const result = await request(`${source.origin}/loop`);
    assert.equal(result.status, 0);
    assert.match(String(result.statusText), /redirect limit/i);
    assert.equal(requests, 6);
});

test('redirect bodies are destroyed even when the server never finishes streaming', {timeout: 5000}, async t => {
    let closed;
    const closedResponse = new Promise(resolve => closed = resolve);
    const source = await serve(t, (req, res) => {
        if (req.url==='/start') {
            res.once('close', closed);
            res.writeHead(302, {Location: '/finish'});
            res.write('unfinished redirect body');
        } else { res.end('finished'); }
    });
    const result = await request(`${source.origin}/start`);
    assert.equal(result.status, 200);
    await closedResponse;
});

test('abort destroys the current redirected response and its socket', {timeout: 5000}, async t => {
    let xhr;
    let closed;
    const closedResponse = new Promise(resolve => closed = resolve);
    const source = await serve(t, (req, res) => {
        if (req.url==='/start') { res.writeHead(302, {Location: '/slow'}); res.end(); }
        else {
            res.once('close', closed);
            res.write('unfinished final body');
            xhr.abort();
        }
    });
    const result = await request(`${source.origin}/start`, {onRequest: value => xhr = value});
    assert.equal(result.status, 0);
    await closedResponse;
});

test('IPv6 loopback supports an authenticated request and same-origin relative redirect', {timeout: 5000}, async t => {
    const received = [];
    const source = await serve(t, (req, res) => {
        received.push({url: req.url, host: req.headers.host, cookie: req.headers.cookie});
        if (req.url==='/start') { res.writeHead(302, {Location: '/finish'}); }
        res.end('IPv6 response');
    }, '::1');
    const result = await request(`${source.origin}/start`);
    assert.equal(result.status, 200);
    assert.equal(result.responseText, 'IPv6 response');
    assert.deepEqual(received.map(item => item.url), ['/start', '/finish']);
    assert(received.every(item => item.host===new URL(source.origin).host));
    assert(received.every(item => item.cookie==='sid=synthetic-security-fixture'));
});

function reopen(xhr, url) {
    return new Promise(resolve => {
        xhr.onreadystatechange = () => {
            if (xhr.readyState===xhr.DONE) { resolve(xhr); }
        };
        xhr.open('GET', url, true);
        xhr.send();
    });
}

test('reopening an XHR does not retain previous Cookie or Authorization headers', {timeout: 5000}, async t => {
    const source = await serve(t, (_req, res) => res.end('first response'));
    let received;
    const destination = await serve(t, (req, res) => {
        received = req.headers;
        res.end('second response');
    });
    const xhr = await request(`${source.origin}/first`, {headers: {Authorization: 'Bearer synthetic-security-fixture'}});
    const result = await reopen(xhr, `${destination.origin}/second`);
    assert.equal(result.status, 200);
    assert.equal(received.cookie, undefined);
    assert.equal(received.authorization, undefined);
});

test('a late aborted response cannot fail a reopened XHR', {timeout: 5000}, async t => {
    let signalStarted;
    const started = new Promise(resolve => signalStarted = resolve);
    const source = await serve(t, (req, res) => {
        if (req.url==='/slow') {
            res.write('unfinished first response');
            signalStarted();
        } else { res.end('second response'); }
    });
    let xhr;
    const first = request(`${source.origin}/slow`, {onRequest: value => xhr = value});
    await started;
    xhr.abort();
    await first;
    const result = await reopen(xhr, `${source.origin}/second`);
    assert.equal(result.status, 200);
    assert.equal(result.responseText, 'second response');
});

test('real HTTPS same-origin redirects preserve certificate verification and authenticated headers', {timeout: 5000}, async t => {
    const received = [];
    const source = await serve(t, (req, res) => {
        received.push({url: req.url, cookie: req.headers.cookie, host: req.headers.host});
        if (req.url==='/start') { res.writeHead(302, {Location: '/finish'}); }
        res.end('verified HTTPS response');
    }, '127.0.0.1', tlsFixture);
    const untrusted = await request(`${source.origin}/start`);
    assert.equal(untrusted.status, 0);
    assert.match(String(untrusted.statusText), /self.signed certificate/i);
    assert.equal(received.length, 0);
    const originalRequest = https.request;
    t.mock.method(https, 'request', (options, callback) => originalRequest({...options, ca: tlsFixture.cert}, callback));
    const result = await request(`${source.origin}/start`);
    assert.equal(result.status, 200);
    assert.equal(result.responseText, 'verified HTTPS response');
    assert.deepEqual(received.map(item => item.url), ['/start', '/finish']);
    assert(received.every(item => item.cookie==='sid=synthetic-security-fixture'));
    assert(received.every(item => item.host===new URL(source.origin).host));
});

test('explicit and implicit default ports compare as the same canonical origin', {timeout: 5000}, async t => {
    const received = [];
    const source = await serve(t, (req, res) => {
        received.push({url: req.url, host: req.headers.host});
        if (req.url==='/start') { res.writeHead(302, {Location: 'http://127.0.0.1/finish'}); }
        res.end('default port response');
    });
    const originalRequest = http.request;
    // Keep the actual server unprivileged while testing logical port 80 URLs.
    t.mock.method(http, 'request', (options, callback) => originalRequest({...options, port: source.server.address().port}, callback));
    const result = await request('http://127.0.0.1:80/start');
    assert.equal(result.status, 200);
    assert.deepEqual(received.map(item => item.url), ['/start', '/finish']);
    assert(received.every(item => item.host==='127.0.0.1'));
});
