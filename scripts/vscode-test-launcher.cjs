const {spawn} = require('node:child_process');

// Retain Electron's sandbox and VS Code's workspace trust controls.
exports.runInstalledVscode = ({executable, root, suite, args = [], env = {}}) => new Promise((resolve, reject) => {
    const child = spawn(executable, [
        `--extensionDevelopmentPath=${root}`,
        ...(suite ? [`--extensionTestsPath=${suite}`] : []),
        '--disable-extensions', '--disable-updates', '--skip-welcome', '--skip-release-notes',
        '--disable-telemetry', '--new-window', ...args,
    ], {env: {...process.env, ...env}, stdio: 'inherit'});
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`VS Code test failed (${code ?? signal})`)));
});
