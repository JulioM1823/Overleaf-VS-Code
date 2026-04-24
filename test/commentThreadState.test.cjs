const test = require('node:test');
const assert = require('node:assert/strict');

const {
    areStableCommentRenderListsEqual,
    collapseExpandedCommentThreads,
} = require('../out/comments/commentThreadState.js');

test('collapseExpandedCommentThreads collapses only expanded threads', () => {
    const threads = [
        { collapsibleState: 1, id: 'a' },
        { collapsibleState: 0, id: 'b' },
        { collapsibleState: 1, id: 'c' },
    ];
    const collapsedCount = collapseExpandedCommentThreads(threads);
    assert.equal(collapsedCount, 2);
    assert.deepEqual(threads.map((thread) => thread.collapsibleState), [0, 0, 0]);
});

test('collapseExpandedCommentThreads is a no-op when every thread is already collapsed', () => {
    const threads = [
        { collapsibleState: 0 },
        { collapsibleState: 0 },
    ];
    const collapsedCount = collapseExpandedCommentThreads(threads);
    assert.equal(collapsedCount, 0);
    assert.deepEqual(threads.map((thread) => thread.collapsibleState), [0, 0]);
});

test('areStableCommentRenderListsEqual ignores object identity for unchanged comments', () => {
    const first = [{
        author: { iconPath: { toString: () => 'icon:blue' }, name: 'Ada' },
        body: 'Same text',
        contextValue: 'overleafComment root editable',
        label: 'Today',
        mode: 0,
        overleafMessageId: 'message-1',
        overleafThreadId: 'thread-1',
        overleafUserId: 'user-1',
    }];
    const second = [{
        author: { iconPath: { toString: () => 'icon:blue' }, name: 'Ada' },
        body: 'Same text',
        contextValue: 'overleafComment root editable',
        label: 'Today',
        mode: 0,
        overleafMessageId: 'message-1',
        overleafThreadId: 'thread-1',
        overleafUserId: 'user-1',
    }];

    assert.equal(areStableCommentRenderListsEqual(first, second), true);
});

test('areStableCommentRenderListsEqual detects visible comment changes', () => {
    const first = [{
        body: 'Original',
        overleafMessageId: 'message-1',
        overleafThreadId: 'thread-1',
    }];
    const second = [{
        body: 'Edited',
        overleafMessageId: 'message-1',
        overleafThreadId: 'thread-1',
    }];

    assert.equal(areStableCommentRenderListsEqual(first, second), false);
});
