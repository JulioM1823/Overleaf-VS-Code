const vscode = require('vscode');
const {failPhase} = require('../../../scripts/self-hosted-phase-report.cjs');
exports.activate = async () => {
    try { await require('../selfHostedAcceptance.cjs').run(); }
    catch {
        failPhase(process.env.OVERLEAF_LIVE_REPORT, process.env.OVERLEAF_CE_PHASE, process.env.OVERLEAF_CE_PHASE_RUN_ID,
            'Acceptance driver failed; the current phase is not a successful result.');
        console.error('Self-hosted acceptance failed; inspect the credential-free phase report.');
    } finally { await vscode.commands.executeCommand('workbench.action.quit'); }
};
