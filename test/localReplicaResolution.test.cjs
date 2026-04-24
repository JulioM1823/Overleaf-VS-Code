const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    buildDeterministicLocalSearchRoots,
    inspectLocalReplicaCandidate,
    searchForExactDirectoryName,
} = require('../out/scm/localReplicaResolution.js');

test('buildDeterministicLocalSearchRoots prioritizes known replica parents and deduplicates roots', () => {
    const roots = buildDeterministicLocalSearchRoots({
        cachedRoots: ['/Users/example/Documents', '/Users/example/Documents'],
        existingReplicaPaths: ['/Users/example/Projects/Thesis', '/Users/example/Projects/Paper'],
        homeDirectory: '/Users/example',
        workspaceFolderPaths: ['/Users/example/Workspace'],
    });

    assert.deepEqual(roots, [
        '/Users/example/Projects',
        '/Users/example/Workspace',
        '/Users/example/Documents',
        '/Users/example/Desktop',
        '/Users/example/Downloads',
    ]);
});

test('searchForExactDirectoryName finds exact directory name matches without brute forcing ignored folders', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-local-search-'));
    try {
        await fs.mkdir(path.join(rootDirectory, 'Documents', 'Projects', 'Target Project'), {recursive: true});
        await fs.mkdir(path.join(rootDirectory, 'Documents', '.git', 'Target Project'), {recursive: true});
        await fs.mkdir(path.join(rootDirectory, 'Downloads', 'Nested', 'Target Project'), {recursive: true});

        const matches = await searchForExactDirectoryName({
            maxDepth: 4,
            roots: [
                path.join(rootDirectory, 'Documents'),
                path.join(rootDirectory, 'Downloads'),
            ],
            targetFolderName: 'Target Project',
        });

        assert.deepEqual(matches, [
            path.join(rootDirectory, 'Documents', 'Projects', 'Target Project'),
            path.join(rootDirectory, 'Downloads', 'Nested', 'Target Project'),
        ]);
    } finally {
        await fs.rm(rootDirectory, {recursive: true, force: true});
    }
});

test('inspectLocalReplicaCandidate classifies linked, mismatched, and missing metadata', async () => {
    const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-local-inspect-'));
    const linkedDirectory = path.join(rootDirectory, 'Linked Project');
    const mismatchedDirectory = path.join(rootDirectory, 'Mismatched Project');
    const missingDirectory = path.join(rootDirectory, 'Missing Project');
    const expectedUri = 'overleaf-workshop://www.overleaf.com/Linked%20Project?user=user-1&project=project-1';

    try {
        await fs.mkdir(path.join(linkedDirectory, '.overleaf'), {recursive: true});
        await fs.writeFile(path.join(linkedDirectory, '.overleaf', 'settings.json'), JSON.stringify({
            uri: expectedUri,
        }, null, 2));

        await fs.mkdir(path.join(mismatchedDirectory, '.overleaf'), {recursive: true});
        await fs.writeFile(path.join(mismatchedDirectory, '.overleaf', 'settings.json'), JSON.stringify({
            uri: 'overleaf-workshop://www.overleaf.com/Other?user=user-1&project=project-2',
        }, null, 2));

        await fs.mkdir(missingDirectory, {recursive: true});

        const linked = await inspectLocalReplicaCandidate(linkedDirectory, expectedUri);
        const mismatched = await inspectLocalReplicaCandidate(mismatchedDirectory, expectedUri);
        const missing = await inspectLocalReplicaCandidate(missingDirectory, expectedUri);

        assert.equal(linked.metadataState, 'linked');
        assert.equal(linked.exists, true);
        assert.equal(mismatched.metadataState, 'mismatched');
        assert.equal(mismatched.exists, true);
        assert.equal(missing.metadataState, 'missing');
        assert.equal(missing.exists, true);
    } finally {
        await fs.rm(rootDirectory, {recursive: true, force: true});
    }
});

