/* eslint-disable @typescript-eslint/naming-convention */
export type OverleafPermissionsLevel = 'owner' | 'readAndWrite' | 'readOnly' | 'review';

export interface OverleafCommentAuthor {
    id: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    name?: string;
    avatar_text?: string;
    hue?: number;
    isSelf?: boolean;
}

export interface OverleafCommentMessage {
    content: string;
    edited_at?: number | string;
    id: string;
    timestamp: Date | number | string;
    user?: OverleafCommentAuthor;
    user_id: string;
}

export interface OverleafCommentThread {
    messages: OverleafCommentMessage[];
    resolved?: boolean;
    resolved_at?: string;
    resolved_by_user?: OverleafCommentAuthor;
    resolved_by_user_id?: string;
}

export interface OverleafCommentMetadata {
    ts?: Date | number | string;
    user_id?: string | null;
}

export interface OverleafCommentOperation {
    c: string;
    p: number;
    resolved?: boolean;
    t: string;
}

export interface OverleafCommentRange {
    id: string;
    metadata?: OverleafCommentMetadata;
    op: OverleafCommentOperation;
    resolved?: boolean;
}

export interface OverleafCommentPermissions {
    comment: boolean;
    read: boolean;
    resolveAllComments: boolean;
    resolveOwnComments: boolean;
    write: boolean;
}

export interface OverleafDocumentCommentSnapshot {
    docId: string;
    permissions: OverleafCommentPermissions;
    threads: Array<{
        range: OverleafCommentRange;
        thread?: OverleafCommentThread;
    }>;
}
