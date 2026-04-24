import type { LocalReplicaPathState } from './localReplicaSyncState';

const LOCAL_REPLICA_METADATA_DIR = '.overleaf';

function normalizeRelPath(relPath: string) {
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized==='' || normalized==='/') {
        return '/';
    }
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function isLocalReplicaMetadataPath(relPath: string) {
    const normalized = normalizeRelPath(relPath);
    return normalized===`/${LOCAL_REPLICA_METADATA_DIR}`
        || normalized.startsWith(`/${LOCAL_REPLICA_METADATA_DIR}/`);
}

export function shouldRehydrateEmptyLocalReplicaFromRemote(options: {
    isRootReconcile: boolean,
    localPathCount: number,
    pathStates: Iterable<LocalReplicaPathState>,
    remotePathCount: number,
}) {
    if (!options.isRootReconcile || options.localPathCount!==0 || options.remotePathCount===0) {
        return false;
    }
    for (const state of options.pathStates) {
        if (state.baseline!==undefined && state.baseline.kind!=='missing') {
            return true;
        }
    }
    return false;
}
