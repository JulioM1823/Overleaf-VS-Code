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
function verifyPhase(filename, phase, phaseRunId, observe) {
    const report = readReport(filename);
    // Retain the credential-free current phase evidence even when validation
    // rejects it; the parent removes its private working directory afterwards.
    observe?.(report);
    assert.equal(report.status, 'passed', `Self-hosted ${phase} must pass`);
    assert.equal(report.phase, phase, 'Report must belong to the requested phase');
    assert.equal(report.phaseRunId, phaseRunId, 'Report must belong to this fresh launch');
    checkEvidence(report, phase);
    return report;
}
async function withDeadline(operation, milliseconds, message) {
    let timer;
    try {
        return await Promise.race([Promise.resolve().then(operation), new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                const error = new Error(message); error.code = 'ORBITLEAF_CE_DEADLINE'; reject(error);
            }, milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}
function confirmUnsupportedCeComments(capabilities, probe) {
    assert.equal(capabilities.imageDigest, 'sha256:8fe42ff1991cb0cd5a3750171d2c568f78cd8c75f60eba1279e5ddf6fd427271',
        'Unsupported comments require the exact inspected official CE image');
    for (const key of ['trackChangesFeature', 'trackChangesModulePresent', 'trackChangesModuleConfigured', 'commentRoutesPresent']) {
        assert.equal(capabilities[key], false, `Unsupported comments require confirmed ${key} absence`);
    }
    assert(Number.isInteger(capabilities.routerFilesInspected) && capabilities.routerFilesInspected > 0,
        'Actual version-matched server router sources must have been inspected');
    assert.match(probe.projectId, /^[0-9a-f]{24}$/);
    assert.equal(probe.method, 'GET');
    assert.equal(probe.path, `/project/${probe.projectId}/threads`, 'Probe must use the exact production comment route');
    assert.equal(probe.authenticated, true);
    assert.equal(probe.httpStatus, 404);
    assert.equal(probe.notFoundBody, true, 'Authenticated missing-route response must identify Not Found');
    return {status: 'unsupported', reason: 'Official CE image omits its track-changes module and comment routes; authenticated exact endpoint is Not Found.'};
}
function canonicalNotFoundBody(body, requestedPath) {
    const visible = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    return /\bnot[ -]found\b|\bcan(?:not|['’]t) find (?:the|that|this) page\b/i.test(visible)
        || visible.includes(`Cannot GET ${requestedPath}`);
}
async function compileAfterThrottle(operation, {maxAttempts = 8, wait = () => new Promise(resolve => setTimeout(resolve, 2000))} = {}) {
    const statuses = [];
    let response;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        response = await operation();
        const status = response.type === 'success' ? response.compile?.status : 'api-error';
        statuses.push(typeof status === 'string' && /^[a-z-]{1,40}$/.test(status) ? status : 'unknown');
        if (status !== 'too-recently-compiled' || attempt + 1 === maxAttempts) break;
        await wait();
    }
    return {response, statuses};
}
module.exports = {beginPhase, failPhase, completePhase, verifyPhase, withDeadline, confirmUnsupportedCeComments, canonicalNotFoundBody, compileAfterThrottle};
