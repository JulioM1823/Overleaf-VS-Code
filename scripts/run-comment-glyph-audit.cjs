const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');

(async () => {
    const phase = process.argv[2];
    assert(['baseline', 'first-line'].includes(phase));
    const executable = process.env.OVERLEAF_GLYPH_AUDIT_EXECUTABLE;
    assert(executable && path.isAbsolute(executable), 'Supply the isolated test app executable');
    const testRoot = await fs.realpath(process.env.OVERLEAF_GLYPH_AUDIT_DIRECTORY ||
        path.resolve(os.tmpdir(), 'overleaf-comment-glyph-audit'));
    const temporaryRoots = await Promise.all([os.tmpdir(), '/tmp'].map(directory => fs.realpath(directory)));
    assert(temporaryRoots.some(root => testRoot.startsWith(root + path.sep)), 'Use a temporary test directory');
    const actualExecutable = await fs.realpath(executable);
    assert(actualExecutable.startsWith(testRoot + path.sep), 'Never launch/modify the installed app for this fixture');
    const profile = path.join(testRoot, `profile-${phase}`);
    const extensions = path.join(testRoot, 'empty-extensions');
    await fs.mkdir(path.join(profile, 'User'), {recursive: true});
    await fs.mkdir(extensions, {recursive: true});
    await fs.writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
        'window.title': `Comment glyph renderer audit (${phase})`,
        'editor.wordWrap': 'on', 'editor.fontSize': 22, 'editor.minimap.enabled': false,
        'workbench.startupEditor': 'none', 'workbench.colorTheme': 'Default Dark Modern',
        'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
        'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
    }), {mode: 0o600});
    const child = spawn(actualExecutable, [
        `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`,
        `--extensionDevelopmentPath=${path.resolve(__dirname, '../test/integration/comment-glyph-driver')}`,
        '--disable-extensions', '--disable-updates', '--disable-telemetry',
        '--skip-welcome', '--skip-release-notes', '--new-window',
    ], {stdio: 'inherit', env: {...process.env,
        OVERLEAF_GLYPH_AUDIT_PHASE: phase,
        OVERLEAF_GLYPH_AUDIT_DIRECTORY: testRoot,
    }});
    child.on('error', error => { console.error(error); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code || 0; });
})().catch(error => { console.error(error); process.exitCode = 1; });
