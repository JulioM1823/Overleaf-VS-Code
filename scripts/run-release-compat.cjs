// Download an official editor into a disposable cache and test the exact VSIX.
// No user's installed extensions, settings or credentials are reused.
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {downloadAndUnzipVSCode} = require('@vscode/test-electron');

async function main() {
    const vsix = path.resolve(process.argv[2] || 'orbitleaf.vsix');
    const version = process.argv[3] || 'stable';
    const executable = await downloadAndUnzipVSCode({version,
        cachePath: process.env.OVERLEAF_VSCODE_CACHE || path.join(os.tmpdir(), 'overleaf-vscode-compat')});
    const env = {...process.env, RELEASE_SMOKE_CODE: executable,
        RELEASE_SMOKE_REPORT: process.env.RELEASE_SMOKE_REPORT
            || path.resolve('output', 'release-audit', `installed-${process.platform}-${version}.json`)};
    delete env.RELEASE_SMOKE_CODE_CLI;
    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'run-release-smoke.cjs'), vsix], {env, stdio: 'inherit'});
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Installed-package test failed (${code ?? signal})`)));
    });
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});
