// Pinned, integrity-checked build inputs. No archive may write through a symlink
// or outside its destination. These are build tools, never runtime downloads.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const JSZip = require('jszip');
const root = path.resolve(__dirname, '..');
const artifacts = {
    pdfjs: {
        url: 'https://github.com/mozilla/pdf.js/releases/download/v3.10.111/pdfjs-3.10.111-dist.zip',
        sha256: '95cf3d37f7614b420c19890cd460fdadb2d6cb2b788e5156a17a732d393c6417',
        directory: 'views/pdf-viewer/vendor', strip: 0,
    },
    latex: {
        url: 'https://github.com/jlelong/vscode-latex-basics/archive/refs/tags/v1.5.4.zip',
        sha256: '3c21ef4be37008e32d1aab78722e63621a6b1c25972df22cbb02c1e505d300ce',
        directory: 'data/vendor', strip: 1,
    },
};
async function assertNoSymlinks(rootPath, target) {
    const rel = path.relative(rootPath, target);
    if (rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Unsafe vendor path');
    let current = rootPath;
    for (const segment of ['', ...rel.split(path.sep).filter(Boolean)]) {
        current = path.join(current, segment);
        try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Symlink in vendor path'); }
        catch (error) { if (error.code!=='ENOENT') throw error; }
    }
}
async function install(name, bytes) {
    const artifact = artifacts[name];
    if (!artifact) throw new Error('Unknown vendor artifact');
    if (createHash('sha256').update(bytes).digest('hex')!==artifact.sha256) throw new Error(`${name} checksum mismatch`);
    const archive = await JSZip.loadAsync(bytes);
    const destination = path.join(root, artifact.directory);
    for (const entry of Object.values(archive.files)) {
        const original = entry.unsafeOriginalName ?? entry.name;
        if (/^[\\/]/.test(original) || original.includes('\\') || original.split('/').some(x => x==='..')
            || (Number(entry.unixPermissions) & 0o170000)===0o120000) throw new Error('Unsafe vendor archive entry');
        const parts = entry.name.split('/').filter(Boolean).slice(artifact.strip);
        if (!parts.length) continue;
        const target = path.join(destination, ...parts);
        await assertNoSymlinks(root, target);
        if (entry.dir) { await fs.mkdir(target, {recursive: true}); continue; }
        await fs.mkdir(path.dirname(target), {recursive: true});
        await fs.writeFile(target, await entry.async('nodebuffer'));
    }
    if (name==='pdfjs') {
        execFileSync('patch', ['--batch', '-p1', '-i', path.join(root, 'scripts/vendor-patches/pdfjs-3.10.111-dist.patch')], {cwd: destination, stdio: 'inherit'});
    }
}
async function main() {
    for (const name of process.argv[2] ? [process.argv[2]] : Object.keys(artifacts)) {
        if (!artifacts[name]) throw new Error('Unknown vendor artifact');
        const response = await fetch(artifacts[name].url, {signal: AbortSignal.timeout(60_000)});
        if (!response.ok || !response.url.startsWith('https://')) throw new Error(`Vendor download failed: ${response.status}`);
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
            length += chunk.length;
            if (length > 32 * 1024 * 1024) throw new Error('Vendor archive too large');
            chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks, length);
        await install(name, bytes);
    }
}
module.exports = {install, artifacts};
if (require.main===module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
