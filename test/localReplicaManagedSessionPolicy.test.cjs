const test = require('node:test');
const assert = require('node:assert/strict');

const {
    shouldDeferLocalReplicaFileSyncToManagedSession,
} = require('../out/scm/localReplicaManagedSessionPolicy.js');

test('shouldDeferLocalReplicaFileSyncToManagedSession defers file reconciliation for open managed documents', () => {
    assert.equal(shouldDeferLocalReplicaFileSyncToManagedSession({
        localSnapshotKind: 'file',
        managedDocumentState: 'live',
        remoteSnapshotKind: 'file',
    }), true);
    assert.equal(shouldDeferLocalReplicaFileSyncToManagedSession({
        localSnapshotKind: 'file',
        managedDocumentState: 'offline-queued',
        remoteSnapshotKind: 'file',
    }), true);
    assert.equal(shouldDeferLocalReplicaFileSyncToManagedSession({
        localSnapshotKind: 'file',
        managedDocumentState: 'recovery-required',
        remoteSnapshotKind: 'file',
    }), true);
});

test('shouldDeferLocalReplicaFileSyncToManagedSession keeps non-file or unmanaged paths on the replica engine', () => {
    assert.equal(shouldDeferLocalReplicaFileSyncToManagedSession({
        localSnapshotKind: 'file',
        managedDocumentState: undefined,
        remoteSnapshotKind: 'file',
    }), false);
    assert.equal(shouldDeferLocalReplicaFileSyncToManagedSession({
        localSnapshotKind: 'directory',
        managedDocumentState: 'live',
        remoteSnapshotKind: 'file',
    }), false);
    assert.equal(shouldDeferLocalReplicaFileSyncToManagedSession({
        localSnapshotKind: 'file',
        managedDocumentState: 'live',
        remoteSnapshotKind: 'missing',
    }), false);
});
