const test = require('node:test');
const assert = require('node:assert/strict');

const { LatexParser } = require('../out/compile/compileLogParser.js');

test('LatexParser does not skip warnings on the first log line', () => {
    const content = 'LaTeX Warning: Reference `sec:intro` on input line 7 undefined.\n';
    const result = new LatexParser(content).parse();

    assert.equal(result?.warnings.length, 1);
    assert.equal(result?.warnings[0].line, 7);
    assert.equal(result?.warnings[0].message.includes('sec:intro'), true);
});
