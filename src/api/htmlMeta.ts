function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlAttribute(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

export function extractHtmlMetaContent(body: string, name: string): string | undefined {
    const escapedName = escapeRegExp(name);
    const patterns = [
        new RegExp(`<meta[^>]*name="${escapedName}"[^>]*content="([^"]*)"[^>]*>`, 'i'),
        new RegExp(`<meta[^>]*content="([^"]*)"[^>]*name="${escapedName}"[^>]*>`, 'i'),
        new RegExp(`<meta[^>]*name='${escapedName}'[^>]*content='([^']*)'[^>]*>`, 'i'),
        new RegExp(`<meta[^>]*content='([^']*)'[^>]*name='${escapedName}'[^>]*>`, 'i'),
    ];

    for (const pattern of patterns) {
        const match = pattern.exec(body);
        if (match?.[1] !== undefined) {
            return decodeHtmlAttribute(match[1]);
        }
    }

    return undefined;
}

export function extractJsonMetaContent<T>(body: string, name: string): T | undefined {
    const content = extractHtmlMetaContent(body, name);
    if (content === undefined || content === '') {
        return undefined;
    }

    return JSON.parse(content) as T;
}
