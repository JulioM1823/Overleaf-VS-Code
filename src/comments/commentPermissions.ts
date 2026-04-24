import { OverleafCommentPermissions, OverleafPermissionsLevel } from './types';

const basePermissionsMap: Readonly<Record<OverleafPermissionsLevel, OverleafCommentPermissions>> = {
    readOnly: {
        comment: true,
        read: true,
        resolveAllComments: false,
        resolveOwnComments: false,
        write: false,
    },
    review: {
        comment: true,
        read: true,
        resolveAllComments: false,
        resolveOwnComments: true,
        write: false,
    },
    readAndWrite: {
        comment: true,
        read: true,
        resolveAllComments: true,
        resolveOwnComments: true,
        write: true,
    },
    owner: {
        comment: true,
        read: true,
        resolveAllComments: true,
        resolveOwnComments: true,
        write: true,
    },
};

export function resolveCommentPermissions(
    permissionsLevel: OverleafPermissionsLevel | undefined,
    options: {
        anonymous?: boolean,
        fallbackReadonly?: boolean,
    } = {},
): OverleafCommentPermissions {
    const basePermissions = basePermissionsMap[permissionsLevel ?? 'readOnly'];
    const permissions = {...basePermissions};

    if (options.anonymous) {
        permissions.comment = false;
    }

    if (options.fallbackReadonly) {
        permissions.comment = false;
        permissions.write = false;
        permissions.resolveAllComments = false;
        permissions.resolveOwnComments = false;
    }

    return permissions;
}

export function canEditOwnComment(
    permissions: OverleafCommentPermissions,
    currentUserId: string | undefined,
    messageUserId: string | undefined,
) {
    return Boolean(permissions.comment && currentUserId && messageUserId && currentUserId===messageUserId);
}

export function canDeleteCommentMessage(
    permissions: OverleafCommentPermissions,
    currentUserId: string | undefined,
    messageUserId: string | undefined,
) {
    if (permissions.resolveAllComments) {
        return true;
    }
    return Boolean(permissions.resolveOwnComments && currentUserId && messageUserId && currentUserId===messageUserId);
}

export function canDeleteThread(
    permissions: OverleafCommentPermissions,
    currentUserId: string | undefined,
    threadAuthorUserId: string | undefined,
) {
    if (permissions.resolveAllComments) {
        return true;
    }
    return Boolean(permissions.resolveOwnComments && currentUserId && threadAuthorUserId && currentUserId===threadAuthorUserId);
}
