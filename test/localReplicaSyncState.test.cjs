const test = require('node:test');
const assert = require('node:assert/strict');

const {
    classifyLocalReplicaReconcile,
    classifyLocalReplicaRuntimeSync,
    createLocalReplicaSnapshot,
    localReplicaSnapshotsEqual,
    mergeLocalReplicaText,
    parsePersistedLocalReplicaSyncState,
    recordLocalReplicaBaseline,
    recordLocalReplicaConflict,
    serializePersistedLocalReplicaSyncState,
} = require('../out/scm/localReplicaSyncState.js');

function textSnapshot(value) {
    return createLocalReplicaSnapshot('file', new TextEncoder().encode(value));
}

test('classifyLocalReplicaReconcile pulls remote content into an empty local replica', () => {
    assert.deepEqual(
        classifyLocalReplicaReconcile(undefined, createLocalReplicaSnapshot('missing'), textSnapshot('remote')),
        {kind: 'sync_remote_to_local', reason: 'bootstrap_local_missing'},
    );
});

test('classifyLocalReplicaReconcile flags divergence when baseline is missing and both sides contain different data', () => {
    assert.deepEqual(
        classifyLocalReplicaReconcile(undefined, textSnapshot('local'), textSnapshot('remote')),
        {kind: 'conflict', reason: 'missing_baseline'},
    );
});

test('classifyLocalReplicaReconcile chooses the side that diverged from the stored baseline', () => {
    const baseline = textSnapshot('base');
    const state = {baseline};

    assert.deepEqual(
        classifyLocalReplicaReconcile(state, baseline, textSnapshot('remote')),
        {kind: 'sync_remote_to_local', reason: 'local_matches_baseline'},
    );
    assert.deepEqual(
        classifyLocalReplicaReconcile(state, textSnapshot('local'), baseline),
        {kind: 'sync_local_to_remote', reason: 'remote_matches_baseline'},
    );
    assert.deepEqual(
        classifyLocalReplicaReconcile(state, textSnapshot('local'), textSnapshot('remote')),
        {kind: 'conflict', reason: 'diverged_from_baseline'},
    );
});

test('classifyLocalReplicaRuntimeSync skips in-sync paths and applies source-ahead paths', () => {
    const baseline = textSnapshot('base');
    assert.deepEqual(
        classifyLocalReplicaRuntimeSync({baseline}, textSnapshot('same'), textSnapshot('same')),
        {kind: 'skip', reason: 'already_in_sync'},
    );
    assert.deepEqual(
        classifyLocalReplicaRuntimeSync({baseline}, textSnapshot('local'), baseline),
        {kind: 'apply', reason: 'source_ahead'},
    );
    assert.deepEqual(
        classifyLocalReplicaRuntimeSync({baseline}, baseline, textSnapshot('remote')),
        {kind: 'skip', reason: 'source_matches_baseline'},
    );
});

test('classifyLocalReplicaRuntimeSync preserves conflicted paths until they are resolved', () => {
    const baseline = textSnapshot('base');
    const state = recordLocalReplicaConflict({baseline}, 'diverged_from_baseline', 1234);
    assert.deepEqual(
        classifyLocalReplicaRuntimeSync(state, textSnapshot('local'), baseline),
        {kind: 'conflict', reason: 'path_conflicted'},
    );
});

test('classifyLocalReplicaRuntimeSync bootstraps when no baseline exists and one side is missing', () => {
    assert.deepEqual(
        classifyLocalReplicaRuntimeSync(
            undefined,
            createLocalReplicaSnapshot('missing'),
            textSnapshot('remote'),
        ),
        {kind: 'apply', reason: 'bootstrap'},
    );
});

test('mergeLocalReplicaText merges non-overlapping text edits and rejects missing baseline data', () => {
    const encoder = new TextEncoder();
    const merged = mergeLocalReplicaText(
        encoder.encode('hello world\n'),
        encoder.encode('hello brave world\n'),
        encoder.encode('hello world!\n'),
    );
    assert.equal(merged.kind, 'merged');
    assert.match(new TextDecoder().decode(merged.mergedContent), /brave/);
    assert.match(new TextDecoder().decode(merged.mergedContent), /!/);

    assert.deepEqual(
        mergeLocalReplicaText(undefined, encoder.encode('local'), encoder.encode('remote')),
        {kind: 'conflict', reason: 'missing_baseline'},
    );
});

test('mergeLocalReplicaText rejects non-text content instead of forcing a merge', () => {
    const binary = new Uint8Array([0, 159, 146, 150]);
    assert.deepEqual(
        mergeLocalReplicaText(binary, binary, binary),
        {kind: 'conflict', reason: 'non_text_content'},
    );
});

test('mergeLocalReplicaText reports overlapping text edits as conflicts', () => {
    const encoder = new TextEncoder();
    const result = mergeLocalReplicaText(
        encoder.encode('line one\nline two\n'),
        encoder.encode('line one\nlocal change\n'),
        encoder.encode('line one\nremote change\n'),
    );
    assert.equal(result.kind, 'conflict');
    assert.equal(result.reason, 'patch_apply_failed');
});

test('serializePersistedLocalReplicaSyncState keeps only baseline state and sorts keys', () => {
    const state = {
        paths: {
            '/b.tex': recordLocalReplicaConflict({baseline: textSnapshot('b')}, 'conflict'),
            '/a.tex': recordLocalReplicaBaseline(undefined, textSnapshot('a')),
        },
        version: 1,
    };
    const raw = serializePersistedLocalReplicaSyncState(state);
    const parsed = parsePersistedLocalReplicaSyncState(raw);

    assert.deepEqual(Object.keys(parsed.paths), ['/a.tex', '/b.tex']);
    assert.ok(localReplicaSnapshotsEqual(parsed.paths['/a.tex'].baseline, textSnapshot('a')));
    assert.ok(localReplicaSnapshotsEqual(parsed.paths['/b.tex'].baseline, textSnapshot('b')));
});

test('parsePersistedLocalReplicaSyncState tolerates malformed path payloads', () => {
    const parsed = parsePersistedLocalReplicaSyncState(JSON.stringify({
        paths: null,
        version: 99,
    }));
    assert.deepEqual(parsed, {
        paths: {},
        version: 1,
    });
});
