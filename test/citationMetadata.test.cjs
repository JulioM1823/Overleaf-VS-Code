const test = require('node:test');
const assert = require('node:assert/strict');

const {parseBibEntries, parseBblEntries} = require('../out/intellisense/citationMetadata.js');
const {findCitationKeyAtOffset} = require('../out/intellisense/referenceNavigation.js');

test('parseBibEntries extracts core citation metadata from bibtex', () => {
    const entries = parseBibEntries(`
@article{knuth1984,
  title = {Literate {Programming}},
  author = {Knuth, Donald E.},
  year = {1984},
  journal = {The Computer Journal},
  doi = {10.1093/comjnl/27.2.97}
}
`);
    assert.deepEqual(entries, [
        {
            key: 'knuth1984',
            title: 'Literate Programming',
            author: 'Knuth, Donald E.',
            year: '1984',
            journal: 'The Computer Journal',
            booktitle: undefined,
            publisher: undefined,
            doi: '10.1093/comjnl/27.2.97',
            source: 'bib',
        },
    ]);
});

test('parseBibEntries handles multiline fields and skips string/comment entries', () => {
    const entries = parseBibEntries(`
@string{abbr = "ignored"}
@comment{ignore me}
@inproceedings{lamport1994,
  title = {LaTeX:
    A Document Preparation System},
  author = {Lamport, Leslie and Mittelbach, Frank},
  year = 1994,
  booktitle = {Tools and Techniques}
}
`);
    assert.deepEqual(entries, [
        {
            key: 'lamport1994',
            title: 'LaTeX: A Document Preparation System',
            author: 'Lamport, Leslie and Mittelbach, Frank',
            year: '1994',
            journal: undefined,
            booktitle: 'Tools and Techniques',
            publisher: undefined,
            doi: undefined,
            source: 'bib',
        },
    ]);
});

test('parseBblEntries extracts fallback bibliography summaries', () => {
    const entries = parseBblEntries(`
\\bibitem{knuth1984}
Donald E. Knuth.
\\newblock Literate programming.

\\bibitem[Lamport(1994)]{lamport1994}
Leslie Lamport.
\\newblock LaTeX: a document preparation system.
`);
    assert.deepEqual(entries, [
        {
            key: 'knuth1984',
            summary: 'Donald E. Knuth. Literate programming.',
            source: 'bbl',
        },
        {
            key: 'lamport1994',
            summary: 'Leslie Lamport. LaTeX: a document preparation system.',
            source: 'bbl',
        },
    ]);
});

test('findCitationKeyAtOffset resolves a hovered key in multi-citation commands', () => {
    const source = 'See \\citep{knuth1984, lamport1994}.';
    const start = source.indexOf('lamport1994');
    assert.deepEqual(findCitationKeyAtOffset(source, start + 2), {
        label: 'lamport1994',
        start,
        end: start + 'lamport1994'.length,
    });
});

test('findCitationKeyAtOffset supports starred citation commands with optional arguments', () => {
    const source = 'See \\textcite*[p. 4][and references therein]{knuth1984, lamport1994}.';
    const start = source.indexOf('knuth1984');
    assert.deepEqual(findCitationKeyAtOffset(source, start + 2), {
        label: 'knuth1984',
        start,
        end: start + 'knuth1984'.length,
    });
});
