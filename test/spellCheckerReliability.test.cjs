const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const originalLoad=Module._load;
const handlers={};let collection;
class Range {
    constructor(a,b,c,d){this.start=typeof a==='number'?{line:a,character:b}:a;this.end=typeof c==='number'?{line:c,character:d}:b;}
    intersection(other){return this.start.line<=other.end.line&&this.end.line>=other.start.line?this:undefined;}
}
const disposable=()=>({dispose(){}});
const vscode={
    Disposable:class{constructor(fn){this.dispose=fn;}},
    Range,Diagnostic:class{constructor(range,message,severity){Object.assign(this,{range,message,severity});}},
    DiagnosticSeverity:{Information:1},CodeAction:class{constructor(title){this.title=title;}},CodeActionKind:{QuickFix:'quickfix'},
    WorkspaceEdit:class{replace(){}},l10n:{t:x=>x},
    workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback}),textDocuments:[],onDidOpenTextDocument:fn=>(handlers.open=fn,disposable()),
        onDidCloseTextDocument:fn=>(handlers.close=fn,disposable()),
        onDidChangeTextDocument:fn=>(handlers.change=fn,disposable())},
    languages:{registerCodeActionsProvider:disposable,createDiagnosticCollection:()=>{
        collection=new Map();collection.clear=Map.prototype.clear.bind(collection);
        const set=collection.set.bind(collection),get=collection.get.bind(collection),del=collection.delete.bind(collection);
        collection.set=(uri,value)=>set(uri.toString(),value);collection.get=uri=>get(uri.toString());collection.delete=uri=>del(uri.toString());
        collection.dispose=()=>collection.clear();return collection;
    }},commands:{registerCommand:disposable},
};
Module._load=function(request,parent,main){
    if(request==='vscode')return vscode;
    if(parent?.filename.endsWith('/intellisense/langMisspellingCheckProvider.js')){
        if(request==='.')return {IntellisenseProvider:class{constructor(vfsm){this.vfsm=vfsm;}}};
        if(request==='../core/remoteFileSystemProvider')return {parseUri:u=>({serverName:'server',userId:u.user,projectId:u.project})};
        if(request==='../utils/eventBus')return {EventBus:{on:(_event,fn)=>(handlers.language=fn,disposable())}};
    }
    return originalLoad.call(this,request,parent,main);
};
const {MisspellingCheckProvider}=require('../out/intellisense/langMisspellingCheckProvider');
function doc(project,lines=['mispelled'],user='u'){
    return {uri:{scheme:'overleaf-workshop',project,user,toString:()=>project+':'+user},version:1,isClosed:false,
        get lineCount(){return lines.length;},lineAt(line){if(line<0||line>=lines.length)throw new Error('invalid line');return {text:lines[line]};},lines};
}
function fixture(){
    const projects=new Map();const provider=new MisspellingCheckProvider({prefetch:async uri=>{
        assert.equal(uri.scheme,'overleaf-workshop','unrelated documents must never be sent to Overleaf');
        if(!projects.has(uri.toString())){
            const calls=[];const dictionary=[];const vfs={calls,dictionary,language:'en',
                getDictionary:()=>dictionary,getSpellCheckLanguage:()=>({code:vfs.language}),
                spellCheck:async(_uri,words)=>{calls.push(words);return words.map((_word,index)=>({index,suggestions:['suggestion']}));},
                spellLearn:async word=>{dictionary.push(word);return true;}};
            projects.set(uri.toString(),vfs);
        }return projects.get(uri.toString());
    }});
    const triggers=provider.triggers;
    const dispose=()=>triggers.forEach(item=>item.dispose());
    const run=async(document,start=0,end=document.lineCount-1)=>{
        provider.schedule(document,start,end);clearTimeout(provider.scans.get(document.uri.toString()).timer);
        await provider.runScan(document.uri.toString());
    };
    return {provider,projects,dispose,run};
}
test('edits near the end of large documents only scan nearby lines and coalesce typing bursts',async()=>{
    const f=fixture();const document=doc('large',Array.from({length:10000},()=> 'word'));
    let reads=0;const lineAt=document.lineAt;document.lineAt=line=>{reads++;return lineAt.call(document,line);};
    for(let i=0;i<100;i++)handlers.change({document,contentChanges:[{range:new Range(9998,0,9998,1),text:'x'}]});
    assert.equal(f.provider.scans.size,1);const scan=f.provider.scans.get(document.uri.toString());
    assert.equal(scan.start,9997);clearTimeout(scan.timer);await f.provider.runScan(document.uri.toString());
    assert.equal(reads,4);assert.equal(f.projects.get('large:u').calls.length,1);f.dispose();
});
test('failed or malformed checks do not permanently whitelist words and can be retried',async()=>{
    const f=fixture(),document=doc('retry');const {context}=await f.provider.getContext(document.uri);
    for(const response of [undefined,[{index:5,suggestions:[]}],[{index:0,suggestions:[42]}]]){
        context.vfs.spellCheck=async()=>response;
        await f.run(document);assert.equal(context.verdicts.size,0);assert.equal(context.learned.size,0);
    }
    context.vfs.spellCheck=async()=>[{index:0,suggestions:[]}];
    await f.run(document);assert.equal(collection.get(document.uri).length,1);
    const actions=f.provider.provideCodeActions(document,new Range(0,0,0,1),{diagnostics:collection.get(document.uri)});
    assert.equal(actions.length,1);assert.equal(actions[0].command.command,'langIntellisense.learnSpelling');f.dispose();
});
test('correct-word verdicts are bounded without growing the user dictionary',async()=>{
    const f=fixture(),document=doc('bounded');const {context}=await f.provider.getContext(document.uri);const calls=[];
    context.vfs.spellCheck=async(_uri,words)=>{calls.push(words.length);return [];};
    const words=Array.from({length:1500},(_,i)=>'word'+String.fromCharCode(65+i%26)+String.fromCharCode(65+Math.floor(i/26)%26)+String.fromCharCode(65+Math.floor(i/676)));
    await f.provider.check(document.uri,words.join(' '),context);
    assert.equal(context.verdicts.size,1000);assert.equal(context.learned.size,0);assert.equal(Math.max(...calls),250);f.dispose();
});
test('project, account and language changes cannot reuse spelling decisions',async()=>{
    const f=fixture();const a=doc('same'),b=doc('other'),otherUser=doc('same',['mispelled'],'other');
    for(const document of [a,b,otherUser])await f.run(document);
    assert.equal(f.provider.contexts.size,3);
    const vfs=f.projects.get('same:u');vfs.language='de';vfs.spellCheck=async()=>[];
    await f.run(a);assert.equal(f.provider.contexts.size,4);assert.equal(collection.get(a.uri).length,0);
    assert.equal(collection.get(otherUser.uri).length,1);f.dispose();
});
test('overlapping checks share an in-flight request and stale results do not publish diagnostics',async()=>{
    const f=fixture(),document=doc('overlap');const {context}=await f.provider.getContext(document.uri);
    let finish,calls=0;context.vfs.spellCheck=async()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
    const a=f.provider.check(document.uri,'mispelled',context),b=f.provider.check(document.uri,'mispelled',context);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);finish([{index:0,suggestions:[]}]);await Promise.all([a,b]);
    context.verdicts.clear();const scan=f.run(document);
    await new Promise(resolve=>setImmediate(resolve));document.version++;document.lines[0]='correct';
    finish([{index:0,suggestions:[]}]);await scan;
    assert.equal(collection.get(document.uri),undefined);assert.equal(f.provider.scans.size,1);f.dispose();
});
test('reset ignores unrelated local documents and an old request cannot repopulate cleared diagnostics',async()=>{
    const f=fixture(),document=doc('reset');const {context}=await f.provider.getContext(document.uri);
    let finish;context.vfs.spellCheck=()=>new Promise(resolve=>{finish=resolve;});
    const scan=f.run(document);await new Promise(resolve=>setImmediate(resolve));
    vscode.workspace.textDocuments=[{...doc('private'),uri:{scheme:'file',toString:()=>'/private.txt'}}];
    handlers.language();assert.equal(f.provider.scans.size,0);
    finish([{index:0,suggestions:[]}]);await scan;assert.equal(collection.size,0);vscode.workspace.textDocuments=[];f.dispose();
});
test('failed dictionary learning leaves verdicts intact until the server confirms it',async()=>{
    const f=fixture(),document=doc('dictionary');await f.run(document);const vfs=f.projects.get('dictionary:u');
    vfs.spellLearn=async()=>false;await assert.rejects(f.provider.learnSpelling(document.uri,'mispelled'),/not confirmed/);
    assert.equal(collection.get(document.uri).length,1);
    vfs.spellLearn=async()=>true;await f.provider.learnSpelling(document.uri,'mispelled');assert.equal(collection.size,0);f.dispose();
});
test('quick fixes remain available when correct words evict the misspelling from the shared verdict cache',async()=>{
    const f=fixture();const words=Array.from({length:1500},(_,i)=>'word'+String.fromCharCode(65+i%26)+String.fromCharCode(65+Math.floor(i/26)%26)+String.fromCharCode(65+Math.floor(i/676)));
    const document=doc('suggestions',['mispelled '+words.join(' ')]);const {context}=await f.provider.getContext(document.uri);
    context.vfs.spellCheck=async(_uri,batch)=>batch.flatMap((word,index)=>word==='mispelled'?[{index,suggestions:['spelled']}]:[]);
    await f.run(document);assert.equal(context.verdicts.has('mispelled'),false);
    const diagnostics=collection.get(document.uri);assert.equal(diagnostics.length,1);
    const actions=f.provider.provideCodeActions(document,new Range(0,0,0,1),{diagnostics});
    assert.equal(actions[0].title,'spelled');assert.equal(actions.length,2);
    document.isClosed=true;handlers.close(document);assert.equal(f.provider.documentSuggestions.size,0);f.dispose();
});
test('inserting a newline refreshes shifted diagnostic ranges and disabling spelling clears them',async()=>{
    const f=fixture(),document=doc('shifted',['mispelled','other']);
    await f.run(document);document.lines.unshift('new');document.version++;
    handlers.change({document,contentChanges:[{range:new Range(0,0,0,0),text:'new\n'}]});
    const queued=f.provider.scans.get(document.uri.toString());assert.equal(queued.start,0);assert.equal(queued.end,2);
    clearTimeout(queued.timer);await f.provider.runScan(document.uri.toString());
    assert.deepEqual(collection.get(document.uri).map(item=>item.range.start.line),[0,1,2]);
    f.projects.get('shifted:u').language='';await f.run(document);assert.equal(collection.get(document.uri),undefined);f.dispose();
});
