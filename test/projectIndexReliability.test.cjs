const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const originalLoad=Module._load;
let parseCount=0;
let parseOverride;
const parse=text=>{parseCount++;return parseOverride ? parseOverride(text) : JSON.parse(text).map(([type,label])=>({type,label,children:[]}));};
function uri(project, account='user') {
    return {scheme:'overleaf-workshop',authority:'server',query:`project=${project}&user=${account}`,path:'/Same/main.tex',
        toString(){return `${this.scheme}://${this.authority}${this.path}?${this.query}`;}};
}
Module._load=function(request,parent,main) {
    if(request==='vscode')return {Disposable:class{constructor(fn){this.dispose=fn;}},workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback})},window:{}};
    if(parent?.filename.endsWith('/intellisense/texDocumentSymbolProvider.js')){
        if(request==='.')return {IntellisenseProvider:class{constructor(vfsm){this.vfsm=vfsm;}}};
        if(request==='../core/remoteFileSystemProvider')return {parseUri:u=>({serverName:u.authority,userId:new URLSearchParams(u.query).get('user'),projectId:new URLSearchParams(u.query).get('project'),projectName:'Same',pathParts:['main.tex']})};
        if(request==='./texDocumentParseUtility')return {TeXElementType:{SubFile:1,BibFile:2},
            genTexElements:async text=>parse(text),genTexLabelDefinitions:()=>[]};
    }
    return originalLoad.call(this,request,parent,main);
};
const {ProjectStructRecord,TexDocumentSymbolProvider}=require('../out/intellisense/texDocumentSymbolProvider');
function project(id, files) {
    const reads=[];
    return {reads,origin:{toString:()=>id},getRootDocName:()=> 'main.tex',pathToUri:p=>p,
        openFile:async p=>{reads.push(p);if(reads.length>20)throw new Error('cycle');return Buffer.from(JSON.stringify(files[p]));}};
}
test('cyclic and repeated LaTeX includes are traversed once without losing bibliography paths',async()=>{
    const vfs=project('one',{'main.tex':[[1,'child'],[1,'child'],[2,'main.bib']], 'child.tex':[[1,'main'],[2,'child.bib']]});
    const record=new ProjectStructRecord(vfs);await record.init();
    assert.deepEqual(vfs.reads,['main.tex','child.tex']);
    let lookups=0;const originalGet=record.fileRecordMap.get.bind(record.fileRecordMap);
    record.fileRecordMap.get=p=>{if(++lookups>10)throw new Error('non-terminating bibliography traversal');return originalGet(p);};
    assert.deepEqual(record.getAllBibFilePaths(),['main.bib','child.bib']);
});
test('unchanged editor versions share their parse and older results cannot replace newer indexes',async()=>{
    const vfs=project('cached',{'main.tex':[]});const record=new ProjectStructRecord(vfs);await record.init();
    let content=JSON.stringify([[2,'old.bib']]);const document={uri:uri('cached'),version:1,getText:()=>content};
    const before=parseCount;await Promise.all([record.refreshRecord(document),record.refreshRecord(document)]);
    await record.refreshRecord(document);assert.equal(parseCount-before,1);
    let finish;parseOverride=text=>text.includes('slow')?new Promise(resolve=>{finish=resolve;}):JSON.parse(text).map(([type,label])=>({type,label,children:[]}));
    try {
        document.version=2;content=JSON.stringify([[2,'slow.bib']]);const older=record.refreshRecord(document);
        document.version=3;content=JSON.stringify([[2,'new.bib']]);await record.refreshRecord(document);
        finish([{type:2,label:'slow.bib',children:[]}]);await older;
        assert.deepEqual(record.getAllBibFilePaths(),['new.bib']);
    } finally {parseOverride=undefined;}
});
test('same-name projects and accounts keep independent indexes while concurrent callers share initialization',async()=>{
    const a=project('a',{'main.tex':[[2,'a.bib']]});const b=project('b',{'main.tex':[[2,'b.bib']]});
    const c=project('c',{'main.tex':[[2,'private.bib']]});
    const provider=new TexDocumentSymbolProvider({prefetch:async u=>new URLSearchParams(u.query).get('user')==='other'?c:new URLSearchParams(u.query).get('project')==='a'?a:b});
    const doc=u=>({uri:u,getText:()=>JSON.stringify([[2,'live.bib']])});
    const [first,second,other]=await Promise.all([provider.getProjectContext(doc(uri('a'))),provider.getProjectContext(doc(uri('a'))),provider.getProjectContext(doc(uri('b')))]);
    assert.equal(first.projectRecord,second.projectRecord);assert.notEqual(first.projectRecord,other.projectRecord);
    assert.deepEqual(a.reads,['main.tex']);assert.deepEqual(b.reads,['main.tex']);
    assert.deepEqual(first.projectRecord.getAllBibFilePaths(),['a.bib']);
    const otherAccount=await provider.getProjectContext(doc(uri('a','other')));
    assert.notEqual(otherAccount.projectRecord,first.projectRecord);
    assert.deepEqual(otherAccount.projectRecord.getAllBibFilePaths(),['private.bib']);assert.deepEqual(c.reads,['main.tex']);
});
