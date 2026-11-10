const test = require('node:test');
const assert = require('node:assert/strict');

const { reconstructDocumentFromDiff } = require('../out/api/docDiff.js');

test('reconstructDocumentFromDiff reconstructs the target revision without resurrecting deleted text', () => {
    assert.equal(
        reconstructDocumentFromDiff([
            { u: 'Hello ' },
            { i: 'world' },
            { d: '!' },
        ]),
        'Hello world',
    );
});

test('reconstructDocumentFromDiff returns undefined for missing diff arrays', () => {
    assert.equal(reconstructDocumentFromDiff(undefined), undefined);
});
