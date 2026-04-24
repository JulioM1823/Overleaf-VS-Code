const { createStructuredRecorder } = require('./structuredRecorder.cjs');
const {
    createCorruptPdfFixture,
    createMinimalPdfFixture,
} = require('../fixtures/pdf/minimalPdf.cjs');

const recorder = createStructuredRecorder('PdfFixtures');

function loadPdfFixture(name) {
    let buffer;
    switch (name) {
        case 'corrupt.pdf':
            buffer = createCorruptPdfFixture();
            break;
        case 'minimal.pdf':
            buffer = createMinimalPdfFixture();
            break;
        default:
            throw new Error(`Unknown PDF fixture: ${name}`);
    }
    recorder.record('fixture.loaded', {
        bytes: buffer.length,
        name,
    });
    return buffer;
}

function getPdfFixtureEvents() {
    return recorder.snapshot();
}

module.exports = {
    getPdfFixtureEvents,
    loadPdfFixture,
};
