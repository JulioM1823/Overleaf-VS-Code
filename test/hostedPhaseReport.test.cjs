const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {beginPhase, completePhase, failPhase, requirePassed} = require('./integration/hosted-driver/phase-report.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-phase-report-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const report = path.join(root, 'report.json');
    const initial = {hostedRunId: 'run-a', hostedPhase: 'initial', hostedPhaseId: 'initial-a'};
    const restart = {...initial, hostedPhase: 'restart', hostedPhaseId: 'restart-a'};
    const save = data => fs.writeFileSync(report, JSON.stringify(data));
    const read = () => JSON.parse(fs.readFileSync(report));
    const seed = () => {
        beginPhase(report, initial);
        save({status: 'passed', effects: [{scenario: 'alternative-recovery-copy-with-concurrent-edit', passed: true}]});
        completePhase(report, initial, 0);
    };
    return {report, initial, restart, save, read, seed};
}

test('hosted initial phase requires an explicit completed scenario suite', t => {
    const f = fixture(t);beginPhase(f.report, f.initial);
    assert.throws(() => completePhase(f.report, f.initial, 0), /explicitly pass/);
    f.seed();assert.equal(requirePassed(f.report, f.initial).status, 'passed');
});

test('hosted restart invalidates prior success while preserving initial effects', t => {
    const f = fixture(t);f.seed();const effects=f.read().effects;
    beginPhase(f.report, f.restart);
    assert.equal(f.read().status, 'running');assert.deepEqual(f.read().effects, effects);
    assert.throws(() => requirePassed(f.report, f.restart), /must pass/);
});

test('hosted early restart failure overwrites an earlier passed report', t => {
    const f = fixture(t);f.seed();failPhase(f.report, f.restart);
    assert.equal(f.read().status, 'failed');
    assert.throws(() => requirePassed(f.report, f.restart), /must pass/);
});

test('hosted restart cannot certify an unchanged old restart checkpoint', t => {
    const f = fixture(t);f.seed();const prior=f.read();
    prior.effects.push({scenario:'extension-host-restart-with-pending-draft',passed:true});f.save(prior);
    const baseline=beginPhase(f.report,f.restart);
    assert.equal(baseline,1);
    assert.throws(() => completePhase(f.report,f.restart,baseline),/fresh successful proof/);
});

test('hosted restart accepts only a freshly appended successful checkpoint', t => {
    const f = fixture(t);f.seed();const baseline=beginPhase(f.report,f.restart);
    const report=f.read();report.effects.push({scenario:'extension-host-restart-with-pending-draft',passed:true});f.save(report);
    completePhase(f.report,f.restart,baseline);
    assert.equal(requirePassed(f.report,f.restart).effects.length,2);
});

test('hosted passed reports from another run or phase cannot satisfy this launch', t => {
    const f = fixture(t);f.seed();
    assert.throws(() => requirePassed(f.report,{...f.initial,hostedRunId:'run-b'}),/current audit run and phase/);
    assert.throws(() => requirePassed(f.report,f.restart),/current audit run and phase/);
});

test('hosted failure still replaces a malformed previous report', t => {
    const f = fixture(t);fs.writeFileSync(f.report,'{truncated');
    failPhase(f.report,f.restart);assert.equal(f.read().status,'failed');
    assert.throws(() => requirePassed(f.report,f.restart),/must pass/);
});
