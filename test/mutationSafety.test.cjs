const test = require('node:test');
const assert = require('node:assert/strict');

const {
    allPatchApplicationsSucceeded,
    classifyWritePlan,
    hasFolderChildren,
} = require('../out/core/mutationSafety.js');

test('classifyWritePlan allows creating new files and updating docs', () => {
    assert.deepEqual(classifyWritePlan(undefined, true), {kind: 'create-new'});
    assert.deepEqual(classifyWritePlan('doc', false), {kind: 'update-doc'});
});

test('classifyWritePlan rejects unsafe existing targets', () => {
    assert.deepEqual(classifyWritePlan(undefined, false), {kind: 'reject', reason: 'missing-target'});
    assert.deepEqual(classifyWritePlan('folder', false), {kind: 'reject', reason: 'directory-target'});
    assert.deepEqual(classifyWritePlan('file', true), {kind: 'reject', reason: 'existing-non-document-target'});
    assert.deepEqual(classifyWritePlan('outputs', false), {kind: 'reject', reason: 'existing-non-document-target'});
});

test('hasFolderChildren detects nested content across entity buckets', () => {
    assert.equal(hasFolderChildren({}), false);
    assert.equal(hasFolderChildren({docs: [{}]}), true);
    assert.equal(hasFolderChildren({fileRefs: [{}]}), true);
    assert.equal(hasFolderChildren({folders: [{}]}), true);
    assert.equal(hasFolderChildren({outputs: [{}]}), true);
});

test('allPatchApplicationsSucceeded requires every patch application to succeed', () => {
    assert.equal(allPatchApplicationsSucceeded([]), true);
    assert.equal(allPatchApplicationsSucceeded([true, true]), true);
    assert.equal(allPatchApplicationsSucceeded([true, false]), false);
});
