import type { ManagedTextDocumentState } from '../core/liveTextDocumentRegistry';

export function shouldSuppressRemoteWatcherPullForManagedDocument(
    managedDocumentState: ManagedTextDocumentState | undefined,
) {
    return managedDocumentState!==undefined;
}
