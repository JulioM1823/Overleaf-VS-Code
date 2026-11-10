const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildCompileFailureDiagnostics,
    getCompileFailureSummary,
} = require('../out/compile/compileFailure.js');

test('buildCompileFailureDiagnostics summarizes failed compile payloads with logs', () => {
    const fields = buildCompileFailureDiagnostics({
        buildId: 'build-123',
        clsiServerId: 'clsi-a',
        errors: [{message: 'Undefined control sequence'}],
        outputFiles: [
            {path: 'output.log', type: 'log', url: '/project/p/user/u/build/build-123/output/output.log'},
            {path: 'output.pdf', type: 'pdf', url: '/project/p/user/u/build/build-123/output/output.pdf'},
        ],
        status: 'failure',
        validationProblems: [{message: 'Root document warning'}],
    }, 'main.tex', 'success');

    assert.equal(fields.compileStatus, 'failure');
    assert.equal(fields.hasOutputLog, true);
    assert.equal(fields.outputFileCount, 2);
    assert.equal(fields.errorCount, 1);
    assert.equal(fields.validationProblemCount, 1);
    assert.equal(fields.buildId, 'build-123');
    assert.equal(fields.clsiServerId, 'clsi-a');
    assert.deepEqual(fields.outputFilePaths, ['output.log', 'output.pdf']);
    assert.deepEqual(fields.outputTypes, ['log', 'pdf']);
});

test('getCompileFailureSummary prefers response errors over fallback messages', () => {
    assert.equal(
        getCompileFailureSummary({
            errors: [{message: 'TeX stopped here'}],
            outputFiles: [],
            status: 'failure',
        }, 'generic failure'),
        'TeX stopped here',
    );
    assert.equal(getCompileFailureSummary(undefined, 'generic failure'), 'generic failure');
});
