const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');

const attribution = 'This extension is built on the source code of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop), developed by iamhyc and the Overleaf Workshop contributors.';

function hash(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function installedFile(extensionPath, relativePath) {
    const filename = path.resolve(extensionPath, relativePath);
    assert(filename.startsWith(extensionPath + path.sep), 'Asset must be inside the installed extension');
    assert(fs.statSync(filename).isFile(), `Installed runtime asset missing: ${relativePath}`);
    assert(fs.statSync(filename).size > 0, `Installed runtime asset is empty: ${relativePath}`);
    return filename;
}

function installedAlternative(extensionPath, candidates) {
    const candidate = candidates.find(relativePath => fs.existsSync(path.resolve(extensionPath, relativePath)));
    assert(candidate, `Installed file missing: ${candidates.join(' or ')}`);
    return installedFile(extensionPath, candidate);
}

exports.run = async () => {
    const reportPath = process.env.RELEASE_SMOKE_HOST_REPORT;
    const report = {
        status: 'running',
        vscodeVersion: vscode.version,
        authenticatedProjectWorkflow: 'not-run: this clean profile has no Overleaf credentials; no existing sessions were copied',
        pdfRendering: 'not-run: the custom PDF editor requires an authenticated overleaf-workshop: resource',
        checks: [],
    };
    const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    save();
    try {
        const extensionId = process.env.RELEASE_SMOKE_EXTENSION_ID;
        assert(extensionId, 'Expected extension ID is required');
        const extension = vscode.extensions.getExtension(extensionId);
        assert(extension, `Exact installed extension is available: ${extensionId}`);
        const extensionPath = fs.realpathSync(extension.extensionPath);
        const installedRoot = fs.realpathSync(process.env.RELEASE_SMOKE_EXTENSIONS_DIR);
        assert(extensionPath.startsWith(installedRoot + path.sep), 'Target must run from the clean installed extensions directory');
        const driverPath = fs.realpathSync(__dirname);
        assert.notEqual(extensionPath, driverPath, 'Target must not be the test driver');
        report.extensionId = extension.id;
        report.extensionPath = extensionPath;
        report.checks.push('target extension resolved from isolated VSIX installation, not the source checkout');

        await extension.activate();
        assert(extension.isActive, 'Installed extension activated');
        report.checks.push('installed extension activation completed');

        const manifest = extension.packageJSON;
        assert.equal(`${manifest.publisher}.${manifest.name}`.toLowerCase(), extensionId.toLowerCase());
        assert.equal(manifest.version, process.env.RELEASE_SMOKE_VERSION);
        if (process.env.RELEASE_SMOKE_DISPLAY_NAME) {
            assert.equal(manifest.displayName, process.env.RELEASE_SMOKE_DISPLAY_NAME);
        }
        assert(manifest.displayName && !manifest.displayName.includes('(Local)'), 'Release must have public display branding');
        const nls = JSON.parse(fs.readFileSync(installedFile(extensionPath, 'package.nls.json'), 'utf8'));
        assert.equal(nls['extension.displayName'], process.env.RELEASE_SMOKE_COMMAND_CATEGORY || 'Overleaf-VS Code', 'Command and settings category must match expected short release brand');
        assert(manifest.displayName.includes(nls['extension.displayName']), 'Public display name must contain the short command category brand');
        report.displayName = manifest.displayName;
        report.version = manifest.version;
        report.publisherId = manifest.publisher;
        report.commandCategory = nls['extension.displayName'];
        report.checks.push('installed extension identity, version, display name and short localized command category match release metadata');

        const startupCommands = [
            'overleaf-workshop.projectManager.addServer',
            'overleaf-workshop.projectManager.loginServer',
            'overleaf-workshop.projectManager.openProjectInCurrentWindow',
            'overleaf-workshop.projectManager.openProjectInNewWindow',
            'overleaf-workshop.projectManager.openProjectLocalReplica',
            'overleaf-workshop.compileManager.compile',
            'overleaf-workshop.compileManager.viewPdf',
            'overleaf-workshop.compileManager.syncCode',
            'overleaf-workshop.projectSearch.searchProject',
            'overleaf-workshop.comments.addComment',
            'overleaf-workshop.diagnostics.showOutput',
        ];
        const commands = new Set(await vscode.commands.getCommands(true));
        for (const command of startupCommands) {
            assert(commands.has(command), `Backward-compatible startup command registered: ${command}`);
        }
        report.registeredCommands = startupCommands;
        report.checks.push('primary startup commands retain their existing IDs and are registered');

        const config = vscode.workspace.getConfiguration('overleaf-workshop');
        assert.equal(config.get('compileOnSave.enabled'), true);
        assert.equal(config.get('compileOutputFolderName'), '.output');
        report.checks.push('clean profile sees compile-on-save and output-folder defaults');

        const icon = installedFile(extensionPath, manifest.icon);
        const png = fs.readFileSync(icon);
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Marketplace icon must be a PNG');
        assert(png.readUInt32BE(16) >= 128 && png.readUInt32BE(20) >= 128, 'Icon dimensions meet Marketplace minimum');
        report.icon = {path: manifest.icon, width: png.readUInt32BE(16), height: png.readUInt32BE(20), sha256: hash(icon)};
        report.checks.push('new PNG icon is present and has valid dimensions');

        const readmePath = installedAlternative(extensionPath, ['README.md', 'readme.md']);
        const readme = fs.readFileSync(readmePath, 'utf8').replace(/\r\n/g, '\n');
        const blocks = readme.trim().split(/\n\s*\n/);
        const titleIndex = blocks.findIndex(block => /^#\s+/.test(block));
        assert(titleIndex >= 0, 'README has an extension title');
        assert(blocks[titleIndex + 1] && !blocks[titleIndex + 1].startsWith('#'), 'README starts with an introduction');
        assert.equal(blocks[titleIndex + 2].replace(/^>\s?/, '').trim(), attribution, 'Visible attribution must immediately follow the introduction');
        report.readmeSha256 = hash(readmePath);
        report.checks.push('installed README includes the exact clickable upstream attribution immediately below its introduction');

        const assets = [
            manifest.main,
            'THIRD_PARTY_NOTICES.md',
            'source/README.md',
            'source/manifest.json',
            'views/chat-view/dist/index.html',
            'views/pdf-viewer/vendor/LICENSE',
            'views/pdf-viewer/vendor/web/viewer.html',
            'views/pdf-viewer/vendor/web/viewer.js',
            'views/pdf-viewer/vendor/web/viewer.css',
            'views/pdf-viewer/vendor/build/pdf.js',
            'views/pdf-viewer/vendor/build/pdf.worker.js',
            'views/pdf-viewer/index.js',
            'views/pdf-viewer/index.css',
            'views/pdf-viewer/syncHighlight.js',
            'views/pdf-viewer/documentLoader.js',
            'data/vendor/languages/latex-language-configuration.json',
        ];
        for (const asset of assets) { installedFile(extensionPath, asset); }
        installedAlternative(extensionPath, ['LICENSE', 'LICENSE.txt']);
        const sourceManifest = JSON.parse(fs.readFileSync(installedFile(extensionPath, 'source/manifest.json'), 'utf8'));
        assert.equal(sourceManifest.extensionId.toLowerCase(), extensionId.toLowerCase());
        assert.equal(sourceManifest.version, manifest.version);
        const sourceArchive = installedFile(extensionPath, path.join('source', sourceManifest.archive));
        assert.equal(hash(sourceArchive), sourceManifest.sha256, 'Bundled corresponding-source archive hash must match its manifest');
        report.correspondingSource = {archive: sourceManifest.archive, sha256: sourceManifest.sha256};
        const containers = manifest.contributes.viewsContainers.activitybar;
        assert(containers.length > 0);
        for (const container of containers) { installedFile(extensionPath, container.icon); }
        const customEditors = manifest.contributes.customEditors || [];
        assert(customEditors.some(editor => editor.viewType === 'overleaf-workshop.pdfViewer'), 'PDF custom editor contribution must be present');
        report.runtimeAssets = assets;
        report.checks.push('compiled entrypoint, chat/PDF webview assets, language configuration, license and third-party notices exist in the installed package');
        report.checks.push('version-matched corresponding-source archive is bundled and matches its declared SHA-256');

        // VS Code extension-test hosts use in-memory state. Observe the installed
        // method's actual tree reads without substituting its arguments or result.
        // Only public server metadata is retained; no SecretStorage is accessed.
        const {GlobalStateManager} = require(path.join(extensionPath, 'out/utils/globalStateManager.js'));
        const getServers = GlobalStateManager.getServers;
        let observedContext;
        GlobalStateManager.getServers = function (...args) {
            const result = getServers.apply(this, args);
            observedContext = args[0];
            return result;
        };
        try {
            await vscode.commands.executeCommand('overleaf-workshop.projectManager.focus');
            const deadline = Date.now() + 5000;
            while (!observedContext && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            assert(observedContext, 'Actual project manager tree queried server state');
            const serverMap = observedContext.globalState.get('overleaf-servers', {});
            const server = serverMap['www.overleaf.com'];
            assert(server, 'First-run project manager registers the official default server');
            assert.equal(server.url, 'https://www.overleaf.com/');
            assert(!server.login, 'Clean test profile must not contain authenticated login metadata');
            report.defaultServer = {name: server.name, url: server.url, authenticated: false};
        } finally {
            GlobalStateManager.getServers = getServers;
        }
        report.checks.push('actual project manager view focused in a clean first-run profile');
        report.checks.push('actual tree state contains the default official server and no authenticated login metadata (test-host in-memory state)');
        report.status = 'passed';
        save();
    } catch (error) {
        report.status = 'failed';
        report.error = error instanceof Error ? error.message : String(error);
        save();
        throw error;
    }
};
