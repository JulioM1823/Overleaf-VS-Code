const test = require('node:test');
const assert = require('node:assert/strict');

const {findReferenceLabelAtOffset} = require('../out/intellisense/referenceNavigation.js');
const {genTexLabelDefinitions} = require('../out/intellisense/texDocumentParseUtility.js');

test('findReferenceLabelAtOffset resolves a simple ref label', () => {
    const source = 'See \\ref{sec:intro}.';
    const start = source.indexOf('sec:intro');
    assert.deepEqual(findReferenceLabelAtOffset(source, start + 2), {
        label: 'sec:intro',
        start,
        end: start + 'sec:intro'.length,
    });
});

test('findReferenceLabelAtOffset resolves the correct label in comma-separated refs', () => {
    const source = 'See \\cref{fig:a, fig:b}.';
    const start = source.indexOf('fig:b');
    assert.deepEqual(findReferenceLabelAtOffset(source, start + 1), {
        label: 'fig:b',
        start,
        end: start + 'fig:b'.length,
    });
});

test('findReferenceLabelAtOffset ignores hyperref display text', () => {
    const source = 'See \\hyperref[sec:intro]{the introduction}.';
    const offset = source.indexOf('introduction');
    assert.equal(findReferenceLabelAtOffset(source, offset), undefined);
});

test('findReferenceLabelAtOffset supports starred refs with optional arguments', () => {
    const source = 'See \\Cref*[chap.][eq.]{eq:first, eq:second}.';
    const start = source.indexOf('eq:second');
    assert.deepEqual(findReferenceLabelAtOffset(source, start + 3), {
        label: 'eq:second',
        start,
        end: start + 'eq:second'.length,
    });
});

test('genTexLabelDefinitions records label ranges and ignores comments', () => {
    assert.deepEqual(
        genTexLabelDefinitions([
            '% \\label{ignored}',
            '\\label{sec:intro}',
            'Text',
            '\\section{Plots}',
            '\\label{fig:plot}',
        ].join('\n')),
        [
            {
                label: 'sec:intro',
                line: 1,
                column: 7,
                endLine: 1,
                endColumn: 16,
            },
            {
                label: 'fig:plot',
                line: 4,
                column: 7,
                endLine: 4,
                endColumn: 15,
            },
        ],
    );
});
