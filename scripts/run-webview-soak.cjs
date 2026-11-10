// Launch the installed VS Code with an isolated profile and no user extensions.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {runInstalledVscode} = require('./vscode-test-launcher.cjs');

async function main() {
    const root = path.resolve(__dirname, '..');
    const executable = process.env.OVERLEAF_TEST_VSCODE
        || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
    if (!fs.existsSync(executable)) {
        throw new Error('Set OVERLEAF_TEST_VSCODE to an installed VS Code executable');
    }
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-webview-soak-'));
    const report = path.join(root, 'output/audit-2026-10/webview-soak.json');
    fs.rmSync(report, {force: true});
    try {
        await runInstalledVscode({
            executable, root,
            suite: path.join(root, 'test/integration/webviewSoak.cjs'),
            env: {
                OVERLEAF_SOAK_REPORT: report,
                OVERLEAF_SOAK_CYCLES: process.env.OVERLEAF_SOAK_CYCLES || '600',
                OVERLEAF_SOAK_INTERVAL_MS: process.env.OVERLEAF_SOAK_INTERVAL_MS || '250',
            },
            args: [
                '--user-data-dir', path.join(profile, 'user'),
                '--extensions-dir', path.join(profile, 'extensions'),
                '--disable-extensions', '--skip-welcome', '--skip-release-notes',
                '--disable-telemetry', '--new-window',
            ],
        });
        console.log(`Webview evidence: ${report}`);
    } finally {
        fs.rmSync(profile, {recursive: true, force: true});
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
