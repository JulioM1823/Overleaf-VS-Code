import JSZip = require('jszip');
import { Readable } from 'stream';
import { splitSafeProjectPath } from '../utils/projectPath';

function normalizeArchivePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function stripArchiveRoot(path: string, root?: string): string | undefined {
    const normalizedPath = normalizeArchivePath(path);
    const normalizedRoot = root ? normalizeArchivePath(root) : '';
    if (!normalizedPath || !normalizedRoot) {
        return undefined;
    }

    if (normalizedPath === normalizedRoot) {
        return '';
    }

    if (!normalizedPath.startsWith(`${normalizedRoot}/`)) {
        return undefined;
    }

    return normalizedPath.slice(normalizedRoot.length + 1);
}

function detectCommonArchiveRoot(paths: string[]): string | undefined {
    if (paths.length === 0) {
        return undefined;
    }

    const roots = paths.map((path) => path.split('/')[0]).filter(Boolean);
    if (roots.length !== paths.length) {
        return undefined;
    }

    const [firstRoot] = roots;
    if (!firstRoot || !paths.every((path) => path.startsWith(`${firstRoot}/`))) {
        return undefined;
    }

    return firstRoot;
}

export interface ArchiveLimits { maxEntries: number, maxFileBytes: number, maxTotalBytes: number }
const defaultLimits: ArchiveLimits = {maxEntries: 20_000, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024};

async function readBoundedEntry(entry: JSZip.JSZipObject, limit: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        const stream = entry.nodeStream('nodebuffer') as Readable;
        stream.on('data', (chunk: Uint8Array) => {
            size += chunk.length;
            if (size > limit) {
                stream.destroy();
                chunks.length = 0;
                reject(new Error('Project archive exceeds the extraction size limit'));
                return;
            }
            chunks.push(chunk);
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks, size)));

    });
}

export async function loadProjectArchiveEntries(
    content: Uint8Array,
    projectName?: string,
    limits: ArchiveLimits = defaultLimits,
): Promise<Map<string, Uint8Array>> {
    const archive = await JSZip.loadAsync(content);
    const entries = Object.values(archive.files);
    if (entries.length > limits.maxEntries) { throw new Error('Project archive contains too many entries'); }
    const paths: string[] = [];
    for (const entry of entries) {
        // JSZip sanitizes dot segments. Inspect the original spelling so a
        // malicious name cannot become an innocent-looking overwrite.
        const original = (entry as JSZip.JSZipObject & {unsafeOriginalName?: string}).unsafeOriginalName ?? entry.name;
        if (/^[\\/]/.test(original) || !splitSafeProjectPath(original)
            || original.replace(/\\/g, '/').split('/').some(part => ['.git', '.overleaf', '.vscode'].includes(part.toLowerCase()))) {
            throw new Error('Unsafe project archive path');
        }
        if (!entry.dir && !entry.name.startsWith('__MACOSX/')) { paths.push(normalizeArchivePath(entry.name)); }
    }
    const root = detectCommonArchiveRoot(paths);
    const files = new Map<string, Uint8Array>();
    let totalBytes = 0;
    for (const entry of entries) {
        if (entry.dir || entry.name.startsWith('__MACOSX/')) { continue; }
        const originalPath = normalizeArchivePath(entry.name);
        const canonicalPath = stripArchiveRoot(originalPath, root)
            || stripArchiveRoot(originalPath, projectName) || originalPath;
        const segments = splitSafeProjectPath(canonicalPath);
        if (!segments?.length || segments.some(segment => ['.git', '.overleaf', '.vscode'].includes(segment.toLowerCase()))) {
            throw new Error('Project archive contains protected workspace metadata');
        }
        if (files.has(canonicalPath)) { throw new Error('Project archive contains colliding paths'); }
        const bytes = await readBoundedEntry(entry, Math.min(limits.maxFileBytes, limits.maxTotalBytes - totalBytes));
        totalBytes += bytes.length;
        files.set(canonicalPath, bytes);
    }
    return files;
}

export function decodeArchiveTextEntry(content?: Uint8Array): string | undefined {
    if (!content) { return undefined; }
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(content);
}
