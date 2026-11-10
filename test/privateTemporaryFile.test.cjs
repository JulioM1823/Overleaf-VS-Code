const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createPrivateTemporaryFile} = require('../out/utils/privateTemporaryFile');

test('external PDF exports are isolated private files and preserve earlier previews', async t => {
    const first = await createPrivateTemporaryFile('output.pdf', Buffer.from('first PDF'));
    t.after(() => fs.rm(path.dirname(first), {recursive: true, force: true}));
    const second = await createPrivateTemporaryFile('output.pdf', Buffer.from('second PDF'));
    t.after(() => fs.rm(path.dirname(second), {recursive: true, force: true}));
    assert.notEqual(path.dirname(first), path.dirname(second));
    assert.equal(path.basename(first), 'output.pdf');
    assert.equal(await fs.readFile(first, 'utf8'), 'first PDF');
    assert.equal(await fs.readFile(second, 'utf8'), 'second PDF');
    assert.equal((await fs.lstat(first)).isSymbolicLink(), false);
    if (process.platform !== 'win32') {
        assert.equal((await fs.stat(first)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(path.dirname(first))).mode & 0o777, 0o700);
    }
});

test('external PDF exports reject paths before creating temporary files', async () => {
    for (const name of ['', '.', '..', '../output.pdf', '/output.pdf', 'a\\output.pdf', 'a\0.pdf']) {
        await assert.rejects(createPrivateTemporaryFile(name, Buffer.from('private')), /Invalid temporary file name/);
    }
});
