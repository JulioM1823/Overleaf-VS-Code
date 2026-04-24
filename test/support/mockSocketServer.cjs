const http = require('node:http');

const { createStructuredRecorder } = require('./structuredRecorder.cjs');

class MockSocketServer {
    constructor(options = {}) {
        this.mode = options.mode ?? 'v1';
        this.resource = options.resource ?? 'socket.io';
        this.sessionId = options.sessionId ?? 'mock-session-id';
        this.transports = options.transports ?? ['websocket', 'xhr-polling'];
        this.engineIoSid = options.engineIoSid ?? 'engine-io-session';
        this.pingInterval = options.pingInterval ?? 25000;
        this.pingTimeout = options.pingTimeout ?? 20000;
        this.heartbeatTimeoutSeconds = options.heartbeatTimeoutSeconds ?? 15;
        this.closeTimeoutSeconds = options.closeTimeoutSeconds ?? 60;
        this.recorder = options.recorder ?? createStructuredRecorder('MockSocketServer');
        this.server = http.createServer(this.handleRequest.bind(this));
        this.baseUrl = undefined;
    }

    get events() {
        return this.recorder.snapshot();
    }

    buildHandshakeUrl(query = '') {
        if (!this.baseUrl) {
            throw new Error('MockSocketServer has not been started.');
        }
        if (this.mode === 'v1') {
            return `${this.baseUrl}${this.resource}/1/${query ? `?${query}` : ''}`;
        }
        const suffix = query ? `&${query}` : '';
        return `${this.baseUrl}${this.resource}/?EIO=4&transport=polling${suffix}`;
    }

    async start() {
        await new Promise((resolve) => {
            this.server.listen(0, '127.0.0.1', resolve);
        });
        const address = this.server.address();
        this.baseUrl = `http://127.0.0.1:${address.port}/`;
        this.recorder.record('server.started', {
            baseUrl: this.baseUrl,
            mode: this.mode,
            resource: this.resource,
        });
        return this;
    }

    async stop() {
        if (!this.server.listening) {
            return;
        }
        await new Promise((resolve, reject) => {
            this.server.close((error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
        this.recorder.record('server.stopped', {
            baseUrl: this.baseUrl ?? '',
            mode: this.mode,
        });
    }

    async handleRequest(req, res) {
        const requestUrl = new URL(req.url, this.baseUrl ?? 'http://127.0.0.1/');
        this.recorder.record('request.received', {
            method: req.method ?? 'GET',
            mode: this.mode,
            pathname: requestUrl.pathname,
            search: requestUrl.search,
        });

        if (this.mode === 'v1' && requestUrl.pathname === `/${this.resource}/1/`) {
            const payload = `${this.sessionId}:${this.heartbeatTimeoutSeconds}:${this.closeTimeoutSeconds}:${this.transports.join(',')}`;
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(payload);
            this.recorder.record('handshake.response', {
                mode: this.mode,
                query: requestUrl.searchParams.toString(),
                sessionId: this.sessionId,
                transports: this.transports,
            });
            return;
        }

        if (
            this.mode === 'v2' &&
            requestUrl.pathname === `/${this.resource}/` &&
            requestUrl.searchParams.get('EIO') === '4' &&
            requestUrl.searchParams.get('transport') === 'polling'
        ) {
            const payload = `0${JSON.stringify({
                pingInterval: this.pingInterval,
                pingTimeout: this.pingTimeout,
                sid: this.engineIoSid,
                upgrades: this.transports.filter((transport) => transport === 'websocket'),
            })}`;
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(payload);
            this.recorder.record('handshake.response', {
                engineIoSid: this.engineIoSid,
                mode: this.mode,
                query: requestUrl.searchParams.toString(),
                transports: this.transports,
            });
            return;
        }

        this.recorder.record('request.unhandled', {
            method: req.method ?? 'GET',
            mode: this.mode,
            pathname: requestUrl.pathname,
            search: requestUrl.search,
        });
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    }
}

module.exports = {
    MockSocketServer,
};
