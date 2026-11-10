// Uses a normal development host: test hosts have in-memory mementos.
// Execute only with explicit authorization to transfer saved Overleaf sessions.
const fs = require('node:fs');
const path = require('node:path');
const {runInstalledVscode} = require('./vscode-test-launcher.cjs');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'output/local-identity-migration');
fs.mkdirSync(dir, {recursive: true, mode: 0o700});
const manifest = require('../package.json');
const reportPath = path.join(root, 'output/audit-2026-10/identity-migration.json');
fs.rmSync(reportPath, {force: true});
for (const [label, publisher] of [['source', 'iamhyc'], ['target', manifest.publisher]]) {
 const helper = path.join(dir, label);
 fs.mkdirSync(helper, {recursive: true, mode: 0o700});
 fs.writeFileSync(path.join(helper, 'package.json'), JSON.stringify({name: manifest.name, publisher,
  version: manifest.version, engines: manifest.engines, main: 'index.cjs', activationEvents: label === 'target' ? ['onStartupFinished'] : []}));
 fs.writeFileSync(path.join(helper, 'index.cjs'), label === 'source'
  ? 'exports.activate = context => ({context});\n'
  : `const vscode = require('vscode');
const fs = require('node:fs');
const {transferState} = require(${JSON.stringify(path.join(__dirname, 'migrate-local-identity.cjs'))});
exports.activate = async context => {
 try {
  const source = await vscode.extensions.getExtension('iamhyc.overleaf-workshop').activate();
  fs.mkdirSync(context.globalStorageUri.fsPath, {recursive: true, mode: 0o700});
  fs.chmodSync(context.globalStorageUri.fsPath, 0o700);
  const report = {status: 'passed', ...await transferState(source.context, context, vscode)};
  fs.writeFileSync(${JSON.stringify(path.join(root, 'output/audit-2026-10/identity-migration.json'))}, JSON.stringify(report, null, 2)+'\\n', {mode: 0o600});
  await vscode.commands.executeCommand('workbench.action.quit');
 } catch { console.error('Local identity migration failed; source retained.');
  fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({status: 'failed', sourceRetained: true}), {mode: 0o600});
  await vscode.commands.executeCommand('workbench.action.quit');
 }
};
`);
}
runInstalledVscode({executable: '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
 root: path.join(dir, 'source'),
 args: ['--extensionDevelopmentPath='+path.join(dir, 'target')],
}).then(() => {
 if (JSON.parse(fs.readFileSync(reportPath, 'utf8')).status !== 'passed') { throw new Error('Migration failed'); }
}).catch(() => { console.error('Identity migration failed; source retained.'); process.exitCode = 1; });
