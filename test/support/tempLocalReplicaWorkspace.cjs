const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createStructuredRecorder } = require('./structuredRecorder.cjs');

function sanitizeProjectFolderName(projectName) {
    const sanitized = String(projectName || 'untitled-project').replace(/[\/\x00]/g, '_');
    return sanitized === '' || sanitized === '.' || sanitized === '..' ? 'untitled-project' : sanitized;
}

async function writeWorkspaceFiles(rootDirectory, files, recorder) {
    const entries = Object.entries(files ?? {});
    for (const [relativePath, content] of entries) {
        const targetPath = path.join(rootDirectory, relativePath);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content);
        recorder.record('workspace.file_written', {
            bytes: Buffer.byteLength(content),
            relativePath,
        });
    }
}

class TempLocalReplicaWorkspace {
    constructor(options = {}) {
        this.enableCompileNPreview = options.enableCompileNPreview ?? false;
        this.files = options.files ?? {};
        this.projectName = options.projectName ?? 'Mock Project';
        this.recorder = options.recorder ?? createStructuredRecorder('TempLocalReplicaWorkspace');
        this.rootDirectory = undefined;
        this.workspaceDirectory = undefined;
        this.uri = options.uri ?? 'overleaf-workshop://mock-server/Mock%20Project';
        this.serverName = options.serverName ?? 'mock-server';
    }

    get events() {
        return this.recorder.snapshot();
    }

    async start() {
        this.rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-workshop-local-replica-'));
        this.workspaceDirectory = path.join(this.rootDirectory, sanitizeProjectFolderName(this.projectName));
        await fs.mkdir(this.workspaceDirectory, { recursive: true });
        await fs.mkdir(path.join(this.workspaceDirectory, '.overleaf'), { recursive: true });
        const settings = {
            enableCompileNPreview: this.enableCompileNPreview,
            projectName: this.projectName,
            serverName: this.serverName,
            uri: this.uri,
        };
        await fs.writeFile(
            path.join(this.workspaceDirectory, '.overleaf', 'settings.json'),
            JSON.stringify(settings, null, 4),
        );
        this.recorder.record('workspace.started', {
            projectName: this.projectName,
            serverName: this.serverName,
            workspaceDirectory: this.workspaceDirectory,
        });
        await writeWorkspaceFiles(this.workspaceDirectory, this.files, this.recorder);
        return this;
    }

    pathFor(relativePath = '') {
        if (!this.workspaceDirectory) {
            throw new Error('TempLocalReplicaWorkspace has not been started.');
        }
        return path.join(this.workspaceDirectory, relativePath);
    }

    async readText(relativePath) {
        const content = await fs.readFile(this.pathFor(relativePath), 'utf8');
        this.recorder.record('workspace.file_read', { relativePath });
        return content;
    }

    async writeText(relativePath, content) {
        const targetPath = this.pathFor(relativePath);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content, 'utf8');
        this.recorder.record('workspace.file_written', {
            bytes: Buffer.byteLength(content),
            relativePath,
        });
    }

    async stop() {
        if (!this.rootDirectory) {
            return;
        }
        await fs.rm(this.rootDirectory, { force: true, recursive: true });
        this.recorder.record('workspace.stopped', {
            rootDirectory: this.rootDirectory,
        });
    }
}

module.exports = {
    TempLocalReplicaWorkspace,
};
