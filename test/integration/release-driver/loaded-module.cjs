const assert = require('node:assert/strict');
const path = require('node:path');

function loadedInstalledModule(extensionPath, relativePath, cache = require.cache, platform = process.platform) {
    const paths = platform === 'win32' ? path.win32 : path;
    const root = paths.resolve(extensionPath);
    const expected = paths.resolve(root, relativePath);
    const inside = filename => {
        const relative = paths.relative(root, paths.resolve(filename));
        return relative && relative !== '..' && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative);
    };
    assert(inside(expected), 'Observed module must be inside the installed extension');
    const key = filename => {
        const resolved = paths.resolve(filename);
        return platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const matches = Object.values(cache).filter(module => module && typeof module.filename === 'string' && key(module.filename) === key(expected));
    assert(matches.length > 0, `Installed extension module must already be loaded: ${relativePath}`);
    assert(matches.every(module => inside(module.filename)), 'Observed loaded module must be inside the installed extension');
    assert(new Set(matches.map(module => module.exports)).size === 1, `Installed extension module has ambiguous loaded exports: ${relativePath}`);
    return matches[0];
}

module.exports = {loadedInstalledModule};
