const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vscode = require('vscode');

// This companion runs in a fresh profile without the audited extension. It
// distinguishes editor/VM startup failures from installed-extension failures.
exports.run = async () => {
    const report = {
        status: 'running',
        mode: 'clean-editor-control',
        vscodeVersion: vscode.version,
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        auditedExtensionInstalled: false,
        checks: [],
    };
    const save = () => fs.writeFileSync(process.env.RELEASE_SMOKE_HOST_REPORT, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    save();
    try {
        assert(process.env.RELEASE_SMOKE_EXTENSION_ID, 'Expected extension ID is required');
        assert.equal(vscode.extensions.getExtension(process.env.RELEASE_SMOKE_EXTENSION_ID), undefined, 'The audited extension must be absent from the clean editor control');
        report.checks.push('audited extension absent from isolated editor');
        const document = await vscode.workspace.openTextDocument({language: 'plaintext', content: 'Clean editor graphics control\n'});
        const editor = await vscode.window.showTextDocument(document);
        assert.equal(editor.document.getText(), 'Clean editor graphics control\n');
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        report.checks.push('clean editor opened and closed a text editor');
        report.status = 'passed';
        save();
    } catch (error) {
        report.status = 'failed';
        report.error = error instanceof Error ? error.message : String(error);
        save();
        throw error;
    }
};
