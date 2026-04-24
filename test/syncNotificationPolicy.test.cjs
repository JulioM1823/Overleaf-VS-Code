const test = require('node:test');
const assert = require('node:assert/strict');

const {
    shouldSuppressBackgroundSyncFailureNotification,
    shouldSurfaceSyncNotification,
} = require('../out/core/syncNotificationPolicy.js');

test('background sync failures stay silent while offline or recovering', () => {
    assert.equal(shouldSuppressBackgroundSyncFailureNotification({
        connectionPhase: 'live',
        synchronizationMode: 'offline',
    }), true);
    assert.equal(shouldSuppressBackgroundSyncFailureNotification({
        connectionPhase: 'recovering',
        synchronizationMode: 'online',
    }), true);
    assert.equal(shouldSuppressBackgroundSyncFailureNotification({
        connectionPhase: 'initializing',
        synchronizationMode: 'online',
    }), true);
    assert.equal(shouldSuppressBackgroundSyncFailureNotification({
        connectionPhase: 'fallback',
        synchronizationMode: 'online',
    }), true);
});

test('background sync failures may surface once the project is stably online', () => {
    assert.equal(shouldSuppressBackgroundSyncFailureNotification({
        connectionPhase: 'live',
        synchronizationMode: 'online',
    }), false);
    assert.equal(shouldSuppressBackgroundSyncFailureNotification({
        connectionPhase: 'invisible',
        synchronizationMode: 'online',
    }), false);
});

test('routine connected and reconnect notifications stay suppressed', () => {
    assert.equal(shouldSurfaceSyncNotification({
        connectionPhase: 'live',
        kind: 'connected',
    }), false);
    assert.equal(shouldSurfaceSyncNotification({
        connectionPhase: 'live',
        kind: 'reconnected',
    }), false);
    assert.equal(shouldSurfaceSyncNotification({
        connectionPhase: 'live',
        kind: 'disconnected',
    }), false);
});

test('fallback read-only disconnect notifications can still surface', () => {
    assert.equal(shouldSurfaceSyncNotification({
        connectionPhase: 'fallback',
        kind: 'disconnected',
    }), true);
});
