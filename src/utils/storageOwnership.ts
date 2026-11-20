import * as fs from 'fs/promises';
import * as path from 'path';
import { hostname } from 'os';
import { createHash, randomUUID } from 'crypto';

const hostKey = createHash('sha256').update(hostname()).digest('hex').slice(0, 24);
const prefix = '.recovery-owner-';
const contenderPattern = /^\.recovery-owner-([a-f0-9]{24})-(\d+)-([a-f0-9-]+)\.json$/;
const conflictMessage = 'This project recovery store is already open in another VS Code window or extension host. Close that project in the other window, then retry opening it here. Pending recovery data has been preserved.';

export class StorageOwnershipError extends Error {
    readonly code = 'RECOVERY_STORE_IN_USE';
    constructor() { super(conflictMessage); this.name = 'StorageOwnershipError'; }
}

interface Contender { name: string; choosing: boolean; ticket: number; }

/** A lifetime writer guard, acquired before loading mutable recovery state.
 * Unique contender files implement Lamport's bakery ordering. Dead same-host
 * processes can be ignored without ever unlinking a new owner's shared lock.
 * A remote host's PID cannot be checked safely, so its claim fails closed. */
export class StorageOwnership {
    private released = false;
    private constructor(private readonly root: string, private readonly name: string) {}

    static async acquire(storagePath: string): Promise<StorageOwnership> {
        const root = await fs.realpath(storagePath);
        const name = `${prefix}${hostKey}-${process.pid}-${randomUUID()}.json`;
        const target = path.join(root, name);
        const guard = new StorageOwnership(root, name);
        try {
            const handle = await fs.open(target, 'wx', 0o600);
            try { await handle.writeFile(JSON.stringify({choosing: true, ticket: 0})); }
            finally { await handle.close(); }
            const contenders = await guard.readContenders();
            const ticket = Math.max(0, ...contenders.map(entry => entry.ticket)) + 1;
            if (!Number.isSafeInteger(ticket)) { throw new StorageOwnershipError(); }
            // Only this process writes its own unique file. An incomplete read
            // while this update is in progress is treated as still choosing.
            await fs.writeFile(target, JSON.stringify({choosing: false, ticket}), {mode: 0o600});
            const deadline = Date.now() + 3000;
            for (;;) {
                const others = (await guard.readContenders()).filter(entry => entry.name!==name);
                if (others.some(entry => !entry.choosing && (entry.ticket < ticket || (entry.ticket===ticket && entry.name < name)))) {
                    throw new StorageOwnershipError();
                }
                if (!others.some(entry => entry.choosing)) { return guard; }
                if (Date.now()>=deadline) { throw new StorageOwnershipError(); }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        } catch (error) {
            await guard.release();
            throw error;
        }
    }

    private async readContenders(): Promise<Contender[]> {
        const result: Contender[] = [];
        for (const name of await fs.readdir(this.root)) {
            const match = contenderPattern.exec(name);
            if (!match) { continue; }
            const target = path.join(this.root, name);
            if (match[1]===hostKey) {
                try { process.kill(Number(match[2]), 0); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code==='ESRCH') {
                        // The filename includes a fresh UUID and is never reused.
                        await fs.rm(target, {force: true});
                        continue;
                    }
                    if ((error as NodeJS.ErrnoException).code!=='EPERM') { throw error; }
                }
            } else {
                throw new StorageOwnershipError();
            }
            try {
                const stat = await fs.lstat(target);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.size>1024) { throw new StorageOwnershipError(); }
                const bytes = await fs.readFile(target, 'utf8');
                let data: {choosing?: unknown, ticket?: unknown};
                try { data = JSON.parse(bytes); }
                catch { result.push({name, choosing: true, ticket: 0}); continue; }
                if (data.choosing!==false || !Number.isSafeInteger(data.ticket) || Number(data.ticket)<1) {
                    result.push({name, choosing: true, ticket: 0});
                } else { result.push({name, choosing: false, ticket: Number(data.ticket)}); }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code!=='ENOENT') { throw error; }
            }
        }
        return result;
    }

    async release() {
        if (this.released) { return; }
        await fs.rm(path.join(this.root, this.name), {force: true});
        this.released = true;
    }
}
