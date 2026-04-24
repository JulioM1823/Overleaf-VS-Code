import { OverleafCommentMessage } from './types';

export interface OverleafReviewPosition {
    character: number;
    line: number;
    offset: number;
}

export interface OverleafReviewMessageEntry {
    authorName: string;
    canDelete: boolean;
    canEdit: boolean;
    content: string;
    deleteOwnOnly: boolean;
    id: string;
    isRoot: boolean;
    timestamp: string;
    userColor: string;
    userId?: string;
}

export interface OverleafReviewThreadEntry {
    canDeleteRootComment: boolean;
    canEditRootComment: boolean;
    canReply: boolean;
    canResolveThread: boolean;
    docId: string;
    filePath: string;
    headerPreview?: string;
    lastActivityAt: number;
    messages: OverleafReviewMessageEntry[];
    overleafUri: string;
    rangeEnd: OverleafReviewPosition;
    rangeStart: OverleafReviewPosition;
    resolved: boolean;
    rootCommentId?: string;
    rootCommentUserId?: string;
    selectedText: string;
    threadId: string;
}

function compareStringKeys(left: string, right: string) {
    if (left===right) {
        return 0;
    }
    return left < right ? -1 : 1;
}

function compareReviewPositions(left: OverleafReviewPosition, right: OverleafReviewPosition) {
    if (left.line!==right.line) {
        return left.line - right.line;
    }
    if (left.character!==right.character) {
        return left.character - right.character;
    }
    return left.offset - right.offset;
}

export function describeOverleafCommentAuthor(message: OverleafCommentMessage) {
    const user = message.user;
    return user?.name
        ?? [user?.first_name, user?.last_name].filter(Boolean).join(' ')
        ?? user?.email
        ?? message.user_id;
}

export function positionAtOffset(text: string, offset: number): OverleafReviewPosition {
    const clampedOffset = Math.min(Math.max(offset, 0), text.length);
    let line = 0;
    let character = 0;
    for (let index = 0; index < clampedOffset; index += 1) {
        if (text[index]==='\n') {
            line += 1;
            character = 0;
        } else {
            character += 1;
        }
    }
    return {
        character,
        line,
        offset: clampedOffset,
    };
}

export function compareReviewThreadEntries(left: OverleafReviewThreadEntry, right: OverleafReviewThreadEntry) {
    const filePathComparison = compareStringKeys(left.filePath, right.filePath);
    if (filePathComparison!==0) {
        return filePathComparison;
    }
    const rangeStartComparison = compareReviewPositions(left.rangeStart, right.rangeStart);
    if (rangeStartComparison!==0) {
        return rangeStartComparison;
    }
    const rangeEndComparison = compareReviewPositions(left.rangeEnd, right.rangeEnd);
    if (rangeEndComparison!==0) {
        return rangeEndComparison;
    }
    return compareStringKeys(left.threadId, right.threadId);
}

export function sortReviewThreadEntries(entries: Iterable<OverleafReviewThreadEntry>) {
    return Array.from(entries).sort(compareReviewThreadEntries);
}
