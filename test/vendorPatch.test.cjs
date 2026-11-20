const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {applyVendorPatch} = require('../scripts/install-vendor.cjs');

const patch = (name, before, after) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-vendor-patch-'));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    await fs.writeFile(path.join(directory, 'first.js'), 'original\n');
    await fs.writeFile(path.join(directory, 'second.js'), 'second\n');
    return directory;
}

test('vendor patch edits multiple assets using JavaScript without a system patch executable', async t => {
    const directory = await fixture(t);
    await applyVendorPatch(directory, patch('first.js', 'original', 'patched') + patch('second.js', 'second', 'also patched'));
    assert.equal(await fs.readFile(path.join(directory, 'first.js'), 'utf8'), 'patched\n');
    assert.equal(await fs.readFile(path.join(directory, 'second.js'), 'utf8'), 'also patched\n');
});

test('all vendor patch hunks validate before any asset changes', async t => {
    const directory = await fixture(t);
    await assert.rejects(applyVendorPatch(directory,
        patch('first.js', 'original', 'patched') + patch('second.js', 'wrong source', 'also patched')));
    assert.equal(await fs.readFile(path.join(directory, 'first.js'), 'utf8'), 'original\n');
    assert.equal(await fs.readFile(path.join(directory, 'second.js'), 'utf8'), 'second\n');
});

test('vendor patch rejects escaping paths and symlink destinations', async t => {
    const directory = await fixture(t);
    await assert.rejects(applyVendorPatch(directory, patch('../outside.js', 'original', 'patched')), /Unsafe/);
    await fs.symlink(path.join(directory, 'first.js'), path.join(directory, 'link.js'));
    await assert.rejects(applyVendorPatch(directory, patch('link.js', 'original', 'patched')), /Symlink/);
    assert.equal(await fs.readFile(path.join(directory, 'first.js'), 'utf8'), 'original\n');
});
