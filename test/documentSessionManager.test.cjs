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
        getConfiguration: () => ({
            get: (_key, fallback) => fallback,
        }),
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

test('shutdown checkpoints every editor even when another draft write fails', async () => {
    const manager=Object.create(DocumentSessionManager.prototype);const saved=[];
    manager.sessions=new Map([
        ['first',{remoteText:'base',vfs:{persistTextDocumentDraft:async()=>{throw new Error('disk failure');}}}],
        ['second',{remoteText:'base',vfs:{persistTextDocumentDraft:async(_uri,text)=>{saved.push(text);}}}],
    ]);
    manager.readCurrentSessionText=()=> 'unsaved draft';
    await assert.rejects(manager.persistOpenDrafts(),/disk failure/);
    assert.deepEqual(saved,['unsaved draft']);
});

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
            persistTextDocumentDraft: async () => {},
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

test('remote editor updates are serialized in arrival order and flushing waits for the queue', async () => {
    const manager = new DocumentSessionManager({});
    const session = {docId: 'd', origin: 'o', key: 'o::d', localText: 'local', remoteText: 'remote', status: 'live'};
    manager.sessions.set(session.key, session);
    const calls = []; let release;
    const gate = new Promise(resolve => {release = resolve;});
    manager.applyRemoteTextUpdate = async arg => {calls.push(`start${arg.id}`); if(arg.id===1) await gate; calls.push(`end${arg.id}`);};
    manager.scheduleFlush = () => calls.push('flush');
    const first = manager.handleRemoteTextUpdate({origin: 'o', docId: 'd', id: 1});
    const second = manager.handleRemoteTextUpdate({origin: 'o', docId: 'd', id: 2});
    await Promise.resolve(); assert.deepEqual(calls, ['start1']);
    release(); await Promise.all([first, second]);
    assert.deepEqual(calls, ['start1', 'end1', 'start2', 'end2', 'flush']);
});

test('out-of-order asynchronous comment updates cannot roll editor text or version backward', async () => {
    const manager = new DocumentSessionManager({}); let release;
    const gate = new Promise(resolve => {release = resolve;});
    const session = {localText: 'base', localVersion: 0, usesLocalReplica: true, status: 'syncing', vfs: {
        applyLocalTextDocumentChangesToCommentRanges: async (_uri, _old, text) => {if(text==='first') await gate;},
    }};
    const first = manager.processSessionDocumentChange(session, 'first');
    const second = manager.processSessionDocumentChange(session, 'second');
    await second; release(); await first;
    assert.equal(session.localText, 'second'); assert.equal(session.localVersion, 2);
});

test('failed authoritative recovery never substitutes stale cached data', async () => {
    const manager = new DocumentSessionManager({});
    const session = {usesLocalReplica: true, openDocumentUris: new Set(), localText: 'keep local', vfs: {
        refreshTextDocumentSessionFromServer: async () => {throw new Error('checkpoint unavailable');},
        ensureTextDocumentSession: async () => {throw new Error('must not use stale cache');},
    }};
    await assert.rejects(manager.recoverSession(session, 'test'), /checkpoint unavailable/);
    assert.equal(session.localText, 'keep local');
});
function revisionFixture(){
    const manager=new DocumentSessionManager({});
    const conflicts=[];let recovery=0,edits=0;
    const session={docId:'d',origin:'o',key:'o::d',localText:'base',remoteText:'base',remoteVersion:4,localVersion:0,status:'live',
        openDocumentUris:new Set(),overleafUri:createUri('overleaf://server/main.tex'),vfs:{
            isOfflineMode:false,realtimeConnectionPhase:'live',acceptRemoteTextUpdate(){},
            recordDocumentSyncConflict:async record=>conflicts.push(record),requestRealtimeRecovery:async()=>{recovery++;},
            toDocumentSyncRelPath:()=>'/main.tex',ensureTextDocumentSession:async()=>({remoteText:'remote',version:5}),
        }};
    manager.sessions.set(session.key,session);
    manager.applyRemoteTextToOpenDocuments=async(_session,text)=>{edits++;session.localText=text;return 'applied';};
    manager.scheduleFlush=()=>{};manager.clearSessionIfUnused=()=>{};
    const update=(v,previous='base',next='remote')=>({docId:'d',origin:'o',overleafUri:'uri',previousRemoteText:previous,nextRemoteText:next,
        update:{v,op:[{p:0,i:'remote'}]}});
    return {manager,session,conflicts,update,get recovery(){return recovery;},get edits(){return edits;}};
}
test('updates queued before an authoritative recovery cannot overwrite the recovered revision',async()=>{
    const f=revisionFixture();let checkpoint;
    f.session.vfs.ensureTextDocumentSession=()=>new Promise(resolve=>{checkpoint=resolve;});
    const recovery=f.manager.startRecovery(f.session,'reconnect');
    await new Promise(resolve=>setImmediate(resolve));
    const old=f.manager.handleRemoteTextUpdate(f.update(4,'base','old remote'));
    checkpoint({remoteText:'latest remote',version:7});await Promise.all([recovery,old]);
    assert.equal(f.session.remoteVersion,7);assert.equal(f.session.localText,'latest remote');assert.equal(f.edits,1);assert.equal(f.conflicts.length,0);
});
test('duplicate remote revisions are ignored before editing and mismatched bases preserve recoverable copies',async()=>{
    const f=revisionFixture();
    await f.manager.handleRemoteTextUpdate(f.update(3));assert.equal(f.edits,0);assert.equal(f.session.localText,'base');
    await f.manager.handleRemoteTextUpdate(f.update(5,'different base','later remote'));
    assert.equal(f.edits,0);assert.equal(f.session.status,'recovery-required');assert.equal(f.conflicts.length,1);assert.equal(f.recovery,1);
    assert.equal(new TextDecoder().decode(f.conflicts[0].localContent),'base');
});
test('repeated stale editor applications become explicit recoverable failures instead of silent divergence',async()=>{
    const f=revisionFixture();f.manager.applyRemoteTextToOpenDocuments=async()=> 'stale-local-state';
    await f.manager.handleRemoteTextUpdate(f.update(4));
    assert.equal(f.session.status,'recovery-required');assert.equal(f.session.localText,'base');
    assert.equal(f.conflicts[0].reason,'document_remote_update_stale_local_retry_exhausted');assert.equal(f.recovery,1);
});
test('recovery rejects older checkpoints and repeated stale local state retains local and remote copies',async()=>{
    const f=revisionFixture();f.session.vfs.ensureTextDocumentSession=async()=>({remoteText:'older',version:3});
    await assert.rejects(f.manager.recoverSession(f.session,'test'),/older/);assert.equal(f.edits,0);
    f.session.vfs.ensureTextDocumentSession=async()=>({remoteText:'remote',version:5});
    f.manager.applyRemoteTextToOpenDocuments=async()=> 'stale-local-state';
    await f.manager.recoverSession(f.session,'test');assert.equal(f.session.status,'recovery-required');
    assert.equal(f.conflicts[0].reason,'document_recovery_stale_local_retry_exhausted');
});
test('a late flush completion cannot replace a remote update that finished during checkpoint persistence',async()=>{
    const f=revisionFixture();f.session.localText='local';let finish;
    f.session.vfs.pushTextDocumentChanges=()=>new Promise(resolve=>{finish=resolve;});
    const pending=f.manager.flushSession(f.session,'test');await Promise.resolve();
    f.session.remoteText='newer remote';f.session.localText='newer local';f.session.remoteVersion=6;
    finish({kind:'applied'});await pending;
    assert.equal(f.session.remoteText,'newer remote');assert.equal(f.session.remoteVersion,6);assert.equal(f.session.localText,'newer local');
});
test('reattaching an editor does not adopt a checkpoint ahead of still-queued remote edits',async()=>{
    const f=revisionFixture();f.session.pendingRemoteUpdates=1;
    const document={uri:createUri('overleaf://server/main.tex'),getText:()=> 'base'};
    f.manager.resolveBinding=async()=>({docId:'d',loadedFromCache:false,localText:'base',remoteText:'remote',remoteVersion:5,
        overleafUri:document.uri,sessionKey:f.session.key,status:'live',usesLocalReplica:false,
        vfs:{...f.session.vfs,origin:{toString:()=> 'o'}}});
    await f.manager.attachDocument(document,'reattach');
    assert.equal(f.session.remoteVersion,4);assert.equal(f.session.remoteText,'base');f.session.pendingRemoteUpdates=0;
    await f.manager.handleRemoteTextUpdate(f.update(4));assert.equal(f.session.localText,'remote');assert.equal(f.session.remoteVersion,5);
});
test('remote-operation preflight waits for queued editor updates before considering local text synchronized',async()=>{
    const f=revisionFixture();let release,drained=false;
    f.manager.vfsm={prefetch:async()=>f.session.vfs};f.session.pendingRemoteUpdates=1;
    f.session.remoteUpdateQueue={idle:()=>new Promise(resolve=>{release=()=>{drained=true;f.session.pendingRemoteUpdates=0;resolve();};})};
    const pending=f.manager.drainSessionForRemoteOperation(f.session,'compile');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(drained,false);release();await pending;assert.equal(drained,true);
});
