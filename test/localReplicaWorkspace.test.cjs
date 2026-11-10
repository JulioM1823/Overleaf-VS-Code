const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const originalLoad = Module._load;

class MockUri {
    constructor(fsPath) {
        this.scheme = 'file';
        this.fsPath = path.resolve(fsPath);
        this.path = this.fsPath.replace(/\\/g, '/');
    }

    toString() {
        return `file://${this.path}`;
    }
}

const vscodeMock = {
    Uri: {
        file: (fsPath) => new MockUri(fsPath),
        joinPath: (base, ...segments) => new MockUri(path.join(base.fsPath, ...segments)),
    },
    workspace: {
        fs: {
            createDirectory: (uri) => fs.mkdir(uri.fsPath, {recursive: true}),
            readFile: (uri) => fs.readFile(uri.fsPath),
            writeFile: (uri, content) => fs.writeFile(uri.fsPath, content),
        },
        getConfiguration: () => ({
            get: (_key, fallback) => fallback,
        }),
    },
};

Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
        return vscodeMock;
    }
    return originalLoad.call(this, request, parent, isMain);
};

const {
    ensureLocalReplicaMetadataDirectory,
    splitSafeProjectPath,
    writeLocalReplicaSettingsToWorkspaceRoot,
} = require('../out/scm/localReplicaWorkspace.js');

test('splitSafeProjectPath accepts normal project paths', () => {
    assert.deepEqual(splitSafeProjectPath('/sections/intro.tex'), ['sections', 'intro.tex']);
    assert.deepEqual(splitSafeProjectPath('figures\\plot.pdf'), ['figures', 'plot.pdf']);
    assert.deepEqual(splitSafeProjectPath('/'), []);
});

test('splitSafeProjectPath rejects traversal and nul segments', () => {
    assert.equal(splitSafeProjectPath('../outside.tex'), undefined);
    assert.equal(splitSafeProjectPath('/sections/../outside.tex'), undefined);
    assert.equal(splitSafeProjectPath('/sections/./intro.tex'), undefined);
    assert.equal(splitSafeProjectPath('/bad\u0000name.tex'), undefined);
});

test('metadata protection does not read, overwrite, or chmod a symlinked gitignore', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-workshop-gitignore-'));
    try {
        const metadataRoot=path.join(tempRoot,'.overleaf'); const target=path.join(tempRoot,'private');
        await fs.mkdir(metadataRoot);await fs.writeFile(target,'keep',{mode:0o644});
        // Establish the fixture's exact mode even under a restrictive umask, so
        // following the symlink and chmodding its target to 0600 is detectable.
        await fs.chmod(target,0o644);
        await fs.symlink(target,path.join(metadataRoot,'.gitignore'));
        await ensureLocalReplicaMetadataDirectory(vscodeMock.Uri.file(metadataRoot));
        assert.equal(await fs.readFile(target,'utf8'),'keep');
        assert.equal((await fs.stat(target)).mode & 0o777,0o644);
    } finally {await fs.rm(tempRoot,{force:true,recursive:true});}
});

test('writeLocalReplicaSettingsToWorkspaceRoot creates self-protecting metadata gitignore', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-workshop-gitignore-'));
    try {
        await writeLocalReplicaSettingsToWorkspaceRoot(vscodeMock.Uri.file(tempRoot), {
            projectName: 'Private Project',
            serverName: 'www.overleaf.com',
            uri: 'overleaf-workshop://www.overleaf.com/project-id',
        });

        const gitignore = await fs.readFile(path.join(tempRoot, '.overleaf', '.gitignore'), 'utf8');
        assert.match(gitignore, /# BEGIN Overleaf Workshop local metadata/);
        assert.match(gitignore, /^\*$/m);
        assert.match(gitignore, /^!\.gitignore$/m);
    } finally {
        await fs.rm(tempRoot, {force: true, recursive: true});
    }
});

test('ensureLocalReplicaMetadataDirectory preserves custom gitignore content and avoids duplicate managed blocks', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-workshop-gitignore-'));
    try {
        const metadataRoot = path.join(tempRoot, '.overleaf');
        const metadataUri = vscodeMock.Uri.file(metadataRoot);
        await fs.mkdir(metadataRoot, {recursive: true});
        await fs.writeFile(path.join(metadataRoot, '.gitignore'), '# custom rule\n!keep-this-note\n');

        await ensureLocalReplicaMetadataDirectory(metadataUri);
        await ensureLocalReplicaMetadataDirectory(metadataUri);

        const gitignore = await fs.readFile(path.join(metadataRoot, '.gitignore'), 'utf8');
        assert.match(gitignore, /^# custom rule$/m);
        assert.match(gitignore, /^!keep-this-note$/m);
        assert.equal((gitignore.match(/# BEGIN Overleaf Workshop local metadata/g) ?? []).length, 1);
        assert.match(gitignore, /^\*$/m);
        assert.match(gitignore, /^!\.gitignore$/m);
    } finally {
        await fs.rm(tempRoot, {force: true, recursive: true});
    }
});
