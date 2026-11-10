const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
test('PDF viewer disables scripting before initialization and disables eval for every document',async()=>{
    const options=new Map();const listeners=new Map();const errors=[];let loadOptions;
    const banner={setAttribute(){},textContent:'',hidden:true};
    const context={
        OverleafPdfDocumentLoader:require('../views/pdf-viewer/documentLoader').PdfDocumentLoader,
        acquireVsCodeApi:()=>({postMessage(){}}),
        PDFViewerApplicationOptions:{set:(key,value)=>options.set(key,value)},
        PDFViewerApplication:{initializedPromise:Promise.resolve(),eventBus:{_off(){assert.fail('Viewer print handler must remain registered');},on(){},_on(){}},_boundEvents:{},load(){},_documentError:message=>errors.push(message)},
        pdfjsLib:{getDocument:arg=>{loadOptions=arg;return {promise:Promise.resolve({}),destroy:async()=>{}};}},
        window:{addEventListener:(name,callback)=>listeners.set(name,callback)},
        document:{getElementById:id=>id==='overleaf-pdf-error'?banner:null},clearTimeout,Uint8Array,ArrayBuffer,
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../views/pdf-viewer/index.js'),'utf8'),context);
    assert.equal(options.get('enableScripting'),false);assert.equal(options.get('isEvalSupported'),false);
    assert.equal(options.get('disablePreferences'),true);
    assert.equal(options.get('defaultUrl'),'');
    await listeners.get('load')();
    await listeners.get('message')({data:{type:'update',content:new Uint8Array([1,2,3])}});
    assert.equal(loadOptions.isEvalSupported,false);
    context.pdfjsLib.getDocument=()=>({promise:Promise.reject(new Error('private manuscript or embedded secret')),destroy:async()=>{}});
    await listeners.get('message')({data:{type:'update',content:new Uint8Array([1,2,3])}});
    assert.equal(errors.length,0);assert.equal(banner.textContent,'Unable to render the PDF. Check the compilation diagnostics and compile again.');
    assert.equal(banner.hidden,false);
    await listeners.get('message')({data:{type:'loadError',content:'HTTP 404: compile again.'}});
    assert.equal(banner.textContent,'HTTP 404: compile again.');
    await listeners.get('message')({data:{type:'loadError',content:'x'.repeat(513)}});
    assert.equal(banner.textContent,'HTTP 404: compile again.');
});
