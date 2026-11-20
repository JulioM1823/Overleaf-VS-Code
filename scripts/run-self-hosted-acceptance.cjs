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
            else {
                const error = new Error(`Acceptance subprocess failed: ${path.basename(executable)} exit ${code}`);
                const marker = Buffer.concat(output.concat(errors)).toString().split(/\r?\n/)
                    .find(line => line.startsWith('ORBITLEAF_BOOTSTRAP_ERROR '));
                if (marker) {
                    try {
                        const parsed = JSON.parse(marker.slice('ORBITLEAF_BOOTSTRAP_ERROR '.length));
                        const safe = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : 'omitted';
                        error.bootstrapDiagnostic = {operation: safe(parsed.operation), errorName: safe(parsed.errorName),
                            errorCode: safe(parsed.errorCode), validationFields: Array.isArray(parsed.validationFields)
                                ? parsed.validationFields.map(safe).slice(0, 10) : []};
                    } catch {}
                }
                reject(error);
            }
        });
        child.stdin.end(input);
    });
}

function assertLinuxSecretSession() {
    if (process.platform !== 'linux' || !process.env.DBUS_SESSION_BUS_ADDRESS) {
        throw new Error('Genuine CE native acceptance requires Linux inside an isolated dbus-run-session');
    }
}

async function main() {
    const root = path.resolve(__dirname, '..');
    const version = process.argv[2] || 'stable';
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitleaf-ce-'));
    fs.chmodSync(directory, 0o700);
    // Keep the synthetic desktop keyring under this task's private directory;
    // leave the runner's HOME and existing desktop credential stores untouched.
    const desktopEnv = {...process.env, XDG_DATA_HOME: path.join(directory, 'desktop-data'),
        XDG_CONFIG_HOME: path.join(directory, 'desktop-config'), XDG_CACHE_HOME: path.join(directory, 'desktop-cache'),
        XDG_RUNTIME_DIR: path.join(directory, 'desktop-runtime')};
    delete desktopEnv.GNOME_KEYRING_CONTROL;
    for (const name of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']) fs.mkdirSync(desktopEnv[name], {recursive: true, mode: 0o700});
    let keyringProcess;
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
    const accounts = [{email: 'owner@acceptance.invalid', password: crypto.randomBytes(32).toString('base64url'), analyticsId: crypto.randomUUID()},
        {email: 'outsider@acceptance.invalid', password: crypto.randomBytes(32).toString('base64url'), analyticsId: crypto.randomUUID()}];
    fs.writeFileSync(accountPath, JSON.stringify(accounts), {mode: 0o600});
    const url = 'http://127.0.0.1:18082/';
    const compose = {services: {
        mongo: {image: 'mongo:8.0', command: ['--replSet', 'overleaf', '--bind_ip_all', '--wiredTigerCacheSizeGB', '0.25'], volumes: ['mongo:/data/db']},
        redis: {image: 'redis:7.4', command: ['redis-server', '--appendonly', 'yes'], volumes: ['redis:/data']},
        server: {image: 'sharelatex/sharelatex:6.3.4', ports: ['127.0.0.1:18082:80'], volumes: ['overleaf:/var/lib/overleaf'],
            environment: {OVERLEAF_APP_NAME: 'Orbitleaf Disposable Release Acceptance', OVERLEAF_SITE_URL: url,
                OVERLEAF_MONGO_URL: 'mongodb://mongo/sharelatex?replicaSet=overleaf',
                OVERLEAF_REDIS_HOST: 'redis', REDIS_HOST: 'redis', EMAIL_CONFIRMATION_DISABLED: 'true',
                OVERLEAF_INVITE_TOKEN_SECRET: crypto.randomBytes(32).toString('base64'),
                ENABLE_CONVERSIONS: 'true', SANDBOXED_COMPILES: 'false'}}},
        volumes: {mongo: {}, redis: {}, overleaf: {}}};
    fs.writeFileSync(composePath, JSON.stringify(compose, null, 2), {mode: 0o600});
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
        const bootstrap = `let operation='read-account-input';\ntry {\nconst fs=await import('node:fs');\nconst accounts=JSON.parse(fs.readFileSync(0,'utf8'));\noperation='import-registration';\nconst {default:Registration}=await import('./app/src/Features/User/UserRegistrationHandler.mjs');\nfor(const [index,account] of accounts.entries()){operation='register-account-'+index;await Registration.promises.registerNewUser(account);}\noperation='inspect-ce-capabilities';\nconst {default:Features}=await import('./app/src/infrastructure/Features.mjs');\nconst {default:Settings}=await import('@overleaf/settings');\nconst routers=[];\nfunction collect(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const filename=directory+'/'+entry.name;if(entry.isDirectory())collect(filename);else if(entry.isFile()&&(entry.name.endsWith('Router.mjs')||entry.name==='router.mjs'))routers.push(filename);}}\ncollect('./app/src');collect('./modules');\nconst capabilities={trackChangesFeature:Features.hasFeature('track-changes'),trackChangesModulePresent:fs.existsSync('./modules/track-changes'),trackChangesModuleConfigured:Settings.moduleImportSequence.includes('track-changes'),commentRoutesPresent:routers.some(filename=>{const source=fs.readFileSync(filename,'utf8');return source.includes('/threads')||source.includes('/thread/');}),routerFilesInspected:routers.length};\nconsole.log('ORBITLEAF_CE_CAPABILITIES '+JSON.stringify(capabilities));\nprocess.exit(0);\n} catch(error) {\nconsole.error('ORBITLEAF_BOOTSTRAP_ERROR '+JSON.stringify({operation,errorName:error.name,errorCode:error.code||'none',validationFields:Object.keys(error.errors||{})}));\nprocess.exit(1);\n}`;
        accountBootstrapStarted = true;
        const bootstrapOutput = await docker(['exec', '-T', 'server', 'bash', '-c',
            'source /etc/overleaf/env.sh && source /etc/container_environment.sh && cd /overleaf/services/web && exec node --input-type=module -e "$1"',
            'orbitleaf-acceptance-bootstrap', bootstrap], {input: JSON.stringify(accounts)});
        const capabilityLine = bootstrapOutput.split(/\r?\n/).find(line => line.startsWith('ORBITLEAF_CE_CAPABILITIES '));
        if (!capabilityLine) throw new Error('Actual CE feature/source capability evidence is missing');
        const capabilities = JSON.parse(capabilityLine.slice('ORBITLEAF_CE_CAPABILITIES '.length));
        for (const name of ['trackChangesFeature', 'trackChangesModulePresent', 'trackChangesModuleConfigured', 'commentRoutesPresent']) {
            if (typeof capabilities[name] !== 'boolean') throw new Error('Invalid CE feature/source capability evidence');
        }
        if (!Number.isInteger(capabilities.routerFilesInspected) || capabilities.routerFilesInspected < 1) throw new Error('CE routers were not inspected');
        const runningServerId = (await docker(['ps', '-q', 'server'])).trim();
        const runningImageId = (await command('docker', ['inspect', '--format', '{{.Image}}', runningServerId])).trim();
        const runningDigests = JSON.parse(await command('docker', ['image', 'inspect', runningImageId, '--format', '{{json .RepoDigests}}']));
        const expectedCeDigest = 'sharelatex/sharelatex@sha256:8fe42ff1991cb0cd5a3750171d2c568f78cd8c75f60eba1279e5ddf6fd427271';
        if (!runningDigests.includes(expectedCeDigest)) throw new Error('Running CE container does not match the exact inspected official image');
        capabilities.imageDigest = expectedCeDigest.split('@')[1];
        capabilities.runningImageId = runningImageId;
        capabilities.imageProofSource = 'Running server container immutable Image ID';
        report.ceCapabilities = capabilities; save();
        console.log('Acceptance: two synthetic server accounts created; starting isolated native editor.');
        const executable = await downloadAndUnzipVSCode({version,
            cachePath: process.env.OVERLEAF_VSCODE_CACHE || path.join(os.tmpdir(), 'overleaf-vscode-compat')});
        assertLinuxSecretSession();
        const existingOwner = await command('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus',
            '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.freedesktop.secrets'],
            {env: desktopEnv, timeout: 5000});
        if (!/\bboolean false\b/.test(existingOwner)) throw new Error('Acceptance requires an unused isolated Secret Service session');
        const controlDirectory = path.join(directory, 'keyring-control');
        fs.mkdirSync(controlDirectory, {mode: 0o700});
        desktopEnv.GNOME_KEYRING_CONTROL = controlDirectory;
        await command('dbus-update-activation-environment', ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
            'XDG_RUNTIME_DIR', 'GNOME_KEYRING_CONTROL'].map(name => `${name}=${desktopEnv[name]}`),
            {env: desktopEnv, timeout: 5000});
        const unlockPassword = crypto.randomBytes(32).toString('base64');
        let keyringFailed = false;
        keyringProcess = spawn('gnome-keyring-daemon', ['--foreground', '--unlock', '--components=secrets',
            '--control-directory', controlDirectory], {env: desktopEnv, stdio: ['pipe', 'ignore', 'ignore']});
        keyringProcess.once('error', () => { keyringFailed = true; });
        keyringProcess.once('close', () => { keyringFailed = true; });
        keyringProcess.stdin.on('error', () => { keyringFailed = true; });
        keyringProcess.stdin.end(unlockPassword + '\n');
        await waitFor(async () => {
            if (keyringFailed) return false;
            // Queries to the bus daemon do not activate a Secret Service. Only
            // address that service once its owner is this task's foreground PID.
            const owned = await command('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus',
                '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.freedesktop.secrets'],
                {env: desktopEnv, timeout: 5000});
            if (!/\bboolean true\b/.test(owned)) return false;
            const owner = await command('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus',
                '/org/freedesktop/DBus', 'org.freedesktop.DBus.GetConnectionUnixProcessID', 'string:org.freedesktop.secrets'],
                {env: desktopEnv, timeout: 5000});
            if (Number(owner.match(/\buint32 (\d+)\b/)?.[1]) !== keyringProcess.pid) return false;
            const state = await command('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.secrets',
                '/org/freedesktop/secrets/collection/login', 'org.freedesktop.DBus.Properties.Get',
                'string:org.freedesktop.Secret.Collection', 'string:Locked'], {env: desktopEnv, timeout: 5000});
            return /\bboolean false\b/.test(state);
        }, 'unlocked task-local encrypted Secret Service', 20000);
        const probeId = crypto.randomUUID();
        const probeValue = crypto.randomBytes(32).toString('base64');
        await command('secret-tool', ['store', '--label=Orbitleaf disposable acceptance probe', 'orbitleaf-audit', probeId],
            {env: desktopEnv, input: probeValue, timeout: 10000});
        const loadedProbe = await command('secret-tool', ['lookup', 'orbitleaf-audit', probeId], {env: desktopEnv, timeout: 10000});
        if (loadedProbe.trim() !== probeValue) throw new Error('Task-local encrypted Secret Service round trip failed');
        const keyringFile = path.join(desktopEnv.XDG_DATA_HOME, 'keyrings', 'login.keyring');
        let keyringBytes;
        try { keyringBytes = fs.readFileSync(keyringFile); }
        catch { throw new Error('Task-local encrypted keyring binary file is unavailable'); }
        const binaryFormat = keyringBytes.subarray(0, 16).equals(Buffer.from('GnomeKeyring\n\r\0\n'));
        if (!binaryFormat || keyringBytes.includes(Buffer.from(probeValue)) || keyringBytes.includes(Buffer.from(unlockPassword))) {
            throw new Error('Task-local keyring must use its password-protected binary format');
        }
        await command('secret-tool', ['clear', 'orbitleaf-audit', probeId], {env: desktopEnv, timeout: 10000});
        report.secretService = {provider: 'gnome-libsecret', taskScopedXdgDirectories: true, separateDbusSession: true,
            nonemptyRandomUnlockPassword: true, serviceOwnerMatchesTaskDaemon: true, collectionUnlocked: true, roundTrip: true, passwordProtectedBinaryFormat: true}; save();
        const profile = path.join(directory, 'profile');
        const env = {...desktopEnv, OVERLEAF_CE_ACCOUNT_FILE: accountPath, OVERLEAF_CE_STATE_FILE: statePath,
            OVERLEAF_CE_URL: url, OVERLEAF_CE_REPORT: reportPath, OVERLEAF_CE_CAPABILITIES: JSON.stringify(capabilities), OVERLEAF_SELF_HOSTED_ACCEPTANCE: '1',
            OVERLEAF_LIVE_REPORT: path.join(directory, 'live-report.json')};
        delete env.ELECTRON_RUN_AS_NODE; delete env.VSCODE_IPC_HOOK_CLI;
        const launch = async phase => {
            console.log(`Acceptance: ${phase} native extension-host phase.`);
            const phaseRunId = crypto.randomUUID();
            beginPhase(env.OVERLEAF_LIVE_REPORT, phase, phaseRunId);
            let executionError;
            try { await command(executable, ['--user-data-dir', path.join(profile, 'user'), '--extensions-dir', path.join(profile, 'extensions'),
                '--extensionDevelopmentPath=' + root,
                '--extensionDevelopmentPath=' + path.join(root, 'test/integration/self-hosted-driver'),
                '--password-store=gnome-libsecret', '--disable-extensions', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window'],
            {env: {...env, OVERLEAF_CE_PHASE: phase, OVERLEAF_CE_PHASE_RUN_ID: phaseRunId}, timeout: 720000, inherit: true}); }
            catch (error) { executionError = error; }
            verifyPhase(env.OVERLEAF_LIVE_REPORT, phase, phaseRunId, live => {
                report.phases.push({...live, requestedPhase: phase, expectedPhaseRunId: phaseRunId,
                    ...(executionError ? {hostExecutionFailure: executionError.message} : {})}); save();
            });
            if (executionError) throw executionError;
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
        if (error.bootstrapDiagnostic) report.bootstrapDiagnostic = error.bootstrapDiagnostic;
        await preAccountDiagnostics();
        save(); throw error;
    } finally {
        await docker(['down', '--volumes', '--remove-orphans']).catch(() => { report.cleanupFailure = true; save(); });
        if (keyringProcess && keyringProcess.exitCode === null) {
            keyringProcess.kill('SIGTERM');
            await new Promise(resolve => {
                const timer = setTimeout(() => { keyringProcess.kill('SIGKILL'); resolve(); }, 3000);
                keyringProcess.once('close', () => { clearTimeout(timer); resolve(); });
            });
        }
        fs.rmSync(directory, {recursive: true, force: true});
    }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
