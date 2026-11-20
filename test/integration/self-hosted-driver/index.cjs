const vscode = require('vscode');
const fs = require('node:fs');
exports.activate = async () => {
    try { await require('../selfHostedAcceptance.cjs').run(); }
    catch {
        if (!fs.existsSync(process.env.OVERLEAF_LIVE_REPORT)) {
            fs.writeFileSync(process.env.OVERLEAF_LIVE_REPORT, JSON.stringify({status: 'failed', reason: 'Acceptance driver failed before producing a report.'}), {mode: 0o600});
        }
        console.error('Self-hosted acceptance failed; inspect the credential-free phase report.');
    } finally { await vscode.commands.executeCommand('workbench.action.quit'); }
};
