const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const {
    decodeArchiveTextEntry,
    loadProjectArchiveEntries,
} = require('../out/api/projectArchive.js');

test('loadProjectArchiveEntries strips the project root folder prefix when present', async () => {
    const archive = new JSZip();
    archive.file('Morales-Thesis-Proposal/main.tex', 'Hello world\n');
    archive.file('Morales-Thesis-Proposal/sections/intro.tex', '\\section{Intro}\n');

    const content = await archive.generateAsync({type: 'uint8array'});
    const entries = await loadProjectArchiveEntries(content, 'Morales-Thesis-Proposal');

    assert.equal(decodeArchiveTextEntry(entries.get('main.tex')), 'Hello world\n');
    assert.equal(
        decodeArchiveTextEntry(entries.get('sections/intro.tex')),
        '\\section{Intro}\n',
    );
});

test('loadProjectArchiveEntries preserves root-level files without stripping', async () => {
    const archive = new JSZip();
    archive.file('main.tex', 'Root file\n');
    archive.file('figures/plot.pdf', Buffer.from([1, 2, 3]));

    const content = await archive.generateAsync({type: 'uint8array'});
    const entries = await loadProjectArchiveEntries(content, 'Morales-Thesis-Proposal');

    assert.equal(decodeArchiveTextEntry(entries.get('main.tex')), 'Root file\n');
    assert.deepEqual(Array.from(entries.get('figures/plot.pdf') || []), [1, 2, 3]);
});

test('loadProjectArchiveEntries strips a shared top-level folder even when it does not match the project name', async () => {
    const archive = new JSZip();
    archive.file('source/main.tex', 'Hello from source\n');
    archive.file('source/chapters/intro.tex', '\\chapter{Intro}\n');

    const content = await archive.generateAsync({type: 'uint8array'});
    const entries = await loadProjectArchiveEntries(content, 'Morales-Thesis-Proposal');

    assert.equal(decodeArchiveTextEntry(entries.get('main.tex')), 'Hello from source\n');
    assert.equal(
        decodeArchiveTextEntry(entries.get('chapters/intro.tex')),
        '\\chapter{Intro}\n',
    );
});

test('decodeArchiveTextEntry returns undefined for missing content', () => {
    assert.equal(decodeArchiveTextEntry(undefined), undefined);
});
