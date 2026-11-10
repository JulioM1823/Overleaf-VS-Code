const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
const originalLoad=Module._load;let onSave;
const disposable=()=>({dispose(){}});
Module._load=function(request,parent,main){
    if(request==='vscode')return {Disposable:class{constructor(fn){this.dispose=fn;}},
        workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback}),onDidSaveTextDocument:fn=>(onSave=fn,disposable())},
        languages:{registerCompletionItemProvider:disposable}};
    if(parent?.filename.endsWith('/intellisense/langCompletionProvider.js')){
        if(request==='.')return {IntellisenseProvider:class{constructor(vfsm){this.vfsm=vfsm;}}};
        if(request==='../core/remoteFileSystemProvider')return {parseUri:u=>({serverName:u.server,userId:u.user,projectId:u.project,
            identifier:'same-user/same-id/Same',pathParts:['main.tex']})};
        if(request==='./texDocumentSymbolProvider')return {};
    }
    return originalLoad.call(this,request,parent,main);
};
const {CommandCompletionProvider}=require('../out/intellisense/langCompletionProvider');
function uri(server='server',user='user'){return {scheme:'overleaf-workshop',path:'/Same/main.tex',server,user,project:'same-id'};}
function fixture(){
    const vfs={};const provider=new CommandCompletionProvider({prefetch:async()=>vfs},{});
    provider.loadJson=async()=>[];provider.loadMetadata=async()=>({});provider.reloadCommands=async()=>new Map();
    return {provider,vfs};
}
test('concurrent completion loads wait for all constant snippets and share project initialization',async()=>{
    const {provider}=fixture();let constants,metadata=0,commands=0;
    provider.loadJson=()=>new Promise(resolve=>{constants=resolve;});
    provider.loadMetadata=async()=>{metadata++;return {};};provider.reloadCommands=async()=>{commands++;return new Map();};
    const first=provider.load(uri()),second=provider.load(uri());let done=false;first.then(()=>{done=true;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);
    constants([{caption:'constant',snippet:'text',meta:'cmd',score:1}]);
    const [a,b]=await Promise.all([first,second]);assert.equal(a.custom,b.custom);assert.ok(a.constants.constant);
    assert.equal(metadata,1);assert.equal(commands,1);
});
test('identical project identifiers on different servers or accounts keep independent completion caches',async()=>{
    const {provider}=fixture();let loads=0;
    provider.loadMetadata=async target=>{loads++;return {server:target.server,user:target.user};};
    const a=await provider.load(uri()),b=await provider.load(uri('other-server')),c=await provider.load(uri('server','other-user'));
    assert.notEqual(a.custom,b.custom);assert.notEqual(a.custom,c.custom);assert.equal(loads,3);
    assert.equal(b.custom.metadata.server,'other-server');assert.equal(c.custom.metadata.user,'other-user');
});
test('saving a changed command replaces its original file entry and avoids rereading the file over the network',async()=>{
    const {provider}=fixture();provider.reloadCommands=async()=>new Map([['main.tex',{old:{caption:'old'}}]]);
    const loaded=await provider.load(uri());const triggers=provider.triggers;
    await onSave({uri:uri(),getText:()=> '\\newcommand{\\newcmd}[1]{}'});
    assert.equal(loaded.custom.commands.size,1);assert.equal(loaded.custom.commands.get('main.tex').old,undefined);
    assert.ok(Object.values(loaded.custom.commands.get('main.tex')).some(command=>command.caption==='newcmd'));
    triggers.forEach(item=>item.dispose());
});
test('failed initialization is evicted so the next completion can recover',async()=>{
    const {provider}=fixture();provider.loadMetadata=async()=>{throw new Error('failed metadata');};
    await assert.rejects(provider.load(uri()),/failed/);assert.equal(provider.customData.size,0);
    provider.loadMetadata=async()=>({fixed:{caption:'fixed'}});const recovered=await provider.load(uri());assert.ok(recovered.custom.metadata.fixed);
});
test('empty completion data is a valid fuzzy-filter result rather than an exception',()=>{
    const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');const exports={};
    const context={exports,require:request=>{
        if(request==='../consts')return {ROOT_NAME:'overleaf-workshop'};
        if(request==='./langIntellisenseProvider')return {};
        if(request==='vscode')return {};
        throw new Error('Empty lists do not need a search dependency: '+request);
    }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../out/intellisense/index.js'),'utf8'),context);
    assert.equal(exports.fuzzyFilter([], 'query').length,0);
});
