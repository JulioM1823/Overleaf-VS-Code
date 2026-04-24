import * as fs from 'fs/promises';
import * as path from 'path';

const LOCAL_REPLICA_SETTINGS_DIR_NAME = '.overleaf';
const LOCAL_REPLICA_SETTINGS_FILE_NAME = 'settings.json';

interface LocalReplicaWorkspaceSettings {
    enableCompileNPreview?: boolean;
    projectName?: string;
    serverName?: string;
    uri?: string;
}

export type LocalReplicaMetadataState = 'linked' | 'missing' | 'mismatched';

export interface LocalReplicaCandidateInspection {
    basePath: string;
    exists: boolean;
    metadataState: LocalReplicaMetadataState;
    settings?: LocalReplicaWorkspaceSettings;
}

const DEFAULT_SEARCH_DIRECTORY_NAMES = [
    'Desktop',
    'Documents',
    'Downloads',
];

const SKIPPED_DIRECTORY_NAMES = new Set([
    '.git',
    '.hg',
    '.overleaf',
    '.svn',
    '.trash',
    '.Trash',
    '.vscode',
    'Library',
    'node_modules',
]);

function uniqueOrderedPaths(paths: string[]) {
    const normalized = new Set<string>();
    const ordered: string[] = [];
    for (const candidate of paths) {
        if (!candidate) {
            continue;
        }
        const normalizedPath = path.resolve(candidate);
        if (normalized.has(normalizedPath)) {
            continue;
        }
        normalized.add(normalizedPath);
        ordered.push(normalizedPath);
    }
    return ordered;
}

export function buildDeterministicLocalSearchRoots(options: {
    cachedRoots?: string[];
    existingReplicaPaths?: string[];
    homeDirectory?: string;
    workspaceFolderPaths?: string[];
}) {
    const roots: string[] = [];
    const existingReplicaParents = (options.existingReplicaPaths ?? []).map((candidatePath) => path.dirname(candidatePath));
    roots.push(...existingReplicaParents);
    roots.push(...(options.workspaceFolderPaths ?? []));
    roots.push(...(options.cachedRoots ?? []));
    if (options.homeDirectory) {
        roots.push(...DEFAULT_SEARCH_DIRECTORY_NAMES.map((directoryName) => path.join(options.homeDirectory!, directoryName)));
    }
    return uniqueOrderedPaths(roots);
}

async function readDirectorySafe(rootPath: string) {
    try {
        return await fs.readdir(rootPath, {
            withFileTypes: true,
        });
    } catch {
        return [];
    }
}

function shouldTraverseDirectory(entryName: string) {
    if (entryName.startsWith('.') && entryName!=='.overleaf') {
        return false;
    }
    return !SKIPPED_DIRECTORY_NAMES.has(entryName);
}

export async function searchForExactDirectoryName(options: {
    maxDepth?: number;
    roots: string[];
    targetFolderName: string;
}) {
    const maxDepth = options.maxDepth ?? 4;
    const matches: string[] = [];
    const visited = new Set<string>();

    for (const root of uniqueOrderedPaths(options.roots)) {
        const initialRoot = path.resolve(root);
        const queue: Array<{depth: number, directoryPath: string}> = [{
            depth: 0,
            directoryPath: initialRoot,
        }];

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (visited.has(current.directoryPath)) {
                continue;
            }
            visited.add(current.directoryPath);

            const entries = await readDirectorySafe(current.directoryPath);
            const childDirectories = entries
                .filter((entry) => entry.isDirectory())
                .sort((left, right) => left.name.localeCompare(right.name));

            for (const entry of childDirectories) {
                const childPath = path.join(current.directoryPath, entry.name);
                if (entry.name===options.targetFolderName) {
                    matches.push(childPath);
                }
                if (current.depth + 1 >= maxDepth) {
                    continue;
                }
                if (!shouldTraverseDirectory(entry.name)) {
                    continue;
                }
                queue.push({
                    depth: current.depth + 1,
                    directoryPath: childPath,
                });
            }
        }
    }

    return uniqueOrderedPaths(matches);
}

export async function inspectLocalReplicaCandidate(
    basePath: string,
    expectedOverleafUri: string,
): Promise<LocalReplicaCandidateInspection> {
    const resolvedBasePath = path.resolve(basePath);
    try {
        const stat = await fs.stat(resolvedBasePath);
        if (!stat.isDirectory()) {
            return {
                basePath: resolvedBasePath,
                exists: false,
                metadataState: 'missing',
            };
        }
    } catch {
        return {
            basePath: resolvedBasePath,
            exists: false,
            metadataState: 'missing',
        };
    }

    const settingsPath = path.join(basePath, LOCAL_REPLICA_SETTINGS_DIR_NAME, LOCAL_REPLICA_SETTINGS_FILE_NAME);
    try {
        const raw = await fs.readFile(settingsPath, 'utf8');
        const parsed = JSON.parse(raw) as LocalReplicaWorkspaceSettings;
        return {
            basePath: resolvedBasePath,
            exists: true,
            metadataState: parsed.uri===expectedOverleafUri ? 'linked' : 'mismatched',
            settings: parsed,
        };
    } catch {
        return {
            basePath: resolvedBasePath,
            exists: true,
            metadataState: 'missing',
        };
    }
}
