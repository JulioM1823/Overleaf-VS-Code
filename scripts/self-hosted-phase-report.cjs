const assert = require('node:assert/strict');
const fs = require('node:fs');

function readReport(filename) {
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch { return {}; }
}
function writeReport(filename, report) {
    fs.writeFileSync(filename, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    return report;
}
function checkEvidence(report, phase) {
    const required = phase === 'restart' ? ['extension-host-restart-with-pending-draft']
        : ['two-live-clients', 'alternative-recovery-copy-with-concurrent-edit', 'authenticated-server-tex-compile-and-pdf-download'];
    assert(Array.isArray(report.effects) && required.every(scenario => report.effects.some(effect => effect.scenario === scenario && effect.passed === true)),
        `Self-hosted ${phase} must record its required completed scenarios`);
    if (phase === 'restart') {
        const checkpoints = report.effects.filter(effect => effect.scenario === 'extension-host-restart-with-pending-draft' && effect.passed === true).length;
        assert(Number.isInteger(report.restartCheckpointsAtStart) && checkpoints > report.restartCheckpointsAtStart,
            'Self-hosted restart must record a fresh checkpoint after this launch began');
    }
}
function beginPhase(filename, phase, phaseRunId) {
    assert(['initial', 'restart'].includes(phase) && phaseRunId, 'Known phase and unique run ID are required');
    const previous = readReport(filename);
    const restartCheckpointsAtStart = (previous.effects || []).filter(effect => effect.scenario === 'extension-host-restart-with-pending-draft' && effect.passed === true).length;
    return writeReport(filename, {...previous, status: 'running', phase, phaseRunId, restartCheckpointsAtStart});
}
function failPhase(filename, phase, phaseRunId, reason) {
    const previous = readReport(filename);
    const currentReason = previous.status === 'failed' && previous.phase === phase && previous.phaseRunId === phaseRunId
        && typeof previous.reason === 'string' ? previous.reason : reason;
    return writeReport(filename, {...previous, status: 'failed', phase: phase || 'unknown', phaseRunId: phaseRunId || 'missing', reason: currentReason});
}
function completePhase(filename, phase, phaseRunId, details = {}) {
    const report = {...readReport(filename), ...details};
    checkEvidence(report, phase);
    return writeReport(filename, {...report, status: 'passed', phase, phaseRunId});
}
function verifyPhase(filename, phase, phaseRunId) {
    const report = readReport(filename);
    assert.equal(report.status, 'passed', `Self-hosted ${phase} must pass`);
    assert.equal(report.phase, phase, 'Report must belong to the requested phase');
    assert.equal(report.phaseRunId, phaseRunId, 'Report must belong to this fresh launch');
    checkEvidence(report, phase);
    return report;
}
module.exports = {beginPhase, failPhase, completePhase, verifyPhase};
