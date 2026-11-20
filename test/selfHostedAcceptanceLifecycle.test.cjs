const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const {beginPhase, failPhase, completePhase, verifyPhase} = require('../scripts/self-hosted-phase-report.cjs');

function reportFile(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitleaf-ce-phase-test-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    return path.join(directory, 'report.json');
}

test('self-hosted driver cannot reuse a passed report after a new phase throws before reporting', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitleaf-ce-phase-test-'));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
    const filename = path.join(directory, 'report.json');
    fs.writeFileSync(filename, JSON.stringify({status: 'passed', phase: 'initial', phaseRunId: 'old', effects: [{scenario: 'previous'}]}));
    const module = {exports: {}};
    let quit = false;
    const source = fs.readFileSync(path.join(__dirname, 'integration/self-hosted-driver/index.cjs'), 'utf8');
    const localRequire = name => {
        if (name === 'vscode') return {commands: {executeCommand: async () => {quit = true;}}};
        if (name === '../selfHostedAcceptance.cjs') return {run: async () => {throw new Error('Synthetic early restart failure');}};
        if (name.startsWith('../../../scripts/')) return require(path.join(__dirname, '..', name.replace('../../../', '')));
        return require(name);
    };
    vm.runInNewContext(source, {module, exports: module.exports, require: localRequire,
        process: {env: {OVERLEAF_LIVE_REPORT: filename, OVERLEAF_CE_PHASE: 'restart', OVERLEAF_CE_PHASE_RUN_ID: 'new'}},
        console: {error() {}}});
    await module.exports.activate();
    const result = JSON.parse(fs.readFileSync(filename, 'utf8'));
    assert.equal(result.status, 'failed');
    assert.equal(result.phase, 'restart');
    assert.equal(result.phaseRunId, 'new');
    assert(quit, 'The failed companion still closes its isolated editor');
});

test('beginning a fresh restart invalidates a prior pass while retaining evidence needed by the restart assertions', t => {
    const file = reportFile(t);
    fs.writeFileSync(file, JSON.stringify({status: 'passed', phase: 'initial', phaseRunId: 'old', effects: [{scenario: 'initial', passed: true}]}));
    const started = beginPhase(file, 'restart', 'fresh');
    assert.equal(started.status, 'running');
    assert.equal(started.phaseRunId, 'fresh');
    assert.equal(started.effects[0].scenario, 'initial');
    assert.throws(() => verifyPhase(file, 'restart', 'fresh'), /must pass/);
});

test('a reported pass must match this phase and launch and contain the actual restart checkpoint', t => {
    const file = reportFile(t);
    const passed = {status: 'passed', phase: 'restart', phaseRunId: 'fresh', restartCheckpointsAtStart: 0, effects: [{scenario: 'initial', passed: true}]};
    fs.writeFileSync(file, JSON.stringify(passed));
    assert.throws(() => verifyPhase(file, 'restart', 'fresh'), /required completed/);
    assert.throws(() => completePhase(file, 'restart', 'fresh'), /required completed/);
    passed.effects.push({scenario: 'extension-host-restart-with-pending-draft', passed: true});
    fs.writeFileSync(file, JSON.stringify(passed));
    assert.throws(() => verifyPhase(file, 'initial', 'fresh'), /requested phase/);
    assert.throws(() => verifyPhase(file, 'restart', 'different'), /fresh launch/);
    assert.equal(verifyPhase(file, 'restart', 'fresh').status, 'passed');
});

test('an older completed restart marker cannot certify a new restart', t => {
    const file = reportFile(t);
    fs.writeFileSync(file, JSON.stringify({status: 'passed', effects: [{scenario: 'extension-host-restart-with-pending-draft', passed: true}]}));
    beginPhase(file, 'restart', 'fresh');
    assert.throws(() => completePhase(file, 'restart', 'fresh'), /fresh checkpoint/);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.effects.push({scenario: 'extension-host-restart-with-pending-draft', passed: true});
    fs.writeFileSync(file, JSON.stringify(data));
    completePhase(file, 'restart', 'fresh');
    assert.equal(verifyPhase(file, 'restart', 'fresh').status, 'passed');
});

test('the outer failure preserves a current detailed failure but never a previous launch result', t => {
    const file = reportFile(t);
    beginPhase(file, 'restart', 'fresh');
    failPhase(file, 'restart', 'fresh', 'Specific current assertion failed');
    assert.equal(failPhase(file, 'restart', 'fresh', 'Outer driver failed').reason, 'Specific current assertion failed');
    assert.equal(failPhase(file, 'restart', 'different', 'New launch failed').reason, 'New launch failed');
});

test('failed phase diagnostics are published before verification rejects and private files can be removed', t => {
    const file = reportFile(t);
    beginPhase(file, 'initial', 'fresh');
    failPhase(file, 'initial', 'fresh', 'Synthetic password login failed');
    let retained;
    assert.throws(() => verifyPhase(file, 'initial', 'fresh', report => {retained = report;}), /must pass/);
    fs.rmSync(file);
    assert.equal(retained.status, 'failed');
    assert.equal(retained.phaseRunId, 'fresh');
    assert.equal(retained.reason, 'Synthetic password login failed');
});
