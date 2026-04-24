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

function buildArchivePathCandidates(path: string, projectName?: string, archiveRoot?: string): string[] {
    const normalizedPath = normalizeArchivePath(path);
    if (!normalizedPath) {
        return [];
    }

    const candidates = new Set<string>([normalizedPath]);
    const strippedProjectPath = stripArchiveRoot(normalizedPath, projectName);
    if (strippedProjectPath) {
        candidates.add(strippedProjectPath);
    }

    const strippedArchiveRoot = stripArchiveRoot(normalizedPath, archiveRoot);
    if (strippedArchiveRoot) {
        candidates.add(strippedArchiveRoot);
    }

    return Array.from(candidates);
}

export async function loadProjectArchiveEntries(
    content: Uint8Array,
    projectName?: string,
): Promise<Map<string, Uint8Array>> {
    const jsZipModule = require('jszip');
    const archive = await jsZipModule.loadAsync(Buffer.from(content));
    const files = new Map<string, Uint8Array>();
    const archivePaths = Object.values<any>(archive.files)
        .filter((entry) => !entry.dir)
        .map((entry) => normalizeArchivePath(entry.name))
        .filter((path) => path && !path.startsWith('__MACOSX/'));
    const commonArchiveRoot = detectCommonArchiveRoot(archivePaths);

    for (const entry of Object.values<any>(archive.files)) {
        if (entry.dir) {
            continue;
        }

        const normalizedPath = normalizeArchivePath(entry.name);
        if (!normalizedPath || normalizedPath.startsWith('__MACOSX/')) {
            continue;
        }

        const entryContent = await entry.async('uint8array') as Uint8Array;
        for (const candidatePath of buildArchivePathCandidates(normalizedPath, projectName, commonArchiveRoot)) {
            if (!files.has(candidatePath)) {
                files.set(candidatePath, entryContent);
            }
        }
    }

    return files;
}

export function decodeArchiveTextEntry(content?: Uint8Array): string | undefined {
    if (!content) {
        return undefined;
    }

    return new TextDecoder().decode(content);
}
