import { type ManagedTextDocumentState } from '../core/liveTextDocumentRegistry';
import { type LocalReplicaSnapshotKind } from './localReplicaSyncState';

export function shouldDeferLocalReplicaFileSyncToManagedSession(arg: {
    localSnapshotKind: LocalReplicaSnapshotKind,
    managedDocumentState?: ManagedTextDocumentState,
    remoteSnapshotKind: LocalReplicaSnapshotKind,
}) {
    return arg.managedDocumentState!==undefined
        && arg.localSnapshotKind==='file'
        && arg.remoteSnapshotKind==='file';
}
