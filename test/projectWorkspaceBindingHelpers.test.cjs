const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeProjectRelativePath,
    resolveOverleafProjectPathSegment,
    toNormalizedLocalReplicaRelativePath,
    toNormalizedOverleafRelativePath,
    toOverleafProjectIdentityKey,
} = require('../out/core/projectWorkspaceBindingHelpers.js');

test('normalizeProjectRelativePath preserves root and prefixes relative paths', () => {
    assert.equal(normalizeProjectRelativePath(''), '/');
    assert.equal(normalizeProjectRelativePath('/'), '/');
    assert.equal(normalizeProjectRelativePath('main.tex'), '/main.tex');
    assert.equal(normalizeProjectRelativePath('/sections/intro.tex'), '/sections/intro.tex');
});

test('resolveOverleafProjectPathSegment extracts the project root segment', () => {
    assert.equal(resolveOverleafProjectPathSegment('/My%20Project/sections/intro.tex'), 'My%20Project');
    assert.equal(resolveOverleafProjectPathSegment('/My%20Project'), 'My%20Project');
    assert.equal(resolveOverleafProjectPathSegment('/'), '');
});

test('relative path helpers normalize local replica and overleaf document paths', () => {
    assert.equal(
        toNormalizedLocalReplicaRelativePath('/Users/example/Replica', '/Users/example/Replica/sections/intro.tex'),
        '/sections/intro.tex',
    );
    assert.equal(
        toNormalizedLocalReplicaRelativePath('/Users/example/Replica', '/Users/example/Replica'),
        '/',
    );
    assert.equal(
        toNormalizedOverleafRelativePath('/My%20Project/sections/intro.tex'),
        '/sections/intro.tex',
    );
    assert.equal(
        toNormalizedOverleafRelativePath('/My%20Project'),
        '/',
    );
});

test('toOverleafProjectIdentityKey matches project roots and nested document URIs', () => {
    const projectRoot = {
        authority: 'www.overleaf.com',
        path: '/My%20Project',
        query: 'user=user-1&project=project-1',
        scheme: 'overleaf-workshop',
    };
    const nestedDocument = {
        authority: 'www.overleaf.com',
        path: '/My%20Project/sections/intro.tex',
        query: 'project=project-1&user=user-1',
        scheme: 'overleaf-workshop',
    };
    const differentProject = {
        authority: 'www.overleaf.com',
        path: '/My%20Project',
        query: 'user=user-1&project=project-2',
        scheme: 'overleaf-workshop',
    };

    assert.equal(
        toOverleafProjectIdentityKey(projectRoot),
        toOverleafProjectIdentityKey(nestedDocument),
    );
    assert.notEqual(
        toOverleafProjectIdentityKey(projectRoot),
        toOverleafProjectIdentityKey(differentProject),
    );
});
