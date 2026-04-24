const test = require('node:test');
const assert = require('node:assert/strict');

const {
    formatOverleafCommentTimestamp,
} = require('../out/comments/commentTimestamps.js');

test('formatOverleafCommentTimestamp matches Overleaf same-year formatting', () => {
    assert.equal(
        formatOverleafCommentTimestamp('2026-04-08T06:16:00-06:00', new Date('2026-05-01T12:00:00-06:00')),
        '8 April, 6:16 am',
    );
});

test('formatOverleafCommentTimestamp includes the year for older timestamps', () => {
    assert.equal(
        formatOverleafCommentTimestamp('2025-04-08T18:16:00-06:00', new Date('2026-05-01T12:00:00-06:00')),
        '8 April 2025, 6:16 pm',
    );
});

test('formatOverleafCommentTimestamp returns undefined for invalid timestamps', () => {
    assert.equal(
        formatOverleafCommentTimestamp('not-a-date', new Date('2026-05-01T12:00:00-06:00')),
        undefined,
    );
});
