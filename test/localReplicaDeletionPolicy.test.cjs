const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isLocalReplicaMetadataPath,
    shouldRehydrateEmptyLocalReplicaFromRemote,
} = require('../out/scm/localReplicaDeletionPolicy.js');
const {
    createLocalReplicaSnapshot,
} = require('../out/scm/localReplicaSyncState.js');

test('shouldRehydrateEmptyLocalReplicaFromRemote protects an emptied existing replica', () => {
    const shouldRehydrate = shouldRehydrateEmptyLocalReplicaFromRemote({
        isRootReconcile: true,
        localPathCount: 0,
        pathStates: [
            {baseline: createLocalReplicaSnapshot('file', Buffer.from('remote'))},
        ],
        remotePathCount: 3,
    });

    assert.equal(shouldRehydrate, true);
});

test('shouldRehydrateEmptyLocalReplicaFromRemote leaves normal partial deletes to sync', () => {
    const shouldRehydrate = shouldRehydrateEmptyLocalReplicaFromRemote({
        isRootReconcile: true,
        localPathCount: 2,
        pathStates: [
            {baseline: createLocalReplicaSnapshot('file', Buffer.from('remote'))},
        ],
        remotePathCount: 3,
    });

    assert.equal(shouldRehydrate, false);
});

test('shouldRehydrateEmptyLocalReplicaFromRemote does not affect first-time bootstrap', () => {
    const shouldRehydrate = shouldRehydrateEmptyLocalReplicaFromRemote({
        isRootReconcile: true,
        localPathCount: 0,
        pathStates: [],
        remotePathCount: 3,
    });

    assert.equal(shouldRehydrate, false);
});

test('shouldRehydrateEmptyLocalReplicaFromRemote only applies to root reconciliation', () => {
    const shouldRehydrate = shouldRehydrateEmptyLocalReplicaFromRemote({
        isRootReconcile: false,
        localPathCount: 0,
        pathStates: [
            {baseline: createLocalReplicaSnapshot('file', Buffer.from('remote'))},
        ],
        remotePathCount: 3,
    });

    assert.equal(shouldRehydrate, false);
});

test('isLocalReplicaMetadataPath detects local replica metadata deletes', () => {
    assert.equal(isLocalReplicaMetadataPath('/.overleaf/settings.json'), true);
    assert.equal(isLocalReplicaMetadataPath('.overleaf/local-replica-state.json'), true);
    assert.equal(isLocalReplicaMetadataPath('/sections/.overleaf/settings.json'), false);
    assert.equal(isLocalReplicaMetadataPath('/main.tex'), false);
});
