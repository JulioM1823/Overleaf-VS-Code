const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {sendConfirmedOtUpdate, emitWithTimeout} = require('../out/api/socketAcknowledgement');
const update = {doc: 'd', v: 4, op: [{p: 0, i: 'unsaved'}]};
function socket() {
    const s = new EventEmitter();
    s.on('applyOtUpdate', (_doc, _update, cb) => cb());
    return s;
}
test('queue receipt alone cannot mark user work saved', async () => {
    const s = socket();
    await assert.rejects(sendConfirmedOtUpdate(s, 'd', update, 10), /confirmation timeout/);
    for (const event of ['disconnect', 'otUpdateError', 'otUpdateApplied']) assert.equal(s.listenerCount(event), 0);
});
test('only a matching committed revision confirms an update', async () => {
    const s = socket(); let completed = false;
    const pending = sendConfirmedOtUpdate(s, 'd', update, 100).then(() => {completed = true;});
    s.emit('otUpdateApplied', {doc: 'other', v: 4});
    s.emit('otUpdateApplied', {doc: 'd', v: 3});
    s.emit('otUpdateApplied', {...update, op: [{p: 0, i: 'remote'}]});
    await Promise.resolve(); assert.equal(completed, false);
    s.emit('otUpdateApplied', {doc: 'd', v: 4});
    await pending; assert.equal(completed, true);
    assert.equal(s.listenerCount('otUpdateApplied'), 0);
});
test('transformed revisions, disconnects and server update errors require recovery', async () => {
    for (const event of ['revision', 'disconnect', 'otUpdateError']) {
        const s = socket(); const pending = sendConfirmedOtUpdate(s, 'd', update, 100);
        if (event === 'revision') s.emit('otUpdateApplied', {doc: 'd', v: 5});
        else s.emit(event, 'failure', {doc_id: 'd'});
        await assert.rejects(pending);
        assert.equal(s.listenerCount('otUpdateApplied'), 0);
    }
});
test('a synchronous committed acknowledgement is handled before the send callback', async () => {
    const s = new EventEmitter();
    s.on('applyOtUpdate', (_doc, _update, cb) => {s.emit('otUpdateApplied', {doc: 'd', v: 4}); cb();});
    await sendConfirmedOtUpdate(s, 'd', update, 100);
});
test('emit timeout wrappers propagate values, throws and timeouts', async () => {
    const s = new EventEmitter(); s.on('ok', cb => cb(null, 7));
    assert.deepEqual(await emitWithTimeout(s, 'ok', [], 20), [7]);
    await assert.rejects(emitWithTimeout(s, 'no-reply', [], 5), /timeout/);
    await assert.rejects(emitWithTimeout({emit: () => {throw new Error('send failure');}}, 'fail', [], 20), /send failure/);
});
