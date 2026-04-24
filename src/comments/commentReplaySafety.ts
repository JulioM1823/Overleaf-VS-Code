export function evaluateCommentReplayAgainstQueuedLocalReplica(input: {
    hasQueuedLocalReplicaChangeForPath: boolean,
    remoteText?: string,
    selectedText: string,
    startOffset: number,
}) {
    const remoteText = input.remoteText ?? '';
    const remoteSelectedText = remoteText.slice(
        input.startOffset,
        input.startOffset + input.selectedText.length,
    );
    const selectionMatchesServer = remoteSelectedText===input.selectedText;
    return {
        remoteSelectedText,
        selectionMatchesServer,
        shouldDefer: input.hasQueuedLocalReplicaChangeForPath && !selectionMatchesServer,
    };
}

export function evaluateCommentReplayAgainstManagedDocument(input: {
    localDocumentText?: string,
    managedDocumentState?: 'pending' | 'syncing' | 'live' | 'offline-queued' | 'recovery-required',
    remoteText?: string,
    selectedText: string,
    startOffset: number,
}) {
    const remoteText = input.remoteText ?? '';
    const remoteSelectedText = remoteText.slice(
        input.startOffset,
        input.startOffset + input.selectedText.length,
    );
    const localDocumentText = input.localDocumentText;
    const localSelectedText = localDocumentText?.slice(
        input.startOffset,
        input.startOffset + input.selectedText.length,
    ) ?? '';
    const hasOpenManagedDocument = localDocumentText!==undefined;
    const selectionMatchesLocalDocument = localDocumentText===undefined
        ? true
        : localSelectedText===input.selectedText;
    const localDocumentDiffersFromServer = localDocumentText===undefined
        ? false
        : localDocumentText!==remoteText;
    return {
        hasOpenManagedDocument,
        localDocumentDiffersFromServer,
        localSelectedText,
        managedDocumentState: input.managedDocumentState,
        remoteSelectedText,
        selectionMatchesLocalDocument,
        shouldDefer: hasOpenManagedDocument && (
            input.managedDocumentState!==undefined
                ? input.managedDocumentState!=='live'
                : localDocumentDiffersFromServer
        ),
    };
}
