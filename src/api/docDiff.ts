export interface DocDiffChunk {
    u?: string,
    d?: string,
    i?: string,
}

export function reconstructDocumentFromDiff(diff?: DocDiffChunk[]): string | undefined {
    if (!Array.isArray(diff)) {
        return undefined;
    }

    // The target revision contains unchanged and inserted chunks only.
    // Deleted chunks belong to the old revision and must never be resurrected.
    if (diff.some(entry => !entry || [entry.u, entry.i, entry.d].some(value => value!==undefined && typeof value!=='string'))) {
        return undefined;
    }
    return diff.map((entry) => entry.u ?? entry.i ?? '').join('');
}
