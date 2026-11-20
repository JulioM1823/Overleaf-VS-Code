// Exercise production chat HTML/provider in an isolated native VS Code profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {runInstalledVscode} = require('./vscode-test-launcher.cjs');

async function main() {
    const root = path.resolve(__dirname, '..');
    const executable = process.env.OVERLEAF_TEST_VSCODE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
    if (!fs.existsSync(executable)) { throw new Error('Set OVERLEAF_TEST_VSCODE to an installed VS Code executable'); }
    const report = process.env.OVERLEAF_CHAT_SMOKE_REPORT || path.join(root, 'output/release-audit/chat-webview-smoke.json');
    const profile = fs.mkdtempSync(path.join(process.platform==='darwin' ? '/private/tmp' : os.tmpdir(), 'ol-chat-'));
    fs.chmodSync(profile, 0o700);
    fs.rmSync(report, {force: true});
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.VSCODE_IPC_HOOK_CLI;
    try {
        await runInstalledVscode({executable, root, suite: path.join(root, 'test/integration/chatWebviewSmoke.cjs'),
            env: {OVERLEAF_CHAT_SMOKE_REPORT: report},
            args: ['--user-data-dir', path.join(profile, 'user'), '--extensions-dir', path.join(profile, 'extensions')]});
        console.log(`Chat webview evidence: ${report}`);
    } finally { fs.rmSync(profile, {recursive: true, force: true}); }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
