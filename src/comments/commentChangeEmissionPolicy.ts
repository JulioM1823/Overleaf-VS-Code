export function shouldDeferThreadOnlyCommentCreateChange(input: {
    docIds: string[];
    hasPreviousThread: boolean;
    reason: string;
}) {
    return input.docIds.length===0
        && !input.hasPreviousThread
        && (input.reason==='thread_message_created'
            || input.reason==='thread_message_created_offline');
}
