const test = require('node:test');
const assert = require('node:assert/strict');

const { getPdfFixtureEvents, loadPdfFixture } = require('./support/pdfFixtures.cjs');

test('pdf fixtures provide valid-looking minimal and corrupt buffers for reliability tests', () => {
    const minimal = loadPdfFixture('minimal.pdf');
    const corrupt = loadPdfFixture('corrupt.pdf');

    assert.match(minimal.toString('utf8', 0, 8), /^%PDF-1\./);
    assert.ok(minimal.includes(Buffer.from('startxref', 'utf8')));
    assert.match(corrupt.toString('utf8', 0, 8), /^%PDF-1\./);
    assert.ok(corrupt.length < minimal.length);

    const events = getPdfFixtureEvents();
    assert.ok(events.some((entry) => entry.event === 'fixture.loaded' && entry.name === 'minimal.pdf'));
    assert.ok(events.some((entry) => entry.event === 'fixture.loaded' && entry.name === 'corrupt.pdf'));
});
