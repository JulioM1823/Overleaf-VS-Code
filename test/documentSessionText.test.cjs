const test = require('node:test');
const assert = require('node:assert/strict');

const {
    applyTextOperationsToString,
    buildTextOperations,
    mergeRemoteTextIntoLocalText,
    resolveJoinedDocumentTextState,
    serializeTextOperations,
} = require('../out/core/documentSessionText.js');

test('buildTextOperations round-trips text edits against the remote base text', () => {
    const remoteText = 'Astroseismology is great.\n';
    const localText = 'Astroseismology is very great.\n';
    const operations = buildTextOperations(remoteText, localText);

    assert.equal(serializeTextOperations(operations).includes('very '), true);
    assert.equal(applyTextOperationsToString(remoteText, operations), localText);
});

test('applyTextOperationsToString applies sequential insert and delete operations', () => {
    const operations = [
        { p: 1, i: 'X' },
        { p: 4, d: 'd' },
    ];
    assert.equal(applyTextOperationsToString('abcd', operations), 'aXbc');
});

test('mergeRemoteTextIntoLocalText rebases a pending local edit onto a remote update', () => {
    const merged = mergeRemoteTextIntoLocalText('abcd', 'abcdY', 'abXcd');

    assert.equal(merged.kind, 'merged');
    assert.equal(merged.mergedText, 'abXcdY');
});

test('mergeRemoteTextIntoLocalText merges concurrent non-overlapping edits', () => {
    const base = 'line one\nline two\nline three\n';
    const remote = 'line one\nline two remote\nline three\n';
    const local = 'line one\nline two\nline three local\n';

    const merged = mergeRemoteTextIntoLocalText(base, remote, local);
    assert.equal(merged.kind, 'merged');
    assert.equal(merged.mergedText, 'line one\nline two remote\nline three local\n');
});

test('mergeRemoteTextIntoLocalText keeps merging with repeated nearby text', () => {
    const base = 'alpha beta alpha beta alpha\n';
    const remote = 'alpha beta alpha REMOTE beta alpha\n';
    const local = 'alpha beta alpha beta alpha LOCAL\n';

    const merged = mergeRemoteTextIntoLocalText(base, remote, local);
    assert.equal(merged.kind, 'merged');
    assert.equal(merged.mergedText, 'alpha beta alpha REMOTE beta alpha LOCAL\n');
});

test('resolveJoinedDocumentTextState refreshes stale cache from the joined remote snapshot', () => {
    const resolved = resolveJoinedDocumentTextState({
        joinedText: 'server authoritative text',
        localText: 'stale cached text',
        remoteText: 'stale cached text',
    });

    assert.equal(resolved.hasLocalDivergence, false);
    assert.equal(resolved.contentToOpen, 'server authoritative text');
    assert.equal(resolved.nextLocalText, 'server authoritative text');
    assert.equal(resolved.nextRemoteText, 'server authoritative text');
});

test('resolveJoinedDocumentTextState preserves local divergence while refreshing the remote base', () => {
    const resolved = resolveJoinedDocumentTextState({
        joinedText: 'server authoritative text',
        localText: 'local unsynced edit',
        remoteText: 'stale cached text',
    });

    assert.equal(resolved.hasLocalDivergence, true);
    assert.equal(resolved.contentToOpen, 'local unsynced edit');
    assert.equal(resolved.nextLocalText, 'local unsynced edit');
    assert.equal(resolved.nextRemoteText, 'server authoritative text');
});
