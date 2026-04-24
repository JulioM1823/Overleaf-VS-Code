const http = require('node:http');

const { createStructuredRecorder } = require('./structuredRecorder.cjs');

function escapeHtmlAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function createJsonMetaContent(value) {
    return escapeHtmlAttribute(JSON.stringify(value));
}

function buildProjectPageHtml(options = {}) {
    const {
        csrfToken = 'csrf-token',
        languages = [{ code: 'en', name: 'English' }],
        learnedWords = ['overleaf'],
        projectName = 'Mock Project',
        userEmail = 'user@example.com',
        userId = 'user-123',
        wsUrl = '',
    } = options;

    return `<!DOCTYPE html>
<html>
<head>
    <meta name="ol-user" content="${createJsonMetaContent({ _id: userId, email: userEmail })}">
    <meta name="ol-user_id" content="${escapeHtmlAttribute(userId)}">
    <meta name="ol-usersEmail" content="${escapeHtmlAttribute(userEmail)}">
    <meta name="ol-csrfToken" content="${escapeHtmlAttribute(csrfToken)}">
    <meta name="ol-projectName" content="${escapeHtmlAttribute(projectName)}">
    <meta name="ol-wsUrl" content="${escapeHtmlAttribute(wsUrl)}">
    <meta name="ol-learnedWords" content="${createJsonMetaContent(learnedWords)}">
    <meta name="ol-languages" content="${createJsonMetaContent(languages)}">
    <title>${escapeHtmlAttribute(projectName)}</title>
</head>
<body>Mock Overleaf Project</body>
</html>`;
}

function buildLoginPageHtml(csrfToken = 'csrf-token') {
    return `<!DOCTYPE html>
<html>
<body>
    <form>
        <input type="hidden" name="_csrf" value="${escapeHtmlAttribute(csrfToken)}">
    </form>
</body>
</html>`;
}

function toBuffer(body) {
    if (Buffer.isBuffer(body)) {
        return body;
    }
    if (body instanceof Uint8Array) {
        return Buffer.from(body);
    }
    if (typeof body === 'string') {
        return Buffer.from(body, 'utf8');
    }
    if (body === undefined) {
        return Buffer.alloc(0);
    }
    return Buffer.from(JSON.stringify(body), 'utf8');
}

class MockOverleafHttpServer {
    constructor(options = {}) {
        this.loginPage = {
            body: buildLoginPageHtml(options.csrfToken),
            headers: options.loginHeaders ?? { 'content-type': 'text/html; charset=utf-8' },
            status: 200,
        };
        this.projectPage = {
            body: buildProjectPageHtml(options.projectPage),
            headers: options.projectHeaders ?? { 'content-type': 'text/html; charset=utf-8' },
            status: 200,
        };
        this.recorder = options.recorder ?? createStructuredRecorder('MockOverleafHttpServer');
        this.routes = [];
        this.server = http.createServer(this.handleRequest.bind(this));
        this.baseUrl = undefined;
        this.addRoute('GET', '/login', () => this.loginPage, 'login_page');
        this.addRoute('GET', '/project', () => this.projectPage, 'project_page');
    }

    addRoute(method, matcher, handler, label = 'custom') {
        this.routes.push({
            handler,
            label,
            matcher,
            method,
        });
        this.recorder.record('route.registered', {
            label,
            matcher: matcher instanceof RegExp ? matcher.toString() : String(matcher),
            method,
        });
    }

    setProjectPage(options = {}) {
        this.projectPage = {
            body: buildProjectPageHtml(options),
            headers: { 'content-type': 'text/html; charset=utf-8', ...(options.headers ?? {}) },
            status: options.status ?? 200,
        };
        this.recorder.record('project_page.updated', {
            projectName: options.projectName ?? 'Mock Project',
            status: this.projectPage.status,
            userId: options.userId ?? 'user-123',
        });
    }

    setLoginPage(options = {}) {
        this.loginPage = {
            body: buildLoginPageHtml(options.csrfToken),
            headers: { 'content-type': 'text/html; charset=utf-8', ...(options.headers ?? {}) },
            status: options.status ?? 200,
        };
        this.recorder.record('login_page.updated', {
            status: this.loginPage.status,
        });
    }

    get events() {
        return this.recorder.snapshot();
    }

    async start() {
        await new Promise((resolve) => {
            this.server.listen(0, '127.0.0.1', resolve);
        });
        const address = this.server.address();
        this.baseUrl = `http://127.0.0.1:${address.port}/`;
        this.recorder.record('server.started', { baseUrl: this.baseUrl });
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
        this.recorder.record('server.stopped', { baseUrl: this.baseUrl ?? '' });
    }

    matches(matcher, pathname) {
        if (typeof matcher === 'string') {
            return matcher === pathname;
        }
        if (matcher instanceof RegExp) {
            return matcher.test(pathname);
        }
        return matcher(pathname);
    }

    async handleRequest(req, res) {
        const bodyChunks = [];
        for await (const chunk of req) {
            bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(bodyChunks);
        const requestUrl = new URL(req.url, this.baseUrl ?? 'http://127.0.0.1/');
        this.recorder.record('request.received', {
            bodyBytes: body.length,
            method: req.method ?? 'GET',
            pathname: requestUrl.pathname,
            search: requestUrl.search,
        });

        const route = this.routes.find((item) => item.method === (req.method ?? 'GET') && this.matches(item.matcher, requestUrl.pathname));
        if (!route) {
            this.recorder.record('request.unhandled', {
                method: req.method ?? 'GET',
                pathname: requestUrl.pathname,
            });
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }

        let response;
        try {
            response = await route.handler({
                body,
                headers: req.headers,
                method: req.method ?? 'GET',
                pathname: requestUrl.pathname,
                searchParams: requestUrl.searchParams,
                url: requestUrl,
            });
        } catch (error) {
            this.recorder.record('request.handler_failed', {
                label: route.label,
                pathname: requestUrl.pathname,
            }, error);
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(String(error));
            return;
        }

        const responseBody = toBuffer(response?.body);
        const status = response?.status ?? 200;
        const headers = {
            'content-length': String(responseBody.length),
            ...(response?.headers ?? {}),
        };
        res.writeHead(status, headers);
        res.end(responseBody);
        this.recorder.record('request.responded', {
            bodyBytes: responseBody.length,
            label: route.label,
            pathname: requestUrl.pathname,
            status,
        });
    }
}

module.exports = {
    MockOverleafHttpServer,
    buildLoginPageHtml,
    buildProjectPageHtml,
};
