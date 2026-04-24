const test = require('node:test');
const assert = require('node:assert/strict');

const {
    shouldMaterializeLocalReplicaFromArchive,
} = require('../out/scm/localReplicaMaterialization.js');

test('shouldMaterializeLocalReplicaFromArchive seeds a fresh replica that only has metadata files', () => {
    const shouldSeed = shouldMaterializeLocalReplicaFromArchive({
        archivePaths: ['main.tex', 'refs/library.bib', 'figures/plot.png'],
        existingPaths: ['.overleaf/settings.json', '.overleaf/local-replica-state.json'],
    });

    assert.equal(shouldSeed, true);
});

test('shouldMaterializeLocalReplicaFromArchive skips seeding once project files are already present', () => {
    const shouldSeed = shouldMaterializeLocalReplicaFromArchive({
        archivePaths: ['main.tex', 'refs/library.bib'],
        existingPaths: ['main.tex', '.overleaf/settings.json'],
    });

    assert.equal(shouldSeed, false);
});

test('shouldMaterializeLocalReplicaFromArchive reseeds when only unrelated json files are present', () => {
    const shouldSeed = shouldMaterializeLocalReplicaFromArchive({
        archivePaths: ['main.tex', 'sections/intro.tex'],
        existingPaths: ['offline-project-state.json', 'document-sync-state.json'],
    });

    assert.equal(shouldSeed, true);
});
