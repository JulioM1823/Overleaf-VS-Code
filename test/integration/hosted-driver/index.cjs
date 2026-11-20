// Normal development-host companion: authentication stays in VS Code SecretStorage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const {beginPhase, completePhase, failPhase} = require('./phase-report.cjs');
const vscode = require('vscode');
const {loadedInstalledModule} = require('../release-driver/loaded-module.cjs');
const root = path.resolve(__dirname, '../../..');
const allowedProject = process.env.OVERLEAF_TEST_PROJECT;
const allowedName = process.env.OVERLEAF_TEST_PROJECT_NAME;
let active = false;
let storageDescription;
const phaseIdentity = {
    hostedRunId: process.env.OVERLEAF_HOSTED_RUN_ID || 'manual-' + createHash('sha256').update(String(process.env.OVERLEAF_HOSTED_STATUS) + String(allowedProject)).digest('hex').slice(0,24),
    hostedPhaseId: process.env.OVERLEAF_HOSTED_PHASE_ID || randomUUID(),
    hostedPhase: process.env.OVERLEAF_TEST_PHASE,
};

function state(stage, extra = {}) {
    const filename = process.env.OVERLEAF_HOSTED_STATUS;
    assert(filename, 'Hosted audit status path is required');
    fs.mkdirSync(path.dirname(filename), {recursive: true, mode: 0o700});
    fs.writeFileSync(filename, JSON.stringify({stage, isolatedProfile: true,
        normalSecretStorage: true, credentialsCopied: false, projectId: allowedProject,
        phase: process.env.OVERLEAF_TEST_PHASE, storage: storageDescription, ...extra, ...phaseIdentity}, null, 2) + '\n', {mode: 0o600});
}

async function actualContext() {
    const extension = vscode.extensions.getExtension('AstroJulio.orbitleaf');
    assert(extension, 'Workspace extension must be available');
    assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(root));
    await extension.activate();
    const {GlobalStateManager} = loadedInstalledModule(root, 'out/utils/globalStateManager.js').exports;
    const original = GlobalStateManager.getServers;
    let context;
    GlobalStateManager.getServers = function (...args) {
        const result = original.apply(this, args);
        context = args[0];
        return result;
    };
    try {
        await vscode.commands.executeCommand('overleaf-workshop.projectManager.focus');
        await vscode.commands.executeCommand('overleaf-workshop.projectManager.refreshServer', {name: 'www.overleaf.com'});
        const deadline = Date.now() + 30000;
        while (!context && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); }
        assert(context, 'Actual installed project-manager context must be observed');
        storageDescription = {scheme: context.globalStorageUri?.scheme,
            authorityPresent: !!context.globalStorageUri?.authority,
            absoluteFsPath: path.isAbsolute(context.globalStorageUri?.fsPath || ''),
            appHost: vscode.env.appHost, uiKind: vscode.env.uiKind,
            remoteExtensionHost: !!vscode.env.remoteName};
        return context;
    } finally { GlobalStateManager.getServers = original; }
}

exports.activate = async context => {
    assert(typeof allowedProject==='string' && /^[a-f0-9]{24}$/i.test(allowedProject), 'An explicit disposable hosted project ID is required');
    assert(typeof allowedName==='string' && allowedName.startsWith('Overleaf Workshop Reliability Audit '), 'An explicit disposable audit project name is required');
    assert.equal(process.env.OVERLEAF_TEST_SERVER, 'www.overleaf.com');
    let extensionContext;
    try { extensionContext = await actualContext(); }
    catch {
        failPhase(process.env.OVERLEAF_LIVE_REPORT, phaseIdentity);
        state('failed', {failure: 'Cannot bind the actual workspace extension context'});
        await vscode.window.showErrorMessage('Hosted audit could not bind the extension context. No project changes were made.');
        return;
    }
    const run = async () => {
        if (active) { return; }
        active = true;
        try {
            let server = extensionContext.globalState.get('overleaf-servers', {})['www.overleaf.com'];
            if (!server?.login?.userId) {
                state('awaiting-user-login');
                await vscode.commands.executeCommand('overleaf-workshop.projectManager.loginServer');
                server = extensionContext.globalState.get('overleaf-servers', {})['www.overleaf.com'];
            }
            if (!server?.login?.userId) {
                state('awaiting-user-login', {loginCompleted: false});
                return;
            }
            assert.equal(server.url, 'https://www.overleaf.com/');
            assert.equal(typeof server.login.userId, 'string');
            assert(server.login.userId.length > 0);
            process.env.OVERLEAF_TEST_USER = server.login.userId;
            delete process.env.OVERLEAF_TEST_LOGIN_UI;
            state('running', {loginCompleted: true});
            // Preserve initial effects for restart, but invalidate its prior success.
            const previousRestartCount = beginPhase(process.env.OVERLEAF_LIVE_REPORT, phaseIdentity);
            // liveSync additionally checks the fetched project's exact name before mutation.
            await require('../liveSync.cjs').run();
            completePhase(process.env.OVERLEAF_LIVE_REPORT, phaseIdentity, previousRestartCount);
            state('passed', {loginCompleted: true});
            await vscode.commands.executeCommand('workbench.action.quit');
        } catch {
            failPhase(process.env.OVERLEAF_LIVE_REPORT, phaseIdentity);
            state('failed', {failure: 'Hosted scenario failed; inspect the private local evidence report'});
            await vscode.window.showErrorMessage('Hosted audit failed. Its local evidence report has been retained.');
            await vscode.commands.executeCommand('workbench.action.quit');
        } finally { active = false; }
    };
    context.subscriptions.push(vscode.commands.registerCommand('overleaf-audit.hosted.loginAndRun', run));
    await run();
};
