import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import stripJsonComments = require('strip-json-comments');
import { ROOT_NAME } from '../consts';
import { ProjectPersist, ProjectTagsResponseSchema, ResponseSchema } from '../api/base';
import { GlobalStateManager } from '../utils/globalStateManager';
import { logDiagnostic } from '../utils/diagnostics';
import {
    buildBrowserAssistedLoginMessage,
    buildBrowserAssistedLoginPrompt,
} from '../utils/authFlow';
import { VirtualFileSystem, parseUri } from './remoteFileSystemProvider';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import {
    buildDeterministicLocalSearchRoots,
    inspectLocalReplicaCandidate,
    LocalReplicaCandidateInspection,
    searchForExactDirectoryName,
} from '../scm/localReplicaResolution';
import {
    ensureLocalReplicaCompileWorkspaceDefaults,
    sanitizeLocalReplicaProjectFolderName,
    writeLocalReplicaSettingsToWorkspaceRoot,
} from '../scm/localReplicaWorkspace';
import {
    shouldMaterializeLocalReplicaFromArchive,
} from '../scm/localReplicaMaterialization';
import {
    closeAuxiliaryBarIfPresent,
    clearPendingLocalReplicaAuxiliaryBarClose,
    rememberPendingLocalReplicaAuxiliaryBarClose,
} from './localReplicaWorkbenchLayout';
import {
    loadProjectArchiveEntries,
} from '../api/projectArchive';

type ProjectManagerNodeKind = 'host' | 'folder' | 'project';
type ThemeIconPath = {
    light: vscode.Uri,
    dark: vscode.Uri,
};
type ServerTreeData = {
    projects: ProjectPersist[],
    tags: ProjectTagsResponseSchema[],
};

type ActionProgressOptions = {
    location?: vscode.ProgressLocation,
    title: string,
};

const NativeFolderThemeIcon = (vscode.ThemeIcon as typeof vscode.ThemeIcon & {
    readonly Folder?: vscode.ThemeIcon,
}).Folder ?? new vscode.ThemeIcon('folder');
const NativeProjectBulletThemeIcon = new vscode.ThemeIcon('primitive-dot');

function buildTreeResourceUri(...segments: string[]) {
    return vscode.Uri.file(`/${segments.map(segment => encodeURIComponent(segment)).join('/')}`);
}

type IconThemeDefinition = {
    iconPath?: string,
};

type IconThemeDocument = {
    iconDefinitions?: Record<string, IconThemeDefinition>,
    folder?: string,
    folderExpanded?: string,
    light?: {
        folder?: string,
        folderExpanded?: string,
    },
};

async function loadJsoncFile<T>(filename: string): Promise<T | undefined> {
    try {
        const raw = await fs.readFile(filename, 'utf8');
        return JSON.parse(stripJsonComments(raw)) as T;
    } catch {
        return undefined;
    }
}

async function resolveConfiguredOpenFolderIcon(): Promise<ThemeIconPath | undefined> {
    const themeId = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme');
    if (!themeId) { return undefined; }

    for (const extension of vscode.extensions.all) {
        const iconThemes = ((extension.packageJSON as any)?.contributes?.iconThemes ?? []) as Array<{id?: string, path?: string}>;
        const contribution = iconThemes.find(iconTheme => iconTheme.id===themeId && iconTheme.path);
        if (!contribution?.path) { continue; }

        const themeFile = path.join(extension.extensionPath, contribution.path);
        const themeDocument = await loadJsoncFile<IconThemeDocument>(themeFile);
        if (!themeDocument?.folderExpanded || !themeDocument.iconDefinitions) { continue; }

        const darkDefinition = themeDocument.iconDefinitions[themeDocument.folderExpanded];
        if (!darkDefinition?.iconPath) { continue; }

        const lightExpandedId = themeDocument.light?.folderExpanded ?? themeDocument.folderExpanded;
        const lightDefinition = themeDocument.iconDefinitions[lightExpandedId];

        return {
            light: vscode.Uri.file(path.join(path.dirname(themeFile), (lightDefinition?.iconPath ?? darkDefinition.iconPath))),
            dark: vscode.Uri.file(path.join(path.dirname(themeFile), darkDefinition.iconPath)),
        };
    }

    return undefined;
}

class DataItem extends vscode.TreeItem {
    constructor(
        public readonly nodeKind: ProjectManagerNodeKind,
        public readonly label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        id: string,
    ) {
        super(label, collapsibleState);
        this.id = id;
    }
}

class ServerItem extends DataItem {
    tags?: {name:string, tid:string}[];
    constructor(
        readonly api: any,
        public readonly name: string,
        public readonly username: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
    ) {
        const displayLabel = username.trim() || name;
        super('host', displayLabel, collapsibleState, `server:${name}`);
        this.contextValue = collapsibleState===vscode.TreeItemCollapsibleState.None ? 'server_no_login' : 'server_login';
        this.description = undefined;
        this.iconPath = undefined;
        this.tooltip = username.trim()
            ? `${username}\n${api.url}`
            : `${name}\n${api.url}`;
    }
}

class TagItem extends DataItem {
    constructor(
        readonly api: any,
        public readonly serverName: string,
        public readonly tid: string,
        public readonly name: string,
        readonly projects: ProjectItem[],
        readonly isExpanded: boolean,
        openIconPath?: ThemeIconPath,
    ) {
        super(
            'folder',
            name,
            projects.length===0
                ? vscode.TreeItemCollapsibleState.None
                : isExpanded
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed,
            `tag:${serverName}:${tid}`
        );
        this.resourceUri = buildTreeResourceUri('overleaf-workshop', serverName, name);
        this.iconPath = isExpanded && openIconPath ? openIconPath : NativeFolderThemeIcon;
        this.contextValue = 'tag';
        this.tooltip = name;
    }
}

class ProjectItem extends DataItem {
    tag?: {name:string, tid:string};
    constructor(
        readonly api: any,
        readonly uri: string,
        readonly parent: ServerItem,
        readonly pid: string,
        readonly projectLabel: string,
        readonly status: 'normal' | 'archived' | 'trashed',
        readonly treeLocation: string = 'root',
    ) {
        const _label = status==='normal'
            ? `${projectLabel}`
            : `[${status}] ${projectLabel}`;
        super('project', _label, vscode.TreeItemCollapsibleState.None, `project:${parent.name}:${pid}:${treeLocation}`);
        this.tooltip = status==='normal' ? projectLabel : `[${status}] ${projectLabel}`;
        this.setStatus(status);
    }

    static clone(project: ProjectItem, treeLocation: string) {
        return new ProjectItem(
            project.api,
            project.uri,
            project.parent,
            project.pid,
            project.projectLabel,
            project.status,
            treeLocation,
        );
    }

    setStatus(status:'normal' | 'archived' | 'trashed') {
        switch (status) {
            case 'normal':
                this.contextValue = 'project';
                this.iconPath = NativeProjectBulletThemeIcon;
                break;
            case 'archived':
                this.contextValue = 'archived_project';
                this.iconPath = new vscode.ThemeIcon('archive');
                break;
            case 'trashed':
                this.contextValue = 'trashed_project';
                this.iconPath = new vscode.ThemeIcon('trash');
        }
    }
}

export class ProjectManagerProvider implements vscode.TreeDataProvider<DataItem> {
    private static readonly localReplicaSearchRootsStateKey = `${ROOT_NAME}.localReplica.searchRoots`;
    private treeView?: vscode.TreeView<DataItem>;
    constructor(
        private context:vscode.ExtensionContext) {
        this.context = context;
    }

    private _onDidChangeTreeData: vscode.EventEmitter<DataItem | undefined | void> = new vscode.EventEmitter<DataItem | undefined | void>();
    private readonly expandedTags = new Set<string>();
    private readonly serverTreeDataCache = new Map<string, ServerTreeData>();
    private readonly pendingServerTreeData = new Map<string, Promise<ServerTreeData>>();
    private cachedOpenFolderIconThemeId?: string;
    private cachedOpenFolderIconPath?: ThemeIconPath;
    private refreshSequence = 0;
    private childrenRequestSequence = 0;

    private getCachedLocalReplicaSearchRoots() {
        return this.context.globalState.get<string[]>(ProjectManagerProvider.localReplicaSearchRootsStateKey, []);
    }

    private async rememberLocalReplicaSearchRoot(baseUri: vscode.Uri) {
        const existingRoots = this.getCachedLocalReplicaSearchRoots();
        const nextRoots = Array.from(new Set([
            path.dirname(baseUri.fsPath),
            ...existingRoots,
        ])).slice(0, 20);
        await this.context.globalState.update(ProjectManagerProvider.localReplicaSearchRootsStateKey, nextRoots);
    }

    private buildLocalReplicaSearchRoots(replicaPaths: string[]) {
        return buildDeterministicLocalSearchRoots({
            cachedRoots: this.getCachedLocalReplicaSearchRoots(),
            existingReplicaPaths: replicaPaths,
            homeDirectory: os.homedir(),
            workspaceFolderPaths: (vscode.workspace.workspaceFolders ?? [])
                .filter((folder) => folder.uri.scheme==='file')
                .map((folder) => folder.uri.fsPath),
        });
    }

    private async inspectLocalReplicaCandidates(
        candidatePaths: string[],
        expectedOverleafUri: string,
    ) {
        const inspections = await Promise.all(candidatePaths.map((candidatePath) => inspectLocalReplicaCandidate(candidatePath, expectedOverleafUri)));
        return inspections.filter((inspection) => inspection.exists);
    }

    private async chooseLocalReplicaCandidate(
        inspections: LocalReplicaCandidateInspection[],
        projectLabel: string,
    ) {
        if (inspections.length===0) {
            return undefined;
        }
        if (inspections.length===1) {
            return inspections[0];
        }
        const selected = await vscode.window.showQuickPick(
            inspections.map((inspection) => ({
                description: inspection.metadataState,
                detail: inspection.basePath,
                inspection,
                label: path.basename(inspection.basePath),
            })),
            {
                ignoreFocusOut: true,
                placeHolder: vscode.l10n.t('Select the local project folder for "{label}"', {label: projectLabel}),
            },
        );
        return selected?.inspection;
    }

    private async promptForLocalReplicaDestination(projectLabel: string) {
        const selection = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: vscode.l10n.t('Choose parent folder'),
            title: vscode.l10n.t('Choose a destination for "{label}"', {label: projectLabel}),
        });
        return selection?.[0];
    }

    private async collectLocalReplicaRelativeFilePaths(baseUri: vscode.Uri) {
        const relativePaths = new Set<string>();
        const queue: Array<{relativePath: string, uri: vscode.Uri}> = [{
            relativePath: '',
            uri: baseUri,
        }];

        while (queue.length > 0) {
            const next = queue.shift()!;
            const entries = await vscode.workspace.fs.readDirectory(next.uri);
            for (const [name, type] of entries) {
                const relativePath = next.relativePath===''
                    ? name
                    : path.posix.join(next.relativePath, name);
                if (type===vscode.FileType.Directory) {
                    queue.push({
                        relativePath,
                        uri: vscode.Uri.joinPath(baseUri, ...relativePath.split('/')),
                    });
                    continue;
                }
                if (type===vscode.FileType.File) {
                    relativePaths.add(relativePath);
                }
            }
        }

        return relativePaths;
    }

    private async seedLocalReplicaFromArchive(
        vfs: VirtualFileSystem,
        baseUri: vscode.Uri,
        project: ProjectItem,
    ) {
        try {
            const archive = await vfs.downloadCurrentProjectArchive();
            if (!archive || archive.length===0) {
                this.logDiagnostic('local_replica.archive_seed_skipped', {
                    localPath: baseUri.fsPath,
                    projectId: project.pid,
                    reason: 'archive_unavailable',
                    serverName: project.parent.name,
                });
                return;
            }

            const archiveEntries = await loadProjectArchiveEntries(archive, vfs.projectName);
            const existingRelativePaths = await this.collectLocalReplicaRelativeFilePaths(baseUri);
            const shouldSeed = shouldMaterializeLocalReplicaFromArchive({
                archivePaths: archiveEntries.keys(),
                existingPaths: existingRelativePaths,
            });
            this.logDiagnostic('local_replica.archive_seed_evaluated', {
                archiveEntryCount: archiveEntries.size,
                existingFileCount: existingRelativePaths.size,
                localPath: baseUri.fsPath,
                projectId: project.pid,
                serverName: project.parent.name,
                shouldSeed,
            });
            if (!shouldSeed) {
                return;
            }

            // First-time local replicas should be materialized from the actual
            // Overleaf project archive so the workspace starts as a standard
            // on-disk project before incremental SCM sync takes over.
            for (const [relativePath, content] of Array.from(archiveEntries.entries()).sort(([left], [right]) => left.localeCompare(right))) {
                const normalizedPath = relativePath.replace(/^\/+/, '');
                if (normalizedPath==='') {
                    continue;
                }
                const parts = normalizedPath.split('/').filter(Boolean);
                if (parts.length===0) {
                    continue;
                }
                const parentParts = parts.slice(0, -1);
                if (parentParts.length > 0) {
                    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(baseUri, ...parentParts));
                }
                await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(baseUri, ...parts), content);
            }

            this.logDiagnostic('local_replica.archive_seed_completed', {
                archiveEntryCount: archiveEntries.size,
                localPath: baseUri.fsPath,
                projectId: project.pid,
                serverName: project.parent.name,
            });
        } catch (error) {
            this.logDiagnostic('local_replica.archive_seed_failed', {
                localPath: baseUri.fsPath,
                projectId: project.pid,
                serverName: project.parent.name,
            }, error);
        }
    }

    private async preflightLocalReplica(
        vfs: VirtualFileSystem,
        baseUri: vscode.Uri,
        project: ProjectItem,
    ) {
        // The local replica is prepared before the folder is opened so the next
        // window can activate in local mode with complete sync metadata and an
        // already-initialized baseline for file watching.
        await writeLocalReplicaSettingsToWorkspaceRoot(baseUri, {
            enableCompileNPreview: true,
            projectName: project.projectLabel,
            serverName: project.parent.name,
            uri: project.uri,
        });
        await ensureLocalReplicaCompileWorkspaceDefaults(baseUri);
        await this.seedLocalReplicaFromArchive(vfs, baseUri, project);
        const scm = new LocalReplicaSCMProvider(vfs, baseUri);
        const triggers = await scm.triggers;
        vfs.setProjectSCMPersist(baseUri.toString(), {
            enabled: true,
            label: LocalReplicaSCMProvider.label,
            baseUri: baseUri.toString(),
            settings: {} as JSON,
        });
        const conflictPaths = scm.getConflictPaths();
        triggers.forEach((trigger) => trigger.dispose());
        await this.rememberLocalReplicaSearchRoot(baseUri);
        return conflictPaths;
    }

    readonly onDidChangeTreeData: vscode.Event<DataItem | undefined | void> = this._onDidChangeTreeData.event;

    private logDiagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown) {
        logDiagnostic('ProjectManager', event, {
            expandedTagCount: this.expandedTags.size,
            pendingServerTreeDataCount: this.pendingServerTreeData.size,
            refreshSequence: this.refreshSequence,
            serverTreeCacheCount: this.serverTreeDataCache.size,
            ...fields,
        }, error);
    }

    private logAction(event: 'started' | 'completed' | 'failed' | 'cancelled' | 'response_failed', action: string, fields: Record<string, unknown> = {}, error?: unknown) {
        this.logDiagnostic(`action.${event}`, {
            action,
            ...fields,
        }, error);
    }

    private async withActionProgress<T>(action: string, options: ActionProgressOptions, fields: Record<string, unknown>, task: () => Promise<T>): Promise<T> {
        this.logAction('started', action, fields);
        try {
            const result = await vscode.window.withProgress({
                location: options.location ?? vscode.ProgressLocation.Notification,
                cancellable: false,
                title: options.title,
            }, async () => task());
            this.logAction('completed', action, fields);
            return result;
        } catch (error) {
            this.logAction('failed', action, fields, error);
            throw error;
        }
    }

    private handleResponseFailure(action: string, response: ResponseSchema | undefined, fields: Record<string, unknown>) {
        this.logAction('response_failed', action, {
            ...fields,
            responseType: response?.type ?? 'undefined',
        }, response?.message);
        const message = response?.message ?? vscode.l10n.t('Operation failed.');
        if (response?.message) {
            vscode.window.showErrorMessage(response.message);
        } else {
            vscode.window.showErrorMessage(message);
        }
        throw new Error(message);
    }

    private logActionCancelled(action: string, fields: Record<string, unknown>) {
        this.logAction('cancelled', action, fields);
    }

    private getTagKey(serverName: string, tid: string) {
        return `${serverName}:${tid}`;
    }

    private async promptCookieLogin(server: ServerItem, action: string, fields: Record<string, unknown> = {}, prompt?: string) {
        const cookies = await vscode.window.showInputBox({
            placeHolder: vscode.l10n.t('Cookies, e.g., "sharelatex.sid=..." or "overleaf_session2=..."'),
            prompt: prompt ?? vscode.l10n.t('README: [How to Login with Cookies](https://github.com/overleaf-workshop/overleaf-workshop#how-to-login-with-cookies)'),
        });
        if (!cookies) {
            this.logActionCancelled(action, {
                serverName: server.name,
                ...fields,
            });
            return;
        }

        await this.withActionProgress(
            action,
            {title: vscode.l10n.t('Signing in to {serverName}', {serverName: server.name})},
            {serverName: server.name, ...fields},
            async () => {
                const success = await GlobalStateManager.loginServer(this.context, server.api, server.name, {cookies});
                if (!success) {
                    throw new Error(vscode.l10n.t('Login failed.'));
                }
                this.refresh(action === 'server_login_browser_assisted' ? 'server_logged_in_browser_assisted' : 'server_logged_in_cookies');
            }
        );
    }

    private async beginBrowserAssistedLogin(server: ServerItem) {
        const loginUri = vscode.Uri.parse(new URL('login', server.api.url).toString());
        const projectUri = vscode.Uri.parse(new URL('project', server.api.url).toString());
        const flowFields = {
            loginUrl: loginUri.toString(),
            projectUrl: projectUri.toString(),
            serverName: server.name,
        };

        await this.withActionProgress(
            'server_login_browser_launch',
            {title: vscode.l10n.t('Opening browser sign-in for {serverName}', {serverName: server.name})},
            flowFields,
            async () => {
                const opened = await vscode.env.openExternal(loginUri);
                if (!opened) {
                    throw new Error(vscode.l10n.t('Failed to open the browser login page.'));
                }
            }
        );

        while (true) {
            const selection = await vscode.window.showInformationMessage(
                vscode.l10n.t(buildBrowserAssistedLoginMessage(server.name)),
                vscode.l10n.t('Paste Cookies'),
                vscode.l10n.t('Open Project Page'),
                vscode.l10n.t('Open Login Guide'),
            );

            if (!selection) {
                this.logActionCancelled('server_login_browser_assisted_prompt', flowFields);
                return;
            }

            if (selection===vscode.l10n.t('Open Project Page')) {
                this.logAction('started', 'server_login_browser_open_project_page', flowFields);
                const opened = await vscode.env.openExternal(projectUri);
                if (opened) {
                    this.logAction('completed', 'server_login_browser_open_project_page', flowFields);
                } else {
                    const error = new Error(vscode.l10n.t('Failed to open the Overleaf project page.'));
                    this.logAction('failed', 'server_login_browser_open_project_page', flowFields, error);
                    vscode.window.showErrorMessage(error.message);
                }
                continue;
            }

            if (selection===vscode.l10n.t('Open Login Guide')) {
                await this.openLoginGuide(server.name);
                continue;
            }

            await this.promptCookieLogin(
                server,
                'server_login_browser_assisted',
                {origin: 'browser_assisted'},
                vscode.l10n.t(buildBrowserAssistedLoginPrompt()),
            );
            return;
        }
    }

    private isTagExpanded(serverName: string, tid: string) {
        return this.expandedTags.has(this.getTagKey(serverName, tid));
    }

    private async getOpenFolderIconPath() {
        const themeId = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme');
        if (themeId===this.cachedOpenFolderIconThemeId) {
            this.logDiagnostic('icon_theme.cache_hit', {
                hasOpenFolderIconPath: this.cachedOpenFolderIconPath !== undefined,
                themeId,
            });
            return this.cachedOpenFolderIconPath;
        }
        this.logDiagnostic('icon_theme.cache_miss', {
            previousThemeId: this.cachedOpenFolderIconThemeId,
            themeId,
        });
        this.cachedOpenFolderIconThemeId = themeId;
        this.cachedOpenFolderIconPath = await resolveConfiguredOpenFolderIcon();
        this.logDiagnostic('icon_theme.resolved', {
            hasOpenFolderIconPath: this.cachedOpenFolderIconPath !== undefined,
            themeId,
        });
        return this.cachedOpenFolderIconPath;
    }

    private clearServerTreeData(reason: string, serverName?: string) {
        if (serverName) {
            this.serverTreeDataCache.delete(serverName);
            this.pendingServerTreeData.delete(serverName);
            this.logDiagnostic('server_tree_cache.invalidated', {
                reason,
                scope: 'server',
                serverName,
            });
            return;
        }
        this.serverTreeDataCache.clear();
        this.pendingServerTreeData.clear();
        this.logDiagnostic('server_tree_cache.invalidated', {
            reason,
            scope: 'all',
        });
    }

    private async getServerTreeData(server: ServerItem): Promise<ServerTreeData> {
        const cached = this.serverTreeDataCache.get(server.name);
        if (cached) {
            this.logDiagnostic('server_tree_cache.hit', {
                projectCount: cached.projects.length,
                serverName: server.name,
                tagCount: cached.tags.length,
            });
            return cached;
        }

        const pending = this.pendingServerTreeData.get(server.name);
        if (pending) {
            this.logDiagnostic('server_tree_cache.pending_reused', {
                serverName: server.name,
            });
            return pending;
        }

        this.logDiagnostic('server_tree_cache.fetch_start', {
            serverName: server.name,
        });
        const request = GlobalStateManager.fetchServerProjects(this.context, server.api, server.name)
        .then(projects => {
            return GlobalStateManager.authenticate(this.context, server.name)
            .then(identity => server.api.getAllTags(identity))
            .then(res => ({
                projects,
                tags: res.type==='success' ? res.tags as ProjectTagsResponseSchema[] : [],
            }));
        })
        .then(data => {
            this.serverTreeDataCache.set(server.name, data);
            this.logDiagnostic('server_tree_cache.fetch_success', {
                projectCount: data.projects.length,
                serverName: server.name,
                tagCount: data.tags.length,
            });
            return data;
        })
        .catch((error) => {
            this.logDiagnostic('server_tree_cache.fetch_failed', {
                serverName: server.name,
            }, error);
            return Promise.reject(error);
        })
        .finally(() => {
            this.pendingServerTreeData.delete(server.name);
        });

        this.pendingServerTreeData.set(server.name, request);
        return request;
    }

    refresh(reason = 'manual'): void {
        this.refreshSequence += 1;
        this.clearServerTreeData(reason);
        this.logDiagnostic('tree.refresh', {reason});
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DataItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: DataItem): Thenable<DataItem[]> {
        if (element) {
            if (element instanceof ServerItem) {
                const requestId = ++this.childrenRequestSequence;
                this.logDiagnostic('children.server.start', {
                    requestId,
                    serverName: element.name,
                });
                return this.getServerTreeData(element)
                .catch(() => {
                    // Direct logout if cookie expired
                    GlobalStateManager.logoutServer(this.context, element.api, element.name)
                    .then(success => {
                        if (success) {
                            this.refresh('server_auto_logout');
                        }
                    });
                    return Promise.reject();
                })
                .then(data => this.getOpenFolderIconPath().then(openFolderIconPath => ({...data, openFolderIconPath})))
                .then(({projects, tags, openFolderIconPath}) => {
                    const allTags:{name:string, tid:string}[] = [];
                    // get project items
                    const normalProjects = [], trashedProjects = [], archivedProjects = [];
                    for (const project of projects) {
                        const uri = `${ROOT_NAME}://${element.name}/${encodeURIComponent(project.name)}?user=${project.userId}&project=${project.id}`;
                        const status = project.archived ? 'archived' : project.trashed ? 'trashed' : 'normal';
                        const item = new ProjectItem(element.api, uri, element, project.id, project.name, status);
                        switch (status) {
                            case 'normal': normalProjects.push(item); break;
                            case 'archived': archivedProjects.push(item); break;
                            case 'trashed': trashedProjects.push(item); break;
                        }
                    }
                    const allProjectItems = [...normalProjects, ...archivedProjects, ...trashedProjects];
                    // create tag items
                    const tagProjectItems:TagItem[] = tags.map(tag => {
                        const _tag = {name:tag.name, tid:tag._id};
                        allTags.push( _tag );
                        const _projects:ProjectItem[] = tag.project_ids.map(pid => {
                            const item = allProjectItems.find(project => project.pid===pid);
                            if (item) {
                                const _item = ProjectItem.clone(item, `tag:${tag._id}`);
                                item.tag = _tag; // for filter purpose
                                _item.contextValue = 'project_in_tag';
                                _item.tag = _tag;
                                return _item;
                            }
                        }).filter(item => item) as ProjectItem[];
                        return new TagItem(
                            element.api,
                            element.name,
                            tag._id,
                            tag.name,
                            _projects,
                            this.isTagExpanded(element.name, tag._id),
                            openFolderIconPath
                        );
                    });
                    // get remaining projects
                    const remainingProjects = allProjectItems.filter(project => !project.tag);
                    // return all items
                    element.tags = allTags;
                    const items = [...tagProjectItems, ...remainingProjects];
                    this.logDiagnostic('children.server.resolved', {
                        itemCount: items.length,
                        projectCount: allProjectItems.length,
                        remainingProjectCount: remainingProjects.length,
                        requestId,
                        serverName: element.name,
                        tagCount: tagProjectItems.length,
                    });
                    return items;
                });
            } else if (element instanceof TagItem) {
                this.logDiagnostic('children.tag.resolved', {
                    projectCount: element.projects.length,
                    serverName: element.serverName,
                    tagId: element.tid,
                    tagName: element.name,
                });
                return Promise.resolve(element.projects);
            } else {
                return Promise.resolve([]);
            }
        } else {
            const persists = GlobalStateManager.getServers(this.context);
            const serverItems = Object.values(persists).map(persist => new ServerItem(
                persist.api,
                persist.server.name,
                persist.server.login?.username || '',
                persist.server.login? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            ));
            this.logDiagnostic('children.root.resolved', {
                serverCount: serverItems.length,
            });
            return Promise.resolve(serverItems);
        }
    }

    addServer() {
        vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Overleaf server address, e.g. "https://www.overleaf.com"')})
        .then((url) => {
            if (url) {
                try {
                    // check if url is valid
                    const _url = new URL(url);
                    if (!(_url.protocol==='http:' || _url.protocol==='https:')) {
                        throw new Error( vscode.l10n.t('Invalid protocol.') );
                    }
                    if (GlobalStateManager.addServer(this.context, _url.host, _url.href)) {
                        this.refresh('server_added');
                    }
                } catch (e) {
                    vscode.window.showErrorMessage( vscode.l10n.t('Invalid server address.') );
                }
            }
        });
    }

    removeServer(name:string) {
        vscode.window.showWarningMessage(vscode.l10n.t('Remove server "{name}" ?', {name}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                if (GlobalStateManager.removeServer(this.context, name)) {
                    this.refresh('server_removed');
                }
            }
        });
    }

    loginServer(server: ServerItem) {
        const loginMethods:Record<string, ()=>void> = {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Login with Password': () => {
                vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Email')})
                .then(email => email ? Promise.resolve(email) : Promise.reject())
                .then(email =>
                    vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Password'), 'password': true})
                    .then(password => {
                        return password ? Promise.resolve([email,password]) : Promise.reject();
                    })
                )
                .then(([email,password]) => this.withActionProgress(
                    'server_login_password',
                    {title: vscode.l10n.t('Signing in to {serverName}', {serverName: server.name})},
                    {serverName: server.name},
                    async () => {
                        const success = await GlobalStateManager.loginServer(this.context, server.api, server.name, {email, password});
                        if (!success) {
                            throw new Error(vscode.l10n.t('Login failed.'));
                        }
                        this.refresh('server_logged_in_password');
                    }
                ), (error: unknown) => {
                    if (error) {
                        vscode.window.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Login failed.'));
                    }
                });
            },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Login in Browser (Then Paste Cookies)': () => {
                this.beginBrowserAssistedLogin(server)
                .catch((error: unknown) => {
                    if (error) {
                        vscode.window.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Login failed.'));
                    }
                });
            },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Login with Cookies': () => {
                this.promptCookieLogin(server, 'server_login_cookies')
                .catch((error: unknown) => {
                    if (error) {
                        vscode.window.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Login failed.'));
                    }
                });
            },
            // eslint-disable-next-line @typescript-eslint/naming-convention
            'Open Login Guide': () => {
                this.openLoginGuide(server.name);
            },
        };

        vscode.window.showQuickPick(Object.keys(loginMethods), {
            canPickMany:false, placeHolder:vscode.l10n.t('Select the login method below.')})
        .then(selection => {
            if (selection===undefined) {
                this.logActionCancelled('server_login_pick', {
                    serverName: server.name,
                });
                return Promise.reject();
            }
            return Promise.resolve( (loginMethods as any)[selection] );
        })
        .then(method => method(), () => undefined);
    }

    openLoginGuide(serverName?: string) {
        const guideUri = vscode.Uri.parse('https://github.com/overleaf-workshop/overleaf-workshop/blob/main/docs/wiki.md#login-to-server');
        this.logAction('started', 'open_login_guide', {
            serverName: serverName ?? '',
            target: guideUri.toString(),
        });
        return vscode.env.openExternal(guideUri)
            .then(opened => {
                if (!opened) {
                    throw new Error(vscode.l10n.t('Unable to open the login guide.'));
                }
                this.logAction('completed', 'open_login_guide', {
                    serverName: serverName ?? '',
                    target: guideUri.toString(),
                });
            }, (error: unknown) => {
                this.logAction('failed', 'open_login_guide', {
                    serverName: serverName ?? '',
                    target: guideUri.toString(),
                }, error);
                vscode.window.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Unable to open the login guide.'));
            });
    }

    logoutServer(server: ServerItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Logout server "{name}" ?', {name:server.name}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                this.withActionProgress(
                    'server_logout',
                    {title: vscode.l10n.t('Signing out from {serverName}', {serverName: server.name})},
                    {serverName: server.name},
                    async () => {
                        const success = await GlobalStateManager.logoutServer(this.context, server.api, server.name);
                        if (success) {
                            this.refresh('server_logged_out');
                            return;
                        }
                        throw new Error(vscode.l10n.t('Logout failed.'));
                    }
                ).catch((error) => {
                    vscode.window.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Logout failed.'));
                });
            } else if (answer === "No") {
                this.logActionCancelled('server_logout', {
                    serverName: server.name,
                });
            }
        });
    }

    refreshServer(server: ServerItem) {
        this.clearServerTreeData('server_refresh', server.name);
        this.refreshSequence += 1;
        this.logDiagnostic('tree.refresh', {
            reason: 'server_refresh',
            serverName: server.name,
        });
        this._onDidChangeTreeData.fire();
    }

    newProject(server: ServerItem) {
        // 'Blank Project', 'Example Project', 'Upload Project'
        vscode.window.showQuickPick([vscode.l10n.t('Blank Project'), vscode.l10n.t('Example Project'), vscode.l10n.t('Upload Project')])
        .then((answer) => {
            switch (answer) {
                case vscode.l10n.t('Blank Project'):
                case vscode.l10n.t('Example Project'):
                    const template = answer===vscode.l10n.t('Example Project') ? 'example' : 'none';
                    vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Project name')})
                    .then(name => {
                        if (name) {
                            this.withActionProgress(
                                'project_create',
                                {title: vscode.l10n.t('Creating project "{name}"', {name})},
                                {projectName: name, serverName: server.name, template},
                                async () => {
                                    const identity = await GlobalStateManager.authenticate(this.context, server.name);
                                    const res = await server.api.newProject(identity, name, template);
                                    if (res.type==='success') {
                                        this.refresh('project_created');
                                        return;
                                    }
                                    this.handleResponseFailure('project_create', res, {
                                        projectName: name,
                                        serverName: server.name,
                                        template,
                                    });
                                }
                            ).catch(() => undefined);
                        } else {
                            this.logActionCancelled('project_create_input', {
                                serverName: server.name,
                                template,
                            });
                        }
                    });
                    break;
                case vscode.l10n.t('Upload Project'):
                    vscode.window.showOpenDialog({
                        canSelectFiles: true,
                        canSelectFolders: false,
                        canSelectMany: false,
                        filters: {
                            // eslint-disable-next-line @typescript-eslint/naming-convention
                            'Archive File': ['zip'],
                        },
                        title: vscode.l10n.t('Upload Zipped Project'),
                    }).then((uri) => {
                        if (!uri) {
                            this.logActionCancelled('project_upload_pick', {
                                serverName: server.name,
                            });
                            return;
                        }
                        vscode.workspace.fs.readFile(uri[0])
                        .then(fileContent => {
                            const filename = uri[0].path.split('/').pop();
                            if (filename) {
                                this.withActionProgress(
                                    'project_upload',
                                    {title: vscode.l10n.t('Uploading project "{name}"', {name: filename})},
                                    {filename, serverName: server.name},
                                    async () => {
                                        const identity = await GlobalStateManager.authenticate(this.context, server.name);
                                        const res = await server.api.uploadProject(identity, filename, fileContent);
                                        if (res.type==='success') {
                                            this.refresh('project_uploaded');
                                            return;
                                        }
                                        this.handleResponseFailure('project_upload', res, {
                                            filename,
                                            serverName: server.name,
                                        });
                                    }
                                ).catch(() => undefined);
                            }
                        });
                    });
                    break;
                case undefined:
                    this.logActionCancelled('project_create_pick', {
                        serverName: server.name,
                    });
                    break;
            }
        });
    }

    copyProject(project: ProjectItem) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New Project Name'),
            'value': `${project.projectLabel} (Copy)`,
            'title': vscode.l10n.t('Copy Project'),
        }).then(name => {
            if (name) {
                this.withActionProgress(
                    'project_copy',
                    {title: vscode.l10n.t('Copying project "{label}"', {label: project.projectLabel})},
                    {newName: name, projectId: project.pid, projectLabel: project.projectLabel, serverName: project.parent.name},
                    async () => {
                        const identity = await GlobalStateManager.authenticate(this.context, project.parent.name);
                        const res = await project.api.cloneProject(identity, project.pid, name);
                        if (res.type==='success') {
                            this.refresh('project_copied');
                            return;
                        }
                        this.handleResponseFailure('project_copy', res, {
                            newName: name,
                            projectId: project.pid,
                            projectLabel: project.projectLabel,
                            serverName: project.parent.name,
                        });
                    }
                ).catch(() => undefined);
            } else {
                this.logActionCancelled('project_copy_input', {
                    projectId: project.pid,
                    projectLabel: project.projectLabel,
                    serverName: project.parent.name,
                });
            }
        });
    }

    renameProject(project: ProjectItem) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New Project Name'),
            'value': project.projectLabel,
        })
        .then(newName => {
            if (newName && newName!==project.projectLabel) {
                this.withActionProgress(
                    'project_rename',
                    {title: vscode.l10n.t('Renaming project "{label}"', {label: project.projectLabel})},
                    {newName, projectId: project.pid, projectLabel: project.projectLabel, serverName: project.parent.name},
                    async () => {
                        const identity = await GlobalStateManager.authenticate(this.context, project.parent.name);
                        const res = await project.api.renameProject(identity, project.pid, newName);
                        if (res.type==='success') {
                            this.refresh('project_renamed');
                            return;
                        }
                        this.handleResponseFailure('project_rename', res, {
                            newName,
                            projectId: project.pid,
                            projectLabel: project.projectLabel,
                            serverName: project.parent.name,
                        });
                    }
                ).catch(() => undefined);
            } else {
                this.logActionCancelled('project_rename_input', {
                    projectId: project.pid,
                    projectLabel: project.projectLabel,
                    serverName: project.parent.name,
                });
            }
        });
    }

    deleteProject(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Permanently delete project "{label}" ?', {label:project.projectLabel}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                this.withActionProgress(
                    'project_delete',
                    {title: vscode.l10n.t('Deleting project "{label}"', {label: project.projectLabel})},
                    {projectId: project.pid, projectLabel: project.projectLabel, serverName: project.parent.name},
                    async () => {
                        const identity = await GlobalStateManager.authenticate(this.context, project.parent.name);
                        const res = await project.api.deleteProject(identity, project.pid);
                        if (res.type==='success') {
                            this.refresh('project_deleted');
                            return;
                        }
                        this.handleResponseFailure('project_delete', res, {
                            projectId: project.pid,
                            projectLabel: project.projectLabel,
                            serverName: project.parent.name,
                        });
                    }
                ).catch(() => undefined);
            } else if (answer === 'No') {
                this.logActionCancelled('project_delete', {
                    projectId: project.pid,
                    projectLabel: project.projectLabel,
                    serverName: project.parent.name,
                });
            }
        });
    }

    archiveProject(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Archive project "{label}" ?', {label:project.projectLabel}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                this.withActionProgress(
                    'project_archive',
                    {title: vscode.l10n.t('Archiving project "{label}"', {label: project.projectLabel})},
                    {projectId: project.pid, projectLabel: project.projectLabel, serverName: project.parent.name},
                    async () => {
                        const identity = await GlobalStateManager.authenticate(this.context, project.parent.name);
                        const res = await project.api.archiveProject(identity, project.pid);
                        if (res.type==='success') {
                            this.refresh('project_archived');
                            return;
                        }
                        this.handleResponseFailure('project_archive', res, {
                            projectId: project.pid,
                            projectLabel: project.projectLabel,
                            serverName: project.parent.name,
                        });
                    }
                ).catch(() => undefined);
            } else if (answer === 'No') {
                this.logActionCancelled('project_archive', {
                    projectId: project.pid,
                    projectLabel: project.projectLabel,
                    serverName: project.parent.name,
                });
            }
        });
    }

    unarchiveProject(project: ProjectItem) {
        this.withActionProgress(
            'project_unarchive',
            {title: vscode.l10n.t('Restoring project "{label}"', {label: project.projectLabel})},
            {projectId: project.pid, projectLabel: project.projectLabel, serverName: project.parent.name},
            async () => {
                const identity = await GlobalStateManager.authenticate(this.context, project.parent.name);
                const res = await project.api.unarchiveProject(identity, project.pid);
                if (res.type==='success') {
                    this.refresh('project_unarchived');
                    return;
                }
                this.handleResponseFailure('project_unarchive', res, {
                    projectId: project.pid,
                    projectLabel: project.projectLabel,
                    serverName: project.parent.name,
                });
            }
        ).catch(() => undefined);
    }

    trashProject(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Move project "{label}" to trash ?', {label:project.projectLabel}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                this.withActionProgress(
                    'project_trash',
                    {title: vscode.l10n.t('Moving project "{label}" to trash', {label: project.projectLabel})},
                    {projectId: project.pid, projectLabel: project.projectLabel, serverName: project.parent.name},
                    async () => {
                        const identity = await GlobalStateManager.authenticate(this.context, project.parent.name);
                        const res = await project.api.trashProject(identity, project.pid);
                        if (res.type==='success') {
                            this.refresh('project_trashed');
                            return;
                        }
                        this.handleResponseFailure('project_trash', res, {
                            projectId: project.pid,
                            projectLabel: project.projectLabel,
                            serverName: project.parent.name,
                        });
                    }
                ).catch(() => undefined);
            } else if (answer === 'No') {
                this.logActionCancelled('project_trash', {
                    projectId: project.pid,
                    projectLabel: project.projectLabel,
                    serverName: project.parent.name,
                });
            }
        });
    }

    untrashProject(project: ProjectItem) {
        this.withActionProgress(
            'project_untrash',
            {title: vscode.l10n.t('Restoring project "{label}"', {label: project.projectLabel})},
            {projectId: project.pid, projectLabel: project.projectLabel, serverName: project.parent.name},
            async () => {
                const identity = await GlobalStateManager.authenticate(this.context, project.parent.name);
                const res = await project.api.untrashProject(identity, project.pid);
                if (res.type==='success') {
                    this.refresh('project_untrashed');
                    return;
                }
                this.handleResponseFailure('project_untrash', res, {
                    projectId: project.pid,
                    projectLabel: project.projectLabel,
                    serverName: project.parent.name,
                });
            }
        ).catch(() => undefined);
    }

    createTag(server: ServerItem) {
        vscode.window.showInputBox({'placeHolder': vscode.l10n.t('Tag name')})
        .then(name => {
            if (name) {
                this.withActionProgress(
                    'tag_create',
                    {title: vscode.l10n.t('Creating tag "{name}"', {name})},
                    {serverName: server.name, tagName: name},
                    async () => {
                        const identity = await GlobalStateManager.authenticate(this.context, server.name);
                        const res = await server.api.createTag(identity, name);
                        if (res.type==='success') {
                            this.refresh('tag_created');
                            return;
                        }
                        this.handleResponseFailure('tag_create', res, {
                            serverName: server.name,
                            tagName: name,
                        });
                    }
                ).catch(() => undefined);
            } else {
                this.logActionCancelled('tag_create_input', {
                    serverName: server.name,
                });
            }
        });
    }

    renameTag(tag: TagItem) {
        vscode.window.showInputBox({
            'placeHolder': vscode.l10n.t('New tag name'),
            'value': tag.label,
        })
        .then(newName => {
            if (newName && newName!==tag.label) {
                this.withActionProgress(
                    'tag_rename',
                    {title: vscode.l10n.t('Renaming tag "{label}"', {label: tag.label})},
                    {newName, serverName: tag.serverName, tagId: tag.tid, tagName: tag.label},
                    async () => {
                        const identity = await GlobalStateManager.authenticate(this.context, tag.serverName);
                        const res = await tag.api.renameTag(identity, tag.tid, newName);
                        if (res.type==='success') {
                            this.refresh('tag_renamed');
                            return;
                        }
                        this.handleResponseFailure('tag_rename', res, {
                            newName,
                            serverName: tag.serverName,
                            tagId: tag.tid,
                            tagName: tag.label,
                        });
                    }
                ).catch(() => undefined);
            } else {
                this.logActionCancelled('tag_rename_input', {
                    serverName: tag.serverName,
                    tagId: tag.tid,
                    tagName: tag.label,
                });
            }
        });
    }

    deleteTag(tag: TagItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Delete tag "{label}" ?', {label:tag.label}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                this.withActionProgress(
                    'tag_delete',
                    {title: vscode.l10n.t('Deleting tag "{label}"', {label: tag.label})},
                    {serverName: tag.serverName, tagId: tag.tid, tagName: tag.label},
                    async () => {
                        const identity = await GlobalStateManager.authenticate(this.context, tag.serverName);
                        const res = await tag.api.deleteTag(identity, tag.tid);
                        if (res.type==='success') {
                            this.refresh('tag_deleted');
                            return;
                        }
                        this.handleResponseFailure('tag_delete', res, {
                            serverName: tag.serverName,
                            tagId: tag.tid,
                            tagName: tag.label,
                        });
                    }
                ).catch(() => undefined);
            } else if (answer === 'No') {
                this.logActionCancelled('tag_delete', {
                    serverName: tag.serverName,
                    tagId: tag.tid,
                    tagName: tag.label,
                });
            }
        });
    }

    addProjectToTag(project: ProjectItem) {
        const tagNames = project.parent.tags?.map(tag => tag.name) || [];
        vscode.window.showQuickPick(tagNames, {
            canPickMany:false, placeHolder:vscode.l10n.t('Select the tag below.')})
        .then(selection => {
            if (selection===undefined) {
                this.logActionCancelled('project_add_to_tag_pick', {
                    projectId: project.pid,
                    projectLabel: project.projectLabel,
                    serverName: project.parent.name,
                });
                return Promise.reject();
            }
            return Promise.resolve(selection);
        })
        .then(tagName => {
            const tagId = project.parent.tags?.find(tag => tag.name===tagName)?.tid;
            this.withActionProgress(
                'project_add_to_tag',
                {title: vscode.l10n.t('Adding "{label}" to "{tag}"', {label: project.projectLabel, tag: tagName})},
                {projectId: project.pid, projectLabel: project.projectLabel, serverName: project.parent.name, tagId, tagName},
                async () => {
                    const identity = await GlobalStateManager.authenticate(this.context, project.parent.name);
                    const res = await project.api.addProjectToTag(identity, tagId, project.pid);
                    if (res.type==='success') {
                        this.refresh('project_added_to_tag');
                        return;
                    }
                    this.handleResponseFailure('project_add_to_tag', res, {
                        projectId: project.pid,
                        projectLabel: project.projectLabel,
                        serverName: project.parent.name,
                        tagId,
                        tagName,
                    });
                }
            ).catch(() => undefined);
        }, () => undefined);
    }

    removeProjectFromTag(project: ProjectItem) {
        vscode.window.showWarningMessage(vscode.l10n.t('Remove project "{label}" from tag "{name}" ?', {label:project.projectLabel,name:project.tag?.name}), "Yes", "No")
        .then((answer) => {
            if (answer === "Yes") {
                this.withActionProgress(
                    'project_remove_from_tag',
                    {title: vscode.l10n.t('Removing "{label}" from "{tag}"', {label: project.projectLabel, tag: project.tag?.name ?? ''})},
                    {projectId: project.pid, projectLabel: project.projectLabel, serverName: project.parent.name, tagId: project.tag?.tid, tagName: project.tag?.name},
                    async () => {
                        const identity = await GlobalStateManager.authenticate(this.context, project.parent.name);
                        const res = await project.api.removeProjectFromTag(identity, project.tag?.tid, project.pid);
                        if (res.type==='success') {
                            this.refresh('project_removed_from_tag');
                            return;
                        }
                        this.handleResponseFailure('project_remove_from_tag', res, {
                            projectId: project.pid,
                            projectLabel: project.projectLabel,
                            serverName: project.parent.name,
                            tagId: project.tag?.tid,
                            tagName: project.tag?.name,
                        });
                    }
                ).catch(() => undefined);
            } else if (answer === 'No') {
                this.logActionCancelled('project_remove_from_tag', {
                    projectId: project.pid,
                    projectLabel: project.projectLabel,
                    serverName: project.parent.name,
                    tagId: project.tag?.tid,
                    tagName: project.tag?.name,
                });
            }
        });
    }

    openProjectInCurrentWindow(project: ProjectItem) {
        const uri = vscode.Uri.parse(project.uri);
        this.withActionProgress(
            'project_open_current_window',
            {title: vscode.l10n.t('Opening project "{label}"', {label: project.projectLabel})},
            {projectId: project.pid, projectLabel: project.projectLabel, serverName: project.parent.name, targetWindow: 'current'},
            async () => {
                await vscode.commands.executeCommand('remoteFileSystem.prefetch', uri);
                await vscode.commands.executeCommand('vscode.openFolder', uri, false);
                await vscode.commands.executeCommand('workbench.view.explorer');
            }
        ).catch((error) => {
            vscode.window.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Failed to open project.'));
        });
    }

    openProjectInNewWindow(project: ProjectItem) {
        const uri = vscode.Uri.parse(project.uri);
        this.withActionProgress(
            'project_open_new_window',
            {title: vscode.l10n.t('Opening project "{label}" in new window', {label: project.projectLabel})},
            {projectId: project.pid, projectLabel: project.projectLabel, serverName: project.parent.name, targetWindow: 'new'},
            async () => {
                await vscode.commands.executeCommand('remoteFileSystem.prefetch', uri);
                await vscode.commands.executeCommand('vscode.openFolder', uri, true);
                await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                await vscode.commands.executeCommand('workbench.view.explorer');
            }
        ).catch((error) => {
            vscode.window.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Failed to open project.'));
        });
    }

    async openProjectLocalReplica(project: ProjectItem) {
        // should close other open vfs firstly
        const vfsFolder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme===ROOT_NAME);
        if (vfsFolder) {
            vscode.window.showWarningMessage( vscode.l10n.t('Please close the open remote overleaf folder firstly.') );
            return;
        }

        const uri = vscode.Uri.parse(project.uri);
        const {serverName,projectId} = parseUri(uri);
        let vfs: VirtualFileSystem;
        try {
            vfs = await this.withActionProgress(
                'project_open_local_replica_prefetch',
                {title: vscode.l10n.t('Preparing local replica for "{label}"', {label: project.projectLabel})},
                {projectId, projectLabel: project.projectLabel, serverName},
                async () => {
                    const prefetched = await vscode.commands.executeCommand('remoteFileSystem.prefetch', uri) as VirtualFileSystem;
                    await prefetched.init({
                        autoCompileAfterInitialization: false,
                    });
                    return prefetched;
                }
            );
        } catch (error) {
            vscode.window.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Failed to prepare local replica.'));
            return;
        }

        try {
            const scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, serverName, projectId);
            const replicas = Object.values(scmPersists).filter(scmPersist => scmPersist.label===LocalReplicaSCMProvider.label);
            const replicaPaths = replicas.map((scmPersist) => scmPersist.baseUri);
            const searchRoots = this.buildLocalReplicaSearchRoots(replicaPaths);
            const discoveredPaths = await searchForExactDirectoryName({
                roots: searchRoots,
                targetFolderName: sanitizeLocalReplicaProjectFolderName(project.projectLabel),
            });
            const inspections = await this.inspectLocalReplicaCandidates([
                ...replicaPaths,
                ...discoveredPaths,
            ], project.uri);
            const linkedCandidates = inspections.filter((inspection) => inspection.metadataState==='linked');
            const relinkCandidates = inspections.filter((inspection) => inspection.metadataState!=='linked');

            let selectedBaseUri: vscode.Uri | undefined;
            const linkedCandidate = await this.chooseLocalReplicaCandidate(linkedCandidates, project.projectLabel);
            if (linkedCandidates.length > 0 && !linkedCandidate) {
                this.logActionCancelled('project_open_local_replica_pick_existing', {
                    projectId,
                    projectLabel: project.projectLabel,
                    serverName,
                });
                return;
            }
            if (linkedCandidate) {
                selectedBaseUri = vscode.Uri.file(linkedCandidate.basePath);
            } else if (relinkCandidates.length > 0) {
                const relinkCandidate = await this.chooseLocalReplicaCandidate(relinkCandidates, project.projectLabel);
                if (!relinkCandidate) {
                    this.logActionCancelled('project_open_local_replica_pick_relink', {
                        projectId,
                        projectLabel: project.projectLabel,
                        serverName,
                    });
                    return;
                }
                if (relinkCandidate) {
                    const actionLabel = relinkCandidate.metadataState==='missing'
                        ? vscode.l10n.t('Link Folder')
                        : vscode.l10n.t('Relink Folder');
                    const confirmation = await vscode.window.showWarningMessage(
                        vscode.l10n.t('Use "{folder}" as the local replica for "{project}"?', {
                            folder: relinkCandidate.basePath,
                            project: project.projectLabel,
                        }),
                        {modal: true},
                        actionLabel,
                    );
                    if (!confirmation) {
                        this.logActionCancelled('project_open_local_replica_relink', {
                            projectId,
                            projectLabel: project.projectLabel,
                            selectedPath: relinkCandidate.basePath,
                            serverName,
                        });
                        return;
                    }
                    selectedBaseUri = vscode.Uri.file(relinkCandidate.basePath);
                }
            } else {
                const destinationRoot = await this.promptForLocalReplicaDestination(project.projectLabel);
                if (!destinationRoot) {
                    this.logActionCancelled('project_open_local_replica_pick_destination', {
                        projectId,
                        projectLabel: project.projectLabel,
                        serverName,
                    });
                    return;
                }
                selectedBaseUri = await LocalReplicaSCMProvider.validateBaseUri(destinationRoot.fsPath, project.projectLabel);
            }

            if (!selectedBaseUri) {
                return;
            }
            const targetBaseUri = selectedBaseUri;

            const conflictPaths = await this.withActionProgress(
                'project_open_local_replica_preflight',
                {title: vscode.l10n.t('Syncing local replica for "{label}"', {label: project.projectLabel})},
                {localPath: targetBaseUri.fsPath, projectId, projectLabel: project.projectLabel, serverName},
                async () => this.preflightLocalReplica(vfs, targetBaseUri, project),
            );

            if (conflictPaths.length > 0) {
                void vscode.window.showWarningMessage(vscode.l10n.t(
                    'Detected {count} local replica sync conflicts while preparing "{project}". The local project will open with conflicts flagged for review.',
                    {count: conflictPaths.length, project: project.projectLabel},
                ));
            }

            await this.withActionProgress(
                'project_open_local_replica',
                {title: vscode.l10n.t('Opening local replica for "{label}"', {label: project.projectLabel})},
                {localPath: targetBaseUri.fsPath, projectId, projectLabel: project.projectLabel, serverName},
                async () => {
                    await closeAuxiliaryBarIfPresent(vscode.commands);
                    await rememberPendingLocalReplicaAuxiliaryBarClose(this.context, targetBaseUri);
                    try {
                        await vscode.commands.executeCommand('vscode.openFolder', targetBaseUri, false);
                    } catch (error) {
                        await clearPendingLocalReplicaAuxiliaryBarClose(this.context, targetBaseUri);
                        throw error;
                    }
                    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                    await vscode.commands.executeCommand('workbench.view.explorer');
                }
            );
        } catch (error) {
            vscode.window.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Failed to open local replica.'));
        } finally {
            vfs.dispose();
        }
    }

    get triggers() {
        const treeView = vscode.window.createTreeView(`${ROOT_NAME}.projectManager`, {
            treeDataProvider: this,
            showCollapseAll: false,
        });
        this.treeView = treeView;
        return [
            // register tree data provider
            treeView,
            treeView.onDidExpandElement((event) => {
                if (!(event.element instanceof TagItem)) {
                    return;
                }
                const key = this.getTagKey(event.element.serverName, event.element.tid);
                this.expandedTags.add(key);
                this.logDiagnostic('tag.expanded', {
                    projectCount: event.element.projects.length,
                    serverName: event.element.serverName,
                    tagId: event.element.tid,
                    tagName: event.element.name,
                });
                this._onDidChangeTreeData.fire(event.element);
            }),
            treeView.onDidCollapseElement((event) => {
                if (!(event.element instanceof TagItem)) {
                    return;
                }
                const key = this.getTagKey(event.element.serverName, event.element.tid);
                this.expandedTags.delete(key);
                this.logDiagnostic('tag.collapsed', {
                    projectCount: event.element.projects.length,
                    serverName: event.element.serverName,
                    tagId: event.element.tid,
                    tagName: event.element.name,
                });
                this._onDidChangeTreeData.fire(event.element);
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration('workbench.iconTheme')) {
                    this.cachedOpenFolderIconThemeId = undefined;
                    this.cachedOpenFolderIconPath = undefined;
                    this.refresh();
                }
            }),
            // register server-related commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.addServer`, () => {
                this.addServer();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.removeServer`, (item) => {
                this.removeServer(item.name);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.loginServer`, (item) => {
                this.loginServer(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.openLoginGuide`, (item) => {
                this.openLoginGuide(item?.name);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.logoutServer`, (item) => {
                this.logoutServer(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.refreshServer`, (item) => {
                this.refreshServer(item);
            }),
            // register project-related commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.newProject`, (item) => {
                this.newProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.copyProject`, (item) => {
                this.copyProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.renameProject`, (item) => {
                this.renameProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.deleteProject`, (item) => {
                this.deleteProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.archiveProject`, (item) => {
                this.archiveProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.unarchiveProject`, (item) => {
                this.unarchiveProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.trashProject`, (item) => {
                this.trashProject(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.untrashProject`, (item) => {
                this.untrashProject(item);
            }),
            // register tag-related commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.createTag`, (item) => {
                this.createTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.renameTag`, (item) => {
                this.renameTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.deleteTag`, (item) => {
                this.deleteTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.addProjectToTag`, (item) => {
                this.addProjectToTag(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.removeProjectFromTag`, (item) => {
                this.removeProjectFromTag(item);
            }),
            // register open project commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.openProjectInCurrentWindow`, (item) => {
                this.openProjectInCurrentWindow(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.openProjectInNewWindow`, (item) => {
                this.openProjectInNewWindow(item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectManager.openProjectLocalReplica`, (item) => {
                this.openProjectLocalReplica(item);
            }),
        ];
    }
}
