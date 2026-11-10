const test = require('node:test');
const assert = require('node:assert/strict');

const {
    applyPendingReviewLocalMutations,
    applyReviewMessageDeleteLocally,
    applyReviewMessageEditLocally,
    resolveReviewEntryByThreadOrMessage,
} = require('../out/comments/reviewLocalMutation.js');

function createEntry() {
    return {
        canDeleteRootComment: true,
        canEditRootComment: true,
        canReply: true,
        canResolveThread: true,
        docId: 'doc-1',
        filePath: 'main.tex',
        headerPreview: 'selected',
        lastActivityAt: 100,
        messages: [{
            authorName: 'Julio',
            canDelete: true,
            canEdit: true,
            content: 'Root message',
            deleteOwnOnly: false,
            id: 'message-root',
            isRoot: true,
            timestamp: 'now',
            userColor: '#000000',
            userId: 'user-1',
        }, {
            authorName: 'Julio',
            canDelete: true,
            canEdit: true,
            content: 'Reply message',
            deleteOwnOnly: false,
            id: 'message-reply',
            isRoot: false,
            timestamp: 'later',
            userColor: '#000000',
            userId: 'user-1',
        }],
        overleafUri: 'overleaf-workshop:/main.tex',
        rangeEnd: {character: 3, line: 0, offset: 3},
        rangeStart: {character: 0, line: 0, offset: 0},
        resolved: false,
        rootCommentId: 'message-root',
        rootCommentUserId: 'user-1',
        selectedText: 'selected',
        threadId: 'thread-1',
    };
}

test('applyReviewMessageEditLocally updates the targeted message content', () => {
    const entry = createEntry();

    const nextEntry = applyReviewMessageEditLocally(entry, 'message-reply', 'Edited reply');

    assert.equal(nextEntry.messages[0].content, 'Root message');
    assert.equal(nextEntry.messages[1].content, 'Edited reply');
});

test('applyReviewMessageDeleteLocally removes a reply and keeps the root intact', () => {
    const entry = createEntry();

    const nextEntry = applyReviewMessageDeleteLocally(entry, 'message-reply');

    assert.equal(nextEntry.messages.length, 1);
    assert.equal(nextEntry.messages[0].id, 'message-root');
    assert.equal(nextEntry.messages[0].isRoot, true);
    assert.equal(nextEntry.rootCommentId, 'message-root');
});

test('applyReviewMessageDeleteLocally promotes the next message when deleting the root', () => {
    const entry = createEntry();

    const nextEntry = applyReviewMessageDeleteLocally(entry, 'message-root');

    assert.equal(nextEntry.messages.length, 1);
    assert.equal(nextEntry.messages[0].id, 'message-reply');
    assert.equal(nextEntry.messages[0].isRoot, true);
    assert.equal(nextEntry.rootCommentId, 'message-reply');
    assert.equal(nextEntry.rootCommentUserId, 'user-1');
    assert.equal(nextEntry.canDeleteRootComment, true);
    assert.equal(nextEntry.canEditRootComment, true);
});

test('applyReviewMessageDeleteLocally removes the entry when deleting the last message', () => {
    const entry = createEntry();
    entry.messages = [entry.messages[0]];

    const nextEntry = applyReviewMessageDeleteLocally(entry, 'message-root');

    assert.equal(nextEntry, undefined);
});

test('resolveReviewEntryByThreadOrMessage falls back to message id when thread ids drift', () => {
    const entry = createEntry();

    const resolved = resolveReviewEntryByThreadOrMessage([entry], 'thread-legacy', 'message-reply');

    assert.equal(resolved.entry.threadId, 'thread-1');
    assert.equal(resolved.matchedBy, 'messageId');
});

test('resolveReviewEntryByThreadOrMessage prefers direct thread id matches', () => {
    const entry = createEntry();

    const resolved = resolveReviewEntryByThreadOrMessage([entry], 'thread-1', 'message-reply');

    assert.equal(resolved.entry.threadId, 'thread-1');
    assert.equal(resolved.matchedBy, 'threadId');
});

test('applyPendingReviewLocalMutations reapplies an offline edit onto stale refreshed entries', () => {
    const entry = createEntry();

    const result = applyPendingReviewLocalMutations([entry], [{
        content: 'Root message.',
        kind: 'editMessage',
        messageId: 'message-root',
        threadId: 'thread-1',
    }]);

    assert.equal(result.entries[0].messages[0].content, 'Root message.');
    assert.deepEqual(result.retainedMutations, [{
        content: 'Root message.',
        kind: 'editMessage',
        messageId: 'message-root',
        threadId: 'thread-1',
    }]);
});

test('applyPendingReviewLocalMutations clears an edit override once refreshed entries already match it', () => {
    const entry = createEntry();
    entry.messages[0].content = 'Root message.';

    const result = applyPendingReviewLocalMutations([entry], [{
        content: 'Root message.',
        kind: 'editMessage',
        messageId: 'message-root',
        threadId: 'thread-1',
    }]);

    assert.equal(result.entries[0].messages[0].content, 'Root message.');
    assert.deepEqual(result.retainedMutations, []);
});

test('applyPendingReviewLocalMutations keeps a delete applied until refreshed entries stop containing the message', () => {
    const entry = createEntry();

    const result = applyPendingReviewLocalMutations([entry], [{
        kind: 'deleteMessage',
        messageId: 'message-reply',
        threadId: 'thread-1',
    }]);

    assert.equal(result.entries[0].messages.length, 1);
    assert.equal(result.entries[0].messages[0].id, 'message-root');
    assert.deepEqual(result.retainedMutations, [{
        kind: 'deleteMessage',
        messageId: 'message-reply',
        threadId: 'thread-1',
    }]);
});

test('explicit thread deletion removes replies and suppresses a stale review snapshot until absence is confirmed',()=>{
    const deletion={kind:'deleteThread',threadId:'thread-1',messageId:'message-root'};
    const first=applyPendingReviewLocalMutations([createEntry()],[deletion]);
    assert.deepEqual(first.entries,[]);assert.deepEqual(first.retainedMutations,[deletion]);
    const stale=applyPendingReviewLocalMutations([createEntry()],first.retainedMutations);
    assert.deepEqual(stale.entries,[]);
    assert.deepEqual(applyPendingReviewLocalMutations([],stale.retainedMutations).retainedMutations,[]);
});
