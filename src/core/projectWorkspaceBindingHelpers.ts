import * as path from 'path';

const OVERLEAF_WORKSPACE_SCHEME = 'overleaf-workshop';

export function normalizeProjectRelativePath(pathname: string) {
    if (pathname==='' || pathname==='/') {
        return '/';
    }
    return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

export function resolveOverleafProjectPathSegment(projectPath: string) {
    return projectPath.split('/').filter(Boolean)[0] ?? '';
}

export function toNormalizedLocalReplicaRelativePath(workspaceRootPath: string, filePath: string) {
    const relativePath = path.posix.relative(workspaceRootPath, filePath);
    if (!relativePath || relativePath==='.') {
        return '/';
    }
    return relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
}

export function toNormalizedOverleafRelativePath(projectPath: string) {
    const pathParts = projectPath.split('/').filter(Boolean);
    const relativePath = pathParts.slice(1).join('/');
    if (!relativePath) {
        return '/';
    }
    return `/${relativePath}`;
}

export function toOverleafProjectIdentityKey(uriLike: {
    authority: string,
    path: string,
    query: string,
    scheme: string,
}) {
    if (uriLike.scheme!==OVERLEAF_WORKSPACE_SCHEME) {
        return undefined;
    }
    const query = new URLSearchParams(uriLike.query);
    return [
        uriLike.authority,
        query.get('user') ?? '',
        query.get('project') ?? '',
        resolveOverleafProjectPathSegment(uriLike.path),
    ].join('\u0000');
}
