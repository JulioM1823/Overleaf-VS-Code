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

test('native login deadlines reject a hung operation with a fixed diagnostic and preserve successful values', async () => {
    const {withDeadline} = require('../scripts/self-hosted-phase-report.cjs');
    await assert.rejects(withDeadline(() => new Promise(() => {}), 10, 'Synthetic login deadline'),
        error => error.code === 'ORBITLEAF_CE_DEADLINE' && error.message === 'Synthetic login deadline');
    assert.equal(await withDeadline(async () => 'complete', 1000, 'Unused deadline'), 'complete');
});

const commentCapabilities = {imageDigest: 'sha256:8fe42ff1991cb0cd5a3750171d2c568f78cd8c75f60eba1279e5ddf6fd427271',
    trackChangesFeature: false, trackChangesModulePresent: false, trackChangesModuleConfigured: false,
    commentRoutesPresent: false, routerFilesInspected: 16};
const commentProbe = {projectId: '0123456789abcdef01234567', method: 'GET', path: '/project/0123456789abcdef01234567/threads',
    authenticated: true, httpStatus: 404, notFoundBody: true};
test('CE unsupported comments require both an authenticated exact route failure and actual exact-image source absence', () => {
    const {confirmUnsupportedCeComments} = require('../scripts/self-hosted-phase-report.cjs');
    const result = confirmUnsupportedCeComments(commentCapabilities, commentProbe);
    assert.equal(result.status, 'unsupported'); assert.equal(result.passed, undefined);
    for (const key of ['trackChangesFeature', 'trackChangesModulePresent', 'trackChangesModuleConfigured', 'commentRoutesPresent']) {
        assert.throws(() => confirmUnsupportedCeComments({...commentCapabilities, [key]: true}, commentProbe));
    }
    assert.throws(() => confirmUnsupportedCeComments({...commentCapabilities, imageDigest: 'sha256:different'}, commentProbe));
    assert.throws(() => confirmUnsupportedCeComments({...commentCapabilities, routerFilesInspected: 0}, commentProbe));
    assert.throws(() => confirmUnsupportedCeComments(commentCapabilities, {...commentProbe, path: commentProbe.path + '/wrong'}));
    assert.throws(() => confirmUnsupportedCeComments(commentCapabilities, {...commentProbe, authenticated: false}));
    assert.throws(() => confirmUnsupportedCeComments(commentCapabilities, {...commentProbe, httpStatus: 403}));
    assert.throws(() => confirmUnsupportedCeComments(commentCapabilities, {...commentProbe, notFoundBody: false}));
});

test('comment Not Found evidence comes from canonical visible text, not opaque script data or a bare status number', () => {
    const {canonicalNotFoundBody} = require('../scripts/self-hosted-phase-report.cjs');
    assert(canonicalNotFoundBody('<h1>Page Not Found</h1>', commentProbe.path));
    assert(canonicalNotFoundBody('<pre>Cannot GET ' + commentProbe.path + '</pre>', commentProbe.path));
    assert(!canonicalNotFoundBody('<script>const value="not found";</script><p>Unknown error 404</p>', commentProbe.path));
    assert(!canonicalNotFoundBody('<pre>Cannot GET /wrong/route</pre>', commentProbe.path));
});
