const fs = require('node:fs');
const path = require('node:path');

function normalizeError(error) {
    if (error instanceof Error) {
        return {
            errorMessage: error.message,
            errorName: error.name,
        };
    }
    if (typeof error === 'string') {
        return { errorMessage: error };
    }
    if (error === undefined) {
        return undefined;
    }
    return { errorMessage: String(error) };
}

function log(event, fields = {}, error) {
    const record = {
        event,
        ...Object.fromEntries(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right))),
    };
    const normalizedError = normalizeError(error);
    if (normalizedError) {
        Object.assign(record, normalizedError);
    }
    console.error(`ReleaseValidation: ${JSON.stringify(record)}`);
}

function assertFileExists(relativePath) {
    const absolutePath = path.join(process.cwd(), relativePath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Missing required file: ${relativePath}`);
    }
    log('file.exists', { relativePath });
}

function readJson(relativePath) {
    const absolutePath = path.join(process.cwd(), relativePath);
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

function main() {
    log('validation.started', { cwd: process.cwd() });

    const packageJson = readJson('package.json');
    const expectedRepositoryUrl = 'https://github.com/JulioM1823/Overleaf-VS-Code';
    const expectedIssuesUrl = 'https://github.com/JulioM1823/Overleaf-VS-Code/issues';

    if (packageJson.publisher !== 'iamhyc') {
        throw new Error('Unexpected publisher change detected. Marketplace continuity requires a dedicated migration plan.');
    }
    log('package.publisher_verified', { publisher: packageJson.publisher });

    if (packageJson.repository?.url !== expectedRepositoryUrl) {
        throw new Error(`Unexpected repository url: ${packageJson.repository?.url ?? '<missing>'}`);
    }
    if (packageJson.bugs?.url !== expectedIssuesUrl) {
        throw new Error(`Unexpected bugs url: ${packageJson.bugs?.url ?? '<missing>'}`);
    }
    log('package.metadata_verified', {
        bugsUrl: packageJson.bugs.url,
        repositoryUrl: packageJson.repository.url,
        version: packageJson.version,
    });

    assertFileExists('.github/workflows/vsce-package.yml');
    assertFileExists('.github/workflows/vsce-publish.yml');
    assertFileExists('docs/governance.md');
    assertFileExists('docs/roadmap/milestones.md');
    assertFileExists('docs/roadmap/blocked-items.md');
    assertFileExists('docs/testing-harnesses.md');

    const secretsPresent = {
        hasOvsxToken: Boolean(process.env.OVSX_TOKEN),
        hasVscePat: Boolean(process.env.VSCE_PAT),
    };
    log('release.secrets_observed', secretsPresent);

    log('validation.completed', {
        status: 'success',
    });
}

try {
    main();
} catch (error) {
    log('validation.failed', {}, error);
    process.exitCode = 1;
}
