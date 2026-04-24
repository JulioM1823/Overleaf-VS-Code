const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const noop = () => {};
const originalLoad = Module._load;
const projectWorkspaceBindingMock = {
    isPotentialProjectWorkspaceUri: () => true,
    resolveProjectDocumentBinding: async () => undefined,
};
const vscodeMock = {
    Range: class Range {
        constructor(start, end) {
            this.start = start;
            this.end = end;
        }
    },
    WorkspaceEdit: class WorkspaceEdit {
        constructor() {
            this.edits = [];
        }

        replace(uri, range, text) {
            this.edits.push({range, text, uri});
        }
    },
    workspace: {
        applyEdit: async (workspaceEdit) => {
            for (const edit of workspaceEdit.edits) {
                const document = vscodeMock.workspace.textDocuments.find((candidate) => (
                    candidate.uri.toString()===edit.uri.toString()
                ));
                if (document?.setText) {
                    document.setText(edit.text);
                }
            }
            return true;
        },
        textDocuments: [],
    },
};

Module._load = function patchedLoad(request, parent, isMain) {
    if (request==='vscode') {
        return vscodeMock;
    }
    if (request==='./remoteFileSystemProvider' && parent?.id?.endsWith('/documentSessionManager.js')) {
        return {
            RemoteFileSystemProvider: class {},
            VirtualFileSystem: class {},
        };
    }
    if (request==='./liveTextDocumentRegistry' && parent?.id?.endsWith('/documentSessionManager.js')) {
        return {
            clearManagedDocumentSession: noop,
            clearManagedDocumentUri: noop,
            linkManagedDocumentUri: noop,
            markManagedDocumentPending: noop,
            setManagedDocumentSessionState: noop,
        };
    }
    if (request==='./projectWorkspaceBinding' && parent?.id?.endsWith('/documentSessionManager.js')) {
        return {
            isPotentialProjectWorkspaceUri: (...args) => projectWorkspaceBindingMock.isPotentialProjectWorkspaceUri(...args),
            resolveProjectDocumentBinding: (...args) => projectWorkspaceBindingMock.resolveProjectDocumentBinding(...args),
        };
    }
    if (request==='../utils/eventBus' && parent?.id?.endsWith('/documentSessionManager.js')) {
        return {
            EventBus: {
                fire: noop,
                on: () => ({dispose: noop}),
            },
        };
    }
    if (request==='../utils/diagnostics') {
        return {
            logDiagnostic: noop,
            registerDiagnosticStateProvider: () => ({dispose: noop}),
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { DocumentSessionManager } = require('../out/core/documentSessionManager.js');
const { createLocalReplicaSnapshot } = require('../out/scm/localReplicaSyncState.js');

function createUri(value, path = '/main.tex') {
    return {
        path,
        toString() {
            return value;
        },
    };
}

test('attachDocument checkpoints cached local-replica sessions before any stale flush', async () => {
    const manager = new DocumentSessionManager({});
    const document = {
        getText: () => 'local stale copy',
        uri: createUri('file:///workspace/main.tex'),
    };
    const overleafUri = createUri('overleaf://server/project/main.tex');
    manager.resolveBinding = async () => ({
        docId: 'doc-1',
        loadedFromCache: true,
        localText: 'local stale copy',
        overleafUri,
        remoteText: 'cached remote copy',
        sessionKey: 'origin::doc-1',
        status: 'live',
        usesLocalReplica: true,
        vfs: {
            origin: {
                toString: () => 'origin',
            },
        },
    });

    const recoverCalls = [];
    const flushCalls = [];
    manager.recoverSession = async (_session, reason) => {
        recoverCalls.push(reason);
    };
    manager.scheduleFlush = (_session, reason) => {
        flushCalls.push(reason);
    };

    const session = await manager.attachDocument(document, 'document_opened');

    assert.equal(session.status, 'syncing');
    assert.deepEqual(recoverCalls, ['document_attached_local_replica_checkpoint']);
    assert.deepEqual(flushCalls, []);
});

test('attachDocument checkpoints fresh local-replica mismatches before any stale flush', async () => {
    const manager = new DocumentSessionManager({});
    const document = {
        getText: () => 'stale local replica copy',
        uri: createUri('file:///workspace/main.tex'),
    };
    const overleafUri = createUri('overleaf://server/project/main.tex');
    manager.resolveBinding = async () => ({
        docId: 'doc-1',
        loadedFromCache: false,
        localText: 'stale local replica copy',
        overleafUri,
        remoteText: 'server remote copy',
        sessionKey: 'origin::doc-1',
        status: 'live',
        usesLocalReplica: true,
        vfs: {
            origin: {
                toString: () => 'origin',
            },
        },
    });

    const recoverCalls = [];
    const flushCalls = [];
    manager.recoverSession = async (_session, reason, options) => {
        recoverCalls.push({options, reason});
    };
    manager.scheduleFlush = (_session, reason) => {
        flushCalls.push(reason);
    };

    const session = await manager.attachDocument(document, 'document_opened');

    assert.equal(session.status, 'syncing');
    assert.deepEqual(recoverCalls, [{
        options: {
            forceAuthoritativeRemoteCheckpoint: true,
        },
        reason: 'document_attached_local_replica_checkpoint',
    }]);
    assert.deepEqual(flushCalls, []);
});

test('attachDocument checkpoints cached live sessions before any stale flush', async () => {
    const manager = new DocumentSessionManager({});
    const document = {
        getText: () => 'local edit before attach completes',
        uri: createUri('file:///workspace/main.tex'),
    };
    const overleafUri = createUri('overleaf://server/project/main.tex');
    manager.resolveBinding = async () => ({
        docId: 'doc-1',
        loadedFromCache: true,
        localText: 'local edit before attach completes',
        overleafUri,
        remoteText: 'cached remote copy',
        sessionKey: 'origin::doc-1',
        status: 'live',
        usesLocalReplica: false,
        vfs: {
            origin: {
                toString: () => 'origin',
            },
        },
    });

    const recoverCalls = [];
    const flushCalls = [];
    manager.recoverSession = async (_session, reason, options) => {
        recoverCalls.push({options, reason});
    };
    manager.scheduleFlush = (_session, reason) => {
        flushCalls.push(reason);
    };

    const session = await manager.attachDocument(document, 'document_opened');

    assert.equal(session.status, 'syncing');
    assert.deepEqual(recoverCalls, [{
        options: {
            forceAuthoritativeRemoteCheckpoint: true,
        },
        reason: 'document_attached_cached_checkpoint',
    }]);
    assert.deepEqual(flushCalls, []);
});

test('recoverSession re-reads local text after the authoritative checkpoint fetch', async () => {
    const manager = new DocumentSessionManager({});
    const overleafUri = createUri('overleaf://server/project/main.tex');
    const appliedTexts = [];
    const flushedTexts = [];
    let readCount = 0;

    manager.readCurrentSessionText = () => {
        readCount += 1;
        return readCount===1 ? 'abcd' : 'abXcd';
    };
    manager.applyRemoteTextToOpenDocuments = async (_session, nextText, options) => {
        appliedTexts.push({nextText, options});
        return 'applied';
    };
    manager.flushSession = async (session, reason) => {
        flushedTexts.push({
            reason,
            status: session.status,
            text: session.localText,
        });
    };

    const session = {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'abcd',
        localVersion: 0,
        openDocumentUris: new Set(),
        origin: 'origin',
        overleafUri,
        remoteText: 'abcd',
        status: 'syncing',
        usesLocalReplica: false,
        vfs: {
            acceptRemoteTextUpdate: noop,
            ensureTextDocumentSession: async () => ({
                docId: 'doc-1',
                loadedFromCache: true,
                localText: 'abcd',
                overleafUri,
                remoteText: 'abcd',
                version: 1,
            }),
            isOfflineMode: false,
            refreshTextDocumentSessionFromServer: async () => ({
                docId: 'doc-1',
                loadedFromCache: false,
                localText: 'abcd',
                overleafUri,
                remoteText: 'abcdY',
                version: 7,
            }),
            toDocumentSyncRelPath: () => 'main.tex',
        },
    };

    await manager.recoverSession(session, 'document_attached_cached_checkpoint', {
        forceAuthoritativeRemoteCheckpoint: true,
    });

    assert.deepEqual(appliedTexts, [{
        nextText: 'abXcdY',
        options: {
            expectedLocalText: 'abXcd',
            expectedLocalVersion: 0,
        },
    }]);
    assert.deepEqual(flushedTexts, [{
        reason: 'document_attached_cached_checkpoint_merged_replay',
        status: 'live',
        text: 'abXcdY',
    }]);
});

test('recoverSession refreshes local-replica server state before reconciling', async () => {
    const manager = new DocumentSessionManager({});
    const overleafUri = createUri('overleaf://server/project/main.tex');
    const refreshCalls = [];
    const acceptCalls = [];
    let ensureCallCount = 0;

    manager.applyRemoteTextToOpenDocuments = async () => true;

    const session = {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'cached remote copy',
        openDocumentUris: new Set(),
        origin: 'origin',
        overleafUri,
        remoteText: 'cached remote copy',
        status: 'offline-queued',
        usesLocalReplica: true,
        vfs: {
            acceptRemoteTextUpdate: (...args) => {
                acceptCalls.push(args);
            },
            ensureTextDocumentSession: async () => {
                ensureCallCount += 1;
                return {
                    docId: 'doc-1',
                    loadedFromCache: true,
                    localText: 'cached remote copy',
                    overleafUri,
                    remoteText: 'cached remote copy',
                    version: 1,
                };
            },
            isOfflineMode: false,
            refreshTextDocumentSessionFromServer: async (uri, reason, options) => {
                refreshCalls.push({options, reason, uri: uri.toString()});
                return {
                    docId: 'doc-1',
                    loadedFromCache: false,
                    localText: 'cached remote copy',
                    overleafUri: uri,
                    remoteText: 'server remote copy',
                    version: 7,
                };
            },
            toDocumentSyncRelPath: () => 'main.tex',
        },
    };

    await manager.recoverSession(session, 'realtime_phase_live');

    assert.equal(refreshCalls.length, 1);
    assert.equal(ensureCallCount, 0);
    assert.deepEqual(refreshCalls[0], {
        options: {
            localTextOverride: 'cached remote copy',
        },
        reason: 'realtime_phase_live_authoritative_checkpoint',
        uri: 'overleaf://server/project/main.tex',
    });
    assert.equal(session.remoteText, 'server remote copy');
    assert.equal(session.localText, 'server remote copy');
    assert.equal(session.status, 'live');
    assert.equal(acceptCalls.length, 1);
    assert.equal(acceptCalls[0][1], 'server remote copy');
});

test('recoverSession prefers the server copy when a local replica still matches its clean baseline', async () => {
    const manager = new DocumentSessionManager({});
    const overleafUri = createUri('overleaf://server/project/main.tex');
    const applyCalls = [];
    const acceptCalls = [];
    const flushCalls = [];

    manager.readCurrentSessionText = () => 'stale local replica copy';
    manager.applyRemoteTextToOpenDocuments = async (_session, nextText, options) => {
        applyCalls.push({nextText, options});
        return 'applied';
    };
    manager.flushSession = async (_session, reason) => {
        flushCalls.push(reason);
    };

    const session = {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'stale local replica copy',
        localVersion: 0,
        openDocumentUris: new Set(),
        origin: 'origin',
        overleafUri,
        remoteText: 'server remote copy',
        status: 'syncing',
        usesLocalReplica: true,
        vfs: {
            acceptRemoteTextUpdate: (...args) => {
                acceptCalls.push(args);
            },
            ensureTextDocumentSession: async () => ({
                docId: 'doc-1',
                loadedFromCache: true,
                localText: 'stale local replica copy',
                overleafUri,
                remoteText: 'server remote copy',
                version: 3,
            }),
            getDocumentSyncRecord: async () => ({
                baseSnapshot: createLocalReplicaSnapshot('file', Buffer.from('stale local replica copy')),
                localDirty: false,
                relPath: 'main.tex',
            }),
            isOfflineMode: false,
            refreshTextDocumentSessionFromServer: async (uri) => ({
                docId: 'doc-1',
                loadedFromCache: false,
                localText: 'stale local replica copy',
                overleafUri: uri,
                remoteText: 'server remote copy',
                version: 7,
            }),
            toDocumentSyncRelPath: () => 'main.tex',
        },
    };

    await manager.recoverSession(session, 'realtime_phase_live');

    assert.deepEqual(applyCalls, [{
        nextText: 'server remote copy',
        options: {
            expectedLocalText: 'stale local replica copy',
            expectedLocalVersion: 0,
        },
    }]);
    assert.deepEqual(flushCalls, []);
    assert.equal(session.remoteText, 'server remote copy');
    assert.equal(session.localText, 'server remote copy');
    assert.equal(session.status, 'live');
    assert.equal(acceptCalls.length, 1);
    assert.equal(acceptCalls[0][4], 'document_recovery_local_replica_stale_baseline');
});

test('recoverSession preserves real local-replica edits when the sync journal marks them dirty', async () => {
    const manager = new DocumentSessionManager({});
    const overleafUri = createUri('overleaf://server/project/main.tex');
    const applyCalls = [];
    const flushCalls = [];

    manager.readCurrentSessionText = () => 'true local edit';
    manager.applyRemoteTextToOpenDocuments = async () => {
        applyCalls.push('applied');
        return 'applied';
    };
    manager.flushSession = async (session, reason) => {
        flushCalls.push({
            reason,
            status: session.status,
            text: session.localText,
        });
    };

    const session = {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'true local edit',
        openDocumentUris: new Set(),
        origin: 'origin',
        overleafUri,
        remoteText: 'server remote copy',
        status: 'syncing',
        usesLocalReplica: true,
        vfs: {
            acceptRemoteTextUpdate: noop,
            ensureTextDocumentSession: async () => ({
                docId: 'doc-1',
                loadedFromCache: true,
                localText: 'true local edit',
                overleafUri,
                remoteText: 'server remote copy',
                version: 3,
            }),
            getDocumentSyncRecord: async () => ({
                baseSnapshot: createLocalReplicaSnapshot('file', Buffer.from('old baseline')),
                localDirty: true,
                relPath: 'main.tex',
            }),
            isOfflineMode: false,
            refreshTextDocumentSessionFromServer: async (uri) => ({
                docId: 'doc-1',
                loadedFromCache: false,
                localText: 'true local edit',
                overleafUri: uri,
                remoteText: 'server remote copy',
                version: 7,
            }),
            toDocumentSyncRelPath: () => 'main.tex',
        },
    };

    await manager.recoverSession(session, 'realtime_phase_live');

    assert.deepEqual(applyCalls, []);
    assert.deepEqual(flushCalls, [{
        reason: 'realtime_phase_live',
        status: 'live',
        text: 'true local edit',
    }]);
});

test('recoverSession refreshes server state for a forced authoritative checkpoint', async () => {
    const manager = new DocumentSessionManager({});
    const overleafUri = createUri('overleaf://server/project/main.tex');
    const refreshCalls = [];
    let ensureCallCount = 0;

    manager.applyRemoteTextToOpenDocuments = async () => true;

    const session = {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'cached remote copy',
        openDocumentUris: new Set(),
        origin: 'origin',
        overleafUri,
        remoteText: 'cached remote copy',
        status: 'offline-queued',
        usesLocalReplica: false,
        vfs: {
            acceptRemoteTextUpdate: noop,
            ensureTextDocumentSession: async () => {
                ensureCallCount += 1;
                return {
                    docId: 'doc-1',
                    loadedFromCache: true,
                    localText: 'cached remote copy',
                    overleafUri,
                    remoteText: 'cached remote copy',
                    version: 1,
                };
            },
            isOfflineMode: false,
            refreshTextDocumentSessionFromServer: async (uri, reason, options) => {
                refreshCalls.push({options, reason, uri: uri.toString()});
                return {
                    docId: 'doc-1',
                    loadedFromCache: false,
                    localText: 'cached remote copy',
                    overleafUri: uri,
                    remoteText: 'server remote copy',
                    version: 7,
                };
            },
            toDocumentSyncRelPath: () => 'main.tex',
        },
    };

    await manager.recoverSession(session, 'document_attached_cached_checkpoint', {
        forceAuthoritativeRemoteCheckpoint: true,
    });

    assert.equal(refreshCalls.length, 1);
    assert.equal(ensureCallCount, 0);
    assert.deepEqual(refreshCalls[0], {
        options: {
            localTextOverride: 'cached remote copy',
        },
        reason: 'document_attached_cached_checkpoint_authoritative_checkpoint',
        uri: 'overleaf://server/project/main.tex',
    });
});

test('handleRemoteTextUpdate flushes a merged local replay immediately', async () => {
    const manager = new DocumentSessionManager({});
    const overleafUri = createUri('overleaf://server/project/main.tex');
    const applyCalls = [];
    const acceptCalls = [];
    const flushCalls = [];

    manager.readCurrentSessionText = () => 'line one\nline two local\n';
    manager.applyRemoteTextToOpenDocuments = async (_session, nextText, options) => {
        applyCalls.push({nextText, options});
        return 'applied';
    };
    manager.flushSession = async (session, reason) => {
        flushCalls.push({
            localText: session.localText,
            reason,
            remoteText: session.remoteText,
            status: session.status,
        });
    };

    const session = {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'line one\nline two local\n',
        localVersion: 0,
        openDocumentUris: new Set(),
        origin: 'origin',
        overleafUri,
        remoteText: 'line one\nline two\n',
        status: 'live',
        usesLocalReplica: true,
        vfs: {
            acceptRemoteTextUpdate: (...args) => {
                acceptCalls.push(args);
            },
            isOfflineMode: false,
            realtimeConnectionPhase: 'live',
        },
    };
    manager.sessions.set(session.key, session);

    await manager.handleRemoteTextUpdate({
        docId: 'doc-1',
        nextRemoteText: 'line one remote\nline two\n',
        origin: 'origin',
        overleafUri: overleafUri.toString(),
        previousRemoteText: 'line one\nline two\n',
        update: {
            op: [{i: ' remote', p: 8}],
            v: 4,
        },
    });

    assert.deepEqual(applyCalls, [{
        nextText: 'line one remote\nline two local\n',
        options: {
            expectedLocalText: 'line one\nline two local\n',
            expectedLocalVersion: 0,
        },
    }]);
    assert.deepEqual(flushCalls, [{
        localText: 'line one remote\nline two local\n',
        reason: 'document_remote_update_merged_replay',
        remoteText: 'line one remote\nline two\n',
        status: 'live',
    }]);
    assert.equal(acceptCalls.length, 1);
    assert.equal(acceptCalls[0][1], 'line one remote\nline two\n');
    assert.equal(acceptCalls[0][2], 'line one remote\nline two local\n');
});

test('scheduleFlush throttles repeated local changes instead of postponing until idle', async () => {
    const manager = new DocumentSessionManager({});
    const flushCalls = [];
    const scheduled = [];
    const cleared = [];
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const session = {
        docId: 'doc-1',
        flushPromise: undefined,
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'pending local text',
        openDocumentUris: new Set(),
        origin: 'origin',
        overleafUri: createUri('overleaf://server/project/main.tex'),
        remoteText: 'server text',
        status: 'live',
        usesLocalReplica: false,
        vfs: {
            isOfflineMode: false,
            realtimeConnectionPhase: 'live',
        },
    };

    manager.flushSession = async (_session, reason) => {
        flushCalls.push(reason);
    };

    global.setTimeout = (callback, delay) => {
        scheduled.push({callback, delay});
        return {callback, delay};
    };
    global.clearTimeout = (timer) => {
        cleared.push(timer);
    };

    try {
        manager.scheduleFlush(session, 'document_changed');
        manager.scheduleFlush(session, 'document_changed');

        assert.equal(scheduled.length, 1);
        assert.equal(scheduled[0].delay, 100);
        assert.deepEqual(cleared, []);

        scheduled[0].callback();
        await Promise.resolve();

        assert.deepEqual(flushCalls, ['document_changed']);
    } finally {
        global.setTimeout = originalSetTimeout;
        global.clearTimeout = originalClearTimeout;
    }
});

test('flushSession defers while realtime recovery is still in progress', async () => {
    const manager = new DocumentSessionManager({});
    const session = {
        docId: 'doc-1',
        flushPromise: undefined,
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'pending local text',
        openDocumentUris: new Set(),
        origin: 'origin',
        overleafUri: createUri('overleaf://server/project/main.tex'),
        remoteText: 'server text',
        status: 'live',
        usesLocalReplica: false,
        vfs: {
            isOfflineMode: false,
            pushTextDocumentChanges: async () => {
                throw new Error('push should not run while recovering');
            },
            realtimeConnectionPhase: 'recovering',
        },
    };

    await manager.flushSession(session, 'queued_document_change');

    assert.equal(session.status, 'offline-queued');
    assert.equal(session.localText, 'pending local text');
    assert.equal(session.flushPromise, undefined);
});

test('handleDocumentChanged keeps existing live sessions on the live path without rebinding', async () => {
    const manager = new DocumentSessionManager({});
    const document = {
        getText: () => 'server text plus local edit',
        uri: createUri('file:///workspace/main.tex'),
    };
    const session = {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'server text',
        localVersion: 0,
        openDocumentUris: new Set([document.uri.toString()]),
        origin: 'origin',
        overleafUri: createUri('overleaf://server/project/main.tex'),
        remoteText: 'server text',
        status: 'live',
        usesLocalReplica: true,
        vfs: {
            applyLocalTextDocumentChangesToCommentRanges: async (...args) => {
                commentRangeCalls.push(args);
            },
            isOfflineMode: false,
            realtimeConnectionPhase: 'live',
        },
    };
    const commentRangeCalls = [];
    const flushCalls = [];
    manager.sessions.set(session.key, session);
    manager.sessionKeyByDocumentUri.set(document.uri.toString(), session.key);
    manager.attachDocument = async () => {
        throw new Error('attachDocument should not run for an existing session');
    };
    manager.scheduleFlush = (_session, reason) => {
        flushCalls.push(reason);
    };

    await manager.handleDocumentChanged(document);

    assert.equal(session.localText, 'server text plus local edit');
    assert.equal(session.localVersion, 1);
    assert.deepEqual(flushCalls, ['document_changed']);
    assert.equal(commentRangeCalls.length, 1);
    assert.equal(commentRangeCalls[0][1], 'server text');
    assert.equal(commentRangeCalls[0][2], 'server text plus local edit');
});

test('handleDocumentChanged ignores suppressed remote applies for existing sessions without rebinding', async () => {
    const manager = new DocumentSessionManager({});
    const document = {
        getText: () => 'server refreshed text',
        uri: createUri('file:///workspace/main.tex'),
    };
    const session = {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'older local text',
        localVersion: 4,
        openDocumentUris: new Set([document.uri.toString()]),
        origin: 'origin',
        overleafUri: createUri('overleaf://server/project/main.tex'),
        remoteText: 'older local text',
        status: 'live',
        usesLocalReplica: true,
        vfs: {
            applyLocalTextDocumentChangesToCommentRanges: async () => {
                throw new Error('suppressed remote apply should not touch comment ranges');
            },
            isOfflineMode: false,
            realtimeConnectionPhase: 'live',
        },
    };
    const flushCalls = [];
    manager.sessions.set(session.key, session);
    manager.sessionKeyByDocumentUri.set(document.uri.toString(), session.key);
    manager.attachDocument = async () => {
        throw new Error('attachDocument should not run for a suppressed change on an existing session');
    };
    manager.scheduleFlush = (_session, reason) => {
        flushCalls.push(reason);
    };
    manager.suppressNextDocumentChange(document.uri);

    await manager.handleDocumentChanged(document);

    assert.equal(session.localText, 'server refreshed text');
    assert.equal(session.localVersion, 4);
    assert.deepEqual(flushCalls, []);
});

test('handleDocumentChanged does not consume remote-apply suppressions for unrelated rapid local edits', async () => {
    const manager = new DocumentSessionManager({});
    const document = {
        getText: () => 'user rapid edit',
        uri: createUri('file:///workspace/main.tex'),
    };
    const session = {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'older local text',
        localVersion: 4,
        openDocumentUris: new Set([document.uri.toString()]),
        origin: 'origin',
        overleafUri: createUri('overleaf://server/project/main.tex'),
        remoteText: 'older local text',
        status: 'live',
        usesLocalReplica: false,
        vfs: {
            isOfflineMode: false,
            realtimeConnectionPhase: 'live',
        },
    };
    const flushCalls = [];
    manager.sessions.set(session.key, session);
    manager.sessionKeyByDocumentUri.set(document.uri.toString(), session.key);
    manager.scheduleFlush = (_session, reason) => {
        flushCalls.push(reason);
    };
    manager.suppressNextDocumentChange(document.uri, 'server refreshed text');

    await manager.handleDocumentChanged(document);

    assert.equal(session.localText, 'user rapid edit');
    assert.equal(session.localVersion, 5);
    assert.deepEqual(flushCalls, ['document_changed']);
});

test('applyRemoteTextToOpenDocuments rejects stale local versions before replacing editor text', async () => {
    const manager = new DocumentSessionManager({});
    const document = {
        getText: () => 'local text',
        positionAt: (offset) => offset,
        setText: () => {
            throw new Error('stale remote apply should not edit the document');
        },
        uri: createUri('file:///workspace/main.tex'),
    };
    const session = {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'local text',
        localVersion: 2,
        openDocumentUris: new Set([document.uri.toString()]),
        origin: 'origin',
        overleafUri: createUri('overleaf://server/project/main.tex'),
        remoteText: 'local text',
        status: 'live',
        usesLocalReplica: false,
        vfs: {},
    };

    vscodeMock.workspace.textDocuments = [document];
    try {
        const result = await manager.applyRemoteTextToOpenDocuments(session, 'remote text', {
            expectedLocalText: 'local text',
            expectedLocalVersion: 1,
        });

        assert.equal(result, 'stale-local-state');
    } finally {
        vscodeMock.workspace.textDocuments = [];
    }
});

test('prepareProjectForRemoteOperation skips open virtual files missing from the Overleaf project', async () => {
    const missingSettingsUri = createUri(
        'overleaf://server/project/.vscode/settings.json',
        '/.vscode/settings.json',
    );
    let ensureSessionCalls = 0;
    const projectVfs = {
        ensureTextDocumentSession: async () => {
            ensureSessionCalls += 1;
            const error = new Error(missingSettingsUri.toString());
            error.code = 'FileNotFound';
            error.name = 'EntryNotFound (FileSystemError)';
            throw error;
        },
        isOfflineMode: false,
        origin: {
            toString: () => 'origin',
        },
        realtimeConnectionPhase: 'live',
    };
    const manager = new DocumentSessionManager({
        prefetch: async () => projectVfs,
    });
    const openSettingsDocument = {
        getText: () => '{}',
        uri: missingSettingsUri,
    };

    vscodeMock.workspace.textDocuments = [openSettingsDocument];
    projectWorkspaceBindingMock.resolveProjectDocumentBinding = async () => ({
        mode: 'currentWindow',
        overleafProjectUri: createUri('overleaf://server/project', '/'),
        overleafUri: missingSettingsUri,
        relPath: '/.vscode/settings.json',
        renderUri: missingSettingsUri,
        workspaceRootUri: createUri('overleaf://server/project', '/'),
    });

    try {
        const result = await manager.prepareProjectForRemoteOperation(
            createUri('overleaf://server/project', '/'),
            'compile_preflight',
        );

        assert.equal(result, 'ready');
        assert.equal(manager.sessions.size, 0);
        assert.equal(ensureSessionCalls, 0);
    } finally {
        vscodeMock.workspace.textDocuments = [];
        projectWorkspaceBindingMock.resolveProjectDocumentBinding = async () => undefined;
    }
});

test('prepareProjectForRemoteOperation skips rebinding documents already attached to the origin', async () => {
    const manager = new DocumentSessionManager({
        prefetch: async () => ({
            isOfflineMode: false,
            origin: {
                toString: () => 'origin',
            },
            realtimeConnectionPhase: 'live',
        }),
    });
    const documentUri = createUri('overleaf://server/project/main.tex');
    const document = {
        getText: () => 'remote text',
        uri: documentUri,
    };
    const session = {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'remote text',
        localVersion: 0,
        openDocumentUris: new Set([documentUri.toString()]),
        origin: 'origin',
        overleafUri: documentUri,
        remoteText: 'remote text',
        status: 'live',
        usesLocalReplica: false,
        vfs: {
            isOfflineMode: false,
            realtimeConnectionPhase: 'live',
        },
    };
    manager.sessions.set(session.key, session);
    manager.sessionKeyByDocumentUri.set(documentUri.toString(), session.key);
    manager.attachDocument = async () => {
        throw new Error('already attached documents should not be rebound during compile preflight');
    };

    vscodeMock.workspace.textDocuments = [document];
    try {
        const result = await manager.prepareProjectForRemoteOperation(
            createUri('overleaf://server/project', '/'),
            'compile_preflight',
        );

        assert.equal(result, 'ready');
    } finally {
        vscodeMock.workspace.textDocuments = [];
    }
});

test('prepareProjectForRemoteOperation drains pending live session flushes before returning ready', async () => {
    const manager = new DocumentSessionManager({
        prefetch: async () => ({
            isOfflineMode: false,
            origin: {
                toString: () => 'origin',
            },
            realtimeConnectionPhase: 'live',
        }),
    });
    manager.attachOpenDocumentsForOrigin = async () => {};

    const session = {
        docId: 'doc-1',
        flushPromise: undefined,
        flushQueued: false,
        flushTimer: setTimeout(noop, 10_000),
        key: 'origin::doc-1',
        localText: 'pending local text',
        localVersion: 0,
        openDocumentUris: new Set(),
        origin: 'origin',
        overleafUri: createUri('overleaf://server/project/main.tex'),
        remoteText: 'server text',
        status: 'live',
        usesLocalReplica: false,
        vfs: {
            isOfflineMode: false,
            realtimeConnectionPhase: 'live',
        },
    };
    manager.sessions.set(session.key, session);

    const flushCalls = [];
    manager.flushSession = async (targetSession, reason) => {
        flushCalls.push(reason);
        targetSession.remoteText = targetSession.localText;
        targetSession.status = 'live';
    };

    const result = await manager.prepareProjectForRemoteOperation(createUri('overleaf://server/project'), 'compile_preflight');

    assert.equal(result, 'ready');
    assert.deepEqual(flushCalls, ['compile_preflight_forced_flush']);
    assert.equal(session.flushTimer, undefined);
});

test('prepareProjectForRemoteOperation blocks while a managed session still requires recovery', async () => {
    const manager = new DocumentSessionManager({
        prefetch: async () => ({
            isOfflineMode: false,
            origin: {
                toString: () => 'origin',
            },
            realtimeConnectionPhase: 'live',
        }),
    });
    manager.attachOpenDocumentsForOrigin = async () => {};

    manager.sessions.set('origin::doc-1', {
        docId: 'doc-1',
        flushQueued: false,
        key: 'origin::doc-1',
        localText: 'pending local text',
        localVersion: 0,
        openDocumentUris: new Set(),
        origin: 'origin',
        overleafUri: createUri('overleaf://server/project/main.tex'),
        remoteText: 'server text',
        status: 'recovery-required',
        usesLocalReplica: false,
        vfs: {
            isOfflineMode: false,
            realtimeConnectionPhase: 'live',
        },
    });

    const result = await manager.prepareProjectForRemoteOperation(createUri('overleaf://server/project'), 'compile_preflight');

    assert.equal(result, 'blocked');
});
