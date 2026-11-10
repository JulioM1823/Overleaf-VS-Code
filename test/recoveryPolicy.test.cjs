const test = require('node:test');
const assert = require('node:assert/strict');

const {
    calculateRecoveryDelayMs,
    extractOutputBuildId,
    hasCompileOutputs,
    shouldClearAuxFilesBeforeCompile,
} = require('../out/core/recoveryPolicy.js');

test('calculateRecoveryDelayMs uses immediate retry first then bounded backoff', () => {
    assert.equal(calculateRecoveryDelayMs(0), 0);
    assert.equal(calculateRecoveryDelayMs(1), 0);
    assert.equal(calculateRecoveryDelayMs(2), 1000);
    assert.equal(calculateRecoveryDelayMs(3), 2000);
    assert.equal(calculateRecoveryDelayMs(4), 4000);
    assert.equal(calculateRecoveryDelayMs(5), 8000);
    assert.equal(calculateRecoveryDelayMs(10), 30000);
});

test('extractOutputBuildId returns first matched build id', () => {
    assert.equal(
        extractOutputBuildId([
            {url: '/project/demo/user/u/build/build-123/output/output.pdf'},
            {url: '/project/demo/user/u/build/build-456/output/output.log'},
        ]),
        'build-123',
    );
    assert.equal(extractOutputBuildId([{url: '/project/demo/output/output.pdf'}]), undefined);
});

test('hasCompileOutputs only accepts non-empty arrays', () => {
    assert.equal(hasCompileOutputs(undefined), false);
    assert.equal(hasCompileOutputs(null), false);
    assert.equal(hasCompileOutputs([]), false);
    assert.equal(hasCompileOutputs([{}]), true);
});

test('shouldClearAuxFilesBeforeCompile only clears when no cached build outputs exist', () => {
    assert.equal(shouldClearAuxFilesBeforeCompile({}), true);
    assert.equal(shouldClearAuxFilesBeforeCompile({outputs: []}), true);
    assert.equal(shouldClearAuxFilesBeforeCompile({outputs: [{path: 'output.log'}]}), false);
    assert.equal(shouldClearAuxFilesBeforeCompile({outputBuildId: 'build-123'}), false);
});
