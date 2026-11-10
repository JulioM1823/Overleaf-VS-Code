const fs = require('node:fs'), path = require('node:path');
const {runInstalledVscode} = require('./vscode-test-launcher.cjs');
const root = path.resolve(__dirname, '..');
const mode = process.env.OVERLEAF_COMMENTS_PDF_MODE || 'reproduce';
const reportPath = path.join(root, `output/audit-2026-10/comments-pdf-${mode}.json`);
fs.rmSync(reportPath, {force:true});
runInstalledVscode({executable:'/Applications/Visual Studio Code.app/Contents/MacOS/Code', root,
    args:['--extensionDevelopmentPath='+path.join(root,'test/integration/comments-pdf-driver')],
    env:{...process.env, OVERLEAF_COMMENTS_PDF_REPORT:reportPath},
}).then(() => {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (!['passed','reproduced'].includes(report.status)) { throw new Error('Audit failed'); }
    console.log('Comments/PDF evidence:', reportPath);
}).catch(() => { console.error('Inspect private comments/PDF evidence.'); process.exitCode=1; });
