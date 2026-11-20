const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {downloadDirToExecutablePath} = require('@vscode/test-electron/out/util');

async function bundle(t, executable, plistName = executable) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-editor-layout-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    const contents = path.join(root, 'Visual Studio Code.app', 'Contents');
    const target = path.join(contents, 'MacOS', executable);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, 'synthetic executable fixture');
    await fs.writeFile(path.join(contents, 'Info.plist'), `<plist><dict><key>CFBundleExecutable</key><string>${plistName}</string></dict></plist>`);
    return {root, target};
}

test('official test downloader resolves the current renamed macOS Code executable', async t => {
    const {root, target} = await bundle(t, 'Code');
    assert.equal(downloadDirToExecutablePath(root, 'darwin-arm64'), target);
});

test('official test downloader retains the minimum editor Electron executable layout', async t => {
    const {root, target} = await bundle(t, 'Electron');
    assert.equal(downloadDirToExecutablePath(root, 'darwin-arm64'), target);
});

test('a malformed bundle executable cannot redirect the test launcher outside the app', async t => {
    const {root, target} = await bundle(t, 'Code', '../../../outside');
    await fs.writeFile(path.join(root, 'outside'), 'must not launch');
    assert.equal(downloadDirToExecutablePath(root, 'darwin-arm64'), target);
});
