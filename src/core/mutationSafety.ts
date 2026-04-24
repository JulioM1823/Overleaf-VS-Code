export type MutationTargetFileType = 'doc' | 'file' | 'folder' | 'outputs' | undefined;

export type WritePlan =
    | {kind: 'create-new'}
    | {kind: 'update-doc'}
    | {
        kind: 'reject',
        reason: 'missing-target' | 'directory-target' | 'existing-non-document-target',
    };

export type FolderLike = {
    docs?: unknown[],
    fileRefs?: unknown[],
    folders?: unknown[],
    outputs?: unknown[],
};

export function classifyWritePlan(fileType: MutationTargetFileType, create: boolean): WritePlan {
    if (fileType === undefined) {
        return create ? {kind: 'create-new'} : {kind: 'reject', reason: 'missing-target'};
    }

    if (fileType === 'doc') {
        return {kind: 'update-doc'};
    }

    if (fileType === 'folder') {
        return {kind: 'reject', reason: 'directory-target'};
    }

    return {kind: 'reject', reason: 'existing-non-document-target'};
}

export function hasFolderChildren(folder: FolderLike): boolean {
    return Boolean(
        (folder.docs?.length ?? 0)
        || (folder.fileRefs?.length ?? 0)
        || (folder.folders?.length ?? 0)
        || (folder.outputs?.length ?? 0)
    );
}

export function allPatchApplicationsSucceeded(results: readonly boolean[]): boolean {
    return results.every(Boolean);
}
