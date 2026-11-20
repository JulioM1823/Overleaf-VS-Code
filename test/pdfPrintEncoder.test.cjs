const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {PrintEncoder} = require('../views/pdf-viewer/printEncoder');

function fixture(options = {}) {
    const revoked = [], workers = [], bitmaps = [];
    class Worker {
        constructor() { this.requests = []; workers.push(this); }
        postMessage(message, transfer) { this.requests.push({message, transfer}); }
        terminate() { this.terminated = true; }
        complete(blob = {type: 'image/png'}) {
            this.onmessage({data: {id: this.requests.at(-1).message.id, blob}});
        }
    }
    const env = {
        AbortController, Worker, setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout,
        fetch: options.fetch || (async () => ({ok: true, blob: async () => ({})})),
        URL: {createObjectURL: () => 'blob:print-worker', revokeObjectURL: url => revoked.push(url)},
        createImageBitmap: options.snapshot || (async () => {
            const bitmap = {close() { this.closed = true; }};
            bitmaps.push(bitmap); return bitmap;
        }),
    };
    const encoder = new PrintEncoder('https://fixture.invalid/printEncoderWorker.js', env);
    return {encoder, workers, revoked, bitmaps};
}

async function posted(f) {
    const deadline = Date.now() + 500;
    while (!f.workers[0]?.requests.length && Date.now() < deadline) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(f.workers[0].requests.length, 1);
}

test('print encoder transfers one snapshot and returns the worker PNG, then releases its worker', async () => {
    const f = fixture();
    const pending = f.encoder.encode({});
    await posted(f);
    const request = f.workers[0].requests[0];
    assert.deepEqual(request.transfer, [f.bitmaps[0]]);
    const blob = {type: 'image/png', bytes: 'encoded page'};
    f.workers[0].complete(blob);
    assert.equal(await pending, blob);
    assert.equal(f.encoder.pending.size, 0);
    f.encoder.dispose(); f.encoder.dispose();
    assert.equal(f.workers[0].terminated, true);
    assert.deepEqual(f.revoked, ['blob:print-worker']);
});

test('print cancellation rejects pending work and ignores a stale worker reply', async () => {
    const f = fixture();
    const pending = f.encoder.encode({});
    const rejected = assert.rejects(pending, /cancelled/);
    await posted(f);
    f.encoder.dispose();
    await rejected;
    f.workers[0].complete();
    assert.equal(f.encoder.pending.size, 0);
    assert.deepEqual(f.revoked, ['blob:print-worker']);
});

test('a snapshot finishing after cancellation is closed rather than transferred', async () => {
    let finish;
    const bitmap = {close() { this.closed = true; }};
    const f = fixture({snapshot: () => new Promise(resolve => finish = resolve)});
    await f.encoder.ready;
    const pending = f.encoder.encode({});
    const rejected = assert.rejects(pending, /cancelled/);
    await new Promise(resolve => setImmediate(resolve));
    f.encoder.dispose(); finish(bitmap); await rejected;
    assert.equal(bitmap.closed, true);
    assert.equal(f.workers[0].requests.length, 0);
});

test('worker startup failure is handled before the first print page without an unhandled rejection', async () => {
    const f = fixture();
    await f.encoder.ready;
    let prevented = false;
    f.workers[0].onerror({preventDefault() { prevented = true; }});
    await assert.rejects(f.encoder.encode({}), /failed/);
    assert(prevented);
    assert.equal(f.workers[0].terminated, true);
    assert.deepEqual(f.revoked, ['blob:print-worker']);
});

test('worker rejection reports an encoding error and leaves no pending request', async () => {
    const f = fixture();
    const pending = f.encoder.encode({});
    const rejected = assert.rejects(pending, /could not be encoded/);
    await posted(f); f.workers[0].complete(null); await rejected;
    assert.equal(f.encoder.pending.size, 0); f.encoder.dispose();
});

test('a missing worker asset fails safely before a worker or object URL is allocated', async () => {
    const f = fixture({fetch: async () => ({ok: false})});
    await f.encoder.ready;
    await assert.rejects(f.encoder.encode({}), /unavailable/);
    assert.equal(f.workers.length, 0); assert.equal(f.revoked.length, 0);
});

test('a hung print worker is terminated at its bounded encoding deadline', async () => {
    let sequence = 0;
    const timers = new Map();
    const f = fixture({setTimeout: callback => { const id = ++sequence; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id)});
    const pending = f.encoder.encode({});
    const rejected = assert.rejects(pending, /timed out/);
    await posted(f);
    assert.equal(timers.size, 1);
    [...timers.values()][0]();
    await rejected;
    assert.equal(f.workers[0].terminated, true); assert.equal(f.encoder.pending.size, 0);
    assert.deepEqual(f.revoked, ['blob:print-worker']);
});

test('print worker encodes PNG and closes bitmap snapshots on success and failure', async () => {
    const messages = [], encoded = [], bitmaps = [];
    let fail = false;
    const context = {self: {postMessage: message => messages.push(message)}, OffscreenCanvas: class {
        constructor() {}
        getContext() { return {drawImage: bitmap => bitmaps.push(bitmap)}; }
        async convertToBlob(options) { encoded.push(options.type); if (fail) { throw Error('encoding'); } return 'PNG'; }
    }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../views/pdf-viewer/printEncoderWorker.js'), 'utf8'), context);
    const bitmap = () => ({width: 400, height: 400, close() { this.closed = true; }});
    const first = bitmap(); await context.self.onmessage({data: {id: 1, bitmap: first}});
    assert.equal(messages[0].blob, 'PNG'); assert(first.closed);
    fail = true;
    const second = bitmap(); await context.self.onmessage({data: {id: 2, bitmap: second}});
    assert.equal(messages[1].error, true); assert(second.closed);
    assert.deepEqual(encoded, ['image/png', 'image/png']); assert.equal(bitmaps.length, 2);
});
