const test = require('node:test');
const assert = require('node:assert/strict');

const {
    evaluateCommentReplayAgainstManagedDocument,
    evaluateCommentReplayAgainstQueuedLocalReplica,
} = require('../out/comments/commentReplaySafety.js');

test('evaluateCommentReplayAgainstQueuedLocalReplica allows replay when no queued local replica change exists', () => {
    assert.deepEqual(evaluateCommentReplayAgainstQueuedLocalReplica({
        hasQueuedLocalReplicaChangeForPath: false,
        remoteText: 'abcdefghij',
        selectedText: 'def',
        startOffset: 3,
    }), {
        remoteSelectedText: 'def',
        selectionMatchesServer: true,
        shouldDefer: false,
    });
});

test('evaluateCommentReplayAgainstQueuedLocalReplica defers replay when the queued anchor text no longer matches the server doc', () => {
    assert.deepEqual(evaluateCommentReplayAgainstQueuedLocalReplica({
        hasQueuedLocalReplicaChangeForPath: true,
        remoteText: 'abcXYZghij',
        selectedText: 'def',
        startOffset: 3,
    }), {
        remoteSelectedText: 'XYZ',
        selectionMatchesServer: false,
        shouldDefer: true,
    });
});

test('evaluateCommentReplayAgainstQueuedLocalReplica allows replay for same-path file queues when the anchor text still matches', () => {
    assert.deepEqual(evaluateCommentReplayAgainstQueuedLocalReplica({
        hasQueuedLocalReplicaChangeForPath: true,
        remoteText: 'abcdefghij',
        selectedText: 'def',
        startOffset: 3,
    }), {
        remoteSelectedText: 'def',
        selectionMatchesServer: true,
        shouldDefer: false,
    });
});

test('evaluateCommentReplayAgainstManagedDocument defers replay while an open document is still offline queued', () => {
    assert.deepEqual(evaluateCommentReplayAgainstManagedDocument({
        localDocumentText: 'abcLOCALghij',
        managedDocumentState: 'offline-queued',
        remoteText: 'abcREMOTEij',
        selectedText: 'LOCAL',
        startOffset: 3,
    }), {
        hasOpenManagedDocument: true,
        localDocumentDiffersFromServer: true,
        localSelectedText: 'LOCAL',
        managedDocumentState: 'offline-queued',
        remoteSelectedText: 'REMOT',
        selectionMatchesLocalDocument: true,
        shouldDefer: true,
    });
});

test('evaluateCommentReplayAgainstManagedDocument defers replay while an open document is still syncing', () => {
    assert.deepEqual(evaluateCommentReplayAgainstManagedDocument({
        localDocumentText: 'abcLOCALghij',
        managedDocumentState: 'syncing',
        remoteText: 'abcREMOTEij',
        selectedText: 'LOCAL',
        startOffset: 3,
    }), {
        hasOpenManagedDocument: true,
        localDocumentDiffersFromServer: true,
        localSelectedText: 'LOCAL',
        managedDocumentState: 'syncing',
        remoteSelectedText: 'REMOT',
        selectionMatchesLocalDocument: true,
        shouldDefer: true,
    });
});

test('evaluateCommentReplayAgainstManagedDocument allows replay once the managed document is live again', () => {
    assert.deepEqual(evaluateCommentReplayAgainstManagedDocument({
        localDocumentText: 'abcdefghij',
        managedDocumentState: 'live',
        remoteText: 'abcdefghij',
        selectedText: 'def',
        startOffset: 3,
    }), {
        hasOpenManagedDocument: true,
        localDocumentDiffersFromServer: false,
        localSelectedText: 'def',
        managedDocumentState: 'live',
        remoteSelectedText: 'def',
        selectionMatchesLocalDocument: true,
        shouldDefer: false,
    });
});
