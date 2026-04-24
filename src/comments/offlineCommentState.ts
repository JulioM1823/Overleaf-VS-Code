import {
    cloneCommentRange,
    dedupeCommentRangesByThreadId,
} from './commentRanges';
import {
    normalizeCommentThread,
} from './commentThreads';
import {
    OverleafCommentRange,
    OverleafCommentThread,
} from './types';

export function mergeOfflineCommentState(input: {
    inMemoryCommentRangesByDocId: Map<string, OverleafCommentRange[]>,
    inMemoryCommentThreads: Map<string, OverleafCommentThread>,
    persistedCommentRangesByDocId: Record<string, OverleafCommentRange[]>,
    persistedCommentThreads: Record<string, OverleafCommentThread>,
}) {
    const loadedDocIds = new Set(input.inMemoryCommentRangesByDocId.keys());
    const commentRangesByDocId = new Map<string, OverleafCommentRange[]>();
    for (const [docId, ranges] of Object.entries(input.persistedCommentRangesByDocId)) {
        if (loadedDocIds.has(docId)) {
            continue;
        }
        commentRangesByDocId.set(docId, dedupeCommentRangesByThreadId(ranges.map(cloneCommentRange)));
    }
    for (const [docId, ranges] of input.inMemoryCommentRangesByDocId.entries()) {
        commentRangesByDocId.set(docId, dedupeCommentRangesByThreadId(ranges.map(cloneCommentRange)));
    }

    const persistedThreadIdsForUnloadedDocs = new Set(
        Array.from(commentRangesByDocId.values())
            .flatMap((ranges) => ranges.map((range) => range.op.t)),
    );
    const commentThreads = new Map<string, OverleafCommentThread>();
    for (const [threadId, thread] of Object.entries(input.persistedCommentThreads)) {
        if (!persistedThreadIdsForUnloadedDocs.has(threadId)) {
            continue;
        }
        commentThreads.set(threadId, normalizeCommentThread(thread));
    }
    for (const [threadId, thread] of input.inMemoryCommentThreads.entries()) {
        commentThreads.set(threadId, normalizeCommentThread(thread));
    }

    return {
        commentRangesByDocId,
        commentThreads,
    };
}
