const test = require('node:test');
const assert = require('node:assert/strict');
const {LatestTaskQueue} = require('../out/utils/latestTaskQueue');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('a burst of complete snapshots keeps one active and only the newest pending payload', async () => {
    const written = []; const gates = [];
    const queue = new LatestTaskQueue(value => {written.push(value); return new Promise(resolve => gates.push(resolve));});
    const first = queue.enqueue(0); await tick();
    const callers = Array.from({length:10000}, (_, i) => queue.enqueue(i+1));
    assert.equal(new Set(callers).size, 1);
    let covered = false; callers[0].then(() => {covered=true;});
    gates.shift()(); await first; await tick();
    assert.deepEqual(written, [0,10000]); assert.equal(covered,false);
    let idle = false; const drain = queue.idle().then(() => {idle=true;}); await tick();
    assert.equal(idle,false); gates.shift()(); await Promise.all(callers); await drain;
    assert.equal(covered,true); assert.equal(idle,true);
});
test('failed writes remain observable and do not prevent newer snapshots from being saved', async () => {
    let fail; const written=[];
    const queue = new LatestTaskQueue(async value => {written.push(value); if(value===1)await new Promise((_resolve,reject)=>{fail=reject;});});
    const first=queue.enqueue(1); const rejected=assert.rejects(first, /disk failed/);
    const second=queue.enqueue(2); await tick(); fail(new Error('disk failed'));
    await rejected; await second; await queue.idle(); assert.deepEqual(written,[1,2]);
});
test('undefined rejection reasons are propagated as failures', async () => {
    const queue=new LatestTaskQueue(async()=>{throw undefined;});
    let rejected=false; await queue.enqueue(1).then(()=>assert.fail('write succeeded'),()=>{rejected=true;});
    await queue.idle(); assert.equal(rejected,true);
});
