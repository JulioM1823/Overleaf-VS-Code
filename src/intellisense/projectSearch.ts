export type ProjectSearchQueryMode = 'literal' | 'regex';

export interface NormalizedProjectSearchQuery {
    display: string,
    flags: string,
    mode: ProjectSearchQueryMode,
    regex: RegExp,
}

export interface ProjectSearchMatch {
    endColumn: number,
    line: number,
    lineText: string,
    matchText: string,
    preview: string,
    startColumn: number,
}

const obviousBinaryExtensionRegex = /\.(?:7z|ai|avi|bmp|class|dll|docx?|dylib|eot|eps|exe|gif|gz|ico|jpe?g|m4a|mov|mp3|mp4|obj|otf|pdf|png|pptx?|psd|pyc|rar|so|tar|tif?f|ttf|wav|webm|webp|woff2?|xls[xm]?|zip)$/i;

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimPreview(value: string, maxLength = 140) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength - 1)}…`;
}

function collapsePreviewWhitespace(value: string) {
    return value.replace(/\s+/g, ' ').trim();
}

function isRegexQuery(input: string) {
    if (!input.startsWith('/')) {
        return false;
    }
    const lastSlash = input.lastIndexOf('/');
    if (lastSlash <= 0) {
        return false;
    }
    const flags = input.slice(lastSlash + 1);
    return /^[dgimsuy]*$/.test(flags);
}

function ensureGlobalFlag(flags: string) {
    return flags.includes('g') ? flags : `${flags}g`;
}

function buildLineStartOffsets(content: string) {
    const offsets = [0];
    for (let index = 0; index < content.length; index++) {
        if (content[index] === '\n') {
            offsets.push(index + 1);
        }
    }
    return offsets;
}

function findLineIndex(lineStartOffsets: number[], offset: number) {
    let left = 0;
    let right = lineStartOffsets.length - 1;
    while (left <= right) {
        const middle = Math.floor((left + right) / 2);
        const lineStart = lineStartOffsets[middle];
        const nextLineStart = middle + 1 < lineStartOffsets.length ? lineStartOffsets[middle + 1] : Number.POSITIVE_INFINITY;
        if (offset < lineStart) {
            right = middle - 1;
            continue;
        }
        if (offset >= nextLineStart) {
            left = middle + 1;
            continue;
        }
        return middle;
    }
    return Math.max(0, lineStartOffsets.length - 1);
}

export function normalizeProjectSearchQuery(input: string): NormalizedProjectSearchQuery {
    const trimmed = input.trim();
    if (trimmed === '') {
        throw new Error('Search query is empty.');
    }

    if (isRegexQuery(trimmed)) {
        const lastSlash = trimmed.lastIndexOf('/');
        const pattern = trimmed.slice(1, lastSlash);
        const flags = ensureGlobalFlag(trimmed.slice(lastSlash + 1));
        return {
            display: trimmed,
            flags,
            mode: 'regex',
            regex: new RegExp(pattern, flags),
        };
    }

    return {
        display: trimmed,
        flags: 'gi',
        mode: 'literal',
        regex: new RegExp(escapeRegExp(trimmed), 'gi'),
    };
}

export function isSearchableProjectPath(path: string, outputFolderName: string) {
    const normalizedPath = path.toLowerCase();
    const normalizedOutputFolder = outputFolderName.toLowerCase();
    if (normalizedPath === `/${normalizedOutputFolder}` || normalizedPath.startsWith(`/${normalizedOutputFolder}/`)) {
        return false;
    }
    if (obviousBinaryExtensionRegex.test(normalizedPath)) {
        return false;
    }
    return true;
}

export function decodeSearchableTextContent(content: Uint8Array) {
    if (content.length === 0) {
        return '';
    }
    if (content.includes(0)) {
        return undefined;
    }

    const decoded = new TextDecoder().decode(content);
    const replacementCharacterCount = decoded.match(/\uFFFD/g)?.length ?? 0;
    if (replacementCharacterCount > Math.max(2, Math.floor(decoded.length * 0.02))) {
        return undefined;
    }
    return decoded;
}

export function findProjectSearchMatches(content: string, regex: RegExp, maxPerFile = 20): ProjectSearchMatch[] {
    const matches: ProjectSearchMatch[] = [];
    const flags = ensureGlobalFlag(regex.flags);
    const searchRegex = new RegExp(regex.source, flags);
    const lineStartOffsets = buildLineStartOffsets(content);

    let match: RegExpExecArray | null;
    while ((match = searchRegex.exec(content)) !== null) {
        const matchText = match[0] ?? '';
        if (matchText === '') {
            searchRegex.lastIndex += 1;
            continue;
        }

        const line = findLineIndex(lineStartOffsets, match.index);
        const lineStart = lineStartOffsets[line];
        const lineEndCandidate = content.indexOf('\n', match.index);
        const lineEnd = lineEndCandidate === -1 ? content.length : lineEndCandidate;
        const lineText = content.slice(lineStart, lineEnd);
        const startColumn = match.index - lineStart;
        const endColumn = startColumn + matchText.length;
        matches.push({
            endColumn,
            line,
            lineText,
            matchText,
            preview: trimPreview(collapsePreviewWhitespace(lineText)),
            startColumn,
        });
        if (matches.length >= maxPerFile) {
            break;
        }
    }

    return matches;
}
