// Uses the existing VS Code session through SecretStorage; never exports credentials.
const path = require('node:path');
const fs = require('node:fs');
const {runInstalledVscode} = require('./vscode-test-launcher.cjs');
const root = path.resolve(__dirname, '..');
const reportPath = path.join(root, 'output/audit-2026-10/live-sync.json');
fs.rmSync(reportPath, {force: true});
if (!process.env.OVERLEAF_TEST_PROJECT || !process.env.OVERLEAF_TEST_USER) {
    throw new Error('Set OVERLEAF_TEST_PROJECT and OVERLEAF_TEST_USER for a disposable audit project');
}
const launch = phase => runInstalledVscode({
    executable: process.env.OVERLEAF_TEST_VSCODE
        || '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    root,
    args: [`--extensionDevelopmentPath=${path.join(root, 'test/integration/live-driver')}`],
    env: {
        OVERLEAF_TEST_PROJECT: process.env.OVERLEAF_TEST_PROJECT,
        OVERLEAF_TEST_USER: process.env.OVERLEAF_TEST_USER,
        OVERLEAF_TEST_SERVER: process.env.OVERLEAF_TEST_SERVER || 'www.overleaf.com',
        OVERLEAF_TEST_PROJECT_NAME: process.env.OVERLEAF_TEST_PROJECT_NAME,
        OVERLEAF_LIVE_REPORT: reportPath,
        OVERLEAF_TEST_LOGIN_UI: process.env.OVERLEAF_TEST_LOGIN_UI,
        OVERLEAF_TEST_PHASE: phase,
    },
});
launch('initial').then(async () => {
    const initial = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (initial.status !== 'passed') { throw new Error('Initial live test did not pass'); }
    // Reopen the development extension in a fresh extension-host process to
    // verify persisted drafts, using the same normal SecretStorage profile.
    await launch('restart');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (report.status !== 'passed') { throw new Error('Live test did not pass'); }
    console.log(`Live evidence: ${reportPath}`);
}).catch(() => { console.error('Live synchronization test failed; inspect the private local test log.'); process.exitCode = 1; });
