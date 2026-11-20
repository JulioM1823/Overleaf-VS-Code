const assert = require('node:assert/strict');
const fs = require('node:fs');

const restartScenario = 'extension-host-restart-with-pending-draft';
function read(filename) { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
function write(filename, data) { fs.writeFileSync(filename, JSON.stringify(data, null, 2) + '\n', {mode: 0o600}); }
function tagged(data, identity, status) { return {...data, ...identity, status}; }

function beginPhase(filename, identity) {
    assert(['initial', 'restart'].includes(identity.hostedPhase));
    assert(identity.hostedRunId && identity.hostedPhaseId);
    let previous = {effects: []};
    if (identity.hostedPhase==='restart') {
        previous = read(filename);
        assert.equal(previous.status, 'passed', 'Restart requires the completed initial report');
        assert.equal(previous.hostedRunId, identity.hostedRunId, 'Restart must belong to the same audit run');
        assert.equal(previous.hostedPhase, 'initial', 'Restart requires the initial phase');
        assert(Array.isArray(previous.effects));
    }
    write(filename, tagged(previous, identity, 'running'));
    return previous.effects.filter(effect => effect.scenario===restartScenario).length;
}

function completePhase(filename, identity, previousRestartCount) {
    const result = read(filename);
    assert.notEqual(result.status, 'failed', 'A failed phase cannot be promoted');
    assert(Array.isArray(result.effects));
    if (identity.hostedPhase==='initial') {
        assert.equal(result.status, 'passed', 'Initial scenario suite must explicitly pass');
        assert(result.effects.some(effect => effect.scenario==='alternative-recovery-copy-with-concurrent-edit' && effect.passed));
    } else {
        const proofs = result.effects.filter(effect => effect.scenario===restartScenario);
        assert.equal(proofs.length, previousRestartCount + 1, 'Restart must append a fresh successful proof');
        assert.equal(proofs.at(-1).passed, true);
    }
    write(filename, tagged(result, identity, 'passed'));
}

function failPhase(filename, identity) {
    let previous = {};
    try { previous = read(filename); } catch {}
    write(filename, tagged(previous, identity, 'failed'));
}

function requirePassed(filename, identity) {
    const result = read(filename);
    assert.equal(result.status ?? result.stage, 'passed', 'Current phase must pass');
    for (const [key, value] of Object.entries(identity)) {
        assert.equal(result[key], value, 'Report must identify the current audit run and phase');
    }
    return result;
}

module.exports = {beginPhase, completePhase, failPhase, requirePassed};
