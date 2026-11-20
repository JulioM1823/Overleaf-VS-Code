// Disposable normal profile; no browser cookies or existing VS Code credentials are read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {requirePassed} = require('../test/integration/hosted-driver/phase-report.cjs');
const {createOwnedProfile, resumeOwnedProfile, launchProfilePath} = require('./hosted-audit-profile.cjs');
const hostedRunId = randomUUID();
const root = path.resolve(__dirname, '..');
const projectId = process.env.OVERLEAF_TEST_PROJECT;
const projectName = process.env.OVERLEAF_TEST_PROJECT_NAME;
assert(typeof projectId==='string' && /^[a-f0-9]{24}$/i.test(projectId), 'Set OVERLEAF_TEST_PROJECT to the explicit disposable project ID');
assert(typeof projectName==='string' && projectName.startsWith('Overleaf Workshop Reliability Audit '), 'Set OVERLEAF_TEST_PROJECT_NAME to the exact disposable audit name');
assert(!process.env.OVERLEAF_TEST_SERVER || process.env.OVERLEAF_TEST_SERVER==='www.overleaf.com', 'This hosted audit only permits www.overleaf.com');
const output = path.join(root, 'output/release-readiness/hosted-live');
fs.mkdirSync(output, {recursive: true, mode: 0o700});
const launchMetadata = path.join(output, 'launch.json');
const resuming = process.env.OVERLEAF_HOSTED_RESUME==='1';
const owned = resuming
    ? resumeOwnedProfile(JSON.parse(fs.readFileSync(launchMetadata, 'utf8')))
    : createOwnedProfile();
const {profile, profileOwnershipToken} = owned;
const launchProfile = launchProfilePath(profile);
const executable = process.env.OVERLEAF_TEST_VSCODE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
assert(fs.existsSync(executable), 'Set OVERLEAF_TEST_VSCODE to an installed editor');
const status = path.join(output, 'status.json');
const report = path.join(output, 'live-sync.json');
const log = path.join(output, 'native-editor.log');
const settings = path.join(profile, 'user/User/settings.json');
fs.mkdirSync(path.dirname(settings), {recursive: true});
if (!resuming) {
    fs.writeFileSync(settings, JSON.stringify({'telemetry.telemetryLevel': 'off', 'files.autoSave': 'off'}, null, 2), {mode: 0o600});
}
fs.writeFileSync(launchMetadata, JSON.stringify({profile, profileOwnershipToken, hostedRunId, resuming, executable,
    status, report, log, normalDevelopmentHost: true, credentialsCopied: false,
    projectId}, null, 2) + '\n', {mode: 0o600});
if (resuming && fs.existsSync(log)) {
    fs.copyFileSync(log, path.join(output, `run-${hostedRunId}-previous-editor.log`));
}
const logFd = fs.openSync(log, 'w', 0o600);

async function launch(phase) {
    const identity = {hostedRunId, hostedPhase: phase, hostedPhaseId: randomUUID()};
    fs.writeFileSync(status, JSON.stringify({stage: 'starting', phase, credentialsCopied: false, ...identity}) + '\n', {mode: 0o600});
    if (phase==='initial') { fs.rmSync(report, {force: true}); }
    const env = {...process.env, OVERLEAF_TEST_PROJECT: projectId,
        OVERLEAF_TEST_PROJECT_NAME: projectName,
        OVERLEAF_TEST_SERVER: 'www.overleaf.com', OVERLEAF_TEST_PHASE: phase,
        OVERLEAF_HOSTED_STATUS: status, OVERLEAF_LIVE_REPORT: report,
        OVERLEAF_HOSTED_RUN_ID: identity.hostedRunId, OVERLEAF_HOSTED_PHASE_ID: identity.hostedPhaseId};
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VSCODE_IPC_HOOK_CLI;
    delete env.OVERLEAF_TEST_USER;
    delete env.OVERLEAF_TEST_LOGIN_UI;
    await new Promise((resolve, reject) => {
        const child = spawn(executable, [
            '--extensionDevelopmentPath=' + root,
            '--extensionDevelopmentPath=' + path.join(root, 'test/integration/hosted-driver'),
            '--user-data-dir', path.join(launchProfile, 'user'), '--extensions-dir', path.join(launchProfile, 'extensions'),
            '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window',
        ], {env, stdio: ['ignore', logFd, logFd]});
        child.once('error', reject);
        child.once('exit', (code, signal) => code===0 ? resolve() : reject(new Error(`Hosted audit editor failed (${code ?? signal})`)));
    });
    requirePassed(status, identity);
    requirePassed(report, identity);
    return identity;
}

launch('initial').then(async identity => {
    const initial = requirePassed(report, identity);
    fs.writeFileSync(path.join(output, `run-${hostedRunId}-initial-passed.json`), JSON.stringify(initial, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    await launch('restart');
}).then(() => {
    console.log(`Hosted live audit passed; evidence: ${report}`);
}).catch(() => {
    console.error(`Hosted live audit did not complete; inspect local status: ${status}`);
    process.exitCode = 1;
}).finally(() => fs.closeSync(logFd));
