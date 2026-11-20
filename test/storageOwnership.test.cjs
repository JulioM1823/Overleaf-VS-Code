const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {fork} = require('node:child_process');
const {once} = require('node:events');
const {StorageOwnership} = require('../out/utils/storageOwnership');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-storage-owner-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    return root;
}
function child(t, root) {
    const process = fork(path.join(__dirname, 'support/storageOwnershipChild.cjs'), [root], {stdio: ['ignore', 'ignore', 'inherit', 'ipc']});
    t.after(() => { if (process.exitCode===null) { process.kill(); } });
    return {process, result: once(process, 'message').then(([value]) => value)};
}

test('separate stores in one process cannot own the same recovery state and aliases do not bypass ownership', async t => {
    const root = await fixture(t);
    const first = await StorageOwnership.acquire(root);
    try {
        await assert.rejects(StorageOwnership.acquire(path.join(root, '.')), /another VS Code window/);
        await fs.writeFile(path.join(root, 'draft.json'), 'keep pending work');
        assert.equal(await fs.readFile(path.join(root, 'draft.json'), 'utf8'), 'keep pending work');
    } finally { await first.release(); }
    const next = await StorageOwnership.acquire(root);
    await next.release();
    assert.deepEqual(await fs.readdir(root), ['draft.json']);
});

test('actual child processes exclude a second writer and reclaim ownership after abrupt process death', async t => {
    const root = await fixture(t);
    const first = child(t, root);
    assert.equal((await first.result).status, 'acquired');
    await fs.writeFile(path.join(root, 'pending-draft'), 'unsubmitted content');
    const second = child(t, root);
    const denial = await second.result;
    assert.equal(denial.status, 'blocked');
    assert.match(denial.message, /Pending recovery data has been preserved/);
    const exited = once(first.process, 'exit');
    first.process.kill('SIGKILL');
    await exited;
    const third = child(t, root);
    assert.equal((await third.result).status, 'acquired');
    assert.equal(await fs.readFile(path.join(root, 'pending-draft'), 'utf8'), 'unsubmitted content');
    const released = once(third.process, 'message');
    third.process.send('release');
    assert.equal((await released)[0].status, 'released');
    assert.deepEqual(await fs.readdir(root), ['pending-draft']);
});

test('simultaneous processes elect only one recovery writer across repeated contention bursts', async t => {
    const root = await fixture(t);
    for (let round = 0; round<8; round++) {
        const workers = Array.from({length: 8}, () => child(t, root));
        const results = await Promise.all(workers.map(worker => worker.result));
        const owners = workers.filter((_worker, i) => results[i].status==='acquired');
        assert.equal(owners.length, 1, `round ${round}: exactly one writer`);
        const released = once(owners[0].process, 'message');
        owners[0].process.send('release');
        assert.equal((await released)[0].status, 'released');
    }
    assert.deepEqual(await fs.readdir(root), []);
});

test('foreign-host ownership cannot be reclaimed by guessing whether a remote PID is alive', async t => {
    const root = await fixture(t);
    const filename = '.recovery-owner-000000000000000000000000-999999-deadbeef.json';
    await fs.writeFile(path.join(root, filename), JSON.stringify({choosing: false, ticket: 1}));
    await assert.rejects(StorageOwnership.acquire(root), /another VS Code window/);
    assert.deepEqual(await fs.readdir(root), [filename]);
});
