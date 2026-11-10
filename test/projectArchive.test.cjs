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

test('archive root stripping emits one canonical file rather than duplicate trees', async () => {
    const zip = new JSZip(); zip.file('Project/main.tex', 'source');
    const entries = await loadProjectArchiveEntries(await zip.generateAsync({type: 'uint8array'}), 'Project');
    assert.deepEqual([...entries.keys()], ['main.tex']);
});

test('archive traversal, drive paths and protected workspace metadata are rejected', async () => {
    for (const name of ['../outside.tex', 'C:/secret.tex', 'Project/.overleaf/offline-operations.json', '.vscode/tasks.json']) {
        const zip = new JSZip(); zip.file(name, 'malicious');
        await assert.rejects(loadProjectArchiveEntries(await zip.generateAsync({type: 'uint8array'})));
    }
});

test('archive decompression is bounded by file, total size and entry count', async () => {
    const zip = new JSZip(); zip.file('a.tex', 'a'.repeat(10000)); zip.file('b.tex', 'b'.repeat(10000));
    const bytes = await zip.generateAsync({type: 'uint8array', compression: 'DEFLATE'});
    for (const limits of [{maxFileBytes: 10, maxTotalBytes: 10000, maxEntries: 5}, {maxFileBytes: 20000, maxTotalBytes: 15000, maxEntries: 5}, {maxFileBytes: 20000, maxTotalBytes: 50000, maxEntries: 1}]) {
        await assert.rejects(loadProjectArchiveEntries(bytes, undefined, limits), /limit|too many/);
    }
});
