const test=require('node:test');
const assert=require('node:assert/strict');
const {PdfDocumentLoader}=require('../views/pdf-viewer/documentLoader');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
    const tasks=[],displayed=[];let errors=0,workers=0,peak=0;
    const loader=new PdfDocumentLoader(options=>{
        let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});
        workers++;peak=Math.max(peak,workers);
        const task={options,promise,resolve,reject,destroyed:0,destroy(){this.destroyed++;workers--;reject(new Error('cancelled'));return Promise.resolve();}};
        tasks.push(task);return task;
    },doc=>displayed.push(doc),()=>{errors++;});
    return {loader,tasks,displayed,get errors(){return errors;},get workers(){return workers;},get peak(){return peak;}};
}
test('new updates cancel older loads and an out-of-order document never replaces the newest preview',async()=>{
    const f=fixture();const first=f.loader.update(1);await tick();
    const second=f.loader.update(2);await tick();
    assert.equal(f.tasks[0].destroyed,1);f.tasks[1].resolve('newest');
    assert.equal(await second,true);assert.equal(await first,false);assert.deepEqual(f.displayed,['newest']);
    await f.loader.dispose();assert.equal(f.workers,0);assert.equal(f.errors,0);
});
test('failed replacements retain the previous document, release failed workers and allow retry',async()=>{
    const f=fixture();const first=f.loader.update(1);await tick();f.tasks[0].resolve('working');await first;
    const second=f.loader.update(2);await tick();f.tasks[1].reject(new Error('untrusted PDF content'));
    assert.equal(await second,false);assert.equal(f.errors,1);assert.equal(f.tasks[0].destroyed,0);
    assert.deepEqual(f.displayed,['working']);const third=f.loader.update(3);await tick();f.tasks[2].resolve('replacement');await third;
    assert.equal(f.tasks[0].destroyed,1);assert.deepEqual(f.displayed,['working','replacement']);await f.loader.dispose();
});
test('bursts of refreshes keep at most a displayed document and one loading worker',async()=>{
    const f=fixture();const first=f.loader.update(0);await tick();f.tasks[0].resolve('initial');await first;
    const active=f.loader.update(1);await tick();
    const burst=Array.from({length:100},(_,i)=>f.loader.update(i+2));await tick();
    assert.equal(f.tasks.length,3);assert.equal(f.tasks[2].options,101);assert.equal(f.peak,2);
    f.tasks[2].resolve('final');await Promise.all([active,...burst]);assert.deepEqual(f.displayed,['initial','final']);
    await f.loader.dispose();assert.equal(f.workers,0);assert.ok(f.tasks.every(task=>task.destroyed===1));
});
test('worker destruction completes before creating a replacement and disposal prevents late loads',async()=>{
    const f=fixture();const first=f.loader.update(1);await tick();let cleanup;
    const destroy=f.tasks[0].destroy.bind(f.tasks[0]);f.tasks[0].destroy=()=>{destroy();return new Promise(resolve=>{cleanup=resolve;});};
    const second=f.loader.update(2);await tick();assert.equal(f.tasks.length,1);
    const disposed=f.loader.dispose();cleanup();await Promise.all([first,second,disposed]);
    assert.equal(f.tasks.length,1);assert.equal(await f.loader.update(3),false);assert.deepEqual(f.displayed,[]);
});
