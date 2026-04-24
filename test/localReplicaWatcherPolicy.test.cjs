const test = require('node:test');
const assert = require('node:assert/strict');

const {
    shouldSuppressRemoteWatcherPullForManagedDocument,
} = require('../out/scm/localReplicaWatcherPolicy.js');

test('shouldSuppressRemoteWatcherPullForManagedDocument suppresses remote pulls for every open managed session state', () => {
    assert.equal(shouldSuppressRemoteWatcherPullForManagedDocument('pending'), true);
    assert.equal(shouldSuppressRemoteWatcherPullForManagedDocument('syncing'), true);
    assert.equal(shouldSuppressRemoteWatcherPullForManagedDocument('live'), true);
    assert.equal(shouldSuppressRemoteWatcherPullForManagedDocument('offline-queued'), true);
    assert.equal(shouldSuppressRemoteWatcherPullForManagedDocument('recovery-required'), true);
});

test('shouldSuppressRemoteWatcherPullForManagedDocument leaves unowned files available for watcher pulls', () => {
    assert.equal(shouldSuppressRemoteWatcherPullForManagedDocument(undefined), false);
});
