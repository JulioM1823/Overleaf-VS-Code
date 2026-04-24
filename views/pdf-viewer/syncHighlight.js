"use strict";

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.OverleafPdfSyncHighlight = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function getSyncTarget(pdf) {
        if (!Array.isArray(pdf) || pdf.length === 0) { return; }
        return pdf[Math.ceil(pdf.length / 2) - 1];
    }

    function getHighlightLayout({
        left,
        top,
        pageWidth,
        pageHeight,
        pageOffsetLeft,
        pageOffsetTop,
        bodyHeight,
        scrollMode,
    }) {
        const highlightLeft = clamp(left, 0, pageWidth);
        const highlightTop = clamp(pageHeight - top, 0, pageHeight);
        return {
            highlightLeft,
            highlightTop,
            containerScrollLeft: scrollMode === 1 ? pageOffsetLeft : undefined,
            containerScrollTop: scrollMode === 1 ? undefined : Math.max(pageOffsetTop + highlightTop - bodyHeight * 0.4, 0),
        };
    }

    return {
        clamp,
        getSyncTarget,
        getHighlightLayout,
    };
}));
