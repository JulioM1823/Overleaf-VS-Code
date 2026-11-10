// Build the exact corresponding extension source shipped with the VSIX.
// A fixed timestamp and sorted paths make repeated runs byte-for-byte stable.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const JSZip = require('jszip');

const root = path.resolve(__dirname, '..');
const epoch = new Date('1980-01-01T00:00:00.000Z');
const includedRoots = [
    'src', 'scripts', 'patches', 'test', 'data', 'resources', 'l10n', '.github',
    'views/chat-view', 'views/pdf-viewer',
];
const includedFiles = [
    'package.json', 'package-lock.json', 'package.nls.json', 'tsconfig.json',
    '.eslintrc.json', '.vscodeignore', '.gitignore', 'commitlint.config.js',
    'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'source/README.md',
];
const omittedSegments = new Set(['node_modules', '.git', '.DS_Store', 'dist']);
const omittedPrefixes = ['docs/assets/', 'views/pdf-viewer/vendor/', 'data/vendor/'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function collect(directory, files) {
    const absolute = path.join(root, directory);
    for (const entry of fs.readdirSync(absolute, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (omittedSegments.has(entry.name)) continue;
        const relative = `${directory}/${entry.name}`;
        if (omittedPrefixes.some(prefix => relative.startsWith(prefix))) continue;
        if (entry.isSymbolicLink()) throw new Error(`Source archive refuses symlink: ${relative}`);
        if (entry.isDirectory()) collect(relative, files);
        else if (entry.isFile()) {
            if (/^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|vsix))$/i.test(entry.name)) {
                throw new Error(`Unexpected private or development file in source inputs: ${relative}`);
            }
            files.add(relative);
        }
    }
}

function writeThirdPartyNotices() {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'views/chat-view/package-lock.json'), 'utf8'));
    let notices = `# Third-party notices\n\nThis release is built on [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop), developed by iamhyc and the Overleaf Workshop contributors. The extension's license is the GNU Affero General Public License version 3; see LICENSE. Original notices in the source and dependencies are retained.\n\n## Extension icon\n\nThe Overleaf O-and-leaf symbol is based on the [official Overleaf logo](https://www.overleaf.com/for/partners/logos). Overleaf-VS Code is independently published by AstroJulio and is not an official Overleaf product.\n\n## Runtime libraries and vendor assets\n\nNode extension dependencies retain their own license and notice files under node_modules in the VSIX. PDF.js 3.10.111 is provided by Mozilla under Apache-2.0; its full license is in views/pdf-viewer/vendor/LICENSE. Its pinned distribution and the local patch are recorded in scripts/install-vendor.cjs and scripts/vendor-patches. LaTeX language configurations are from jlelong/vscode-latex-basics v1.5.4 under MIT; its license and upstream README are retained in data/vendor. The installer records the exact inputs and integrity hashes for both. The extension's static LaTeX/BibTeX data was extracted from Overleaf; see data/README.md.\n`;
    const supplementalNotices = [
        ['@unified-latex/* (installed 1.8.x packages)', 'unified-latex-LICENSE', 'https://github.com/siefkenj/unified-latex/blob/v1.8.3/LICENSE'],
        ['@vscode/l10n 0.0.18', 'vscode-l10n-LICENSE', 'https://github.com/microsoft/vscode-l10n/blob/main/LICENSE'],
        ['tr46 0.0.3', 'tr46-LICENSE', 'https://github.com/Sebmaster/tr46.js/blob/master/LICENSE.md'],
        ['trie-prefix-tree 1.5.1', 'trie-prefix-tree-LICENSE', 'https://github.com/lyndseybrowning/trie-prefix-tree (MIT declaration and attribution in the installed README; standard MIT text retained here)'],
    ];
    notices += '\nThe following extension runtime npm packages omit a standalone license file. Their declarations and upstream copyright notices are retained below; isarray and socket.io-client also retain the complete license text in their installed README files.\n';
    for (const [name, filename, origin] of supplementalNotices) {
        notices += `\n### ${name}\n\nSource: ${origin}.\n\n\`\`\`text\n${fs.readFileSync(path.join(root, 'scripts/notices', filename), 'utf8').trim()}\n\`\`\`\n`;
    }
    notices += `\n\n## Bundled chat webview dependencies\n\nThe chat webview is bundled into one HTML asset. The following installed production dependencies and their notices are preserved here, including dependencies that the bundler may remove as unused. Codicons' icon font is licensed under CC-BY-4.0 and its code under MIT, copyright Microsoft Corporation; its original license texts follow.\n`;
    for (const [relative, item] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
        if (!relative || item.dev) continue;
        const directory = path.join(root, 'views/chat-view', relative);
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
        notices += `\n### ${manifest.name} ${manifest.version}\n\nLicense: ${typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license ?? 'see package notices')}.\n`;
        const licenseFiles = fs.readdirSync(directory).filter(name => /^(?:licen[sc]e|copying|notice|copyright)(?:[.-].*)?$/i.test(name)).sort();
        if (!licenseFiles.length && manifest.name.startsWith('@microsoft/fast-') && manifest.license === 'MIT') {
            notices += `\nThe npm package declares MIT but omits a license file. The FAST project's upstream LICENSE (https://github.com/microsoft/fast/blob/master/LICENSE), retained in scripts/notices/fast-LICENSE, reads:\n\n\`\`\`text\n${fs.readFileSync(path.join(root, 'scripts/notices/fast-LICENSE'), 'utf8').trim()}\n\`\`\`\n`;
        } else if (!licenseFiles.length) throw new Error(`Missing bundled dependency notice: ${manifest.name}`);
        for (const filename of licenseFiles) {
            const absolute = path.join(directory, filename);
            if (!fs.statSync(absolute).isFile()) continue;
            notices += `\n${filename}:\n\n\`\`\`text\n${fs.readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n').trim()}\n\`\`\`\n`;
        }
    }
    fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices);
}

async function main() {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (!/^[a-z0-9-]+$/.test(manifest.name) || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(manifest.version)) {
        throw new Error('Unsafe package name or version');
    }
    writeThirdPartyNotices();
    const paths = new Set(includedFiles);
    includedRoots.forEach(directory => collect(directory, paths));
    const zip = new JSZip();
    const entries = [];
    for (const relative of [...paths].sort()) {
        const absolute = path.join(root, relative);
        if (!fs.lstatSync(absolute).isFile()) throw new Error(`Missing source input: ${relative}`);
        const bytes = fs.readFileSync(absolute);
        zip.file(relative, bytes, {date: epoch, createFolders: false, unixPermissions: 0o100644});
        entries.push({path: relative, bytes: bytes.length, sha256: digest(bytes)});
    }
    const archive = await zip.generateAsync({type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: {level: 9}});
    const filename = `${manifest.name}-${manifest.version}-source.zip`;
    const destination = path.join(root, 'source');
    fs.mkdirSync(destination, {recursive: true});
    // A VSIX must contain only the source archive for its own version.
    for (const previous of fs.readdirSync(destination)) {
        if (/^[a-z0-9-]+-\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?-source\.zip$/i.test(previous) && previous !== filename) {
            fs.unlinkSync(path.join(destination, previous));
        }
    }
    fs.writeFileSync(path.join(destination, filename), archive);
    fs.writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify({extensionId: `${manifest.publisher}.${manifest.name}`, version: manifest.version, archive: filename, sha256: digest(archive), files: entries}, null, 2)}\n`);
    console.log(`Corresponding source: source/${filename} (${entries.length} files, SHA-256 ${digest(archive)})`);
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});
