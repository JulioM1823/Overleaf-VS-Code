export function resolveStableCommentThreadAnchorShape(lineTextLength: number, hasLineBreak: boolean) {
    void hasLineBreak;
    if (lineTextLength > 0) {
        return {
            endCharacter: 1,
            useLineBreakFallback: false,
        };
    }

    return {
        endCharacter: 0,
        useLineBreakFallback: false,
    };
}

export function shouldPinCommentThreadToStartAnchor(input: {
    isOfflineMode: boolean,
    reason: string,
    rootMessageId?: string,
    synchronizationMode: string,
}) {
    const rootMessageId = input.rootMessageId ?? '';
    if (rootMessageId.startsWith('pending-comment-') || rootMessageId.startsWith('offline-comment-')) {
        return true;
    }

    if (input.isOfflineMode
        || input.synchronizationMode==='offline'
        || input.synchronizationMode==='sync-recovery') {
        return true;
    }

    return false;
}

export function resolveCommentThreadDisplayRange(input: {
    anchorLine: number,
    commentEndCharacter: number,
    commentEndLine: number,
    commentStartCharacter: number,
    commentStartLine: number,
    hasLineBreak: boolean,
    lineTextLength: number,
}) {
    const clampedStartCharacter = Math.min(Math.max(input.commentStartCharacter, 0), input.lineTextLength);
    if (input.lineTextLength > clampedStartCharacter) {
        return {
            endCharacter: clampedStartCharacter + 1,
            endLine: input.anchorLine,
            startCharacter: clampedStartCharacter,
            startLine: input.anchorLine,
        };
    }
    if (input.lineTextLength > 0) {
        const fallbackStartCharacter = Math.max(0, input.lineTextLength - 1);
        return {
            endCharacter: input.lineTextLength,
            endLine: input.anchorLine,
            startCharacter: fallbackStartCharacter,
            startLine: input.anchorLine,
        };
    }

    const shape = resolveStableCommentThreadAnchorShape(input.lineTextLength, input.hasLineBreak);
    if (shape.useLineBreakFallback) {
        return {
            endCharacter: 0,
            endLine: input.anchorLine + 1,
            startCharacter: 0,
            startLine: input.anchorLine,
        };
    }

    return {
        endCharacter: shape.endCharacter,
        endLine: input.anchorLine,
        startCharacter: 0,
        startLine: input.anchorLine,
    };
}

export function resolveCommentThreadExtentRange(input: {
    anchorLine: number,
    commentEndCharacter: number,
    commentEndLine: number,
    commentStartCharacter: number,
    commentStartLine: number,
    hasLineBreak: boolean,
    lineTextLength: number,
}) {
    const isEmpty = input.commentStartLine===input.commentEndLine
        && input.commentStartCharacter===input.commentEndCharacter;
    if (!isEmpty) {
        return {
            endCharacter: input.commentEndCharacter,
            endLine: input.commentEndLine,
            startCharacter: input.commentStartCharacter,
            startLine: input.commentStartLine,
        };
    }

    const shape = resolveStableCommentThreadAnchorShape(input.lineTextLength, input.hasLineBreak);
    if (shape.useLineBreakFallback) {
        return {
            endCharacter: 0,
            endLine: input.anchorLine + 1,
            startCharacter: 0,
            startLine: input.anchorLine,
        };
    }

    return {
        endCharacter: shape.endCharacter,
        endLine: input.anchorLine,
        startCharacter: 0,
        startLine: input.anchorLine,
    };
}

function comparePositions(
    leftLine: number,
    leftCharacter: number,
    rightLine: number,
    rightCharacter: number,
) {
    if (leftLine!==rightLine) {
        return leftLine - rightLine;
    }
    return leftCharacter - rightCharacter;
}

export function resolveViewportAdjustedCommentThreadRange(input: {
    baseEndCharacter: number,
    baseEndLine: number,
    baseStartCharacter: number,
    baseStartLine: number,
    visibleRanges: Array<{
        endCharacter: number,
        endLine: number,
        startCharacter: number,
        startLine: number,
    }>,
}) {
    for (const visibleRange of input.visibleRanges) {
        if (comparePositions(
            visibleRange.endLine,
            visibleRange.endCharacter,
            input.baseStartLine,
            input.baseStartCharacter,
        ) <= 0) {
            continue;
        }
        if (comparePositions(
            visibleRange.startLine,
            visibleRange.startCharacter,
            input.baseEndLine,
            input.baseEndCharacter,
        ) >= 0) {
            continue;
        }
        const startsOnLaterLogicalLine = visibleRange.startLine > input.baseStartLine;
        if (comparePositions(
            visibleRange.startLine,
            visibleRange.startCharacter,
            input.baseStartLine,
            input.baseStartCharacter,
        ) > 0 && startsOnLaterLogicalLine) {
            return {
                endCharacter: input.baseEndCharacter,
                endLine: input.baseEndLine,
                startCharacter: visibleRange.startCharacter,
                startLine: visibleRange.startLine,
            };
        }
        break;
    }

    return {
        endCharacter: input.baseEndCharacter,
        endLine: input.baseEndLine,
        startCharacter: input.baseStartCharacter,
        startLine: input.baseStartLine,
    };
}
