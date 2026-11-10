export function splitSafeProjectPath(pathname: string): string[] | undefined {
    if (pathname.includes('\0')) {
        return undefined;
    }

    const segments = pathname
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean);
    if (segments.some((segment) => segment === '.' || segment === '..'
        || /[<>:\"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
        return undefined;
    }
    return segments;
}

