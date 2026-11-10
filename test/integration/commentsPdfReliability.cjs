const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');
const root = path.resolve(__dirname,'../..');
const {GlobalStateManager} = require(path.join(root,'out/utils/globalStateManager'));
exports.run = async () => {
    if (process.env.OVERLEAF_COMMENTS_PDF_MODE?.startsWith('verify')) {
        return require('./commentsPdfVerification.cjs').run();
    }
    const reportPath = process.env.OVERLEAF_COMMENTS_PDF_REPORT;
    const report = {status:'running', checks:[]};
    const save = () => fs.writeFileSync(reportPath, JSON.stringify(report,null,2), {mode:0o600});
    save();
    let vfs;
    try {
        const projectName=process.env.OVERLEAF_TEST_PROJECT_NAME;
        assert(projectName?.startsWith('Overleaf Workshop Reliability Audit '));
        const extension = vscode.extensions.getExtension(`${require(path.join(root,'package.json')).publisher}.overleaf-workshop`);
        assert.equal(fs.realpathSync(extension.extensionPath), fs.realpathSync(root));
        await extension.activate();
        const uri=vscode.Uri.from({scheme:'overleaf-workshop',authority:process.env.OVERLEAF_TEST_SERVER,
            path:`/${projectName}`,query:new URLSearchParams({user:process.env.OVERLEAF_TEST_USER,project:process.env.OVERLEAF_TEST_PROJECT}).toString()});
        vfs=await vscode.commands.executeCommand('remoteFileSystem.prefetch',uri);
        await vfs.init({autoCompileAfterInitialization:false});
        const identity=await GlobalStateManager.authenticate(vfs.context,vfs.serverName,vfs.userId);
        const file=vfs.pathToUri(`/comments-pdf-audit-${Date.now()}.tex`);
        await vfs.writeFile(file,new Uint8Array(),true,false);
        const doc=await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        const edit=new vscode.WorkspaceEdit();
        edit.insert(file,new vscode.Position(0,0),'\\documentclass{article}\n\\begin{document}\nComments PDF audit baseline.\n'+('% '+ 'wrapped audit text '.repeat(60))+'\n\\end{document}\n');
        assert(await vscode.workspace.applyEdit(edit));
        for (let attempt=0;attempt<200;attempt++) {
            const session=await vfs.ensureTextDocumentSession(file);
            if (session.localText===doc.getText() && session.remoteText===doc.getText()) {break;}
            if (attempt===199) {throw new Error('Document edits did not settle');}
            await new Promise(resolve=>setTimeout(resolve,100));
        }
        const {docId}=await vfs.ensureTextDocumentSession(file);
        report.docId=docId;report.filename=path.posix.basename(file.path);save();
        const threadId=await vfs.createComment(file,new vscode.Range(3,2,3,20),'Disposable deletion audit');
        const threads=await vfs.api.getCommentThreads(identity,vfs.projectId);
        const thread=threads.commentThreads[threadId];assert(thread?.messages.length);
        await vfs.replyToComment(threadId,'Disposable reply');
        report.threadId=threadId;
        report.checks.push({scenario:'local-comment-create',messages:thread.messages.length,passed:true});save();
        await vscode.commands.executeCommand('overleaf-workshop.comments.delete',{
            overleafUri:file,overleafRenderUri:file,overleafThreadId:threadId,
            overleafMessageId:thread.messages[0].id,overleafUserId:vfs.userId,
        });
        const after=await vfs.api.getCommentThreads(identity,vfs.projectId);
        const joined=await vfs.socket.joinDoc(docId);
        report.checks.push({scenario:'local-root-comment-delete',remoteThreadPresent:!!after.commentThreads[threadId],
            remoteMessages:after.commentThreads[threadId]?.messages.length??0,
            remoteAnchorPresent:JSON.stringify(joined.ranges??{}).includes(threadId)});save();
        const original=vfs.api.compile.bind(vfs.api);
        vfs.api.compile=async(...args)=>{const response=await original(...args);
            report.compile={keys:Object.keys(response.compile??{}),fromCache:response.compile?.fromCache,clsiServerId:response.compile?.clsiServerId,compileGroup:response.compile?.compileGroup,rootResourcePath:args[2],type:response.type,status:response.compile?.status,outputs:response.compile?.outputFiles?.map(o=>({path:o.path,
                urlPath:new URL(o.url,`https://${vfs.serverName}`).pathname,queryKeys:[...new URL(o.url,`https://${vfs.serverName}`).searchParams.keys()],origin:new URL(o.url,`https://${vfs.serverName}`).origin,absolute:/^https?:/.test(o.url)}))};save();
            if (process.env.OVERLEAF_COMMENTS_PDF_MODE==='probe') {
                for(const file of response.compile?.outputFiles??[]) {
                    const url=new URL(file.url,vfs.api.url);
                    const c=response.compile;
                    if(c.compileGroup) url.searchParams.set('compileGroup',c.compileGroup);
                    if(c.clsiServerId) url.searchParams.set('clsiserverid',c.clsiServerId);
                    file.url=url.toString();
                }
            }
            return response;};
        report.compiled=await vfs.compile(true,false,false,docId);
        for (let attempt=0;!report.compiled && report.compile?.status==='too-recently-compiled' && attempt<5;attempt++) {
            await new Promise(resolve=>setTimeout(resolve,3000));
            report.compiled=await vfs.compile(true,false,false,docId);
        }
        const current=await vfs.socket.joinDoc(docId);
        report.source={localBytes:doc.getText().length,remoteBytes:current.docLines.join('\n').length,matches:current.docLines.join('\n')===doc.getText()};save();
        if (!report.compiled) {
            try { const log=await vscode.workspace.fs.readFile(vfs.pathToUri('/.output/output.log'));
                report.compilerLog=Buffer.from(log).toString().slice(-4000); }
            catch(error) {report.compilerLogFailure=error.message;}
        }
        const pdfPath=vfs.getPrimaryPdfOutputPath();report.pdfPath=pdfPath;save();
        if (!pdfPath) {report.status="reproduced";save();return;}
        try {
            const bytes=await vscode.workspace.fs.readFile(vfs.pathToUri(pdfPath));
            report.checks.push({scenario:'compiled-pdf-read',bytes:bytes.length,pdf:Buffer.from(bytes).subarray(0,5).toString()==='%PDF-'});
        } catch(error) {report.checks.push({scenario:'compiled-pdf-read',failure:String(error.message).replace(/https?:\S+/g,'[URL]')});}
        report.status='reproduced';save();
    } catch(error) {report.status='failed';report.failure=String(error.message).replace(/https?:\S+/g,'[URL]');save();throw error;}
    finally {await vfs?.flushOfflineProjectStatePersist();}
};
