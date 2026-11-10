const path=require('node:path'),fs=require('node:fs');
const {runInstalledVscode}=require('./vscode-test-launcher.cjs');
const root=path.resolve(__dirname,'..');
const mode=process.env.OVERLEAF_CONNECTION_MODE||'observe';
const reportPath=path.join(root,`output/audit-2026-10/connection-${mode}.json`);
if(!process.env.OVERLEAF_TEST_PROJECT||!process.env.OVERLEAF_TEST_USER){throw new Error('Disposable audit project required');}
fs.rmSync(reportPath,{force:true});
runInstalledVscode({executable:'/Applications/Visual Studio Code.app/Contents/MacOS/Code',root,
 args:['--extensionDevelopmentPath='+path.join(root,'test/integration/reconnect-driver')],
 env:{...process.env,OVERLEAF_CONNECTION_REPORT:reportPath,OVERLEAF_CONNECTION_MODE:mode},
}).then(()=>{const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));if(!['passed','reproduced'].includes(report.status)){throw new Error('Connection investigation failed');}
 console.log('Verified connection evidence:',reportPath);
}).catch(()=>{console.error('Inspect local connection evidence.');process.exitCode=1;});
