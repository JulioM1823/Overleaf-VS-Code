/* eslint-disable @typescript-eslint/naming-convention */
import type { MemberEntity, ProjectSettingsSchema } from './base';
import type {
    DocumentEntity,
    FileRefEntity,
    FolderEntity,
    ProjectEntity,
} from '../core/remoteFileSystemProvider';

export const SYNTHETIC_ENTITY_PREFIX = '__ol_synth__:';

type FlatProjectEntity = {
    path: string,
    type: string,
};

export interface ProjectPageMetadata {
    projectName?: string,
    user?: {
        _id?: string,
        first_name?: string,
        last_name?: string,
        email?: string,
    },
    wsUrl?: string,
    settings: ProjectSettingsSchema,
}

function normalizePath(path: string): string {
    const trimmed = path.trim().replace(/^\/+|\/+$/g, '');
    return trimmed ? `/${trimmed}` : '/';
}

function dirname(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === '/') {
        return '/';
    }

    const segments = normalized.split('/').filter(Boolean);
    segments.pop();
    return segments.length ? `/${segments.join('/')}` : '/';
}

function basename(path: string): string {
    const normalized = normalizePath(path);
    if (normalized === '/') {
        return '';
    }

    const segments = normalized.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? '';
}

function createSyntheticEntityId(type: 'folder' | 'doc' | 'file', path: string): string {
    return `${SYNTHETIC_ENTITY_PREFIX}${type}:${encodeURIComponent(normalizePath(path))}`;
}

function createFolder(path: string, readonly: boolean): FolderEntity {
    return {
        _id: createSyntheticEntityId('folder', path),
        name: path === '/' ? '' : basename(path),
        readonly,
        docs: [],
        fileRefs: [],
        folders: [],
    };
}

function compareByName<T extends { name: string }>(left: T, right: T): number {
    return left.name.localeCompare(right.name);
}

function sortFolder(folder: FolderEntity) {
    folder.docs.sort(compareByName);
    folder.fileRefs.sort(compareByName);
    folder.folders.sort(compareByName);
    folder.folders.forEach(sortFolder);
}

export function isSyntheticEntityId(value?: string): boolean {
    return value?.startsWith(SYNTHETIC_ENTITY_PREFIX) ?? false;
}

export function inferRootDocPath(entities: FlatProjectEntity[]): string | undefined {
    const docPaths = entities
        .filter((entity) => entity.type === 'doc')
        .map((entity) => normalizePath(entity.path));

    if (docPaths.length === 0) {
        return undefined;
    }

    const preferredCandidates = [
        '/main.tex',
        '/output.tex',
        '/ms.tex',
    ];
    for (const preferredCandidate of preferredCandidates) {
        if (docPaths.includes(preferredCandidate)) {
            return preferredCandidate;
        }
    }

    const topLevelTex = docPaths.filter((path) => /^\/[^/]+\.tex$/i.test(path)).sort();
    if (topLevelTex.length === 1) {
        return topLevelTex[0];
    }
    if (topLevelTex.length > 1) {
        return topLevelTex[0];
    }

    const anyTex = docPaths.filter((path) => /\.tex$/i.test(path)).sort();
    if (anyTex.length > 0) {
        return anyTex[0];
    }

    return docPaths.sort()[0];
}

export function buildProjectEntityFromFlatEntities(
    projectId: string,
    entities: FlatProjectEntity[],
    pageMetadata: ProjectPageMetadata,
    readonly: boolean,
): ProjectEntity {
    const root = createFolder('/', readonly);
    const folders = new Map<string, FolderEntity>([['/', root]]);

    const ensureFolder = (path: string): FolderEntity => {
        const normalizedPath = normalizePath(path);
        const cached = folders.get(normalizedPath);
        if (cached) {
            return cached;
        }

        const parentFolder = ensureFolder(dirname(normalizedPath));
        const folder = createFolder(normalizedPath, readonly);
        parentFolder.folders.push(folder);
        folders.set(normalizedPath, folder);
        return folder;
    };

    const normalizedEntities = entities
        .map((entity) => ({
            path: normalizePath(entity.path),
            type: entity.type,
        }))
        .sort((left, right) => left.path.localeCompare(right.path));

    for (const entity of normalizedEntities) {
        const parentFolder = ensureFolder(dirname(entity.path));
        const name = basename(entity.path);

        if (entity.type === 'doc') {
            const doc: DocumentEntity = {
                _id: createSyntheticEntityId('doc', entity.path),
                name,
                readonly,
            };
            parentFolder.docs.push(doc);
            continue;
        }

        const fileRef: FileRefEntity = {
            _id: createSyntheticEntityId('file', entity.path),
            name,
            readonly,
            linkedFileData: null,
            created: new Date(0).toISOString(),
        };
        parentFolder.fileRefs.push(fileRef);
    }

    sortFolder(root);

    const rootDocPath = inferRootDocPath(normalizedEntities);
    const rootDocId = rootDocPath ? createSyntheticEntityId('doc', rootDocPath) : '';
    const currentUser = pageMetadata.user ?? {};
    const owner: MemberEntity = {
        _id: currentUser._id ?? '',
        first_name: currentUser.first_name ?? '',
        last_name: currentUser.last_name,
        email: currentUser.email ?? '',
        privileges: 'owner',
    };

    return {
        _id: projectId,
        name: pageMetadata.projectName ?? '',
        rootDoc_id: rootDocId,
        rootFolder: [root],
        publicAccessLevel: '',
        compiler: 'pdflatex',
        spellCheckLanguage: '',
        deletedDocs: [],
        members: [],
        invites: [],
        owner,
        features: {},
        settings: pageMetadata.settings,
    };
}
