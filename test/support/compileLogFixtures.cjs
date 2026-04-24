const fs = require('node:fs/promises');
const path = require('node:path');

const { createStructuredRecorder } = require('./structuredRecorder.cjs');

const fixtureDirectory = path.join(__dirname, '..', 'fixtures', 'compile');
const recorder = createStructuredRecorder('CompileLogFixtures');

async function loadCompileLogFixture(name) {
    const targetPath = path.join(fixtureDirectory, name);
    const content = await fs.readFile(targetPath, 'utf8');
    recorder.record('fixture.loaded', {
        bytes: Buffer.byteLength(content),
        name,
    });
    return content;
}

function getCompileFixtureEvents() {
    return recorder.snapshot();
}

module.exports = {
    getCompileFixtureEvents,
    loadCompileLogFixture,
};
