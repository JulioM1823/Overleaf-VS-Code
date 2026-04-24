import { OverleafCommentThread } from './types';

export function findCommentThreadIdsByMessageId(
    threads: Iterable<[string, OverleafCommentThread | undefined]>,
    messageId: string,
) {
    const threadIds: string[] = [];
    for (const [threadId, thread] of threads) {
        if (thread?.messages.some((message) => message.id===messageId)) {
            threadIds.push(threadId);
        }
    }
    return threadIds;
}

export function findCommentThreadIdByMessageId(
    threads: Iterable<[string, OverleafCommentThread | undefined]>,
    messageId: string,
) {
    return findCommentThreadIdsByMessageId(threads, messageId)[0];
}
