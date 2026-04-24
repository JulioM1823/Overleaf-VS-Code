const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveCompileRenderStatus,
} = require('../out/compile/compileStatus.js');

test('resolveCompileRenderStatus hides the indicator without an active project', () => {
    assert.equal(resolveCompileRenderStatus({
        connectionPhase: 'live',
        hasProject: false,
        inCompiling: false,
        lastTerminalStatus: 'success',
    }), 'hidden');
});

test('resolveCompileRenderStatus prioritizes active compilation over connection phase', () => {
    assert.equal(resolveCompileRenderStatus({
        connectionPhase: 'recovering',
        hasProject: true,
        inCompiling: true,
        lastTerminalStatus: 'failed',
    }), 'compiling');
});

test('resolveCompileRenderStatus distinguishes recovering and fallback states from terminal compile results', () => {
    assert.equal(resolveCompileRenderStatus({
        connectionPhase: 'recovering',
        hasProject: true,
        inCompiling: false,
        lastTerminalStatus: 'success',
    }), 'recovering');
    assert.equal(resolveCompileRenderStatus({
        connectionPhase: 'fallback',
        hasProject: true,
        inCompiling: false,
        lastTerminalStatus: 'success',
    }), 'fallback');
    assert.equal(resolveCompileRenderStatus({
        connectionPhase: 'live',
        hasProject: true,
        inCompiling: false,
        lastTerminalStatus: 'failed',
    }), 'failed');
    assert.equal(resolveCompileRenderStatus({
        connectionPhase: 'invisible',
        hasProject: true,
        inCompiling: false,
        lastTerminalStatus: 'alert',
    }), 'alert');
});
