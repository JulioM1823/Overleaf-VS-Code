const test = require('node:test');
const assert = require('node:assert/strict');

const {
    clearDiagnosticBuffer,
    configureDiagnostics,
    formatDiagnosticRecord,
    getRecentDiagnosticRecords,
    logDiagnostic,
    sanitizeDiagnosticPayload,
} = require('../out/utils/diagnostics.js');

test('formatDiagnosticRecord sorts keys and normalizes errors', () => {
    const error = new Error('connection lost');
    error.code = 'ECONNRESET';

    const record=JSON.parse(formatDiagnosticRecord('socket.error', {
            zeta: 2,
            alpha: 'first',
            nested: {b: true, a: 1},
        }, error));
    assert.match(record.errorMessage,/^\[redacted-errormessage:/);
    delete record.errorMessage;
    assert.deepEqual(record, {
            event: 'socket.error',
            alpha: 'first',
            nested: {a: 1, b: true},
            zeta: 2,
            errorCode: 'ECONNRESET',
            errorName: 'Error',
        });
});

test('sensitive diagnostic containers redact nested keys, values and numeric identifiers', () => {
    const text = 'Unpublished experiment';
    const payload = sanitizeDiagnosticPayload({
        body: {[text]: {plain: text}},
        content: [{plain: text}],
        credentials: {plain: text},
        userId: 123456,
        cookieLength: 24,
        hasCookie: true,
    });
    assert.equal(JSON.stringify(payload).includes(text), false);
    assert.match(payload.body, /^\[redacted-body/);
    assert.match(payload.userId, /^\[redacted-userid:/);
    assert.equal(payload.cookieLength, 24);
    assert.equal(payload.hasCookie, true);
});

test('diagnostic normalization bounds cycles, depth and collections', () => {
    const cyclic = {step: 1}; cyclic.next = cyclic;
    const array = []; array.push(array);
    const deep = {}; let next = deep;
    for (let i = 0; i < 500; i++) { next.next = {}; next = next.next; }
    next.plain = 'never visited';
    const payload = sanitizeDiagnosticPayload({cyclic, array, deep, many: Array(10000).fill('sample')});
    assert.equal(payload.cyclic.next, '[circular]');
    assert.deepEqual(payload.array, ['[circular]']);
    assert.equal(payload.many.length, 100);
    assert.equal(JSON.stringify(payload).includes('never visited'), false);
    assert.match(JSON.stringify(payload.deep), /truncated/);
});

test('arbitrary thrown objects cannot reflect document contents through unknown fields', () => {
    const serialized = formatDiagnosticRecord('operation.failed', {}, {detail: 'Unpublished experiment', data: {result: 'private'}});
    assert.equal(serialized.includes('Unpublished experiment'), false);
    assert.equal(serialized.includes('private'), false);
});

test('redacted values correlate within a process without exposing a public content hash', () => {
    const crypto = require('node:crypto');
    const first = sanitizeDiagnosticPayload({content: 'guessable'}).content;
    assert.equal(first, sanitizeDiagnosticPayload({content: 'guessable'}).content);
    assert.equal(first.includes(crypto.createHash('sha256').update('guessable').digest('hex').slice(0, 12)), false);
});

test('arbitrary document text reflected by server errors is never emitted in diagnostics', () => {
    const text='Unpublished research result 42';
    const serialized=formatDiagnosticRecord('operation.failed',{message:text},new Error(`Rejected update ${text}`));
    assert.equal(serialized.includes(text),false);
    assert.equal(JSON.parse(serialized).errorName,'Error');
});

test('formatDiagnosticRecord preserves array order and strips undefined values', () => {
    assert.equal(
        formatDiagnosticRecord('project_manager.cache_hit', {
            nested: {z: undefined, b: 2, a: 1},
            transports: ['websocket', undefined, 'xhr-polling'],
            value: undefined,
        }),
        JSON.stringify({
            event: 'project_manager.cache_hit',
            nested: {a: 1, b: 2},
            transports: ['websocket', 'xhr-polling'],
        }),
    );
});

test('formatDiagnosticRecord redacts sensitive payload fields and error text', () => {
    const formatted = formatDiagnosticRecord('privacy.audit', {
        content: 'secret chat text',
        cookies: 'overleaf_session2=session-secret',
        email: 'person@example.com',
        fileName: 'private-draft.tex',
        folderName: 'Grant Applications',
        label: 'sec:private-finding',
        newName: 'Renamed confidential project',
        projectLabel: 'Confidential Research Project',
        route: 'project/project-1/messages?_csrf=csrf-secret&file=main.tex',
        tagName: 'Sensitive Client',
        uri: '/Users/example/private/main.tex',
    }, 'failed for person@example.com at /Users/example/private/main.tex');
    const record = JSON.parse(formatted);
    const serialized = JSON.stringify(record);

    assert.match(record.content, /^\[redacted-content:/);
    assert.match(record.cookies, /^\[redacted-cookies:/);
    assert.match(record.email, /^\[redacted-email:/);
    assert.match(record.fileName, /^\[redacted-filename:/);
    assert.match(record.folderName, /^\[redacted-foldername:/);
    assert.match(record.label, /^\[redacted-label:/);
    assert.match(record.newName, /^\[redacted-newname:/);
    assert.match(record.projectLabel, /^\[redacted-projectlabel:/);
    assert.match(record.tagName, /^\[redacted-tagname:/);
    assert.match(record.uri, /^\[redacted-uri:/);
    assert.match(record.route, /^\[redacted-path:/);
    assert.equal(serialized.includes('secret chat text'), false);
    assert.equal(serialized.includes('session-secret'), false);
    assert.equal(serialized.includes('person@example.com'), false);
    assert.equal(serialized.includes('private-draft.tex'), false);
    assert.equal(serialized.includes('Grant Applications'), false);
    assert.equal(serialized.includes('sec:private-finding'), false);
    assert.equal(serialized.includes('Renamed confidential project'), false);
    assert.equal(serialized.includes('Confidential Research Project'), false);
    assert.equal(serialized.includes('Sensitive Client'), false);
    assert.equal(serialized.includes('/Users/example/private/main.tex'), false);
});

test('logDiagnostic enforces level and category filters when diagnostics are enabled', () => {
    configureDiagnostics({
        consoleEnabled: false,
        enabled: true,
        enabledCategories: ['sync'],
        minLevel: 'warning',
        verbose: false,
    });
    clearDiagnosticBuffer();

    logDiagnostic('DocumentSessions', 'session.flush_started', {
        documentId: 'doc-1',
    });
    logDiagnostic('DocumentSessions', 'session.flush_failed', {
        documentId: 'doc-1',
    }, new Error('flush failed'));
    logDiagnostic('ProjectChat', 'chat.message_send_failed', {
        messageId: 'msg-1',
    }, new Error('send failed'));

    const records = getRecentDiagnosticRecords(10);
    assert.equal(records.length, 1);
    assert.equal(records[0].category, 'sync');
    assert.equal(records[0].level, 'error');
    assert.equal(records[0].event, 'session.flush_failed');

    clearDiagnosticBuffer();
    configureDiagnostics({
        enabled: false,
        enabledCategories: [],
        minLevel: 'warning',
        verbose: false,
    });
});

test('logDiagnostic keeps only newest records when buffer limit is reached', () => {
    configureDiagnostics({
        consoleEnabled: false,
        enabled: true,
        enabledCategories: [],
        maxBufferRecords: 2,
        minLevel: 'debug',
        verbose: true,
    });
    clearDiagnosticBuffer();

    logDiagnostic('CompileManager', 'compile.started', {step: 1});
    logDiagnostic('CompileManager', 'compile.completed', {step: 2});
    logDiagnostic('CompileManager', 'compile.failed', {step: 3}, new Error('compile failed'));

    const records = getRecentDiagnosticRecords(10);
    assert.equal(records.length, 2);
    assert.equal(records[0].event, 'compile.completed');
    assert.equal(records[1].event, 'compile.failed');

    clearDiagnosticBuffer();
    configureDiagnostics({
        enabled: false,
        enabledCategories: [],
        maxBufferRecords: 800,
        minLevel: 'warning',
        verbose: false,
    });
});
