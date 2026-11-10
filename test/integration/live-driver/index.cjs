const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
exports.activate = async () => {
    try { await require('../liveSync.cjs').run(); }
    catch (error) {
        const existing = fs.existsSync(process.env.OVERLEAF_LIVE_REPORT)
            ? JSON.parse(fs.readFileSync(process.env.OVERLEAF_LIVE_REPORT, 'utf8')) : {};
        fs.mkdirSync(path.dirname(process.env.OVERLEAF_LIVE_REPORT), {recursive: true});
        fs.writeFileSync(process.env.OVERLEAF_LIVE_REPORT, JSON.stringify({...existing, status: 'failed',
            stage: process.env.OVERLEAF_TEST_PHASE,
            reason: error instanceof Error ? error.message : 'Live test failure'}, null, 2), {mode: 0o600});
        console.error('Live audit failed; see the local evidence report.');
    }
    finally { await vscode.commands.executeCommand('workbench.action.quit'); }
};
