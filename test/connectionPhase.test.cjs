const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveConnectionAcceptedPhase,
    resolveConnectedConnectionPhase,
    resolveInitializationConnectionPhase,
    shouldBlockDocumentHydrationDuringRecovery,
    shouldAutoCompileAfterInitialization,
} = require('../out/core/connectionPhase.js');

test('resolveInitializationConnectionPhase distinguishes first bootstrap from recovery', () => {
    assert.equal(resolveInitializationConnectionPhase('initial', false), 'initializing');
    assert.equal(resolveInitializationConnectionPhase('socket_disconnect', true), 'recovering');
    assert.equal(resolveInitializationConnectionPhase('toggle_invisible_mode', true), 'recovering');
});

test('resolveConnectedConnectionPhase prioritizes fallback and invisible states', () => {
    assert.equal(
        resolveConnectedConnectionPhase({
            readonlyMode: true,
            usingAlternativeConnectionScheme: false,
        }),
        'fallback',
    );
    assert.equal(
        resolveConnectedConnectionPhase({
            readonlyMode: false,
            usingAlternativeConnectionScheme: true,
        }),
        'invisible',
    );
    assert.equal(
        resolveConnectedConnectionPhase({
            readonlyMode: false,
            usingAlternativeConnectionScheme: false,
        }),
        'live',
    );
});

test('resolveConnectionAcceptedPhase clears recovery only for active online connections', () => {
    assert.equal(
        resolveConnectionAcceptedPhase({
            initializing: false,
            isOfflineMode: false,
            readonlyMode: false,
            usingAlternativeConnectionScheme: false,
        }),
        'live',
    );
    assert.equal(
        resolveConnectionAcceptedPhase({
            initializing: false,
            isOfflineMode: false,
            readonlyMode: false,
            usingAlternativeConnectionScheme: true,
        }),
        'invisible',
    );
    assert.equal(
        resolveConnectionAcceptedPhase({
            initializing: true,
            isOfflineMode: false,
            readonlyMode: false,
            usingAlternativeConnectionScheme: false,
        }),
        undefined,
    );
    assert.equal(
        resolveConnectionAcceptedPhase({
            initializing: false,
            isOfflineMode: true,
            readonlyMode: false,
            usingAlternativeConnectionScheme: false,
        }),
        undefined,
    );
});

test('shouldAutoCompileAfterInitialization only compiles on first bootstrap', () => {
    assert.equal(shouldAutoCompileAfterInitialization('initial'), true);
    assert.equal(shouldAutoCompileAfterInitialization('socket_disconnect'), false);
    assert.equal(shouldAutoCompileAfterInitialization('toggle_invisible_mode'), false);
});

test('shouldBlockDocumentHydrationDuringRecovery blocks only true connection recovery states', () => {
    assert.equal(shouldBlockDocumentHydrationDuringRecovery({
        isOfflineMode: true,
        phase: 'live',
    }), true);
    assert.equal(shouldBlockDocumentHydrationDuringRecovery({
        isOfflineMode: false,
        phase: 'initializing',
    }), true);
    assert.equal(shouldBlockDocumentHydrationDuringRecovery({
        isOfflineMode: false,
        phase: 'recovering',
    }), true);
    assert.equal(shouldBlockDocumentHydrationDuringRecovery({
        isOfflineMode: false,
        phase: 'live',
    }), false);
    assert.equal(shouldBlockDocumentHydrationDuringRecovery({
        isOfflineMode: false,
        phase: 'invisible',
    }), false);
});
