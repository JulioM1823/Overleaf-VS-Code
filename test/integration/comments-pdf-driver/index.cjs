const vscode = require('vscode');
exports.activate = async () => {
    try { await require('../commentsPdfReliability.cjs').run(); }
    catch { console.error('Comments/PDF audit failed; inspect the private evidence report.'); }
    finally { await vscode.commands.executeCommand('workbench.action.quit'); }
};
