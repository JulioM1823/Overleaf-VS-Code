function normalizeTimestampValue(timestamp: Date | number | string | undefined) {
    if (timestamp instanceof Date) {
        return Number.isNaN(timestamp.valueOf()) ? undefined : timestamp;
    }
    if (typeof timestamp === 'number' || typeof timestamp === 'string') {
        const parsed = new Date(timestamp);
        if (!Number.isNaN(parsed.valueOf())) {
            return parsed;
        }
    }
    return undefined;
}

function formatLowercaseTime(date: Date) {
    return new Intl.DateTimeFormat('en', {
        hour: 'numeric',
        hour12: true,
        minute: '2-digit',
    }).format(date).replace(/\s?(AM|PM)$/u, (match) => match.toLowerCase());
}

export function formatOverleafTimestamp(
    timestamp: Date | number | string | undefined,
    now: Date = new Date(),
) {
    const date = normalizeTimestampValue(timestamp);
    if (!date) {
        return undefined;
    }
    const includeYear = now.getFullYear()!==date.getFullYear();
    const month = new Intl.DateTimeFormat('en', {month: 'long'}).format(date);
    const time = formatLowercaseTime(date);
    if (includeYear) {
        return `${date.getDate()} ${month} ${date.getFullYear()}, ${time}`;
    }
    return `${date.getDate()} ${month}, ${time}`;
}
