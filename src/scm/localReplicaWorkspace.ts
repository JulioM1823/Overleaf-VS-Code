import * as path from 'path';
import * as vscode from 'vscode';
import stripJsonComments = require('strip-json-comments');
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import {
    mergeLocalReplicaLatexWorkshopSettings,
} from './localReplicaLatexSettings';

export const LOCAL_REPLICA_SETTINGS_DIR_NAME = '.overleaf';
export const LOCAL_REPLICA_SETTINGS_FILE_NAME = 'settings.json';
export const LOCAL_REPLICA_VSCODE_DIR_NAME = '.vscode';
export const LOCAL_REPLICA_VSCODE_SETTINGS_FILE_NAME = 'settings.json';

export interface LocalReplicaWorkspaceSettings {
    enableCompileNPreview?: boolean;
    projectName?: string;
    serverName?: string;
    uri?: string;
}

export interface ResolvedLocalReplicaWorkspace {
    overleafUri: vscode.Uri;
    settings: LocalReplicaWorkspaceSettings;
    workspaceRoot: vscode.Uri;
}

function isSameOverleafProjectUri(left: vscode.Uri, right: vscode.Uri) {
    return left.scheme===right.scheme
        && left.authority===right.authority
        && left.path===right.path
        && left.query===right.query;
}

export function sanitizeLocalReplicaProjectFolderName(projectName: string, platform = process.platform) {
    let sanitized = projectName;
    if (platform==='win32') {
        sanitized = projectName
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .replace(/[. ]+$/g, '');
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
            sanitized = `${sanitized}_`;
        }
    } else {
        sanitized = projectName.replace(/[\/\x00]/g, '_');
    }
    if (sanitized==='' || sanitized==='.' || sanitized==='..') {
        sanitized = 'untitled-project';
    }
    return sanitized;
}

export function getLocalReplicaSettingsUri(workspaceRoot: vscode.Uri) {
    return vscode.Uri.joinPath(
        workspaceRoot,
        LOCAL_REPLICA_SETTINGS_DIR_NAME,
        LOCAL_REPLICA_SETTINGS_FILE_NAME,
    );
}

export function getLocalReplicaVsCodeSettingsUri(workspaceRoot: vscode.Uri) {
    return vscode.Uri.joinPath(
        workspaceRoot,
        LOCAL_REPLICA_VSCODE_DIR_NAME,
        LOCAL_REPLICA_VSCODE_SETTINGS_FILE_NAME,
    );
}

function isLocalReplicaWorkspaceSettings(candidate: unknown): candidate is LocalReplicaWorkspaceSettings {
    if (!candidate || typeof candidate !== 'object') {
        return false;
    }
    const maybeSettings = candidate as LocalReplicaWorkspaceSettings;
    return typeof maybeSettings.uri === 'string'
        && maybeSettings.uri.length > 0;
}

function containsFileUri(workspaceRoot: vscode.Uri, uri: vscode.Uri) {
    if (workspaceRoot.scheme!=='file' || uri.scheme!=='file') {
        return false;
    }
    if (workspaceRoot.path===uri.path) {
        return true;
    }
    return uri.path.startsWith(`${workspaceRoot.path}/`);
}

function toNormalizedLocalReplicaRelativePath(workspaceRoot: vscode.Uri, uri: vscode.Uri) {
    const relativePath = path.posix.relative(workspaceRoot.path, uri.path);
    if (!relativePath || relativePath==='.') {
        return '/';
    }
    return relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
}

export async function readLocalReplicaSettingsFromWorkspaceRoot(
    workspaceRoot: vscode.Uri,
): Promise<LocalReplicaWorkspaceSettings | undefined> {
    if (workspaceRoot.scheme!=='file') {
        return undefined;
    }
    const settingsUri = getLocalReplicaSettingsUri(workspaceRoot);
    try {
        const content = await vscode.workspace.fs.readFile(settingsUri);
        const parsed = JSON.parse(new TextDecoder().decode(content)) as unknown;
        return isLocalReplicaWorkspaceSettings(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

export async function writeLocalReplicaSettingsToWorkspaceRoot(
    workspaceRoot: vscode.Uri,
    settings: LocalReplicaWorkspaceSettings,
) {
    const settingsUri = getLocalReplicaSettingsUri(workspaceRoot);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot, LOCAL_REPLICA_SETTINGS_DIR_NAME));
    await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(settings, null, 4)));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return value!==null && typeof value==='object' && !Array.isArray(value);
}

export async function ensureLocalReplicaCompileWorkspaceDefaults(workspaceRoot: vscode.Uri) {
    if (workspaceRoot.scheme!=='file') {
        return;
    }

    const settingsUri = getLocalReplicaVsCodeSettingsUri(workspaceRoot);
    let existingSettings: Record<string, unknown> = {};
    try {
        const content = await vscode.workspace.fs.readFile(settingsUri);
        const parsed = JSON.parse(stripJsonComments(new TextDecoder().decode(content))) as unknown;
        if (isJsonObject(parsed)) {
            existingSettings = parsed;
        }
    } catch {
        existingSettings = {};
    }

    const mergedSettings = mergeLocalReplicaLatexWorkshopSettings(existingSettings, OUTPUT_FOLDER_NAME);
    if (mergedSettings.changed) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot, LOCAL_REPLICA_VSCODE_DIR_NAME));
        await vscode.workspace.fs.writeFile(
            settingsUri,
            Buffer.from(JSON.stringify(mergedSettings.settings, null, 4)),
        );
    }

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot, OUTPUT_FOLDER_NAME));
}

export async function resolveLocalReplicaWorkspaceForFileUri(
    uri: vscode.Uri,
    workspaceFolders = vscode.workspace.workspaceFolders,
): Promise<ResolvedLocalReplicaWorkspace | undefined> {
    if (uri.scheme!=='file') {
        return undefined;
    }

    const candidateFolders = (workspaceFolders ?? [])
        .map((folder) => folder.uri)
        .filter((workspaceRoot) => containsFileUri(workspaceRoot, uri))
        .sort((left, right) => right.path.length - left.path.length);

    for (const workspaceRoot of candidateFolders) {
        const settings = await readLocalReplicaSettingsFromWorkspaceRoot(workspaceRoot);
        if (!settings?.uri) {
            continue;
        }
        const overleafUri = vscode.Uri.parse(settings.uri);
        if (overleafUri.scheme!==ROOT_NAME) {
            continue;
        }
        return {
            overleafUri,
            settings,
            workspaceRoot,
        };
    }

    return undefined;
}

export async function resolveLocalReplicaWorkspaceForOverleafUri(
    overleafUri: vscode.Uri,
    workspaceFolders = vscode.workspace.workspaceFolders,
): Promise<ResolvedLocalReplicaWorkspace | undefined> {
    if (overleafUri.scheme!==ROOT_NAME) {
        return undefined;
    }

    const candidateFolders = (workspaceFolders ?? [])
        .map((folder) => folder.uri)
        .filter((workspaceRoot) => workspaceRoot.scheme==='file');

    for (const workspaceRoot of candidateFolders) {
        const settings = await readLocalReplicaSettingsFromWorkspaceRoot(workspaceRoot);
        if (!settings?.uri) {
            continue;
        }
        const configuredOverleafUri = vscode.Uri.parse(settings.uri);
        if (!isSameOverleafProjectUri(configuredOverleafUri, overleafUri)) {
            continue;
        }
        return {
            overleafUri: configuredOverleafUri,
            settings,
            workspaceRoot,
        };
    }

    return undefined;
}

export async function mapLocalReplicaFileUriToOverleafUri(
    uri: vscode.Uri,
    workspaceFolders = vscode.workspace.workspaceFolders,
): Promise<vscode.Uri | undefined> {
    // Local replica editors render against file: URIs, but collaboration state still
    // lives on the mapped Overleaf document URI stored in .overleaf/settings.json.
    const workspace = await resolveLocalReplicaWorkspaceForFileUri(uri, workspaceFolders);
    if (!workspace) {
        return undefined;
    }
    const relativePath = toNormalizedLocalReplicaRelativePath(workspace.workspaceRoot, uri);
    return vscode.Uri.joinPath(workspace.overleafUri, ...relativePath.split('/').filter(Boolean));
}

export async function mapOverleafPathToLocalReplicaFileUri(
    pathname: string,
    workspaceRoot?: vscode.Uri,
): Promise<vscode.Uri | undefined> {
    const resolvedWorkspaceRoot = workspaceRoot
        ?? vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme==='file')?.uri;
    if (!resolvedWorkspaceRoot || resolvedWorkspaceRoot.scheme!=='file') {
        return undefined;
    }

    const settings = await readLocalReplicaSettingsFromWorkspaceRoot(resolvedWorkspaceRoot);
    if (!settings?.uri) {
        return undefined;
    }

    return vscode.Uri.joinPath(resolvedWorkspaceRoot, ...pathname.split('/').filter(Boolean));
}
