const test = require('node:test');
const assert = require('node:assert/strict');

const {
    clearDiagnosticBuffer,
    configureDiagnostics,
    formatDiagnosticRecord,
    getRecentDiagnosticRecords,
    logDiagnostic,
} = require('../out/utils/diagnostics.js');

test('formatDiagnosticRecord sorts keys and normalizes errors', () => {
    const error = new Error('connection lost');
    error.code = 'ECONNRESET';

    assert.equal(
        formatDiagnosticRecord('socket.error', {
            zeta: 2,
            alpha: 'first',
            nested: {b: true, a: 1},
        }, error),
        JSON.stringify({
            event: 'socket.error',
            alpha: 'first',
            nested: {a: 1, b: true},
            zeta: 2,
            errorCode: 'ECONNRESET',
            errorMessage: 'connection lost',
            errorName: 'Error',
        }),
    );
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
