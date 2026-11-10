import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { AsyncQueue } from './asyncQueue';

export function isMissingFile(error: unknown) {
    return ['ENOENT', 'FileNotFound'].includes((error as {code?: string})?.code ?? '')
        || (error as {name?: string})?.name==='EntryNotFound (FileSystemError)';
}

/** Check the root and every existing descendant, including the final file.
 * Symlinks must not redirect project reads, writes, or deletes outside a replica. */
export async function assertSafeLocalPath(root: vscode.Uri, target: vscode.Uri) {
    if (root.scheme!=='file' || target.scheme!=='file') { return; }
    const relative = path.relative(root.fsPath, target.fsPath);
    if (relative==='..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Project path escapes its storage root');
    }
    let current = root.fsPath;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
        current = path.join(current, segment);
        try {
            if ((await fs.lstat(current)).isSymbolicLink()) {
                throw new Error('Refusing a symbolic link in a project storage path');
            }
        } catch (error) {
            if (!isMissingFile(error)) { throw error; }
        }
    }
}

const writes = new Map<string, {queue: AsyncQueue, pending: number}>();

/** Replace complete files through a private sibling, never truncate the last
 * valid recovery state. Native file writes fsync before rename; other providers
 * supply their own rename/durability semantics. Snapshot bytes at call time. */
export function writePrivateFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const bytes = Buffer.from(content);
    const key = uri.toString();
    const entry = writes.get(key) ?? {queue: new AsyncQueue(), pending: 0};
    writes.set(key, entry);
    entry.pending++;
    const result = entry.queue.run(async () => {
        const temporaryPath = `${uri.path}.${randomUUID()}.tmp`;
        if (uri.scheme==='file') {
            await assertSafeLocalPath(vscode.Uri.file(path.dirname(uri.fsPath)), uri);
            const temporaryFile = `${uri.fsPath}.${randomUUID()}.tmp`;
            try {
                const handle = await fs.open(temporaryFile, 'wx', 0o600);
                try {
                    await handle.writeFile(bytes);
                    await handle.sync();
                } finally { await handle.close(); }
                await fs.rename(temporaryFile, uri.fsPath);
            } finally {
                await fs.rm(temporaryFile, {force: true});
            }
        } else {
            const temporaryUri = uri.with({path: temporaryPath});
            try {
                await vscode.workspace.fs.writeFile(temporaryUri, bytes);
                await vscode.workspace.fs.rename(temporaryUri, uri, {overwrite: true});
            } finally {
                try { await vscode.workspace.fs.delete(temporaryUri); }
                catch (error) { if (!isMissingFile(error)) { throw error; } }
            }
        }
    });
    return result.finally(() => {
        if (--entry.pending===0) { writes.delete(key); }
    });
}
