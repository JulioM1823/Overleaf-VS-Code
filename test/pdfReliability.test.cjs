const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isLikelyPdfPayload,
    resolvePdfUpdateDeliveryAction,
    shouldPreservePdfCacheOnReadFailure,
} = require('../out/core/pdfReliability.js');

test('resolvePdfUpdateDeliveryAction prioritizes disposed panels over all other states', () => {
    assert.equal(resolvePdfUpdateDeliveryAction(100, true, true), 'skip_disposed');
});

test('resolvePdfUpdateDeliveryAction skips empty caches before trying to queue or post', () => {
    assert.equal(resolvePdfUpdateDeliveryAction(0, false, false), 'skip_empty');
    assert.equal(resolvePdfUpdateDeliveryAction(-1, true, false), 'skip_empty');
});

test('resolvePdfUpdateDeliveryAction queues updates until the webview is ready', () => {
    assert.equal(resolvePdfUpdateDeliveryAction(100, false, false), 'queue_until_ready');
    assert.equal(resolvePdfUpdateDeliveryAction(100, true, false), 'post');
});

test('shouldPreservePdfCacheOnReadFailure preserves only non-empty cached PDFs', () => {
    assert.equal(shouldPreservePdfCacheOnReadFailure(0), false);
    assert.equal(shouldPreservePdfCacheOnReadFailure(1), true);
    assert.equal(shouldPreservePdfCacheOnReadFailure(2048), true);
});

test('isLikelyPdfPayload recognizes a pdf header within the opening bytes', () => {
    assert.equal(isLikelyPdfPayload(Buffer.from('%PDF-1.7\nbody')), true);
    assert.equal(isLikelyPdfPayload(Buffer.from('not a pdf payload')), false);
});
