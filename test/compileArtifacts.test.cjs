const test = require('node:test');
const assert = require('node:assert/strict');

const {
    isPdfArtifact,
    isCompileLogArtifact,
    normalizeCompileArtifactPath,
    normalizeSyncResultFilePath,
    resolvePrimaryPdfOutputPath,
    resolvePrimaryPdfRenderPath,
    selectPrimaryPdfArtifact,
} = require('../out/compile/compileArtifacts.js');

test('normalizeCompileArtifactPath removes leading relative markers and normalizes separators', () => {
    assert.equal(normalizeCompileArtifactPath('./output.pdf'), 'output.pdf');
    assert.equal(normalizeCompileArtifactPath('/nested\\main.pdf'), 'nested/main.pdf');
});

test('selectPrimaryPdfArtifact prefers output.pdf and then the root document basename', () => {
    assert.equal(
        selectPrimaryPdfArtifact([
            {path: 'appendix.pdf', type: 'pdf'},
            {path: 'output.pdf', type: 'pdf'},
            {path: 'main.pdf', type: 'pdf'},
        ], '/main.tex')?.path,
        'output.pdf',
    );
    assert.equal(
        selectPrimaryPdfArtifact([
            {path: 'appendix.pdf', type: 'pdf'},
            {path: 'main.pdf', type: 'pdf'},
        ], '/main.tex')?.path,
        'main.pdf',
    );
});

test('resolvePrimaryPdfOutputPath prefixes the configured output folder', () => {
    assert.equal(
        resolvePrimaryPdfOutputPath([{path: './output.pdf', type: 'pdf'}], '/main.tex', '.output'),
        '.output/output.pdf',
    );
});

test('resolvePrimaryPdfRenderPath places the primary PDF next to the root document', () => {
    assert.equal(
        resolvePrimaryPdfRenderPath([{path: './output.pdf', type: 'pdf'}], '/chapters/main.tex'),
        'chapters/main.pdf',
    );
    assert.equal(
        resolvePrimaryPdfRenderPath([{path: './output.pdf', type: 'pdf'}], '/page_one.tex'),
        'page_one.pdf',
    );
    assert.equal(
        resolvePrimaryPdfRenderPath([{path: './appendix.pdf', type: 'pdf'}], ''),
        'appendix.pdf',
    );
});

test('normalizeSyncResultFilePath keeps sources and maps output files into the output folder', () => {
    assert.equal(normalizeSyncResultFilePath('./sections/intro.tex', '.output'), 'sections/intro.tex');
    assert.equal(normalizeSyncResultFilePath('output.aux', '.output'), '.output/output.aux');
});

test('isPdfArtifact recognizes pdf type and file extension', () => {
    assert.equal(isPdfArtifact({path: 'build/result.pdf'}), true);
    assert.equal(isPdfArtifact({path: 'build/result.bin', type: 'pdf'}), true);
    assert.equal(isPdfArtifact({path: 'build/result.log'}), false);
});

test('isCompileLogArtifact recognizes output.log artifacts', () => {
    assert.equal(isCompileLogArtifact({path: 'output.log'}), true);
    assert.equal(isCompileLogArtifact({path: './nested/output.log'}), true);
    assert.equal(isCompileLogArtifact({path: 'main.log'}), false);
});
