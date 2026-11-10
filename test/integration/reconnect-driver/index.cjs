const vscode = require('vscode');
exports.activate = async () => {
 try { await require('../connectionReliability.cjs').run(); }
 catch { console.error('Connection investigation failed; inspect its private evidence report.'); }
 finally { await vscode.commands.executeCommand('workbench.action.quit'); }
};
