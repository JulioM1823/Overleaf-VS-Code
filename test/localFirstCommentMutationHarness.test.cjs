const test = require('node:test');
const assert = require('node:assert/strict');

const {
    LocalFirstCommentMutationHarness,
} = require('./support/localFirstCommentMutationHarness.cjs');

function assertReviewInlineParity(harness, docId) {
    const inlineSummary = harness.getInlineSnapshot(docId).threads
        .filter(({thread}) => (thread?.messages.length ?? 0) > 0)
        .map(({range, thread}) => ({
            messageBodies: thread.messages.map((message) => message.content),
            messageIds: thread.messages.map((message) => message.id),
            resolved: Boolean(thread.resolved ?? range.resolved ?? range.op.resolved),
            selectedText: range.op.c,
            threadId: range.op.t,
        }))
        .sort((left, right) => left.threadId.localeCompare(right.threadId));

    const reviewSummary = harness.getReviewEntries(docId)
        .map((entry) => ({
            messageBodies: entry.messageBodies,
            messageIds: entry.messageIds,
            resolved: entry.resolved,
            selectedText: entry.selectedText,
            threadId: entry.threadId,
        }))
        .sort((left, right) => left.threadId.localeCompare(right.threadId));

    assert.deepEqual(reviewSummary, inlineSummary);
}

test('local-first create mutates state before persistence resolves and reconciles server id', async () => {
    const harness = new LocalFirstCommentMutationHarness();
    let resolvePersist;
    const persist = () => new Promise((resolve) => {
        resolvePersist = resolve;
    });

    const mutationPromise = harness.createComment({
        content: 'First comment',
        docId: 'doc-1',
        selectedText: 'alpha',
        startOffset: 5,
        threadId: 'thread-1',
        persist,
    });

    const threadBeforePersist = harness.getThread('thread-1');
    const rangesBeforePersist = harness.getRanges('doc-1');
    assert.equal(threadBeforePersist?.messages.length, 1);
    assert.equal(threadBeforePersist?.messages[0].content, 'First comment');
    assert.equal(rangesBeforePersist.length, 1);
    assert.equal(rangesBeforePersist[0].op.t, 'thread-1');
    assertReviewInlineParity(harness, 'doc-1');

    resolvePersist({ serverMessageId: 'server-message-1' });
    const result = await mutationPromise;

    assert.equal(result.status, 'persisted');
    assert.equal(harness.getThread('thread-1')?.messages[0].id, 'server-message-1');
    assertReviewInlineParity(harness, 'doc-1');
});

test('local-first create keeps local state and queues operation on connectivity failure', async () => {
    const harness = new LocalFirstCommentMutationHarness();
    const result = await harness.createComment({
        content: 'Offline-ish comment',
        docId: 'doc-2',
        selectedText: 'beta',
        startOffset: 0,
        threadId: 'thread-2',
        persist: async () => {
            const error = new Error('network unavailable');
            error.code = 'ENOTFOUND';
            throw error;
        },
    });

    assert.equal(result.status, 'queued');
    assert.deepEqual(harness.getQueuedOperationKinds(), ['comment.create']);
    assert.equal(harness.getThread('thread-2')?.messages[0].content, 'Offline-ish comment');
    assert.equal(harness.getRanges('doc-2').length, 1);
    assertReviewInlineParity(harness, 'doc-2');
});

test('local-first edit rolls back on non-connectivity failure', async () => {
    const harness = new LocalFirstCommentMutationHarness();
    harness.seedThread({
        docId: 'doc-3',
        messages: [
            {
                content: 'Original',
                id: 'message-1',
                timestamp: '2026-04-15T12:00:00.000Z',
                user: { id: 'user-1', name: 'user-1' },
                user_id: 'user-1',
            },
        ],
        selectedText: 'gamma',
        startOffset: 3,
        threadId: 'thread-3',
    });

    const result = await harness.editComment({
        content: 'Edited content',
        messageId: 'message-1',
        threadId: 'thread-3',
        persist: async () => {
            throw new Error('forbidden');
        },
    });

    assert.equal(result.status, 'rolled_back');
    assert.equal(harness.getThread('thread-3')?.messages[0].content, 'Original');
    assert.deepEqual(harness.getQueuedOperationKinds(), []);
    assertReviewInlineParity(harness, 'doc-3');
});

test('local-first delete keeps deletion on connectivity failure and queues replay', async () => {
    const harness = new LocalFirstCommentMutationHarness();
    harness.seedThread({
        docId: 'doc-4',
        messages: [
            {
                content: 'Delete me',
                id: 'message-1',
                timestamp: '2026-04-15T12:00:00.000Z',
                user: { id: 'user-1', name: 'user-1' },
                user_id: 'user-1',
            },
        ],
        selectedText: 'delta',
        startOffset: 8,
        threadId: 'thread-4',
    });

    const result = await harness.deleteComment({
        messageId: 'message-1',
        ownOnly: true,
        threadId: 'thread-4',
        persist: async () => {
            const error = new Error('socket timeout');
            error.code = 'ETIMEDOUT';
            throw error;
        },
    });

    assert.equal(result.status, 'queued');
    assert.equal(harness.getThread('thread-4'), undefined);
    assert.equal(harness.getRanges('doc-4').length, 0);
    assert.deepEqual(harness.getQueuedOperationKinds(), ['comment.deleteMessage']);
    assertReviewInlineParity(harness, 'doc-4');
});

test('local-first delete rolls back thread and ranges on non-connectivity failure', async () => {
    const harness = new LocalFirstCommentMutationHarness();
    harness.seedThread({
        docId: 'doc-5',
        messages: [
            {
                content: 'Keep me after rollback',
                id: 'message-1',
                timestamp: '2026-04-15T12:00:00.000Z',
                user: { id: 'user-1', name: 'user-1' },
                user_id: 'user-1',
            },
        ],
        selectedText: 'epsilon',
        startOffset: 1,
        threadId: 'thread-5',
    });

    const result = await harness.deleteComment({
        messageId: 'message-1',
        ownOnly: true,
        threadId: 'thread-5',
        persist: async () => {
            throw new Error('validation failure');
        },
    });

    assert.equal(result.status, 'rolled_back');
    assert.equal(harness.getThread('thread-5')?.messages.length, 1);
    assert.equal(harness.getRanges('doc-5').length, 1);
    assert.deepEqual(harness.getQueuedOperationKinds(), []);
    assertReviewInlineParity(harness, 'doc-5');
});

test('local-first resolve and reopen keep review and inline state synchronized', async () => {
    const harness = new LocalFirstCommentMutationHarness();
    harness.seedThread({
        docId: 'doc-6',
        messages: [
            {
                content: 'Resolvable thread',
                id: 'message-1',
                timestamp: '2026-04-15T12:00:00.000Z',
                user: {id: 'user-1', name: 'user-1'},
                user_id: 'user-1',
            },
        ],
        selectedText: 'zeta',
        startOffset: 2,
        threadId: 'thread-6',
    });

    assertReviewInlineParity(harness, 'doc-6');

    const resolveResult = await harness.resolveThread({
        resolved: true,
        threadId: 'thread-6',
        persist: async () => ({}),
    });
    assert.equal(resolveResult.status, 'persisted');
    assert.equal(harness.getThread('thread-6')?.resolved, true);
    assertReviewInlineParity(harness, 'doc-6');

    const reopenResult = await harness.resolveThread({
        resolved: false,
        threadId: 'thread-6',
        persist: async () => ({}),
    });
    assert.equal(reopenResult.status, 'persisted');
    assert.equal(Boolean(harness.getThread('thread-6')?.resolved), false);
    assertReviewInlineParity(harness, 'doc-6');
});

test('queued create replay restores missing inline range and keeps review parity', async () => {
    const harness = new LocalFirstCommentMutationHarness();

    const createResult = await harness.createComment({
        content: 'Offline replay target',
        docId: 'doc-7',
        selectedText: 'eta',
        startOffset: 7,
        threadId: 'thread-7',
        persist: async () => {
            const error = new Error('network unavailable');
            error.code = 'ENOTFOUND';
            throw error;
        },
    });

    assert.equal(createResult.status, 'queued');
    assert.deepEqual(harness.getQueuedOperationKinds(), ['comment.create']);
    assert.equal(harness.getRanges('doc-7').length, 1);

    // Simulate a reconnect hydration race that dropped local ranges before replay.
    harness.rangesByDocId.set('doc-7', []);
    assert.equal(harness.getRanges('doc-7').length, 0);

    const replayResults = await harness.replayQueuedCommentCreates({
        persist: async () => ({
            serverMessageId: 'server-message-7',
        }),
    });

    assert.deepEqual(replayResults, [{
        status: 'replayed',
        threadId: 'thread-7',
    }]);
    assert.deepEqual(harness.getQueuedOperationKinds(), []);
    assert.equal(harness.getRanges('doc-7').length, 1);
    assert.equal(harness.getRanges('doc-7')[0].op.t, 'thread-7');
    assert.equal(harness.getThread('thread-7')?.messages[0].id, 'server-message-7');
    assertReviewInlineParity(harness, 'doc-7');
});

test('offline edits to a newly created queued comment are folded into replayed create content', async () => {
    const harness = new LocalFirstCommentMutationHarness();

    const createResult = await harness.createComment({
        content: 'Original offline comment',
        docId: 'doc-7b',
        selectedText: 'eta-prime',
        startOffset: 10,
        threadId: 'thread-7b',
        persist: async () => {
            const error = new Error('network unavailable');
            error.code = 'ENOTFOUND';
            throw error;
        },
    });

    assert.equal(createResult.status, 'queued');
    assert.deepEqual(harness.getQueuedOperationKinds(), ['comment.create']);

    const editResult = await harness.editComment({
        content: 'Edited while still offline',
        messageId: createResult.localMessageId,
        threadId: 'thread-7b',
        persist: async () => {
            const error = new Error('network unavailable');
            error.code = 'ENOTFOUND';
            throw error;
        },
    });

    assert.equal(editResult.status, 'queued');
    assert.deepEqual(harness.getQueuedOperationKinds(), ['comment.create']);
    assert.equal(harness.getThread('thread-7b')?.messages[0].content, 'Edited while still offline');
    assertReviewInlineParity(harness, 'doc-7b');

    const replayResults = await harness.replayQueuedCommentCreates({
        persist: async ({content}) => ({
            echoedContent: content,
            serverMessageId: 'server-message-7b',
        }),
    });

    assert.deepEqual(replayResults, [{
        status: 'replayed',
        threadId: 'thread-7b',
    }]);
    assert.deepEqual(harness.getQueuedOperationKinds(), []);
    assert.equal(harness.getThread('thread-7b')?.messages[0].id, 'server-message-7b');
    assert.equal(harness.getThread('thread-7b')?.messages[0].content, 'Edited while still offline');
    assertReviewInlineParity(harness, 'doc-7b');
});

test('recovery hydration preserves queued create range and thread state', async () => {
    const harness = new LocalFirstCommentMutationHarness();

    const createResult = await harness.createComment({
        content: 'Queued hydration target',
        docId: 'doc-8',
        selectedText: 'theta',
        startOffset: 4,
        threadId: 'thread-8',
        persist: async () => {
            const error = new Error('network unavailable');
            error.code = 'ENOTFOUND';
            throw error;
        },
    });

    assert.equal(createResult.status, 'queued');
    harness.hydrateServerRangesDuringRecovery('doc-8', []);
    harness.hydrateServerThreadsDuringRecovery({});

    assert.equal(harness.getRanges('doc-8').length, 1);
    assert.equal(harness.getRanges('doc-8')[0].op.t, 'thread-8');
    assert.equal(harness.getThread('thread-8')?.messages[0].content, 'Queued hydration target');
    assertReviewInlineParity(harness, 'doc-8');
});

test('offline create replay with server thread reconciliation keeps review synchronized for later edits', async () => {
    const harness = new LocalFirstCommentMutationHarness();

    const createResult = await harness.createComment({
        content: 'Offline root comment',
        docId: 'doc-9',
        selectedText: 'iota',
        startOffset: 9,
        threadId: 'thread-9-local',
        persist: async () => {
            const error = new Error('network unavailable');
            error.code = 'ENOTFOUND';
            throw error;
        },
    });

    assert.equal(createResult.status, 'queued');
    assertReviewInlineParity(harness, 'doc-9');

    const replayResults = await harness.replayQueuedCommentCreates({
        persist: async () => ({
            serverMessageId: 'server-message-9',
        }),
    });

    assert.deepEqual(replayResults, [{
        status: 'replayed',
        threadId: 'thread-9-local',
    }]);

    harness.reconcileThreadId({
        docId: 'doc-9',
        localThreadId: 'thread-9-local',
        serverThreadId: 'thread-9-server',
    });

    const editResult = await harness.editComment({
        content: 'Edited after reconnect',
        messageId: 'server-message-9',
        threadId: 'thread-9-server',
        persist: async () => ({}),
    });

    assert.equal(editResult.status, 'persisted');
    assert.equal(harness.getThread('thread-9-local'), undefined);
    assert.equal(harness.getThread('thread-9-server')?.messages[0].content, 'Edited after reconnect');
    assert.equal(harness.getRanges('doc-9')[0].op.t, 'thread-9-server');
    assertReviewInlineParity(harness, 'doc-9');
});

test('online create followed by replay-style thread reconciliation keeps review synchronized for edits', async () => {
    const harness = new LocalFirstCommentMutationHarness();

    const createResult = await harness.createComment({
        content: 'Online root comment',
        docId: 'doc-10',
        selectedText: 'kappa',
        startOffset: 11,
        threadId: 'thread-10-local',
        persist: async () => ({
            serverMessageId: 'server-message-10',
        }),
    });

    assert.equal(createResult.status, 'persisted');
    harness.reconcileThreadId({
        docId: 'doc-10',
        localThreadId: 'thread-10-local',
        serverThreadId: 'thread-10-server',
    });

    const editResult = await harness.editComment({
        content: 'Edited after reconciliation',
        messageId: 'server-message-10',
        threadId: 'thread-10-server',
        persist: async () => ({}),
    });

    assert.equal(editResult.status, 'persisted');
    assert.equal(harness.getThread('thread-10-local'), undefined);
    assert.equal(harness.getThread('thread-10-server')?.messages[0].content, 'Edited after reconciliation');
    assert.equal(harness.getRanges('doc-10')[0].op.t, 'thread-10-server');
    assertReviewInlineParity(harness, 'doc-10');
});
