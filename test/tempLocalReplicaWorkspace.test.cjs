const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

const { TempLocalReplicaWorkspace } = require('./support/tempLocalReplicaWorkspace.cjs');

test('TempLocalReplicaWorkspace creates a usable .overleaf workspace layout', async () => {
    const workspace = await new TempLocalReplicaWorkspace({
        files: {
            'chapters/intro.tex': '\\chapter{Intro}\n',
            'main.tex': '\\input{chapters/intro}\n',
        },
        projectName: 'Harness Thesis',
        serverName: 'www.overleaf.com',
        uri: 'overleaf-workshop://www.overleaf.com/Harness-Thesis',
    }).start();

    try {
        const settingsText = await workspace.readText('.overleaf/settings.json');
        const settings = JSON.parse(settingsText);
        assert.equal(settings.projectName, 'Harness Thesis');
        assert.equal(settings.serverName, 'www.overleaf.com');

        const mainText = await fs.readFile(workspace.pathFor('main.tex'), 'utf8');
        assert.equal(mainText, '\\input{chapters/intro}\n');
        assert.ok(workspace.events.some((entry) => entry.event === 'workspace.file_written'));
    } finally {
        await workspace.stop();
    }
});
