// Install the exact VSIX in an isolated profile, then test that installed copy.
// Only the test companion uses --extensionDevelopmentPath. No credentials are copied.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const JSZip = require('jszip');

function run(executable, args, env, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
        const output = [];
        child.stdout.on('data', data => output.push(data));
        child.stderr.on('data', data => output.push(data));
        const timeout = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`VS Code operation timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            const text = Buffer.concat(output).toString();
            if (code === 0) { resolve(text); }
            else { reject(new Error(`VS Code operation failed (${code ?? signal}): ${text.slice(-5000)}`)); }
        });
    });
}

async function main() {
    const root = path.resolve(__dirname, '..');
    const vsixPath = path.resolve(process.argv[2] || process.env.RELEASE_SMOKE_VSIX || '');
    assert(/\.vsix$/i.test(vsixPath) && fs.statSync(vsixPath).isFile(), 'Supply the tested .vsix path as the first argument or RELEASE_SMOKE_VSIX');
    const env = {...process.env};
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VSCODE_IPC_HOOK_CLI;
    const executable = process.env.RELEASE_SMOKE_CODE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
    assert(fs.existsSync(executable), 'Set RELEASE_SMOKE_CODE to the installed VS Code executable');
    // Invoke the CLI's JS entrypoint directly: Windows .cmd launchers require
    // shell quoting and `unzip` is not installed on every supported platform.
    const cliScript = path.resolve(path.dirname(executable), process.platform === 'darwin'
        ? '../Resources/app/out/cli.js' : 'resources/app/out/cli.js');
    const cliOverride = process.env.RELEASE_SMOKE_CODE_CLI;
    assert(fs.existsSync(cliOverride || cliScript), 'VS Code CLI entrypoint is missing');
    const cli = cliOverride || executable;
    const cliPrefix = cliOverride ? [] : [cliScript, '--ms-enable-electron-run-as-node'];
    const cliEnv = cliOverride ? env : {...env, ELECTRON_RUN_AS_NODE: '1'};
    const archive = await JSZip.loadAsync(fs.readFileSync(vsixPath));
    const manifestEntry = archive.file('extension/package.json');
    assert(manifestEntry, 'VSIX is missing its extension manifest');
    const manifest = JSON.parse(await manifestEntry.async('string'));
    const extensionId = process.argv[3] || process.env.RELEASE_SMOKE_EXTENSION_ID || `${manifest.publisher}.${manifest.name}`;
    assert.equal(extensionId.toLowerCase(), `${manifest.publisher}.${manifest.name}`.toLowerCase(), 'Requested ID must match VSIX manifest');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitleaf-release-smoke-'));
    fs.chmodSync(profile, 0o700);
    const userData = path.join(profile, 'user');
    const extensions = path.join(profile, 'extensions');
    const hostReport = path.join(profile, 'extension-host-report.json');
    const reportPath = path.resolve(process.env.RELEASE_SMOKE_REPORT || path.join(root, 'output', 'release', `${manifest.name}-${manifest.version}-smoke.json`));
    fs.mkdirSync(path.dirname(reportPath), {recursive: true});
    const report = {
        status: 'running',
        vsixPath,
        vsixSha256: crypto.createHash('sha256').update(fs.readFileSync(vsixPath)).digest('hex'),
        extensionId,
        version: manifest.version,
        cleanProfile: profile,
        credentialsCopied: false,
        sandboxDisabled: false,
    };
    const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    const settingsPath = path.join(userData, 'User', 'settings.json');
    const settingsBytes = Buffer.from(JSON.stringify({'files.eol': '\n', 'telemetry.telemetryLevel': 'off'}, null, 2) + '\n');
    fs.mkdirSync(path.dirname(settingsPath), {recursive: true});
    fs.writeFileSync(settingsPath, settingsBytes);
    save();
    try {
        const profileArgs = ['--user-data-dir', userData, '--extensions-dir', extensions];
        const cliRun = args => run(cli, [...cliPrefix, ...profileArgs, ...args], cliEnv, 90000);
        await cliRun(['--install-extension', vsixPath, '--force']);
        report.exactVsixInstalled = true;
        assert((await cliRun(['--list-extensions', '--show-versions'])).toLowerCase().includes(`${extensionId}@${manifest.version}`.toLowerCase()));
        await cliRun(['--install-extension', vsixPath, '--force']);
        assert.deepEqual(fs.readFileSync(settingsPath), settingsBytes, 'Reinstall must preserve user settings');
        report.reinstallPreservedSettings = true;
        save();
        await run(executable, [
            ...profileArgs,
            '--extensionDevelopmentPath=' + path.join(root, 'test/integration/release-driver'),
            '--extensionTestsPath=' + path.join(root, 'test/integration/release-driver/smoke.cjs'),
            '--disable-updates', '--skip-welcome', '--skip-release-notes',
            '--disable-telemetry', '--new-window',
        ], {...env,
            RELEASE_SMOKE_EXTENSION_ID: extensionId,
            RELEASE_SMOKE_VERSION: manifest.version,
            RELEASE_SMOKE_DISPLAY_NAME: manifest.displayName,
            RELEASE_SMOKE_COMMAND_CATEGORY: process.env.RELEASE_SMOKE_COMMAND_CATEGORY || 'Overleaf-VS Code',
            RELEASE_SMOKE_EXTENSIONS_DIR: extensions,
            RELEASE_SMOKE_HOST_REPORT: hostReport,
        }, 90000);
        report.extensionHost = JSON.parse(fs.readFileSync(hostReport, 'utf8'));
        assert.equal(report.extensionHost.status, 'passed', 'Installed extension host checks must pass');

        report.defaultServer = report.extensionHost.defaultServer;
        await cliRun(['--uninstall-extension', extensionId]);
        assert(!(await cliRun(['--list-extensions'])).toLowerCase().split(/\r?\n/).includes(extensionId.toLowerCase()));
        assert.deepEqual(fs.readFileSync(settingsPath), settingsBytes, 'Uninstall must preserve user settings');
        await cliRun(['--install-extension', vsixPath, '--force']);
        assert((await cliRun(['--list-extensions', '--show-versions'])).toLowerCase().includes(`${extensionId}@${manifest.version}`.toLowerCase()));
        assert.deepEqual(fs.readFileSync(settingsPath), settingsBytes, 'Reinstallation must preserve user settings');
        report.uninstallReinstallPreservedSettings = true;
        report.status = 'passed';
        save();
        console.log(`Exact-installed-package smoke passed. Report: ${reportPath}`);
        console.log(`Isolated profile retained for inspection: ${profile}`);
    } catch (error) {
        if (fs.existsSync(hostReport)) {
            try { report.extensionHost = JSON.parse(fs.readFileSync(hostReport, 'utf8')); } catch {}
        }
        report.status = 'failed';
        report.error = error instanceof Error ? error.message : String(error);
        save();
        throw error;
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
