export function formatCommentThreadPreview(
    content: string | undefined,
    maxLength = 120,
) {
    if (!content) {
        return undefined;
    }

    const normalized = content.replace(/\s+/gu, ' ').trim();
    if (!normalized) {
        return undefined;
    }

    const quotedMaxLength = Math.max(0, maxLength - 2);

    if (normalized.length <= quotedMaxLength) {
        return `"${normalized}"`;
    }

    const truncated = normalized.slice(0, Math.max(0, quotedMaxLength - 1)).trimEnd();
    return `"${truncated}\u2026"`;
}
