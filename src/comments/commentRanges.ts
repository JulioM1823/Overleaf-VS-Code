import { OverleafCommentMetadata, OverleafCommentOperation, OverleafCommentRange } from './types';

export type OverleafTextOperation = {
    commentIds?: string[],
    c?: string,
    d?: string,
    i?: string,
    p: number,
    resolved?: boolean,
    t?: string,
};

export interface CommentRangeTransformResult {
    contentMismatchCount: number;
    removedThreadIds: string[];
    ranges: OverleafCommentRange[];
}

export interface CommentThreadAnchorSource {
    start: {
        line: number;
    };
}

function padHex(value: string, width: number) {
    return '0'.repeat(Math.max(width - value.length, 0)) + value;
}

export function generateCommentThreadId(now = new Date(), random = Math.random) {
    const pid = Math.floor(random() * 32767).toString(16);
    const machine = Math.floor(random() * 16777216).toString(16);
    const timestamp = Math.floor(now.valueOf() / 1000).toString(16);
    return `${padHex(timestamp, 8)}${padHex(machine, 6)}${padHex(pid, 4)}000001`;
}

export function cloneCommentRange(range: OverleafCommentRange): OverleafCommentRange {
    return {
        ...range,
        metadata: range.metadata ? {...range.metadata} : undefined,
        op: {
            c: range.op.c,
            p: range.op.p,
            resolved: range.op.resolved,
            t: range.op.t,
        },
        resolved: range.resolved ?? range.op.resolved,
    };
}

export function dedupeCommentRangesByThreadId(ranges: OverleafCommentRange[]) {
    const rangesByThreadId = new Map<string, OverleafCommentRange>();
    for (const range of ranges) {
        const threadId = range.op.t || range.id;
        if (!threadId) {
            continue;
        }
        rangesByThreadId.set(threadId, cloneCommentRange(range));
    }
    return Array.from(rangesByThreadId.values());
}

export function resolveCommentThreadAnchorLine(range: CommentThreadAnchorSource) {
    return Math.max(0, range.start.line);
}

export function normalizeCommentRanges(rawRanges: unknown): OverleafCommentRange[] {
    if (!Array.isArray(rawRanges)) {
        return [];
    }
    const normalizedRanges = rawRanges.flatMap((rawRange) => {
        if (!rawRange || typeof rawRange !== 'object') {
            return [];
        }
        const candidate = rawRange as Partial<OverleafCommentRange>;
        const op = candidate.op as Partial<OverleafCommentOperation> | undefined;
        if (!candidate.id || !op || typeof op.c !== 'string' || typeof op.p !== 'number' || typeof op.t !== 'string') {
            return [];
        }
        return [{
            id: String(candidate.id),
            metadata: candidate.metadata ? {...candidate.metadata} : undefined,
            op: {
                c: op.c,
                p: op.p,
                resolved: typeof op.resolved === 'boolean' ? op.resolved : undefined,
                t: op.t,
            },
            resolved: typeof candidate.resolved === 'boolean'
                ? candidate.resolved
                : typeof op.resolved === 'boolean'
                    ? op.resolved
                    : undefined,
        }];
    });
    return dedupeCommentRangesByThreadId(normalizedRanges);
}

export function upsertCommentRange(
    ranges: OverleafCommentRange[],
    op: OverleafCommentOperation,
    metadata?: OverleafCommentMetadata,
) {
    const nextRanges = ranges.map(cloneCommentRange);
    const existing = nextRanges.find((range) => range.op.t===op.t || range.id===op.t);
    if (existing) {
        existing.id = op.t;
        existing.metadata = metadata ?? existing.metadata;
        existing.op = {...op};
        existing.resolved = op.resolved ?? existing.resolved;
        return nextRanges;
    }

    nextRanges.push({
        id: op.t,
        metadata,
        op: {...op},
        resolved: op.resolved,
    });
    return nextRanges;
}

export function removeCommentRange(ranges: OverleafCommentRange[], threadId: string) {
    return ranges
        .filter((range) => range.id!==threadId && range.op.t!==threadId)
        .map(cloneCommentRange);
}

export function updateCommentRangeResolvedState(
    ranges: OverleafCommentRange[],
    threadId: string,
    resolved: boolean,
) {
    return ranges.map((range) => {
        if (range.id!==threadId && range.op.t!==threadId) {
            return cloneCommentRange(range);
        }
        return {
            ...cloneCommentRange(range),
            op: {
                ...range.op,
                resolved,
            },
            resolved,
        };
    });
}

function applyInsertToCommentRange(
    range: OverleafCommentRange,
    op: OverleafTextOperation,
) {
    const nextRange = cloneCommentRange(range);
    const insertion = op.i ?? '';

    if (op.p <= nextRange.op.p) {
        nextRange.op.p += insertion.length;
    } else if (op.p < nextRange.op.p + nextRange.op.c.length) {
        const offset = op.p - nextRange.op.p;
        nextRange.op.c = nextRange.op.c.slice(0, offset) + insertion + nextRange.op.c.slice(offset);
    }

    return nextRange;
}

function applyDeleteToCommentRange(
    range: OverleafCommentRange,
    op: OverleafTextOperation,
): {anchorTextFullyDeleted: boolean, contentMismatch: boolean, range: OverleafCommentRange} {
    const nextRange = cloneCommentRange(range);
    const deletedText = op.d ?? '';
    const deleteStart = op.p;
    const deleteEnd = deleteStart + deletedText.length;
    const commentStart = nextRange.op.p;
    const commentEnd = nextRange.op.p + nextRange.op.c.length;

    if (deleteEnd <= commentStart) {
        nextRange.op.p -= deletedText.length;
        return {anchorTextFullyDeleted: false, contentMismatch: false, range: nextRange};
    }

    if (deleteStart >= commentEnd) {
        return {anchorTextFullyDeleted: false, contentMismatch: false, range: nextRange};
    }

    const remainingBefore = deleteStart <= commentStart
        ? ''
        : nextRange.op.c.slice(0, deleteStart - commentStart);
    const remainingAfter = deleteEnd >= commentEnd
        ? ''
        : nextRange.op.c.slice(deleteEnd - commentStart);

    const deletedCommentText = nextRange.op.c.slice(
        remainingBefore.length,
        nextRange.op.c.length - remainingAfter.length,
    );
    const offset = Math.max(0, commentStart - deleteStart);
    const deletedOperationText = deletedText.slice(offset, offset + deletedCommentText.length);
    const contentMismatch = deletedCommentText!==deletedOperationText;

    nextRange.op.p = Math.min(commentStart, deleteStart);
    nextRange.op.c = remainingBefore + remainingAfter;

    return {
        anchorTextFullyDeleted: range.op.c.length > 0 && nextRange.op.c.length===0,
        contentMismatch,
        range: nextRange,
    };
}

export function applyTextOperationToCommentRanges(
    ranges: OverleafCommentRange[],
    op: OverleafTextOperation,
): CommentRangeTransformResult {
    let contentMismatchCount = 0;
    const removedThreadIds: string[] = [];
    const nextRanges = ranges.flatMap((range) => {
        if (typeof op.i === 'string') {
            return [applyInsertToCommentRange(range, op)];
        }
        if (typeof op.d === 'string') {
            const result = applyDeleteToCommentRange(range, op);
            if (result.contentMismatch) {
                contentMismatchCount += 1;
            }
            if (result.anchorTextFullyDeleted) {
                const threadId = result.range.op.t || result.range.id;
                if (threadId) {
                    removedThreadIds.push(threadId);
                }
                return [];
            }
            return [result.range];
        }
        return [cloneCommentRange(range)];
    });

    if (typeof op.c === 'string' && typeof op.t === 'string') {
        return {
            contentMismatchCount,
            removedThreadIds,
            ranges: upsertCommentRange(nextRanges, {
                c: op.c,
                p: op.p,
                resolved: undefined,
                t: op.t,
            }),
        };
    }

    return {contentMismatchCount, removedThreadIds, ranges: nextRanges};
}

export function applyTextOperationsToCommentRanges(
    ranges: OverleafCommentRange[],
    ops: OverleafTextOperation[] | undefined,
): CommentRangeTransformResult {
    if (!ops || ops.length===0) {
        return {
            contentMismatchCount: 0,
            removedThreadIds: [],
            ranges: ranges.map(cloneCommentRange),
        };
    }

    return ops.reduce<CommentRangeTransformResult>((state, op) => {
        const result = applyTextOperationToCommentRanges(state.ranges, op);
        return {
            contentMismatchCount: state.contentMismatchCount + result.contentMismatchCount,
            removedThreadIds: [
                ...state.removedThreadIds,
                ...result.removedThreadIds,
            ],
            ranges: result.ranges,
        };
    }, {
        contentMismatchCount: 0,
        removedThreadIds: [],
        ranges: ranges.map(cloneCommentRange),
    });
}
