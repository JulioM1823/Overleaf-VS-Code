const test = require('node:test');
const assert = require('node:assert/strict');

const {
    clearManagedDocumentSession,
    clearManagedDocumentUri,
    getManagedDocumentState,
    linkManagedDocumentUri,
    markManagedDocumentPending,
    resetManagedTextDocumentRegistryForTest,
    setManagedDocumentSessionState,
} = require('../out/core/liveTextDocumentRegistry.js');

function uri(key) {
    return {
        toString: () => key,
    };
}

test.beforeEach(() => {
    resetManagedTextDocumentRegistryForTest();
});

test('managed text document registry marks pending ownership immediately', () => {
    const targetUri = uri('file:///tmp/example.tex');

    markManagedDocumentPending(targetUri);

    assert.equal(getManagedDocumentState(targetUri), 'pending');
});

test('managed text document registry updates all linked uris when a session becomes live', () => {
    const localUri = uri('file:///tmp/example.tex');
    const overleafUri = uri('overleaf-workshop://server/project/example.tex?user=u&project=p');

    markManagedDocumentPending(localUri);
    linkManagedDocumentUri('origin::doc-1', localUri, 'live');
    linkManagedDocumentUri('origin::doc-1', overleafUri, 'live');
    setManagedDocumentSessionState('origin::doc-1', 'offline-queued');

    assert.equal(getManagedDocumentState(localUri), 'offline-queued');
    assert.equal(getManagedDocumentState(overleafUri), 'offline-queued');
});

test('managed text document registry propagates syncing state to every linked uri', () => {
    const localUri = uri('file:///tmp/example.tex');
    const overleafUri = uri('overleaf-workshop://server/project/example.tex?user=u&project=p');

    markManagedDocumentPending(localUri);
    linkManagedDocumentUri('origin::doc-1', localUri, 'live');
    linkManagedDocumentUri('origin::doc-1', overleafUri, 'live');
    setManagedDocumentSessionState('origin::doc-1', 'syncing');

    assert.equal(getManagedDocumentState(localUri), 'syncing');
    assert.equal(getManagedDocumentState(overleafUri), 'syncing');
});

test('managed text document registry clears one alias without dropping the whole session', () => {
    const localUri = uri('file:///tmp/example.tex');
    const overleafUri = uri('overleaf-workshop://server/project/example.tex?user=u&project=p');

    linkManagedDocumentUri('origin::doc-1', localUri, 'live');
    linkManagedDocumentUri('origin::doc-1', overleafUri, 'live');

    clearManagedDocumentUri(localUri);

    assert.equal(getManagedDocumentState(localUri), undefined);
    assert.equal(getManagedDocumentState(overleafUri), 'live');
});

test('managed text document registry clears every alias when the session ends', () => {
    const localUri = uri('file:///tmp/example.tex');
    const overleafUri = uri('overleaf-workshop://server/project/example.tex?user=u&project=p');

    linkManagedDocumentUri('origin::doc-1', localUri, 'live');
    linkManagedDocumentUri('origin::doc-1', overleafUri, 'live');

    clearManagedDocumentSession('origin::doc-1');

    assert.equal(getManagedDocumentState(localUri), undefined);
    assert.equal(getManagedDocumentState(overleafUri), undefined);
});
