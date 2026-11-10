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

test('text operations preserve Unicode, including strings resembling packed UTF-8', () => {
    for (const removed of ['Ã©', 'é', '漢字', '😀', 'e\u0301']) {
        const base = `prefix ${removed} suffix`;
        assert.equal(applyTextOperationsToString(base, buildTextOperations(base, 'prefix  suffix')), 'prefix  suffix');
    }
});

test('invalid or stale operations fail without silently deleting a different range', () => {
    for (const ops of [[{p: -1, i: 'x'}], [{p: 99, i: 'x'}], [{p: 0.5, d: 'a'}], [{p: 1, d: 'x'}], [{p: 1, d: 'bcdef'}], [{p: 0, i: 'x', d: 'a'}], [null], [{p: 1, i: 42}]]) {
        assert.throws(() => applyTextOperationsToString('abc', ops));
    }
});

test('three-way recovery rejects conflicting replacements and deduplicates identical edits', () => {
    assert.equal(mergeRemoteTextIntoLocalText('value = 100', 'value = 300', 'value = 200').kind, 'conflict');
    assert.equal(mergeRemoteTextIntoLocalText('abc', 'ayc', 'axc').kind, 'conflict');
    assert.deepEqual(mergeRemoteTextIntoLocalText('abc', 'abXc', 'abXc'), {kind: 'merged', mergedText: 'abXc'});
});

test('three-way merge preserves concurrent insertions and rejects insertions inside deletions', () => {
    assert.deepEqual(mergeRemoteTextIntoLocalText('ab', 'aRb', 'aLb'), {kind: 'merged', mergedText: 'aLRb'});
    assert.equal(mergeRemoteTextIntoLocalText('abcdef', 'af', 'abcXdef').kind, 'conflict');
});

test('seeded edit sequences round-trip Unicode and sequential offsets', () => {
    let seed = 12345;
    const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
    const chars = ['a','b','é','漢','😀','\n',' ','Ã©'];
    let base = 'manuscript';
    for (let i=0;i<1000;i++) {
        const tokens = Array.from(base);
        const position = random(tokens.length + 1);
        tokens.splice(position, random(3), chars[random(chars.length)]);
        const next = tokens.join('');
        assert.equal(applyTextOperationsToString(base, buildTextOperations(base,next)),next);
        base = next.length>500 ? next.slice(0,200) : next;
    }
});

test('large documents retain exact content when merging distant incremental edits', () => {
    const base = 'line abcdefghijklmnopqrstuvwxyz\n'.repeat(32000);
    const merged = mergeRemoteTextIntoLocalText(base, base+'remote', 'local'+base);
    assert.deepEqual(merged, {kind:'merged', mergedText:'local'+base+'remote'});
});
