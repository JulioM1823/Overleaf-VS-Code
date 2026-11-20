const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {resolveCliScript} = require('../scripts/run-release-smoke.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-cli-layout-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const put = (relative, text = '') => {
        const filename = path.join(root, relative);
        fs.mkdirSync(path.dirname(filename), {recursive: true});
        fs.writeFileSync(filename, text);
        return filename;
    };
    return {root, put};
}

test('installed-package launcher supports the original Windows CLI layout', t => {
    const {root, put} = fixture(t);
    const cli = put('resources/app/out/cli.js');
    assert.equal(resolveCliScript(path.join(root, 'Code.exe'), 'win32'), cli);
});

test('installed-package launcher reads the official versioned Windows CLI layout without a command shell', t => {
    const {root, put} = fixture(t);
    const cli = put('8a14f0cc1b/resources/app/out/cli.js');
    put('bin/code.cmd', '@echo off\r\nsetlocal\r\nset VSCODE_DEV=\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\Code.exe" "%~dp0..\\8a14f0cc1b\\resources\\app\\out\\cli.js" %*\r\nIF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%\r\nendlocal\r\n');
    assert.equal(resolveCliScript(path.join(root, 'Code.exe'), 'win32'), cli);
});

test('installed-package launcher accepts the matching Insiders launcher', t => {
    const {root, put} = fixture(t);
    const cli = put('version/resources/app/out/cli.js');
    put('bin/code-insiders.cmd', '"%~dp0..\\Code - Insiders.exe" "%~dp0..\\version\\resources\\app\\out\\cli.js" %*');
    assert.equal(resolveCliScript(path.join(root, 'Code - Insiders.exe'), 'win32'), cli);
});

test('installed-package launcher rejects paths escaping the downloaded editor', t => {
    const {root, put} = fixture(t);
    put('bin/code.cmd', '"%~dp0..\\Code.exe" "%~dp0..\\..\\outside\\cli.js" %*');
    assert.throws(() => resolveCliScript(path.join(root, 'Code.exe'), 'win32'), /remain inside/);
});

test('installed-package launcher rejects unresolved variables and missing CLI files', t => {
    const {root, put} = fixture(t);
    put('bin/code.cmd', '"%~dp0..\\Code.exe" "%~dp0..\\%VERSION%\\resources\\app\\out\\cli.js" %*');
    assert.throws(() => resolveCliScript(path.join(root, 'Code.exe'), 'win32'), /relative cli.js/);
    put('bin/code.cmd', '"%~dp0..\\Code.exe" "%~dp0..\\version\\resources\\app\\out\\cli.js" %*');
    assert.throws(() => resolveCliScript(path.join(root, 'Code.exe'), 'win32'), /missing/);
});

test('installed-package launcher preserves macOS and Linux resource resolution', t => {
    const {root, put} = fixture(t);
    const macCli = put('Visual Studio Code.app/Contents/Resources/app/out/cli.js');
    assert.equal(resolveCliScript(path.join(root, 'Visual Studio Code.app/Contents/MacOS/Code'), 'darwin'), macCli);
    const linuxCli = put('resources/app/out/cli.js');
    assert.equal(resolveCliScript(path.join(root, 'code'), 'linux'), linuxCli);
});
