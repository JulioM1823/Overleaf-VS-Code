// Exercise the production chat/PDF renderers in a downloaded official editor.
// Each existing smoke runner creates its own profile; no user credentials are reused.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {downloadAndUnzipVSCode} = require('@vscode/test-electron');

function runSmoke({script, report, env, timeoutMs, root}) {
    fs.mkdirSync(path.dirname(report), {recursive: true});
    fs.rmSync(report, {force: true});
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, script)], {
            cwd: root, env, stdio: 'inherit', detached: process.platform !== 'win32',
        });
        let settled = false;
        const finish = error => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            if (error) { reject(error); } else { resolve(); }
        };
        const timer = setTimeout(() => {
            // Stop the editor as well as its Node launcher when a smoke hangs.
            if (child.pid) {
                if (process.platform === 'win32') {
                    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore', timeout: 10_000});
                } else {
                    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
                }
            }
            finish(new Error(`${script} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        child.once('error', finish);
        child.once('exit', (code, signal) => {
            if (settled) { return; }
            if (code !== 0) {
                finish(new Error(`${script} failed (${code ?? signal})`));
                return;
            }
            try {
                const result = JSON.parse(fs.readFileSync(report, 'utf8'));
                if (result.status !== 'passed') {
                    throw new Error(`${script} did not record a passing report: ${report}`);
                }
                console.log(`Verified renderer evidence: ${report} (VS Code ${result.vscode})`);
                finish();
            } catch (error) { finish(error); }
        });
    });
}

async function main() {
    const root = path.resolve(__dirname, '..');
    const version = process.argv[2] || 'stable';
    const executable = await downloadAndUnzipVSCode({version,
        cachePath: process.env.OVERLEAF_VSCODE_CACHE || path.join(os.tmpdir(), 'overleaf-vscode-compat')});
    if (!fs.existsSync(executable)) { throw new Error(`Downloaded VS Code executable is missing: ${executable}`); }
    const label = `${process.platform}-${process.arch}-${version.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const chatReport = path.resolve(process.env.OVERLEAF_CHAT_SMOKE_REPORT
        || path.join(root, 'output/release-audit', `chat-${label}.json`));
    const pdfReport = path.resolve(process.env.OVERLEAF_SOAK_REPORT
        || path.join(root, 'output/release-audit', `pdf-${label}.json`));
    if (chatReport === pdfReport) { throw new Error('Chat and PDF reports must use different paths'); }
    const env = {...process.env, OVERLEAF_TEST_VSCODE: executable,
        OVERLEAF_CHAT_SMOKE_REPORT: chatReport, OVERLEAF_SOAK_REPORT: pdfReport,
        OVERLEAF_SOAK_CYCLES: '20', OVERLEAF_SOAK_INTERVAL_MS: '0'};
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VSCODE_IPC_HOOK_CLI;
    console.log(`Native renderer editor: ${executable}; disable GPU: ${env.OVERLEAF_TEST_DISABLE_GPU === '1'}`);
    await runSmoke({script: 'run-chat-webview-smoke.cjs', report: chatReport, env, timeoutMs: 180_000, root});
    await runSmoke({script: 'run-webview-soak.cjs', report: pdfReport, env, timeoutMs: 720_000, root});
}

main().catch(error => {console.error(error); process.exitCode = 1;});
