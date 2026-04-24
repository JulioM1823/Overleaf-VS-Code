const test = require('node:test');
const assert = require('node:assert/strict');

const {
    collectHistoryContributorOptions,
    filterHistoryVersionsByContributor,
    formatHistoryContributorLabel,
    normalizeHistoryContributorKey,
} = require('../out/scm/historyFilters.js');

test('normalizeHistoryContributorKey prefers id, then email, then name', () => {
    assert.equal(normalizeHistoryContributorKey({id: 'u-1', email: 'user@example.com'}), 'id:u-1');
    assert.equal(normalizeHistoryContributorKey({email: 'User@Example.com'}), 'email:user@example.com');
    assert.equal(normalizeHistoryContributorKey({first_name: 'Julio', last_name: 'Morales'}), 'name:julio morales');
    assert.equal(normalizeHistoryContributorKey({}), undefined);
});

test('formatHistoryContributorLabel prefers full name and falls back safely', () => {
    assert.equal(formatHistoryContributorLabel({first_name: 'Julio', last_name: 'Morales'}), 'Julio Morales');
    assert.equal(formatHistoryContributorLabel({email: 'user@example.com'}), 'user@example.com');
    assert.equal(formatHistoryContributorLabel({id: 'u-1'}), 'u-1');
    assert.equal(formatHistoryContributorLabel({}), 'Unknown contributor');
});

test('collectHistoryContributorOptions deduplicates per revision and sorts by coverage', () => {
    const contributors = collectHistoryContributorOptions({
        2: {
            users: [
                {id: 'u-1', first_name: 'Julio', email: 'user@example.com'},
                {id: 'u-1', first_name: 'Julio', email: 'user@example.com'},
                {id: 'u-2', first_name: 'Ada', email: 'ada@example.com'},
            ],
        },
        3: {
            users: [
                {id: 'u-1', first_name: 'Julio', email: 'user@example.com'},
            ],
        },
    });

    assert.deepEqual(contributors, [
        {
            key: 'id:u-1',
            label: 'Julio',
            description: 'user@example.com',
            versionCount: 2,
        },
        {
            key: 'id:u-2',
            label: 'Ada',
            description: 'ada@example.com',
            versionCount: 1,
        },
    ]);
});

test('filterHistoryVersionsByContributor keeps only matching versions', () => {
    const versions = filterHistoryVersionsByContributor(
        [5, 4, 3],
        {
            5: {users: [{id: 'u-1'}]},
            4: {users: [{email: 'beta@example.com'}]},
            3: {users: [{first_name: 'Gamma', last_name: 'User'}]},
        },
        'email:beta@example.com',
    );
    assert.deepEqual(versions, [4]);
});

test('filterHistoryVersionsByContributor returns a copy when no contributor filter is set', () => {
    const versions = [3, 2, 1];
    const filtered = filterHistoryVersionsByContributor(versions, {}, undefined);
    assert.deepEqual(filtered, versions);
    assert.notEqual(filtered, versions);
});
