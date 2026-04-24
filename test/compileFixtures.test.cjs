const test = require('node:test');
const assert = require('node:assert/strict');

const { LatexParser } = require('../out/compile/compileLogParser.js');
const { getCompileFixtureEvents, loadCompileLogFixture } = require('./support/compileLogFixtures.cjs');

test('compile log fixtures parse into structured latex diagnostics', async () => {
    const errorFixture = await loadCompileLogFixture('basic-error.log');
    const warningFixture = await loadCompileLogFixture('package-warning.log');

    const errorResult = new LatexParser(errorFixture).parse();
    const warningResult = new LatexParser(warningFixture).parse();

    assert.equal(errorResult.errors.length, 1);
    assert.equal(errorResult.errors[0].line, 12);
    assert.equal(errorResult.errors[0].file, './main.tex');

    assert.equal(warningResult.warnings.length, 1);
    assert.equal(warningResult.warnings[0].line, 22);
    assert.equal(warningResult.warnings[0].file, './main.tex');

    const events = getCompileFixtureEvents();
    assert.ok(events.some((entry) => entry.event === 'fixture.loaded' && entry.name === 'basic-error.log'));
    assert.ok(events.some((entry) => entry.event === 'fixture.loaded' && entry.name === 'package-warning.log'));
});
