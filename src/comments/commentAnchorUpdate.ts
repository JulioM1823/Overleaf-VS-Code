export interface CommentAnchorUpdate {
    doc: string;
    lastV?: number;
    op: [{
        c: string,
        p: number,
        t: string,
    }];
    v: number;
}

export function buildCommentAnchorUpdate(input: {
    docId: string,
    docVersion: number,
    lastVersion?: number,
    selectedText: string,
    startOffset: number,
    threadId: string,
}): CommentAnchorUpdate {
    return {
        doc: input.docId,
        lastV: input.lastVersion,
        op: [{
            c: input.selectedText,
            p: input.startOffset,
            t: input.threadId,
        }],
        v: input.docVersion,
    };
}
