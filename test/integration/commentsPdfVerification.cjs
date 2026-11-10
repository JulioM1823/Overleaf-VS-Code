// Live verification using the existing SecretStorage session. Only the named
// disposable audit project and newly created documents may be mutated.
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const vscode=require('vscode');
const root=path.resolve(__dirname,'../..');
const {GlobalStateManager}=require(path.join(root,'out/utils/globalStateManager'));
const {PdfViewEditorProvider}=require(path.join(root,'out/core/pdfViewEditorProvider'));
exports.run=async()=>{
    const reportPath=process.env.OVERLEAF_COMMENTS_PDF_REPORT;
    const actionPath=path.join(path.dirname(reportPath),'comments-pdf-action.json');
    fs.rmSync(actionPath,{force:true});
    const report={status:'running',checks:[],started:Date.now()};
    const save=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});
    const phase=value=>{report.phase=value;save();};
    const check=(scenario,fields={})=>{report.checks.push({scenario,passed:true,...fields});save();};
    const wait=async(predicate,label,ms=90000)=>{
        const until=Date.now()+ms;
        while(Date.now()<until){const value=await predicate();if(value)return value;await new Promise(r=>setTimeout(r,200));}
        throw new Error('Timed out: '+label);
    };
    const continueAfterUi=()=>wait(()=>{
        if(!fs.existsSync(actionPath))return false;
        const action=JSON.parse(fs.readFileSync(actionPath,'utf8'));
        if(action.phase!==report.phase)return false;
        fs.rmSync(actionPath);return action;
    },'browser confirmation',300000);
    let vfs,originalRoot,panel,pdfDocument,collaborator;
    try {
        const projectName=process.env.OVERLEAF_TEST_PROJECT_NAME;
        assert(projectName?.startsWith('Overleaf Workshop Reliability Audit '));
        const extension=vscode.extensions.getExtension(`${require(path.join(root,'package.json')).publisher}.overleaf-workshop`);
        assert.equal(fs.realpathSync(extension.extensionPath),fs.realpathSync(root));await extension.activate();
        const project=vscode.Uri.from({scheme:'overleaf-workshop',authority:process.env.OVERLEAF_TEST_SERVER,path:`/${projectName}`,
            query:new URLSearchParams({user:process.env.OVERLEAF_TEST_USER,project:process.env.OVERLEAF_TEST_PROJECT}).toString()});
        vfs=await vscode.commands.executeCommand('remoteFileSystem.prefetch',project);await vfs.init({autoCompileAfterInitialization:false});
        const identity=await GlobalStateManager.authenticate(vfs.context,vfs.serverName,vfs.userId);
        const resumeFile=process.env.OVERLEAF_COMMENTS_PDF_RESUME_FILE;
        if(resumeFile) assert(/^comments-pdf-verify-\d+\.tex$/.test(resumeFile));
        const file=vfs.pathToUri(`/${resumeFile || `comments-pdf-verify-${Date.now()}.tex`}`);
        if(!resumeFile) await vfs.writeFile(file,new Uint8Array(),true,false);
        const source=await vscode.workspace.openTextDocument(file);await vscode.window.showTextDocument(source,vscode.ViewColumn.One);
        const edit=new vscode.WorkspaceEdit();edit.insert(file,new vscode.Position(0,0),
            '\\documentclass{article}\n\\begin{document}\nComments PDF audit baseline.\n% '+ 'wrapped audit text '.repeat(60)+'\n\\end{document}\n');
        if(!resumeFile) assert(await vscode.workspace.applyEdit(edit));
        report.resumedBrowserFixture=Boolean(resumeFile);
        await wait(async()=> (await vfs.ensureTextDocumentSession(file)).remoteText===source.getText(),'source reaches server');
        const {docId}=await vfs.ensureTextDocumentSession(file);report.docId=docId;report.filename=path.posix.basename(file.path);save();
        originalRoot=vfs.root.rootDoc_id;vfs.root.rootDoc_id=docId;
        const inline=globalThis.__overleafInlineCommentProvider.provider;
        const handles=()=>Array.from(inline.threadsByUri.values()).flatMap(threads=>Array.from(threads.values()))
            .filter(thread=>thread.uri.path===source.uri.path && thread.uri.authority===source.uri.authority);
        const body=comment=>typeof comment.body==='string'?comment.body:comment.body?.value;
        const find=content=>handles().filter(t=>t.comments.some(c=>body(c)===content));
        const remoteThreads=async()=>{
            const response=await vfs.api.getCommentThreads(identity,vfs.projectId);assert.equal(response.type,'success');return response.commentThreads;
        };
        const absent=async id=>{
            const threads=await remoteThreads(),joined=await vfs.socket.joinDoc(docId);
            return !threads[id] && !JSON.stringify(joined.ranges?.comments??[]).includes(id);
        };
        const commandComment=(t,id)=>({overleafUri:file,overleafRenderUri:source.uri,overleafThreadId:t,overleafMessageId:id,overleafUserId:vfs.userId});
        if(!resumeFile){
        const threadId=await vfs.createComment(file,new vscode.Range(2,0,2,8),'VS Code creation audit');
        await wait(()=>find('VS Code creation audit').length===1,'one native thread');
        assert.equal((await remoteThreads())[threadId].messages.length,1);check('VS Code create appears once remotely and locally');
        await vfs.editComment(threadId,(await remoteThreads())[threadId].messages[0].id,'VS Code edited audit');
        await wait(async()=> (await remoteThreads())[threadId].messages[0].content==='VS Code edited audit','local edit reaches server');
        check('VS Code edit propagates');
        await vfs.replyToComment(threadId,'Reply to retain');await vfs.replyToComment(threadId,'Reply to delete');
        await wait(()=>find('Reply to delete').length===1,'reply rendered');
        let current=(await remoteThreads())[threadId];
        await vscode.commands.executeCommand('overleaf-workshop.comments.delete',commandComment(threadId,current.messages.find(m=>m.content==='Reply to delete').id));
        current=(await remoteThreads())[threadId];assert.equal(current.messages.length,2);check('reply deletion retains root, other reply and anchor');
        await vscode.commands.executeCommand('overleaf-workshop.comments.delete',commandComment(threadId,current.messages[0].id));
        await wait(()=>absent(threadId),'root thread and anchor removed');check('VS Code root deletion removes replies and remote anchor');
        }
        if(resumeFile){phase('native_hydration');await wait(()=>handles().length>0,'existing native comments');}
        const existingWrap=find('Wrapped line audit')[0];
        const wrapId=existingWrap?.overleafThreadId ?? await vfs.createComment(file,new vscode.Range(3,2,3,1100),'Wrapped line audit');
        const wrap=await wait(()=>find('Wrapped line audit')[0],'wrapped thread rendered');
        wrap.collapsibleState=vscode.CommentThreadCollapsibleState.Collapsed;
        report.wrap={threadId:wrapId,nativeHandles:find('Wrapped line audit').length,range:{start:wrap.range.start,end:wrap.range.end},
            logicalLineLength:source.lineAt(3).text.length,wordWrap:vscode.workspace.getConfiguration('editor',file).get('wordWrap')};save();
        if (process.env.OVERLEAF_COMMENTS_PDF_MODE!=='verify-pdf') {
        phase('browser_create_ready');
        // Browser UI creates and edits a comment in this exact document.
        await wait(()=>find('Browser comment audit').length===1 || (resumeFile && find('Browser comment audit edited').length===1),'browser creation',300000);check('Overleaf create appears once in VS Code',{resumed:Boolean(resumeFile)});
        phase('browser_edit_ready');
        await wait(()=>find('Browser comment audit edited').length===1,'browser edit',300000);check('Overleaf edit propagates to VS Code');
        const browserThread=find('Browser comment audit edited')[0],browserId=browserThread.overleafThreadId;
        const browserMessage=(await remoteThreads())[browserId].messages[0];
        await vfs.editComment(browserId,browserMessage.id,'VS Code browser-visible edit');phase('verify_browser_local_edit');
        await continueAfterUi();check('VS Code edit displayed in Overleaf browser');
        await vscode.commands.executeCommand('overleaf-workshop.comments.delete',commandComment(browserId,browserMessage.id));
        await wait(()=>absent(browserId),'browser thread removed by VS Code');phase('verify_browser_local_delete');
        await continueAfterUi();check('VS Code deletion disappears from Overleaf browser');
        phase('browser_second_create_ready');
        const secondThread=await wait(()=>find('Browser deletion audit').length===1 ? find('Browser deletion audit')[0] : false,'second browser creation',300000);
        check('new Overleaf browser comment appears exactly once in VS Code');
        phase('browser_delete_ready');
        await wait(()=>!handles().some(t=>t.overleafThreadId===secondThread.overleafThreadId),'browser deletion in VS Code',300000);
        await wait(()=>absent(secondThread.overleafThreadId),'browser deletion anchor removed');check('Overleaf deletion removes native VS Code thread and anchor');
        phase('verify_wrap_glyph');
        const glyphResult=await continueAfterUi();
        report.wrap.observedGlyphs=glyphResult.glyphs;
        report.wrap.visualRows=glyphResult.visualRows;
        report.wrap.status=glyphResult.glyphs===1 ? 'passed' : 'unresolved_host_defect';save();
        }
        if(process.env.OVERLEAF_COMMENTS_PDF_MODE==='verify-browser'){
            report.status='passed';phase('complete');return;
        }
        const compile=async()=>{
            let outcome=await vfs.compile(true,false,false,docId);
            // Only the test driver waits through an explicit server throttle.
            for(let i=0;!outcome && i<5;i++){await new Promise(r=>setTimeout(r,3000));outcome=await vfs.compile(true,false,false,docId);}
            assert.equal(outcome,true,'Compile must succeed');
        };
        await compile();
        const pdfUri=vfs.pathToUri(vfs.getPrimaryPdfOutputPath());
        const provider=new PdfViewEditorProvider(vfs.context);
        pdfDocument=await provider.openCustomDocument(pdfUri);assert(!pdfDocument.loadError);assert(pdfDocument.cache.length>0);
        panel=vscode.window.createWebviewPanel('overleaf-pdf-live-audit','Live compiled PDF audit',vscode.ViewColumn.Two,{enableScripts:true,retainContextWhenHidden:true});
        const ready=new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{listener.dispose();reject(new Error('PDF webview ready timeout'));},30000);
            const listener=panel.webview.onDidReceiveMessage(message=>{
                if(message.type==='ready'){clearTimeout(timer);listener.dispose();resolve();}
            });
        });
        const originalHtml=provider.getHtmlForWebview.bind(provider);
        provider.getHtmlForWebview=async webview=>{
            const html=await originalHtml(webview),probe=webview.asWebviewUri(vscode.Uri.file(path.join(__dirname,'webviewProbe.js')));
            return html.replace(/(<script src="[^"]*\/index\.js"><\/script>)/,`<script src="${probe}"></script>$1`);
        };
        await provider.resolveCustomEditor(pdfDocument,panel);
        panel.webview.options={...panel.webview.options,localResourceRoots:[...panel.webview.options.localResourceRoots,vscode.Uri.file(__dirname)]};
        await ready;
        let probeId=0;
        const inspect=(expected,page=1,action)=>new Promise((resolve,reject)=>{
            const id=++probeId,timer=setTimeout(()=>{listener.dispose();reject(new Error('Viewer probe timeout'));},15000);
            const listener=panel.webview.onDidReceiveMessage(message=>{
                if(message.type==='soakResult'&&message.id===id){clearTimeout(timer);listener.dispose();resolve(message);}
            });
            panel.webview.postMessage({type:'soakCommand',id,expected,page,action}).catch(reject);
        });
        const rendered=async(expected,pages,page=1)=>wait(async()=>{
            const result=await inspect(expected,page);
            return result.matches && result.canvas && result.renderedCurrent && result.pages===pages ? result : false;
        },'PDF renders expected page and content',180000);
        phase('pdf_initial_render');const initial=await rendered('Comments PDF audit baseline.',1);
        check('source compile download viewer rendering', {pages:initial.pages,bytes:pdfDocument.cache.length,scripting:initial.scripting,eval:initial.eval});
        const refreshEdit=new vscode.WorkspaceEdit();refreshEdit.insert(file,new vscode.Position(4,0),'\\newpage\nPDF refresh audit second page.\n');
        assert(await vscode.workspace.applyEdit(refreshEdit));
        await wait(async()=> (await vfs.ensureTextDocumentSession(file)).remoteText===source.getText(),'second source reaches server');
        assert(await source.save());
        // The real save-triggered CompileManager owns compilation and refresh.
        phase('pdf_save_refresh');
        await wait(async()=> (await inspect(undefined)).pages===2,'save compilation publishes two pages',180000);
        await inspect(undefined,2,'page');
        const refreshed=await rendered('PDF refresh audit second page.',2,2);
        check('save triggers compile and already-open viewer refreshes',{pages:refreshed.pages,bytes:pdfDocument.cache.length});
        const runtime=await GlobalStateManager.initSocketIOAPI(vfs.context,vfs.serverName,vfs.projectId,vfs.userId);collaborator=runtime.socket;
        collaborator.socketConnectionTarget={...vfs.socket.socketConnectionTarget};await collaborator.prepareForJoin();await collaborator.joinProject(vfs.projectId);
        let joined=await collaborator.joinDoc(docId);assert.equal(joined.docLines.join('\n'),source.getText());
        await collaborator.applyOtUpdate(docId,{doc:docId,v:joined.version,op:[{p:0,i:'% browser-side collaboration regression\n'}]});
        await wait(()=>source.getText().startsWith('% browser-side collaboration regression\n'),'remote text update');
        const localEdit=new vscode.WorkspaceEdit();localEdit.insert(file,source.positionAt(source.getText().length),'% VS Code collaboration regression\n');assert(await vscode.workspace.applyEdit(localEdit));
        await wait(async()=> (await collaborator.joinDoc(docId)).docLines.join('\n')===source.getText(),'local text update');
        check('bidirectional text synchronization after comment and PDF operations');
        report.status='passed';phase('complete');
    } catch(error){report.status='failed';report.failure=String(error.message).replace(/https?:\S+/g,'[URL]');
        const inline=globalThis.__overleafInlineCommentProvider?.provider;
        report.nativeGroups=inline ? Array.from(inline.threadsByUri.entries()).map(([uri,threads])=>({uri,count:threads.size})):[];
        save();throw error;}
    finally {
        collaborator?.disconnect();panel?.dispose();pdfDocument?.dispose();
        if(vfs&&originalRoot){vfs.root.rootDoc_id=originalRoot;vfs.scheduleOfflineProjectStatePersist('audit_restore_root');}
        await vfs?.flushOfflineProjectStatePersist();
    }
};
