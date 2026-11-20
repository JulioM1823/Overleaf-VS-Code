// Genuine disposable Overleaf CE acceptance; no existing accounts or profiles.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {downloadAndUnzipVSCode} = require('@vscode/test-electron');
const {beginPhase, verifyPhase} = require('./self-hosted-phase-report.cjs');

function command(executable, args, {input, env = process.env, timeout = 600000, inherit = false, mergeOutput = false} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {env, stdio: ['pipe', inherit ? 'inherit' : 'pipe', 'pipe']});
        const output = [], errors = [];
        child.stdout?.on('data', data => output.push(data));
        child.stderr.on('data', data => errors.push(data));
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Acceptance subprocess timed out: ${path.basename(executable)}`)); }, timeout);
        child.once('error', error => {clearTimeout(timer); reject(error);});
        child.once('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve(Buffer.concat(mergeOutput ? output.concat(errors) : output).toString());
            // Never echo captured server/account-bootstrap output: it can contain session data.
            else reject(new Error(`Acceptance subprocess failed: ${path.basename(executable)} exit ${code}`));
        });
        child.stdin.end(input);
    });
}

async function main() {
    const root = path.resolve(__dirname, '..');
    const version = process.argv[2] || 'stable';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitleaf-ce-'));
    fs.chmodSync(directory, 0o700);
    const project = 'orbitleaf-ce-' + crypto.randomBytes(5).toString('hex');
    const composePath = path.join(directory, 'compose.json');
    const accountPath = path.join(directory, 'accounts.json');
    const statePath = path.join(directory, 'state.json');
    const reportPath = path.resolve(process.env.OVERLEAF_CE_REPORT || path.join(root, 'output/release-audit', `self-hosted-${version}.json`));
    fs.mkdirSync(path.dirname(reportPath), {recursive: true});
    const report = {status: 'running', genuineServer: true, serverVersion: '6.3.4', vscodeRequest: version,
        credentials: 'Synthetic accounts only; random passwords remain in task-private files/stdin and isolated SecretStorage.',
        publishedServerPorts: '127.0.0.1:18082 only', phases: [], limitations: ['Community Edition is not hosted Overleaf SSO/captcha acceptance.']};
    let accountBootstrapStarted = false;
    const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    const accounts = [{email: 'owner@acceptance.invalid', password: crypto.randomBytes(32).toString('base64url')},
        {email: 'outsider@acceptance.invalid', password: crypto.randomBytes(32).toString('base64url')}];
    fs.writeFileSync(accountPath, JSON.stringify(accounts), {mode: 0o600});
    const url = 'http://127.0.0.1:18082/';
    const compose = {services: {
        mongo: {image: 'mongo:8.0', command: ['--replSet', 'overleaf', '--bind_ip_all', '--wiredTigerCacheSizeGB', '0.25'], volumes: ['mongo:/data/db']},
        redis: {image: 'redis:7.4', command: ['redis-server', '--appendonly', 'yes'], volumes: ['redis:/data']},
        server: {image: 'sharelatex/sharelatex:6.3.4', ports: ['127.0.0.1:18082:80'], volumes: ['overleaf:/var/lib/overleaf'],
            environment: {OVERLEAF_APP_NAME: 'Orbitleaf Disposable Release Acceptance', OVERLEAF_SITE_URL: url,
                OVERLEAF_MONGO_URL: 'mongodb://mongo/sharelatex?replicaSet=overleaf',
                OVERLEAF_REDIS_HOST: 'redis', REDIS_HOST: 'redis', EMAIL_CONFIRMATION_DISABLED: 'true',
                ENABLE_CONVERSIONS: 'true', SANDBOXED_COMPILES: 'false'}}},
        volumes: {mongo: {}, redis: {}, overleaf: {}}};
    fs.writeFileSync(composePath, JSON.stringify(compose, null, 2));
    const docker = (args, options) => command('docker', ['compose', '-p', project, '-f', composePath, ...args], options);
    const waitFor = async (predicate, label, timeout = 300000) => {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
            try { if (await predicate()) return; } catch {}
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
        throw new Error(`Acceptance timed out waiting for ${label}`);
    };
    const serverReady = () => waitFor(async () => {
        try {
            const response = await fetch(new URL('login', url), {signal: AbortSignal.timeout(10000)});
            report.lastPreAccountHttp = {status: response.status, path: new URL(response.url).pathname};
            return response.status === 200;
        } catch (error) {
            report.lastPreAccountHttp = {connectionErrorCode: error.cause?.code || error.code || error.name};
            return false;
        }
    }, 'CE login page');
    const preAccountDiagnostics = async () => {
        // No complete logs are retained once credentials or sessions can exist.
        if (accountBootstrapStarted) return;
        const diagnostics = {scope: 'Pre-account provisioning only', services: {}};
        for (const service of ['mongo', 'redis', 'server']) {
            try {
                const id = (await docker(['ps', '-aq', service])).trim();
                if (!id) { diagnostics.services[service] = {status: 'absent'}; continue; }
                const state = JSON.parse(await command('docker', ['inspect', '--format', '{{json .State}}', id]));
                diagnostics.services[service] = {status: state.Status, exitCode: state.ExitCode,
                    oomKilled: state.OOMKilled, health: state.Health?.Status || 'not-configured'};
            } catch { diagnostics.services[service] = {status: 'diagnostic-unavailable'}; }
        }
        try {
            const raw = await docker(['logs', '--no-color', '--tail', '100', 'server'], {mergeOutput: true});
            diagnostics.serverBootLog = raw.split(/\r?\n/)
                .filter(line => !/secret|password|token|cookie|authorization|key|credential|crypto|session|(?:process\.)?env(?:ironment)?\b/i.test(line)
                    && !/\b[A-Z][A-Z0-9_]*\s*[=:]/.test(line))
                .map(line => line.replace(/[A-Za-z0-9_+/=-]{80,}/g, '[redacted opaque value]'))
                .join('\n').slice(-1800);
        } catch { diagnostics.serverBootLog = 'Unavailable'; }
        report.preAccountDiagnostics = diagnostics;
    };
    save();
    try {
        console.log('Acceptance: pulling official CE 6.3.4, MongoDB 8.0 and Redis 7.4 images.');
        await docker(['pull'], {timeout: 1200000});
        report.images = {};
        for (const image of ['sharelatex/sharelatex:6.3.4', 'mongo:8.0', 'redis:7.4']) {
            report.images[image] = JSON.parse(await command('docker', ['image', 'inspect', image, '--format', '{{json .RepoDigests}}']));
        }
        save();
        await docker(['up', '-d', 'mongo', 'redis']);
        await waitFor(async () => (await docker(['exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', 'db.adminCommand({ping:1}).ok'])).trim() === '1', 'MongoDB');
        await docker(['exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', "rs.initiate({_id:'overleaf',members:[{_id:0,host:'mongo:27017'}]})"]);
        await waitFor(async () => (await docker(['exec', '-T', 'mongo', 'mongosh', '--quiet', '--eval', 'db.hello().isWritablePrimary'])).trim() === 'true', 'MongoDB primary');
        await docker(['up', '-d', 'server']);
        await serverReady();
        const bootstrap = `import fs from 'node:fs';\nimport Registration from './app/src/Features/User/UserRegistrationHandler.mjs';\nconst accounts=JSON.parse(fs.readFileSync(0,'utf8'));\nfor(const account of accounts){await Registration.promises.registerNewUser(account);}\nprocess.exit(0);`;
        accountBootstrapStarted = true;
        await docker(['exec', '-T', '-w', '/overleaf/services/web', 'server', 'node', '--input-type=module', '-e', bootstrap], {input: JSON.stringify(accounts)});
        console.log('Acceptance: two synthetic server accounts created; starting isolated native editor.');
        const executable = await downloadAndUnzipVSCode({version,
            cachePath: process.env.OVERLEAF_VSCODE_CACHE || path.join(os.tmpdir(), 'overleaf-vscode-compat')});
        const profile = path.join(directory, 'profile');
        const env = {...process.env, OVERLEAF_CE_ACCOUNT_FILE: accountPath, OVERLEAF_CE_STATE_FILE: statePath,
            OVERLEAF_CE_URL: url, OVERLEAF_CE_REPORT: reportPath, OVERLEAF_SELF_HOSTED_ACCEPTANCE: '1',
            OVERLEAF_LIVE_REPORT: path.join(directory, 'live-report.json')};
        delete env.ELECTRON_RUN_AS_NODE; delete env.VSCODE_IPC_HOOK_CLI;
        const launch = async phase => {
            console.log(`Acceptance: ${phase} native extension-host phase.`);
            const phaseRunId = crypto.randomUUID();
            beginPhase(env.OVERLEAF_LIVE_REPORT, phase, phaseRunId);
            await command(executable, ['--user-data-dir', path.join(profile, 'user'), '--extensions-dir', path.join(profile, 'extensions'),
                '--extensionDevelopmentPath=' + root,
                '--extensionDevelopmentPath=' + path.join(root, 'test/integration/self-hosted-driver'),
                '--disable-extensions', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window'],
            {env: {...env, OVERLEAF_CE_PHASE: phase, OVERLEAF_CE_PHASE_RUN_ID: phaseRunId}, timeout: 720000, inherit: true});
            const live = verifyPhase(env.OVERLEAF_LIVE_REPORT, phase, phaseRunId);
            report.phases.push({phase, ...live}); save();
        };
        await launch('initial');
        console.log('Acceptance: restarting the genuine server before persisted-draft/editor restart phase.');
        await docker(['restart', 'server']);
        await serverReady();
        await launch('restart');
        report.status = 'passed'; save();
        console.log(`Genuine self-hosted acceptance passed: ${reportPath}`);
    } catch (error) {
        report.status = 'failed'; report.failure = error.message;
        await preAccountDiagnostics();
        save(); throw error;
    } finally {
        await docker(['down', '--volumes', '--remove-orphans']).catch(() => { report.cleanupFailure = true; save(); });
        fs.rmSync(directory, {recursive: true, force: true});
    }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
