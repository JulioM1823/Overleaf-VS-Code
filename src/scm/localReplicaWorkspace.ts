import { splitSafeProjectPath } from '../utils/projectPath';
import * as path from 'path';
import { assertSafeLocalPath, isMissingFile, writePrivateFile } from '../utils/safeFile';
import * as vscode from 'vscode';
import stripJsonComments = require('strip-json-comments');
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import {
    mergeLocalReplicaLatexWorkshopSettings,
} from './localReplicaLatexSettings';
import {
    restrictPrivateDirectoryPermissions,
    restrictPrivateFilePermissions,
} from '../utils/filePrivacy';

export const LOCAL_REPLICA_SETTINGS_DIR_NAME = '.overleaf';
export const LOCAL_REPLICA_SETTINGS_FILE_NAME = 'settings.json';
export const LOCAL_REPLICA_GITIGNORE_FILE_NAME = '.gitignore';
export const LOCAL_REPLICA_VSCODE_DIR_NAME = '.vscode';
export const LOCAL_REPLICA_VSCODE_SETTINGS_FILE_NAME = 'settings.json';

const LOCAL_REPLICA_GITIGNORE_BEGIN = '# BEGIN Overleaf Workshop local metadata';
const LOCAL_REPLICA_GITIGNORE_END = '# END Overleaf Workshop local metadata';
const LOCAL_REPLICA_GITIGNORE_BLOCK = [
    LOCAL_REPLICA_GITIGNORE_BEGIN,
    '# Keep local project cache, comments, chat, and sync state out of source control.',
    '*',
    `!${LOCAL_REPLICA_GITIGNORE_FILE_NAME}`,
    LOCAL_REPLICA_GITIGNORE_END,
    '',
].join('\n');

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

export { splitSafeProjectPath } from '../utils/projectPath';

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

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mergeLocalReplicaMetadataGitignore(existing: string | undefined) {
    const managedBlockPattern = new RegExp(
        `${escapeRegExp(LOCAL_REPLICA_GITIGNORE_BEGIN)}[\\s\\S]*?${escapeRegExp(LOCAL_REPLICA_GITIGNORE_END)}\\r?\\n?`,
        'g',
    );
    const existingContent = (existing ?? '').replace(managedBlockPattern, '').trimEnd();
    return existingContent
        ? `${existingContent}\n\n${LOCAL_REPLICA_GITIGNORE_BLOCK}`
        : LOCAL_REPLICA_GITIGNORE_BLOCK;
}

function isWorkspaceLocalReplicaMetadataRoot(metadataRoot: vscode.Uri) {
    return metadataRoot.scheme==='file' && path.posix.basename(metadataRoot.path)===LOCAL_REPLICA_SETTINGS_DIR_NAME;
}

async function ensureLocalReplicaMetadataGitignore(metadataRoot: vscode.Uri) {
    if (!isWorkspaceLocalReplicaMetadataRoot(metadataRoot)) {
        return;
    }

    const gitignoreUri = vscode.Uri.joinPath(metadataRoot, LOCAL_REPLICA_GITIGNORE_FILE_NAME);
    try {
        await assertSafeLocalPath(metadataRoot, gitignoreUri);
        let existing: string | undefined;
        try {
            existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(gitignoreUri));
        } catch (error) {
            if (!isMissingFile(error)) { throw error; }
        }
        const merged = mergeLocalReplicaMetadataGitignore(existing);
        if (merged!==existing) {
            await assertSafeLocalPath(metadataRoot, gitignoreUri);
            await writePrivateFile(gitignoreUri, Buffer.from(merged));
        }
        await restrictPrivateFilePermissions(gitignoreUri);
    } catch {
        // Gitignore protection is best effort so cache availability and offline
        // recovery do not fail on unusual workspace providers or permissions.
    }
}

export async function ensureLocalReplicaMetadataDirectory(metadataRoot: vscode.Uri) {
    await assertSafeLocalPath(metadataRoot, metadataRoot);
    await vscode.workspace.fs.createDirectory(metadataRoot);
    await restrictPrivateDirectoryPermissions(metadataRoot);
    await ensureLocalReplicaMetadataGitignore(metadataRoot);
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
    await ensureLocalReplicaMetadataDirectory(vscode.Uri.joinPath(workspaceRoot, LOCAL_REPLICA_SETTINGS_DIR_NAME));
    await assertSafeLocalPath(workspaceRoot, settingsUri);
    await writePrivateFile(settingsUri, Buffer.from(JSON.stringify(settings, null, 4)));
    await restrictPrivateFilePermissions(settingsUri);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    return value!==null && typeof value==='object' && !Array.isArray(value);
}

export async function ensureLocalReplicaCompileWorkspaceDefaults(workspaceRoot: vscode.Uri) {
    if (workspaceRoot.scheme!=='file') {
        return;
    }

    const settingsUri = getLocalReplicaVsCodeSettingsUri(workspaceRoot);
    await assertSafeLocalPath(workspaceRoot, settingsUri);
    let existingSettings: Record<string, unknown> = {};
    try {
        const content = await vscode.workspace.fs.readFile(settingsUri);
        const parsed = JSON.parse(stripJsonComments(new TextDecoder().decode(content))) as unknown;
        if (!isJsonObject(parsed)) { throw new Error('Existing workspace settings are not a JSON object'); }
        existingSettings = parsed;
    } catch (error) {
        if (!isMissingFile(error)) { throw error; }
    }

    const mergedSettings = mergeLocalReplicaLatexWorkshopSettings(existingSettings, OUTPUT_FOLDER_NAME);
    if (mergedSettings.changed) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceRoot, LOCAL_REPLICA_VSCODE_DIR_NAME));
        await writePrivateFile(
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

    const pathSegments = splitSafeProjectPath(pathname);
    return pathSegments === undefined
        ? undefined
        : vscode.Uri.joinPath(resolvedWorkspaceRoot, ...pathSegments);
}
