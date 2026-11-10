// Validate public-release metadata and the exact corresponding-source payload.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const JSZip = require('jszip');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative));
const json = relative => JSON.parse(read(relative));

async function main() {
    const pkg = json('package.json');
    assert.equal(pkg.name, 'orbitleaf');
    assert.equal(pkg.publisher, 'AstroJulio');
    assert.equal(pkg.displayName, 'Overleaf-VS Code');
    assert.equal(pkg.repository.url, 'https://github.com/JulioM1823/Overleaf-VS-Code');
    assert.equal(pkg.bugs.url, 'https://github.com/JulioM1823/Overleaf-VS-Code/issues');
    assert.equal(pkg.homepage, 'https://github.com/JulioM1823/Overleaf-VS-Code#readme');
    assert.equal(pkg.license, 'AGPL-3.0-only');
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert(pkg.contributes.commands.every(command => command.command.startsWith('overleaf-workshop.')));
    assert(Object.keys(pkg.contributes.configuration.properties).every(key => key.startsWith('overleaf-workshop.')));
    assert(pkg.activationEvents.includes('onFileSystem:overleaf-workshop'));
    assert.equal(json('package.nls.json')['extension.displayName'], 'Overleaf-VS Code');
    const paragraphs = read('README.md').toString().trim().split(/\r?\n\s*\r?\n/);
    assert.equal(paragraphs[2], 'This extension is built on the source code of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop), developed by iamhyc and the Overleaf Workshop contributors.');
    assert(paragraphs[3].includes('**AstroJulio**'));
    const icon = read(pkg.icon);
    assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert(icon.readUInt32BE(16) >= 128 && icon.readUInt32BE(20) >= 128);
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'source/README.md', 'out/extension.js', 'views/chat-view/dist/index.html', 'views/pdf-viewer/vendor/LICENSE', 'views/pdf-viewer/vendor/build/pdf.js', 'views/pdf-viewer/vendor/build/pdf.worker.js', 'data/vendor/languages/latex-language-configuration.json']) read(file);
    assert(read('LICENSE').toString().includes('GNU AFFERO GENERAL PUBLIC LICENSE'));
    const source = json('source/manifest.json');
    assert.equal(source.extensionId, `${pkg.publisher}.${pkg.name}`);
    assert.equal(source.version, pkg.version);
    const archive = read(`source/${source.archive}`);
    assert.equal(hash(archive), source.sha256);
    const zip = await JSZip.loadAsync(archive);
    for (const entry of source.files) {
        assert.equal(hash(read(entry.path)), entry.sha256, `Source is stale: ${entry.path}`);
        const file = zip.file(entry.path);
        assert(file, `Source missing ${entry.path}`);
        assert.equal(hash(await file.async('nodebuffer')), entry.sha256, `Source archive mismatch: ${entry.path}`);
    }
    for (const required of ['src/extension.ts', 'scripts/install-vendor.cjs', 'scripts/package-source.cjs', 'package-lock.json', 'views/chat-view/package-lock.json', 'scripts/vendor-patches/pdfjs-3.10.111-dist.patch']) assert(zip.file(required), `Source missing ${required}`);
    console.log(JSON.stringify({status:'passed', extensionId:source.extensionId, version:pkg.version, sourceFiles:source.files.length, sourceSha256:source.sha256}));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
