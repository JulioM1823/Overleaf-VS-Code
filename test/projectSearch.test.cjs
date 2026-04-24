const test = require('node:test');
const assert = require('node:assert/strict');

const {
    decodeSearchableTextContent,
    findProjectSearchMatches,
    isSearchableProjectPath,
    normalizeProjectSearchQuery,
} = require('../out/intellisense/projectSearch.js');

test('normalizeProjectSearchQuery treats plain text as a case-insensitive literal search', () => {
    const query = normalizeProjectSearchQuery('  Figure 1  ');
    assert.equal(query.mode, 'literal');
    assert.equal(query.display, 'Figure 1');
    assert.equal(query.regex.flags.includes('i'), true);
    assert.equal(query.regex.test('figure 1'), true);
});

test('normalizeProjectSearchQuery preserves regex mode and injects the global flag', () => {
    const query = normalizeProjectSearchQuery('/fig:\\d+/i');
    assert.equal(query.mode, 'regex');
    assert.equal(query.flags.includes('g'), true);
    assert.equal(query.regex.test('FIG:42'), true);
});

test('isSearchableProjectPath excludes compile outputs and obvious binary assets', () => {
    assert.equal(isSearchableProjectPath('/.output/output.log', '.output'), false);
    assert.equal(isSearchableProjectPath('/Figures/plot.png', '.output'), false);
    assert.equal(isSearchableProjectPath('/sections/introduction.tex', '.output'), true);
});

test('decodeSearchableTextContent rejects binary payloads and keeps utf8 text', () => {
    assert.equal(decodeSearchableTextContent(Uint8Array.from([0, 1, 2])), undefined);
    assert.equal(decodeSearchableTextContent(new TextEncoder().encode('alpha beta')), 'alpha beta');
});

test('findProjectSearchMatches returns line-aware matches with trimmed previews', () => {
    const content = [
        'First line',
        'Second alpha beta line',
        'Third alpha line',
    ].join('\n');
    const matches = findProjectSearchMatches(content, /alpha/gi, 10);
    assert.deepEqual(matches.map(match => ({
        endColumn: match.endColumn,
        line: match.line,
        preview: match.preview,
        startColumn: match.startColumn,
    })), [
        {
            endColumn: 12,
            line: 1,
            preview: 'Second alpha beta line',
            startColumn: 7,
        },
        {
            endColumn: 11,
            line: 2,
            preview: 'Third alpha line',
            startColumn: 6,
        },
    ]);
});

test('findProjectSearchMatches guards against zero-length regex loops', () => {
    const matches = findProjectSearchMatches('a\nb', /^/gm, 5);
    assert.equal(matches.length, 0);
});
