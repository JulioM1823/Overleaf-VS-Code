// One-time local migration, executed in an isolated VS Code development host.
// Credentials move only between SecretStorage instances, never into files/logs.
const assert = require('node:assert/strict');
exports.transferState = async (source, target, vscode) => {
    assert.equal(source.extension.id, 'iamhyc.overleaf-workshop');
    assert.equal(target.extension.id, 'morales-local-01a0f106.overleaf-workshop');
    assert.equal(target.globalState.keys().length, 0, 'Target already has state; refusing to overwrite');
    const snapshot = new Map(source.globalState.keys().map(key => [key, source.globalState.get(key)]));
    const secretKeys = new Set();
    for (const [name, server] of Object.entries(snapshot.get('overleaf-servers') || {})) {
        if (server.login) {
            const key = server.login.identitySecretKey || `overleaf-workshop.serverIdentity.${encodeURIComponent(name)}`;
            assert(key.startsWith('overleaf-workshop.serverIdentity.'), 'Unexpected credential key');
            secretKeys.add(key);
        }
    }
    let secrets = 0;
    for (const key of secretKeys) {
        const value = await source.secrets.get(key);
        if (value === undefined) { continue; }
        assert.equal(await target.secrets.get(key), undefined, 'Target already has credentials');
        await target.secrets.store(key, value);
        assert.equal(await target.secrets.get(key) === value, true, 'Credential verification failed');
        secrets++;
    }
    let files = 0;
    const copied = [];
    async function copyDirectory(from, to) {
        let entries;
        try { entries = await vscode.workspace.fs.readDirectory(from); }
        catch (error) { if (error.code === 'FileNotFound') { return; } throw error; }
        await vscode.workspace.fs.createDirectory(to);
        for (const [name, type] of entries) {
            assert(!name.includes('/') && !name.includes('\\') && name !== '..');
            assert(!(type & vscode.FileType.SymbolicLink), 'Storage symlink requires explicit handling');
            const a = vscode.Uri.joinPath(from, name), b = vscode.Uri.joinPath(to, name);
            if (type === vscode.FileType.Directory) { await copyDirectory(a, b); }
            else {
                assert.equal(type, vscode.FileType.File);
                const value = await vscode.workspace.fs.readFile(a);
                await vscode.workspace.fs.writeFile(b, value);
                assert.deepEqual(await vscode.workspace.fs.readFile(b), value, 'Storage verification failed');
                copied.push([a, value]); files++;
            }
        }
    }
    await copyDirectory(source.globalStorageUri, target.globalStorageUri);
    assert.deepEqual(source.globalState.keys().sort(), [...snapshot.keys()].sort(), 'Source changed during migration');
    for (const [key, value] of snapshot) {
        assert.deepEqual(source.globalState.get(key), value, 'Source state changed during migration');
    }
    for (const [uri, value] of copied) {
        assert.deepEqual(await vscode.workspace.fs.readFile(uri), value, 'Source files changed during migration');
    }
    for (const [key, value] of snapshot) {
        await target.globalState.update(key, value);
        assert.deepEqual(target.globalState.get(key), value, 'State verification failed');
    }
    return {globalStateEntries: snapshot.size, credentialsTransferred: secrets, storageFiles: files, sourceRetained: true};
};
