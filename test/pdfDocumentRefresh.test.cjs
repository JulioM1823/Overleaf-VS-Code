const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');const originalLoad=Module._load;
let read;const changes=[];
const vscode={Disposable:class{},EventEmitter:class{event(){}fire(value){changes.push(value);}dispose(){this.disposed=true;}},
    workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback}),fs:{readFile:uri=>read(uri)}}};
Module._load=function(request,parent,main){
    if(request==='vscode')return vscode;
    if(parent?.filename.endsWith('/core/pdfViewEditorProvider.js')&&request==='../utils/globalStateManager')return {};
    return originalLoad.call(this,request,parent,main);
};
const {PdfDocument}=require('../out/core/pdfViewEditorProvider');
const uri={scheme:'overleaf-workshop',toString:()=> 'document'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('overlapping refreshes share a read, follow with one latest read and publish only the latest bytes',async()=>{
    changes.length=0;const document=new PdfDocument(uri),gates=[];let reads=0;
    read=()=>{reads++;return new Promise(resolve=>gates.push(resolve));};
    const first=document.refresh();const callers=Array.from({length:100},()=>document.refresh());
    assert.ok(callers.every(promise=>promise===first));assert.equal(reads,1);
    gates.shift()(Buffer.from('%PDF-old'));await tick();assert.equal(reads,2);assert.equal(changes.length,0);
    gates.shift()(Buffer.from('%PDF-new'));await Promise.all([first,...callers]);assert.equal(changes.length,1);
    assert.equal(Buffer.from(document.cache).toString(),'%PDF-new');document.dispose();
});
test('read failures retain the last working preview and disposal prevents late cache or event updates',async()=>{
    changes.length=0;const document=new PdfDocument(uri);
    read=async()=>Buffer.from('%PDF-good');await document.refresh();
    read=async()=>{throw new Error('transient');};await document.refresh();assert.equal(Buffer.from(document.cache).toString(),'%PDF-good');
    let finish;read=()=>new Promise(resolve=>{finish=resolve;});const pending=document.refresh();
    const events=changes.length;document.dispose();finish(Buffer.from('%PDF-late'));await pending;
    assert.equal(document.cache.length,0);assert.equal(changes.length,events);assert.equal(document._onDidChange.disposed,true);
    await document.refresh();assert.equal(changes.length,events);
});

test('empty or HTML artifact reads surface an error and never replace a working PDF',async()=>{
    const document=new PdfDocument(uri);
    read=async()=>Buffer.from('<html>Session expired; private content</html>');
    await document.refresh();assert.equal(document.cache.length,0);assert.match(document.loadError,/not a PDF/);
    assert.ok(!document.loadError.includes('private content'));
    read=async()=>Buffer.from('%PDF-good');await document.refresh();assert.equal(document.loadError,undefined);
    read=async()=>new Uint8Array();await document.refresh();assert.equal(Buffer.from(document.cache).toString(),'%PDF-good');
    assert.match(document.loadError,/empty/);document.dispose();
});
test('HTTP read failures expose the status and clear their diagnostic after a successful refresh',async()=>{
    const document=new PdfDocument(uri);
    read=async()=>{throw new Error('Download failed (HTTP 404)');};await document.refresh();
    assert.match(document.loadError,/HTTP 404/);
    read=async()=>Buffer.from('%PDF-recovered');await document.refresh();assert.equal(document.loadError,undefined);
    document.dispose();
});
