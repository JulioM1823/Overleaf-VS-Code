import { OverleafReviewThreadEntry } from './reviewIndex';
import { OverleafDocumentCommentSnapshot } from './types';

export interface CommentThreadDebugSummary {
    docId: string;
    messageCount: number;
    messageIds: string[];
    resolved: boolean;
    rootMessageId?: string;
    selectedText: string;
    threadId: string;
}

export interface CommentThreadParityDocSummary {
    docId: string;
    inlineThreadCount: number;
    matchingThreadCount: number;
    messageCountMismatches: string[];
    missingInInline: string[];
    missingInReview: string[];
    resolvedMismatches: string[];
    reviewThreadCount: number;
    selectedTextMismatches: string[];
}

function compareStringArrays(left: string[], right: string[]) {
    if (left.length!==right.length) {
        return false;
    }
    return left.every((value, index) => value===right[index]);
}

function getAllDocIds(
    inlineThreads: readonly CommentThreadDebugSummary[],
    reviewThreads: readonly CommentThreadDebugSummary[],
) {
    return Array.from(new Set([
        ...inlineThreads.map((thread) => thread.docId),
        ...reviewThreads.map((thread) => thread.docId),
    ])).sort((left, right) => left.localeCompare(right));
}

export function summarizeInlineCommentSnapshot(snapshot: OverleafDocumentCommentSnapshot | undefined): CommentThreadDebugSummary[] {
    if (!snapshot) {
        return [];
    }
    return snapshot.threads
        .filter(({thread}) => Boolean(thread && thread.messages.length > 0))
        .map(({range, thread}) => ({
            docId: snapshot.docId,
            messageCount: thread!.messages.length,
            messageIds: thread!.messages.map((message) => message.id),
            resolved: Boolean(thread!.resolved ?? range.resolved ?? range.op.resolved),
            rootMessageId: thread!.messages[0]?.id,
            selectedText: range.op.c,
            threadId: range.op.t,
        }))
        .sort((left, right) => left.threadId.localeCompare(right.threadId));
}

export function summarizeReviewEntries(entries: Iterable<OverleafReviewThreadEntry>): CommentThreadDebugSummary[] {
    return Array.from(entries)
        .map((entry) => ({
            docId: entry.docId,
            messageCount: entry.messages.length,
            messageIds: entry.messages.map((message) => message.id),
            resolved: entry.resolved,
            rootMessageId: entry.rootCommentId,
            selectedText: entry.selectedText,
            threadId: entry.threadId,
        }))
        .sort((left, right) => left.threadId.localeCompare(right.threadId));
}

export function buildCommentThreadParityByDocId(options: {
    inlineThreads: readonly CommentThreadDebugSummary[],
    reviewThreads: readonly CommentThreadDebugSummary[],
}) {
    return getAllDocIds(options.inlineThreads, options.reviewThreads).map<CommentThreadParityDocSummary>((docId) => {
        const inlineThreadsById = new Map(
            options.inlineThreads
                .filter((thread) => thread.docId===docId)
                .map((thread) => [thread.threadId, thread] as const),
        );
        const reviewThreadsById = new Map(
            options.reviewThreads
                .filter((thread) => thread.docId===docId)
                .map((thread) => [thread.threadId, thread] as const),
        );
        const missingInReview = Array.from(inlineThreadsById.keys())
            .filter((threadId) => !reviewThreadsById.has(threadId))
            .sort((left, right) => left.localeCompare(right));
        const missingInInline = Array.from(reviewThreadsById.keys())
            .filter((threadId) => !inlineThreadsById.has(threadId))
            .sort((left, right) => left.localeCompare(right));
        const sharedThreadIds = Array.from(inlineThreadsById.keys())
            .filter((threadId) => reviewThreadsById.has(threadId))
            .sort((left, right) => left.localeCompare(right));
        const messageCountMismatches: string[] = [];
        const resolvedMismatches: string[] = [];
        const selectedTextMismatches: string[] = [];
        for (const threadId of sharedThreadIds) {
            const inlineThread = inlineThreadsById.get(threadId)!;
            const reviewThread = reviewThreadsById.get(threadId)!;
            if (inlineThread.messageCount!==reviewThread.messageCount
                || !compareStringArrays(inlineThread.messageIds, reviewThread.messageIds)) {
                messageCountMismatches.push(threadId);
            }
            if (inlineThread.resolved!==reviewThread.resolved) {
                resolvedMismatches.push(threadId);
            }
            if (inlineThread.selectedText!==reviewThread.selectedText) {
                selectedTextMismatches.push(threadId);
            }
        }
        return {
            docId,
            inlineThreadCount: inlineThreadsById.size,
            matchingThreadCount: sharedThreadIds.length,
            messageCountMismatches,
            missingInInline,
            missingInReview,
            resolvedMismatches,
            reviewThreadCount: reviewThreadsById.size,
            selectedTextMismatches,
        };
    });
}
