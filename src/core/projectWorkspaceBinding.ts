import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import {
    resolveLocalReplicaWorkspaceForFileUri,
    resolveLocalReplicaWorkspaceForOverleafUri,
} from '../scm/localReplicaWorkspace';
import {
    normalizeProjectRelativePath,
    resolveOverleafProjectPathSegment,
    toNormalizedLocalReplicaRelativePath,
    toNormalizedOverleafRelativePath,
    toOverleafProjectIdentityKey,
} from './projectWorkspaceBindingHelpers';

export type ProjectWorkspaceMode = 'currentWindow' | 'localReplica';

export interface ProjectWorkspaceBinding {
    mode: ProjectWorkspaceMode;
    overleafProjectUri: vscode.Uri;
    workspaceRootUri?: vscode.Uri;
}

export interface ProjectDocumentBinding extends ProjectWorkspaceBinding {
    overleafUri: vscode.Uri;
    relPath: string;
    renderUri: vscode.Uri;
}

export function isPotentialProjectWorkspaceUri(uri: vscode.Uri | undefined) {
    return uri?.scheme===ROOT_NAME || uri?.scheme==='file';
}

export function resolveProjectWorkspaceModeForUri(uri: vscode.Uri | undefined): ProjectWorkspaceMode | undefined {
    if (!uri) {
        return undefined;
    }
    if (uri.scheme===ROOT_NAME) {
        return 'currentWindow';
    }
    if (uri.scheme==='file') {
        return 'localReplica';
    }
    return undefined;
}

export function toOverleafProjectRootUri(uri: vscode.Uri) {
    if (uri.scheme!==ROOT_NAME) {
        return uri;
    }
    const projectPathSegment = resolveOverleafProjectPathSegment(uri.path);
    return uri.with({
        fragment: '',
        path: projectPathSegment ? `/${projectPathSegment}` : '/',
    });
}

export function isSameOverleafProjectUri(left: vscode.Uri | undefined, right: vscode.Uri | undefined) {
    if (!left || !right) {
        return false;
    }
    return toOverleafProjectIdentityKey(left)===toOverleafProjectIdentityKey(right);
}

export async function resolveProjectWorkspaceBindingForUri(
    uri: vscode.Uri,
    workspaceFolders = vscode.workspace.workspaceFolders,
): Promise<ProjectWorkspaceBinding | undefined> {
    if (uri.scheme===ROOT_NAME) {
        return {
            mode: 'currentWindow',
            overleafProjectUri: toOverleafProjectRootUri(uri),
            workspaceRootUri: toOverleafProjectRootUri(uri),
        };
    }
    if (uri.scheme!=='file') {
        return undefined;
    }
    const workspace = await resolveLocalReplicaWorkspaceForFileUri(uri, workspaceFolders);
    if (!workspace) {
        return undefined;
    }
    return {
        mode: 'localReplica',
        overleafProjectUri: workspace.overleafUri,
        workspaceRootUri: workspace.workspaceRoot,
    };
}

export async function resolveActiveProjectWorkspaceBinding(options?: {
    activeEditorUri?: vscode.Uri,
    workspaceFolders?: readonly vscode.WorkspaceFolder[],
}) {
    const workspaceFolders = options?.workspaceFolders ?? vscode.workspace.workspaceFolders;
    const activeEditorUri = options?.activeEditorUri ?? vscode.window.activeTextEditor?.document.uri;

    if (activeEditorUri && isPotentialProjectWorkspaceUri(activeEditorUri)) {
        const activeEditorBinding = await resolveProjectWorkspaceBindingForUri(activeEditorUri, workspaceFolders);
        if (activeEditorBinding) {
            return activeEditorBinding;
        }
    }

    for (const folder of workspaceFolders ?? []) {
        const binding = await resolveProjectWorkspaceBindingForUri(folder.uri, workspaceFolders);
        if (binding) {
            return binding;
        }
    }

    return undefined;
}

export async function resolveProjectDocumentBinding(
    renderUri: vscode.Uri,
    workspaceFolders = vscode.workspace.workspaceFolders,
): Promise<ProjectDocumentBinding | undefined> {
    if (renderUri.scheme===ROOT_NAME) {
        return {
            mode: 'currentWindow',
            overleafProjectUri: toOverleafProjectRootUri(renderUri),
            overleafUri: renderUri,
            relPath: toNormalizedOverleafRelativePath(renderUri.path),
            renderUri,
            workspaceRootUri: toOverleafProjectRootUri(renderUri),
        };
    }
    if (renderUri.scheme!=='file') {
        return undefined;
    }

    const workspace = await resolveLocalReplicaWorkspaceForFileUri(renderUri, workspaceFolders);
    if (!workspace) {
        return undefined;
    }
    const relPath = toNormalizedLocalReplicaRelativePath(workspace.workspaceRoot.path, renderUri.path);
    const overleafUri = relPath==='/' ? workspace.overleafUri : vscode.Uri.joinPath(
        workspace.overleafUri,
        ...relPath.split('/').filter(Boolean),
    );
    return {
        mode: 'localReplica',
        overleafProjectUri: workspace.overleafUri,
        overleafUri,
        relPath,
        renderUri,
        workspaceRootUri: workspace.workspaceRoot,
    };
}

export async function resolveProjectRenderUriForPath(
    overleafProjectUri: vscode.Uri,
    pathname: string,
    workspaceFolders = vscode.workspace.workspaceFolders,
): Promise<vscode.Uri> {
    const normalizedPath = normalizeProjectRelativePath(pathname);
    const projectRootUri = toOverleafProjectRootUri(overleafProjectUri);
    const localReplicaWorkspace = await resolveLocalReplicaWorkspaceForOverleafUri(projectRootUri, workspaceFolders);

    if (localReplicaWorkspace) {
        return normalizedPath==='/'
            ? localReplicaWorkspace.workspaceRoot
            : vscode.Uri.joinPath(
                localReplicaWorkspace.workspaceRoot,
                ...normalizedPath.split('/').filter(Boolean),
            );
    }

    return normalizedPath==='/'
        ? projectRootUri
        : vscode.Uri.joinPath(projectRootUri, ...normalizedPath.split('/').filter(Boolean));
}

export async function doesVfsMatchActiveWorkspaceProject(
    overleafProjectUri: vscode.Uri,
    options?: {
        activeEditorUri?: vscode.Uri,
        workspaceFolders?: readonly vscode.WorkspaceFolder[],
    },
) {
    const activeBinding = await resolveActiveProjectWorkspaceBinding(options);
    if (!activeBinding) {
        return true;
    }
    return isSameOverleafProjectUri(activeBinding.overleafProjectUri, overleafProjectUri);
}
