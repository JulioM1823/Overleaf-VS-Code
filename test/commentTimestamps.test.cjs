const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const {
    formatOverleafCommentTimestamp,
} = require('../out/comments/commentTimestamps.js');

test('formatOverleafCommentTimestamp matches Overleaf same-year formatting', () => {
    assert.equal(
        formatOverleafCommentTimestamp(new Date(2026, 3, 8, 6, 16).toISOString(), new Date(2026, 4, 1, 12)),
        '8 April, 6:16 am',
    );
});

test('formatOverleafCommentTimestamp includes the year for older timestamps', () => {
    assert.equal(
        formatOverleafCommentTimestamp(new Date(2025, 3, 8, 18, 16).toISOString(), new Date(2026, 4, 1, 12)),
        '8 April 2025, 6:16 pm',
    );
});

test('comment timestamps convert one instant into each viewer timezone', () => {
    const filename = path.resolve(__dirname, '../out/comments/commentTimestamps.js');
    const script = `const {formatOverleafCommentTimestamp}=require(${JSON.stringify(filename)}); process.stdout.write(formatOverleafCommentTimestamp('2026-04-08T12:16:00Z', new Date('2026-05-01T12:00:00Z')));`;
    for (const [timezone, expected] of [
        ['UTC', '8 April, 12:16 pm'],
        ['America/Denver', '8 April, 6:16 am'],
        ['Asia/Kolkata', '8 April, 5:46 pm'],
    ]) {
        const actual = execFileSync(process.execPath, ['-e', script], {
            env: {...process.env, TZ: timezone}, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(actual, expected, timezone);
    }
});

test('formatOverleafCommentTimestamp returns undefined for invalid timestamps', () => {
    assert.equal(
        formatOverleafCommentTimestamp('not-a-date', new Date('2026-05-01T12:00:00-06:00')),
        undefined,
    );
});
