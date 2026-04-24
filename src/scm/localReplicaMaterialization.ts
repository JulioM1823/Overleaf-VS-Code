const LOCAL_REPLICA_METADATA_DIR = '.overleaf';

function normalizeReplicaPath(candidatePath: string) {
    return candidatePath
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
}

function isReplicaMetadataPath(candidatePath: string) {
    const normalizedPath = normalizeReplicaPath(candidatePath);
    return normalizedPath===LOCAL_REPLICA_METADATA_DIR
        || normalizedPath.startsWith(`${LOCAL_REPLICA_METADATA_DIR}/`);
}

export function shouldMaterializeLocalReplicaFromArchive(options: {
    archivePaths: Iterable<string>,
    existingPaths: Iterable<string>,
}) {
    const archivePaths = Array.from(options.archivePaths)
        .map(normalizeReplicaPath)
        .filter((candidatePath) => candidatePath!=='' && !isReplicaMetadataPath(candidatePath));
    if (archivePaths.length===0) {
        return false;
    }

    const existingPaths = new Set(
        Array.from(options.existingPaths)
            .map(normalizeReplicaPath)
            .filter((candidatePath) => candidatePath!=='' && !isReplicaMetadataPath(candidatePath)),
    );
    if (existingPaths.size===0) {
        return true;
    }

    return !archivePaths.some((archivePath) => existingPaths.has(archivePath));
}
