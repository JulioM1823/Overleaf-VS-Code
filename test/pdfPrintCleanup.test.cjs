const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Execute the actual vendored class, with only the browser/encoder replaced.
// Synchronous image events and delayed encoding exercise lifecycle races.
function fixture({delayed = false, missingBlob = false, encoder} = {}) {
    const source = fs.readFileSync(require('node:path').join(__dirname, '../views/pdf-viewer/vendor/web/viewer.js'), 'utf8');
    const start = source.indexOf('class PDFPrintService {');
    const end = source.indexOf('exports.PDFPrintService = PDFPrintService;', start);
    assert(start > 0 && end > start);
    let encode;
    const urls = new Set(), revoked = [];
    let sequence = 0;
    let legacyEncodes = 0;
    const context = {
        OverleafPdfPrintEncoder: encoder && {create: () => encoder},
        URL: {createObjectURL: () => { const url = `blob:print-${++sequence}`; urls.add(url); return url; },
            revokeObjectURL: url => { revoked.push(url); urls.delete(url); }},
        document: {
            createElement: tag => {
                if (tag === 'canvas') { return {toBlob: callback => {
                    legacyEncodes++;
                    encode = () => callback(missingBlob ? null : {});
                    if (!delayed) { encode(); }
                }}; }
                if (tag === 'img') { return {set src(_value) { this.onload?.(); }}; }
                return {append() {}};
            },
            querySelector: () => ({removeAttribute() {}}),
        },
        ensureOverlay: async () => {}, overlayManager: {active: null}, dialog: {},
        renderPage: () => Promise.resolve(), renderProgress: () => {},
    };
    vm.runInNewContext(`let activeService;\n${source.slice(start, end)}\n` +
        'globalThis.createService = () => {activeService = new PDFPrintService({getOptionalContentConfig: () => Promise.resolve()}, [], {append() {}}, 150); return activeService;};', context);
    return {service: context.createService(), urls, revoked, encode: () => encode(), legacyEncodes: () => legacyEncodes};
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

test('worker-encoded print pages release both page URLs and encoder at teardown', async () => {
    let disposed = 0;
    const f = fixture({encoder: {encode: async () => ({}), dispose: () => disposed++}});
    for (let page = 0; page < 60; page++) { await f.service.useRenderedPage(); }
    assert.equal(f.legacyEncodes(), 0); assert.equal(f.urls.size, 60);
    f.service.destroy(); f.service.destroy();
    assert.equal(disposed, 1); assert.equal(f.urls.size, 0);
});
test('worker failures fall back once and preserve the original print path', async () => {
    let attempts = 0, disposed = 0;
    const f = fixture({encoder: {encode: async () => { attempts++; throw Error('worker unavailable'); }, dispose: () => disposed++}});
    await f.service.useRenderedPage(); await f.service.useRenderedPage();
    assert.equal(attempts, 1); assert.equal(disposed, 1); assert.equal(f.legacyEncodes(), 2);
    f.service.destroy(); assert.equal(f.urls.size, 0);
});
test('cancelling worker print delivery cannot allocate image URLs or fall back after teardown', async () => {
    let cancel;
    const encoder = {encode: () => new Promise((_resolve, reject) => cancel = reject), dispose: () => cancel(Error('cancelled'))};
    const f = fixture({encoder});
    const pending = f.service.useRenderedPage(); const rejected = assert.rejects(pending, /cancelled/);
    f.service.destroy(); await rejected;
    assert.equal(f.legacyEncodes(), 0); assert.equal(f.urls.size, 0);
});

test('cancelling between printed pages rejects the whole job instead of stranding its promise', {timeout: 1000}, async () => {
    const f = fixture(); f.service.pagesOverview = [{}, {}];
    f.service.useRenderedPage = async () => f.service.destroy();
    await assert.rejects(f.service.renderPages(), /cancelled/);
});
