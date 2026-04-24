const test = require('node:test');
const assert = require('node:assert/strict');

const {
    getSyncTarget,
    getHighlightLayout,
} = require('../views/pdf-viewer/syncHighlight.js');

test('getSyncTarget selects the midpoint sync result', () => {
    assert.deepEqual(
        getSyncTarget([
            {page: 1},
            {page: 2},
            {page: 3},
            {page: 4},
        ]),
        {page: 2},
    );
});

test('getSyncTarget returns undefined for empty sync results', () => {
    assert.equal(getSyncTarget([]), undefined);
});

test('getHighlightLayout clamps the marker and computes vertical scrolling', () => {
    assert.deepEqual(
        getHighlightLayout({
            left: 800,
            top: 250,
            pageWidth: 600,
            pageHeight: 900,
            pageOffsetLeft: 120,
            pageOffsetTop: 400,
            bodyHeight: 1000,
            scrollMode: 0,
        }),
        {
            highlightLeft: 600,
            highlightTop: 650,
            containerScrollLeft: undefined,
            containerScrollTop: 650,
        },
    );
});

test('getHighlightLayout uses page-level scrolling in horizontal mode', () => {
    assert.deepEqual(
        getHighlightLayout({
            left: -10,
            top: 950,
            pageWidth: 600,
            pageHeight: 900,
            pageOffsetLeft: 320,
            pageOffsetTop: 400,
            bodyHeight: 1000,
            scrollMode: 1,
        }),
        {
            highlightLeft: 0,
            highlightTop: 0,
            containerScrollLeft: 320,
            containerScrollTop: undefined,
        },
    );
});
