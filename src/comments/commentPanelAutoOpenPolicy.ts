import type { ProjectWorkspaceMode } from '../core/projectWorkspaceBinding';

export type CommentsOpenViewSuppressionDecision =
    | 'already_disabled'
    | 'skip_no_workspace'
    | 'skip_unmanaged_workspace'
    | 'update_workspace';

const STARTUP_PANEL_SUPPRESSION_REASON_PREFIXES = [
    'initial_visible_editors',
    'visible_editors_changed',
    'workspace_folders_changed',
    'local_replica_settings_created',
    'local_replica_settings_changed',
    'local_replica_settings_deleted',
];

const STARTUP_PANEL_SUPPRESSION_REASON_FRAGMENTS = [
    'comments_changed_event:comments_project_index_hydrated',
    'comments_changed_event:comments_threads_hydrated',
];

export function resolveCommentsOpenViewSuppressionDecision(options: {
    mode?: ProjectWorkspaceMode,
    openView: string,
    workspaceFolderCount: number,
}): CommentsOpenViewSuppressionDecision {
    if (options.openView==='never') {
        return 'already_disabled';
    }
    if (options.mode!=='currentWindow' && options.mode!=='localReplica') {
        return 'skip_unmanaged_workspace';
    }
    if (options.workspaceFolderCount > 0) {
        return 'update_workspace';
    }
    return 'skip_no_workspace';
}

export function shouldSuppressStartupPanelAfterRender(options: {
    expiresAtMs: number,
    isProviderDisposed: boolean,
    mode?: ProjectWorkspaceMode,
    now?: number,
    reason: string,
    renderPath: string,
    snapshotThreadCount: number,
}) {
    if (options.isProviderDisposed) {
        return false;
    }
    if ((options.now ?? Date.now()) > options.expiresAtMs) {
        return false;
    }
    if (options.mode!=='currentWindow' && options.mode!=='localReplica') {
        return false;
    }
    if (!options.renderPath.toLowerCase().endsWith('.tex')) {
        return false;
    }
    if (options.snapshotThreadCount===0) {
        return false;
    }
    return STARTUP_PANEL_SUPPRESSION_REASON_PREFIXES.some((prefix) => {
        return options.reason.includes(prefix);
    }) || STARTUP_PANEL_SUPPRESSION_REASON_FRAGMENTS.some((reasonFragment) => {
        return options.reason.includes(reasonFragment);
    });
}
