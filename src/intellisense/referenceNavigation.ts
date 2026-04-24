export type ReferenceLabelMatch = {
    label: string,
    start: number,
    end: number,
};

const referenceCommandRegex = /\\(?!hyperref\b)\w*ref\*?(?:\[[^\]]*\])*\{([^}]*)\}/gm;
const citationCommandRegex = /\\(?:cite\w*|\w*cite)\*?(?:\[[^\]]*\])*\{([^}]*)\}/gm;

function splitReferenceLabels(content: string, startOffset: number): ReferenceLabelMatch[] {
    const matches: ReferenceLabelMatch[] = [];
    let segmentStart = 0;

    for (let index = 0; index <= content.length; index++) {
        if (index < content.length && content[index] !== ',') {
            continue;
        }

        const rawSegment = content.slice(segmentStart, index);
        const leadingWhitespace = rawSegment.match(/^\s*/)?.[0].length ?? 0;
        const trailingWhitespace = rawSegment.match(/\s*$/)?.[0].length ?? 0;
        const label = rawSegment.trim();
        if (label !== '') {
            const start = startOffset + segmentStart + leadingWhitespace;
            const end = startOffset + index - trailingWhitespace;
            matches.push({label, start, end});
        }
        segmentStart = index + 1;
    }

    return matches;
}

export function findReferenceLabelAtOffset(content: string, offset: number): ReferenceLabelMatch | undefined {
    referenceCommandRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = referenceCommandRegex.exec(content)) !== null) {
        const labelContent = match[1];
        const labelStart = match.index + match[0].lastIndexOf('{') + 1;
        const labelMatches = splitReferenceLabels(labelContent, labelStart);
        const labelMatch = labelMatches.find(item => offset >= item.start && offset < item.end);
        if (labelMatch) {
            return labelMatch;
        }
    }
}

export function findCitationKeyAtOffset(content: string, offset: number): ReferenceLabelMatch | undefined {
    citationCommandRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = citationCommandRegex.exec(content)) !== null) {
        const labelContent = match[1];
        const labelStart = match.index + match[0].lastIndexOf('{') + 1;
        const labelMatches = splitReferenceLabels(labelContent, labelStart);
        const labelMatch = labelMatches.find(item => offset >= item.start && offset < item.end);
        if (labelMatch) {
            return labelMatch;
        }
    }
}
