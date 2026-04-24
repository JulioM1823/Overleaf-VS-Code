import { OverleafReviewThreadEntry } from './reviewIndex';

export function mergeScopedReviewThreadEntries(
    existingEntries: Iterable<OverleafReviewThreadEntry>,
    refreshedEntries: Iterable<OverleafReviewThreadEntry>,
    docIds?: string[],
) {
    const normalizedDocIds = docIds?.filter((docId) => typeof docId === 'string' && docId.length > 0);
    if (!normalizedDocIds || normalizedDocIds.length===0) {
        return Array.from(refreshedEntries);
    }

    const targetDocIds = new Set(normalizedDocIds);
    const mergedEntries = new Map<string, OverleafReviewThreadEntry>();

    for (const entry of existingEntries) {
        if (targetDocIds.has(entry.docId)) {
            continue;
        }
        mergedEntries.set(entry.threadId, entry);
    }

    for (const entry of refreshedEntries) {
        mergedEntries.set(entry.threadId, entry);
    }

    return Array.from(mergedEntries.values());
}
