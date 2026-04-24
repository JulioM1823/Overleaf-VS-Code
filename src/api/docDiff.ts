export interface DocDiffChunk {
    u?: string,
    d?: string,
    i?: string,
}

export function reconstructDocumentFromDiff(diff?: DocDiffChunk[]): string | undefined {
    if (!Array.isArray(diff)) {
        return undefined;
    }

    return diff.map((entry) => entry.u ?? entry.i ?? entry.d ?? '').join('');
}
