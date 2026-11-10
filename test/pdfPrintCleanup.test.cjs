const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Execute the actual vendored class, with only the browser/encoder replaced.
// Synchronous image events and delayed encoding exercise lifecycle races.
function fixture({delayed = false, missingBlob = false} = {}) {
    const source = fs.readFileSync(require('node:path').join(__dirname, '../views/pdf-viewer/vendor/web/viewer.js'), 'utf8');
    const start = source.indexOf('class PDFPrintService {');
    const end = source.indexOf('exports.PDFPrintService = PDFPrintService;', start);
    assert(start > 0 && end > start);
    let encode;
    const urls = new Set(), revoked = [];
    let sequence = 0;
    const context = {
        URL: {createObjectURL: () => { const url = `blob:print-${++sequence}`; urls.add(url); return url; },
            revokeObjectURL: url => { revoked.push(url); urls.delete(url); }},
        document: {
            createElement: tag => {
                if (tag === 'canvas') { return {toBlob: callback => {
                    encode = () => callback(missingBlob ? null : {});
                    if (!delayed) { encode(); }
                }}; }
                if (tag === 'img') { return {set src(_value) { this.onload?.(); }}; }
                return {append() {}};
            },
            querySelector: () => ({removeAttribute() {}}),
        },
        ensureOverlay: async () => {}, overlayManager: {active: null}, dialog: {},
    };
    vm.runInNewContext(`let activeService;\n${source.slice(start, end)}\n` +
        'globalThis.createService = () => {activeService = new PDFPrintService({getOptionalContentConfig: () => Promise.resolve()}, [], {append() {}}, 150); return activeService;};', context);
    return {service: context.createService(), urls, revoked, encode: () => encode()};
}
test('completed prints release every page object URL at teardown', {timeout: 1000}, async () => {
    const f = fixture();
    for (let page = 0; page < 60; page++) { await f.service.useRenderedPage(); }
    assert.equal(f.urls.size, 60);
    f.service.destroy();await Promise.resolve();
    assert.equal(f.urls.size, 0);assert.equal(f.revoked.length, 60);
    f.service.destroy();assert.equal(f.revoked.length, 60);
});
test('cancelled printing cannot create late object URLs after teardown', async () => {
    const f = fixture({delayed: true});
    const rendering = f.service.useRenderedPage();
    const rejected = assert.rejects(rendering, /cancelled/);
    f.service.destroy();f.encode();await rejected;
    assert.equal(f.urls.size, 0);assert.equal(f.revoked.length, 0);
});
test('failed print encoding rejects instead of leaving the print job hanging', async () => {
    const f = fixture({missingBlob: true});
    await assert.rejects(f.service.useRenderedPage(), /could not be encoded/);
    f.service.destroy();assert.equal(f.urls.size, 0);
});
