import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** Keep externally opened files available for the viewer's lifetime. Each export
 * has a fresh private directory, so another export cannot replace its contents. */
export async function createPrivateTemporaryFile(fileName: string, content: Uint8Array): Promise<string> {
    if (!fileName || fileName === '.' || fileName === '..' || /[/\\\u0000]/.test(fileName)) {
        throw new Error('Invalid temporary file name');
    }
    const bytes = Buffer.from(content);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-workshop-pdf-'));
    try {
        await fs.chmod(directory, 0o700);
        const target = path.join(directory, fileName);
        const handle = await fs.open(target, 'wx', 0o600);
        try {
            await handle.writeFile(bytes);
        } finally {
            await handle.close();
        }
        return target;
    } catch (error) {
        await fs.rm(directory, {recursive: true, force: true});
        throw error;
    }
}
