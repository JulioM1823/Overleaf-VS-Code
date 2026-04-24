import { formatOverleafTimestamp } from '../utils/overleafTimestamp';

export function formatOverleafCommentTimestamp(
    timestamp: Date | number | string | undefined,
    now: Date = new Date(),
) {
    return formatOverleafTimestamp(timestamp, now);
}
