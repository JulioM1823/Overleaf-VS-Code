const COOKIE_ATTRIBUTE_NAMES = new Set([
    'domain',
    'expires',
    'httponly',
    'max-age',
    'path',
    'priority',
    'samesite',
    'secure',
    'partitioned',
]);

function parseCookiePair(rawCookie: string): [string, string] | undefined {
    const separatorIndex = rawCookie.indexOf('=');
    if (separatorIndex <= 0) {
        return undefined;
    }

    const name = rawCookie.slice(0, separatorIndex).trim();
    const value = rawCookie.slice(separatorIndex + 1).trim();
    if (!name || COOKIE_ATTRIBUTE_NAMES.has(name.toLowerCase())) {
        return undefined;
    }

    return [name, value];
}

function parseCookieHeader(cookieHeader: string): Map<string, string> {
    const cookieMap = new Map<string, string>();
    const normalizedHeader = cookieHeader.replace(/^cookie:\s*/i, '').trim();
    if (!normalizedHeader) {
        return cookieMap;
    }

    normalizedHeader.split(';').forEach((segment) => {
        const cookiePair = parseCookiePair(segment.trim());
        if (cookiePair) {
            const [name, value] = cookiePair;
            cookieMap.set(name, value);
        }
    });

    return cookieMap;
}

function serializeCookieHeader(cookieMap: Map<string, string>): string {
    return Array.from(cookieMap.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

export function normalizeCookieHeader(cookieHeader: string): string {
    return serializeCookieHeader(parseCookieHeader(cookieHeader));
}

export function mergeCookieHeaders(
    cookieHeader: string,
    setCookieHeaders: string[] = [],
): string {
    const cookieMap = parseCookieHeader(cookieHeader);

    setCookieHeaders.forEach((setCookieHeader) => {
        const firstCookieSegment = setCookieHeader.split(';', 1)[0]?.trim() ?? '';
        const cookiePair = parseCookiePair(firstCookieSegment);
        if (cookiePair) {
            const [name, value] = cookiePair;
            cookieMap.set(name, value);
        }
    });

    return serializeCookieHeader(cookieMap);
}
