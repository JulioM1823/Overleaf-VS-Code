export type CitationEntry = {
    key: string,
    title?: string,
    author?: string,
    year?: string,
    journal?: string,
    booktitle?: string,
    publisher?: string,
    doi?: string,
    summary?: string,
    source: 'bib' | 'bbl',
};

function collapseWhitespace(value: string) {
    return value.replace(/\s+/g, ' ').trim();
}

function stripLatexMarkup(value: string) {
    return collapseWhitespace(
        value
            .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1')
            .replace(/\\url\{([^}]*)\}/g, '$1')
            .replace(/\\(?:textit|textbf|emph|mkbibemph|enquote|underline|textsc)\*?(?:\[[^\]]*\])?\{([^}]*)\}/g, '$1')
            .replace(/\\&/g, '&')
            .replace(/\\_/g, '_')
            .replace(/\\-/g, '-')
            .replace(/~/g, ' ')
            .replace(/[{}]/g, '')
            .replace(/\\[a-zA-Z]+\*?/g, '')
    );
}

function readDelimitedValue(content: string, start: number) {
    const open = content[start];
    if (open === '{') {
        let depth = 1;
        let index = start + 1;
        let value = '';
        while (index < content.length && depth > 0) {
            const char = content[index];
            if (char === '{') {
                depth++;
            } else if (char === '}') {
                depth--;
            }
            if (depth > 0) {
                value += char;
            }
            index++;
        }
        return {value, next: index};
    }

    let index = start + 1;
    let value = '';
    let braceDepth = 0;
    while (index < content.length) {
        const char = content[index];
        if (char === '{') {
            braceDepth++;
        } else if (char === '}') {
            braceDepth = Math.max(braceDepth - 1, 0);
        } else if (char === '"' && braceDepth === 0) {
            index++;
            break;
        }
        value += char;
        index++;
    }
    return {value, next: index};
}

function parseBibFields(body: string) {
    const fields: Record<string, string> = {};
    let index = 0;

    while (index < body.length) {
        while (index < body.length && /[\s,]/.test(body[index])) {
            index++;
        }
        const nameStart = index;
        while (index < body.length && /[\w-]/.test(body[index])) {
            index++;
        }
        const name = body.slice(nameStart, index).toLowerCase();
        while (index < body.length && /\s/.test(body[index])) {
            index++;
        }
        if (body[index] !== '=') {
            index++;
            continue;
        }
        index++;
        while (index < body.length && /\s/.test(body[index])) {
            index++;
        }

        let rawValue = '';
        if (body[index] === '{' || body[index] === '"') {
            const parsed = readDelimitedValue(body, index);
            rawValue = parsed.value;
            index = parsed.next;
        } else {
            const valueStart = index;
            while (index < body.length && body[index] !== ',') {
                index++;
            }
            rawValue = body.slice(valueStart, index);
        }

        if (name !== '') {
            fields[name] = stripLatexMarkup(rawValue);
        }
    }

    return fields;
}

export function parseBibEntries(content: string): CitationEntry[] {
    const entries: CitationEntry[] = [];
    const entryStartRegex = /@([a-zA-Z]+)\s*([{(])/g;
    let entryStartMatch: RegExpExecArray | null;

    while ((entryStartMatch = entryStartRegex.exec(content)) !== null) {
        const entryType = entryStartMatch[1].toLowerCase();
        const delimiterIndex = entryStartRegex.lastIndex - 1;
        const openChar = entryStartMatch[2];
        const closeChar = openChar === '{' ? '}' : ')';
        let cursor = delimiterIndex + 1;

        let depth = 1;
        let inQuote = false;
        let entryContent = '';
        while (cursor < content.length && depth > 0) {
            const char = content[cursor];
            const prev = content[cursor - 1];
            if (char === '"' && prev !== '\\') {
                inQuote = !inQuote;
            } else if (!inQuote && char === openChar) {
                depth++;
            } else if (!inQuote && char === closeChar) {
                depth--;
            }
            if (depth > 0) {
                entryContent += char;
            }
            cursor++;
        }

        if (!['comment', 'preamble', 'string'].includes(entryType)) {
            const keyEnd = entryContent.indexOf(',');
            if (keyEnd === -1) {
                entryStartRegex.lastIndex = cursor;
                continue;
            }
            const key = entryContent.slice(0, keyEnd).trim();
            const body = entryContent.slice(keyEnd + 1);
            if (key === '') {
                entryStartRegex.lastIndex = cursor;
                continue;
            }
            const fields = parseBibFields(body);
            entries.push({
                key,
                title: fields.title,
                author: fields.author,
                year: fields.year,
                journal: fields.journal,
                booktitle: fields.booktitle,
                publisher: fields.publisher,
                doi: fields.doi,
                source: 'bib',
            });
        }
        entryStartRegex.lastIndex = cursor;
    }

    return entries;
}

export function parseBblEntries(content: string): CitationEntry[] {
    const entries: CitationEntry[] = [];
    const bibitemRegex = /\\bibitem(?:\[[^\]]*\])?\{([^}]*)\}([\s\S]*?)(?=\\bibitem(?:\[[^\]]*\])?\{|$)/g;
    let match: RegExpExecArray | null;
    while ((match = bibitemRegex.exec(content)) !== null) {
        entries.push({
            key: match[1],
            summary: stripLatexMarkup(match[2]),
            source: 'bbl',
        });
    }
    return entries;
}
