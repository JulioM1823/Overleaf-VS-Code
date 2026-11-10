const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createBlobId,
    createPersistedDocumentSyncState,
    parsePersistedDocumentSyncState,
    serializePersistedDocumentSyncState,
} = require('../out/offline/documentSyncJournalState.js');
const {
    createLocalReplicaSnapshot,
} = require('../out/scm/localReplicaSyncState.js');

function textSnapshot(value) {
    return createLocalReplicaSnapshot('file', new TextEncoder().encode(value));
}

test('document sync journal state sorts keys and preserves conflict metadata', () => {
    const state = createPersistedDocumentSyncState({
        '/z.tex': {
            baseSnapshot: textSnapshot('z'),
            conflict: {
                detectedAt: '2026-04-11T00:00:00.000Z',
                localBlobId: 'local-z',
                reason: 'diverged',
                remoteBlobId: 'remote-z',
            },
            lastKnownRemoteSnapshot: textSnapshot('remote-z'),
            localDirty: true,
            relPath: '/z.tex',
        },
        '/a.tex': {
            baseBlobId: 'blob-a',
            baseSnapshot: textSnapshot('a'),
            baseVersion: 3,
            lastKnownRemoteSnapshot: textSnapshot('a'),
            lastKnownRemoteVersion: 3,
            localDirty: false,
            relPath: '/a.tex',
        },
    });

    const parsed = parsePersistedDocumentSyncState(serializePersistedDocumentSyncState(state));
    assert.deepEqual(Object.keys(parsed.records), ['/a.tex', '/z.tex']);
    assert.equal(parsed.records['/z.tex'].conflict.reason, 'diverged');
    assert.equal(parsed.records['/z.tex'].localDirty, true);
    assert.equal(parsed.records['/a.tex'].baseVersion, 3);
});

test('document sync journal rejects unknown versions rather than silently clearing recovery metadata', () => {
    assert.throws(() => parsePersistedDocumentSyncState(JSON.stringify({records: {}, version: 99})), /Invalid/);
    assert.throws(() => parsePersistedDocumentSyncState('null'), /Invalid/);
});

test('createBlobId is deterministic for identical content and changes when content changes', () => {
    const alpha = new TextEncoder().encode('alpha');
    const alphaAgain = new TextEncoder().encode('alpha');
    const beta = new TextEncoder().encode('beta');

    assert.equal(createBlobId(alpha), createBlobId(alphaAgain));
    assert.notEqual(createBlobId(alpha), createBlobId(beta));
    assert.equal(createBlobId(alpha).length, 64);
});

test('malformed journal entries cannot be silently discarded or marked clean', () => {
    for (const record of [null, [], {}, {localDirty: 'true'}, {localDirty: true, baseVersion: -1},
        {localDirty: true, conflict: {}}, {localDirty: true, baseSnapshot: {kind: 'unknown', hash: 1, size: 0}}]) {
        assert.throws(() => parsePersistedDocumentSyncState(JSON.stringify({version: 1, records: {'/draft.tex': record}})), /Invalid/);
    }
});
