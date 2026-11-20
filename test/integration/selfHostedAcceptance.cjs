const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const root = path.resolve(__dirname, '../..');
const {GlobalStateManager} = require(path.join(root, 'out/utils/globalStateManager'));
const {BaseAPI} = require(path.join(root, 'out/api/base'));
const {completePhase, failPhase, withDeadline} = require('../../scripts/self-hosted-phase-report.cjs');

exports.run = async () => {
    const accounts = JSON.parse(fs.readFileSync(process.env.OVERLEAF_CE_ACCOUNT_FILE, 'utf8'));
    const url = new URL(process.env.OVERLEAF_CE_URL);
    assert(url.hostname === '127.0.0.1' && url.port === '18082', 'Only the task-local disposable CE is allowed');
    const reportPath = process.env.OVERLEAF_LIVE_REPORT;
    const phase = process.env.OVERLEAF_CE_PHASE;
    let stage = 'activate';
    const socketModule = require.cache[require.resolve(path.join(root, 'out/api/socketioAlt'))];
    const targetWindow = socketModule?.require('vscode').window;
    const apiSurface = {targetWindowShared: targetWindow === vscode.window,
        targetWarningWritable: !!Object.getOwnPropertyDescriptor(targetWindow || {}, 'showWarningMessage')?.writable};
    const progress = {contextCaptured: false, passwordLoginChecked: false, passwordHttpResponses: 0, passwordHttpSucceeded: false, secretStorageMetadataChecked: false, projectReady: false};
    const checkpoint = () => {
        const current = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        fs.writeFileSync(reportPath, JSON.stringify({...current, stage, progress, apiSurface}, null, 2) + '\n', {mode: 0o600});
    };
    checkpoint();
    const getServers = GlobalStateManager.getServers;
    let context;
    GlobalStateManager.getServers = function (...args) { context = args[0]; return getServers.apply(this, args); };
    const originalWarning = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async function (message, ...items) {
        const copy = items.find(item => typeof item === 'string' && item === 'Upload recovery copies');
        if (copy && message.includes('recovery copies')) return copy;
        return originalWarning.call(this, message, ...items);
    };
    try {
        const manifest = require(path.join(root, 'package.json'));
        const extension = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
        assert(extension && fs.realpathSync(extension.extensionPath) === fs.realpathSync(root));
        await extension.activate();
        await vscode.commands.executeCommand('overleaf-workshop.projectManager.focus');
        await vscode.commands.executeCommand('overleaf-workshop.projectManager.refreshServer', {name: 'www.overleaf.com'});
        const deadline = Date.now() + 15000;
        while (!context && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert(context, 'Actual extension context must be observed from its tree');
        progress.contextCaptured = true;
        GlobalStateManager.getServers = getServers;
        GlobalStateManager.addServer(context, url.host, url.href);
        stage = 'real-password-login-and-secret-storage'; checkpoint();
        const api = new BaseAPI(url.href);
        const passportLogin = api.passportLogin.bind(api);
        api.passportLogin = async (...args) => {
            stage = 'password-login-http'; checkpoint();
            const response = await withDeadline(() => passportLogin(...args), 45000, 'Synthetic CE password HTTP login exceeded 45 seconds');
            progress.passwordHttpResponses++; progress.passwordHttpSucceeded = response.type === 'success';
            stage = 'password-http-completed-before-secret-storage'; checkpoint();
            return response;
        };
        let login;
        if (phase === 'initial') {
            assert(await withDeadline(() => GlobalStateManager.loginServer(context, api, url.host, accounts[0]), 60000,
                'Synthetic CE production login and SecretStorage persistence exceeded 60 seconds'), 'Synthetic CE password login must succeed');
            progress.passwordLoginChecked = true; checkpoint();
            login = await api.passportLogin(accounts[0].email, accounts[0].password);
        } else {
            const state = JSON.parse(fs.readFileSync(process.env.OVERLEAF_CE_STATE_FILE, 'utf8'));
            stage = 'secret-storage-reload-after-restart'; checkpoint();
            const identity = await withDeadline(() => GlobalStateManager.authenticate(context, url.host, state.userId), 60000,
                'Synthetic CE SecretStorage reload exceeded 60 seconds');
            assert(identity, 'Normal-host SecretStorage session must survive editor/server restart without password login');
            stage = 'stored-session-http-validation'; checkpoint();
            login = await withDeadline(() => api.cookiesLogin(identity.cookies), 45000, 'Synthetic CE stored-session HTTP validation exceeded 45 seconds');
        }
        assert.equal(login.type, 'success'); assert(login.identity && login.userInfo);
        progress.passwordLoginChecked = true; checkpoint();
        const metadataOnly = context.globalState.get('overleaf-servers', {})[url.host];
        assert(metadataOnly.login.identitySecretKey && !metadataOnly.login.identity, 'Credentials remain in SecretStorage, not global state');
        progress.secretStorageMetadataChecked = true; checkpoint();
        let state;
        if (phase === 'initial') {
            stage = 'create-disposable-project'; checkpoint();
            state = {projectName: 'Overleaf Workshop Reliability Audit ' + crypto.randomUUID(), userId: login.userInfo.userId};
            const created = await api.newProject(login.identity, state.projectName, 'none');
            assert.equal(created.type, 'success'); assert(created.message);
            state.projectId = created.message;
            fs.writeFileSync(process.env.OVERLEAF_CE_STATE_FILE, JSON.stringify(state), {mode: 0o600});
        } else state = JSON.parse(fs.readFileSync(process.env.OVERLEAF_CE_STATE_FILE, 'utf8'));
        progress.projectReady = true;
        process.env.OVERLEAF_TEST_PROJECT = state.projectId;
        process.env.OVERLEAF_TEST_USER = state.userId;
        process.env.OVERLEAF_TEST_SERVER = url.host;
        process.env.OVERLEAF_TEST_PROJECT_NAME = state.projectName;
        process.env.OVERLEAF_TEST_PHASE = phase;
        stage = 'live-production-vfs-scenarios'; checkpoint();
        await require('./liveSync.cjs').run();
        completePhase(reportPath, phase, process.env.OVERLEAF_CE_PHASE_RUN_ID, {
            genuineSelfHostedServer: true, passwordLogin: 'passed through production BaseAPI and GlobalStateManager',
            secretStorageOnly: true, normalExtensionHost: true, reauthenticatedAfterRestart: false,
            serverRestartBeforePhase: phase === 'restart'});
    } catch (error) {
        failPhase(reportPath, phase, process.env.OVERLEAF_CE_PHASE_RUN_ID,
            error instanceof assert.AssertionError || error.code === 'ORBITLEAF_CE_DEADLINE' ? error.message : 'Acceptance operation failed; sensitive server response omitted.');
        const failed = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        failed.stage = stage;
        failed.progress = progress;
        failed.apiSurface = apiSurface;
        fs.writeFileSync(reportPath, JSON.stringify(failed, null, 2) + '\n', {mode: 0o600});
        throw new Error(`Self-hosted acceptance failed at ${stage}`);
    } finally {
        GlobalStateManager.getServers = getServers;
        vscode.window.showWarningMessage = originalWarning;
    }
};
