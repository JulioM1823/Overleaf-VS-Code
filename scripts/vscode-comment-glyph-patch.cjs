const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// This host change is separate from the VSIX. It does not change checksums,
// signatures, security settings, or update settings. A modified official build
// will display its integrity warning. Check is the default, read-only operation.
const originalHash = '631c1d79c4f3af9177ca23a70cfe0cf2586a692678bd897af6c869324160d905';
const patchedHash = '181e65439caeda5b6802ddb800bf098a84111c4f29e2992ad6c2c9812191bac5';
const before = 'collapseOnReplaceEdit:!0,linesDecorationsClassName:e};return tn.createDynamic(t)}setThreadState';
const after = 'collapseOnReplaceEdit:!0,firstLineDecorationClassName:e};return tn.createDynamic(t)}setThreadState';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function replaceGlyphOption(source) {
    assert.equal(source.split(before).length - 1, 1, 'Expected exactly one native comment glyph definition');
    return source.replace(before, after);
}

async function run(operation, appPath, backupPath) {
    assert(['check', 'apply', 'restore'].includes(operation), 'Use check, apply, or restore');
    const app = await fs.realpath(appPath);
    const bundle = path.join(app, 'Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js');
    const info = JSON.parse(await fs.readFile(path.join(app, 'Contents/Resources/app/package.json'), 'utf8'));
    assert.equal(info.version, '1.141.0', 'This verified patch is restricted to VS Code 1.141.0');
    const stat = await fs.lstat(bundle);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Expected a regular bundled workbench file');
    const current = await fs.readFile(bundle);
    const currentHash = sha256(current);
    assert([originalHash, patchedHash].includes(currentHash), 'Unrecognized build; no files changed');
    if (operation === 'check') {
        return {operation, app, status: currentHash === originalHash ? 'verified-original' : 'verified-patched',
            sha256: currentHash, changed: false};
    }
    assert(backupPath && path.isAbsolute(backupPath), 'Supply an absolute backup path outside the app');
    const parent = await fs.realpath(path.dirname(backupPath));
    const backup = path.join(parent, path.basename(backupPath));
    assert(!backup.startsWith(app + path.sep), 'Keep the backup outside the application bundle');
    let replacement;
    if (operation === 'apply') {
        assert.equal(currentHash, originalHash, 'Patch already applied; no files changed');
        replacement = Buffer.from(replaceGlyphOption(current.toString('utf8')));
        assert.equal(sha256(replacement), patchedHash);
        const handle = await fs.open(backup, 'wx', 0o600);
        try { await handle.writeFile(current); await handle.sync(); }
        finally { await handle.close(); }
    } else {
        assert.equal(currentHash, patchedHash, 'App already original; no files changed');
        const backupStat = await fs.lstat(backup);
        assert(backupStat.isFile() && !backupStat.isSymbolicLink(), 'Expected a regular backup file');
        replacement = await fs.readFile(backup);
        assert.equal(sha256(replacement), originalHash, 'Backup hash mismatch; no files changed');
    }
    const temporary = `${bundle}.glyph-audit-${crypto.randomBytes(8).toString('hex')}`;
    let temporaryCreated = false;
    try {
        const handle = await fs.open(temporary, 'wx', stat.mode & 0o777);
        temporaryCreated = true;
        try { await handle.writeFile(replacement); await handle.sync(); }
        finally { await handle.close(); }
        // Refuse to replace an app updated or changed after the initial check.
        assert.equal(sha256(await fs.readFile(bundle)), currentHash, 'App changed during patch preparation');
        await fs.rename(temporary, bundle);
    } finally { if (temporaryCreated) { await fs.rm(temporary, {force: true}); } }
    assert.equal(sha256(await fs.readFile(bundle)), sha256(replacement));
    return {operation, app, changed: true, sha256: sha256(replacement), backup,
        integrityChecksChanged: false, signingChanged: false};
}

module.exports = {replaceGlyphOption, run};
if (require.main === module) {
    run(process.argv[2] || 'check', process.argv[3] || '/Applications/Visual Studio Code.app', process.argv[4])
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
}
