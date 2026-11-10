import * as DiffMatchPatch from 'diff-match-patch';

interface Change {
    start: number,
    end: number,
    text: string,
}

function changesFromBase(base: string, text: string): Change[] {
    const changes: Change[] = [];
    let offset = 0;
    let change: Change | undefined;
    for (const [kind, part] of new DiffMatchPatch().diff_main(base, text)) {
        if (kind===0) {
            change = undefined;
            offset += part.length;
        } else {
            if (!change) {
                change = {start: offset, end: offset, text: ''};
                changes.push(change);
            }
            if (kind===-1) {
                offset += part.length;
                change.end = offset;
            } else {
                change.text += part;
            }
        }
    }
    return changes;
}

/** Merge exact edits against a common base. Never use fuzzy patch matching as
 * evidence that a concurrent replacement is safe. Same-position insertions
 * retain both users' text, with local text first; overlapping replacements
 * require an explicit conflict resolution. */
export function mergeTextFromCommonBase(base: string, local: string, remote: string) {
    if (local===remote || remote===base) {
        return {kind: 'merged' as const, mergedText: local};
    }
    if (local===base) {
        return {kind: 'merged' as const, mergedText: remote};
    }
    const localChanges = changesFromBase(base, local);
    const remoteChanges = changesFromBase(base, remote);
    const merged: Change[] = [];
    let i = 0;
    let j = 0;
    while (i < localChanges.length || j < remoteChanges.length) {
        const left = localChanges[i];
        const right = remoteChanges[j];
        if (!left) { merged.push(right); j++; continue; }
        if (!right) { merged.push(left); i++; continue; }
        if (left.start===right.start && left.end===right.end && left.text===right.text) {
            merged.push(left); i++; j++; continue;
        }
        if (left.start===right.start && left.end===left.start && right.end===right.start) {
            merged.push({...left, text: left.text + right.text}); i++; j++; continue;
        }
        if (left.start===right.start || (left.start < right.end && right.start < left.end)) {
            return {kind: 'conflict' as const, failedPatchCount: 1};
        }
        if (left.start < right.start) { merged.push(left); i++; }
        else { merged.push(right); j++; }
    }
    const parts: string[] = [];
    let offset = 0;
    for (const change of merged) {
        parts.push(base.slice(offset, change.start), change.text);
        offset = change.end;
    }
    parts.push(base.slice(offset));
    return {kind: 'merged' as const, mergedText: parts.join('')};
}
