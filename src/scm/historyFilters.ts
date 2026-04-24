type HistoryContributorUser = {
    id?: string,
    email?: string,
    [key: string]: string | undefined,
};

type HistoryRevisionUsers = {
    users: HistoryContributorUser[],
};

export interface HistoryContributorOption {
    description?: string,
    key: string,
    label: string,
    versionCount: number,
}

function normalizeName(user: HistoryContributorUser) {
    return [user['first_name'], user['last_name']].filter(Boolean).join(' ').trim();
}

export function normalizeHistoryContributorKey(user: HistoryContributorUser) {
    if (user.id) {
        return `id:${user.id}`;
    }
    if (user.email) {
        return `email:${user.email.toLowerCase()}`;
    }
    const name = normalizeName(user);
    if (name) {
        return `name:${name.toLowerCase()}`;
    }
    return undefined;
}

export function formatHistoryContributorLabel(user: HistoryContributorUser) {
    return normalizeName(user) || user.email || user.id || 'Unknown contributor';
}

export function collectHistoryContributorOptions(revisions: Record<number, HistoryRevisionUsers>) {
    const contributors = new Map<string, HistoryContributorOption>();

    for (const revision of Object.values(revisions)) {
        const seenInRevision = new Set<string>();
        for (const user of revision.users) {
            const key = normalizeHistoryContributorKey(user);
            if (!key || seenInRevision.has(key)) {
                continue;
            }
            seenInRevision.add(key);
            const existing = contributors.get(key);
            if (existing) {
                existing.versionCount += 1;
                continue;
            }
            const label = formatHistoryContributorLabel(user);
            const description = user.email && user.email !== label ? user.email : undefined;
            contributors.set(key, {
                description,
                key,
                label,
                versionCount: 1,
            });
        }
    }

    return [...contributors.values()].sort((left, right) => {
        if (left.versionCount !== right.versionCount) {
            return right.versionCount - left.versionCount;
        }
        return left.label.localeCompare(right.label);
    });
}

export function filterHistoryVersionsByContributor(
    versions: number[],
    revisions: Record<number, HistoryRevisionUsers>,
    contributorKey?: string,
) {
    if (!contributorKey) {
        return [...versions];
    }

    return versions.filter(version => {
        const revision = revisions[version];
        if (!revision) {
            return false;
        }
        return revision.users.some(user => normalizeHistoryContributorKey(user) === contributorKey);
    });
}
