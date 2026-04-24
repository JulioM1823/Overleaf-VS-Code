const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildLocalReplicaLatexWorkshopSettings,
    mergeLocalReplicaLatexWorkshopSettings,
} = require('../out/scm/localReplicaLatexSettings.js');

test('buildLocalReplicaLatexWorkshopSettings keeps PDFs beside the root document and aux files in .output', () => {
    const settings = buildLocalReplicaLatexWorkshopSettings('.output');
    const tools = settings['latex-workshop.latex.tools'];
    const latexmkTools = tools.filter((tool) => tool.name !== 'latexmk_rconly');

    assert.equal(settings['latex-workshop.latex.outDir'], '%DIR%');
    assert.equal(settings['latex-workshop.latex.auxDir'], '%WORKSPACE_FOLDER%/.output');
    assert.equal(settings['latex-workshop.message.warning.show'], false);
    assert.equal(settings['latex-workshop.message.error.show'], false);
    assert.ok(Array.isArray(tools));
    assert.ok(latexmkTools.length > 0);
    assert.ok(latexmkTools.every((tool) => {
        return Array.isArray(tool.args)
            && tool.args.includes('-f')
            && tool.args.includes('-outdir=%OUTDIR%')
            && tool.args.includes('-auxdir=%AUXDIR%')
            && tool.args.includes('-emulate-aux-dir');
    }));
});

test('mergeLocalReplicaLatexWorkshopSettings fills missing defaults without overwriting user settings', () => {
    const merged = mergeLocalReplicaLatexWorkshopSettings({
        'files.autoSave': 'off',
        'latex-workshop.latex.outDir': 'custom-output',
    }, '.output');

    assert.equal(merged.changed, true);
    assert.equal(merged.settings['files.autoSave'], 'off');
    assert.equal(merged.settings['latex-workshop.latex.outDir'], 'custom-output');
    assert.equal(merged.settings['latex-workshop.latex.auxDir'], '%WORKSPACE_FOLDER%/.output');
    assert.equal(merged.settings['latex-workshop.message.warning.show'], false);
    assert.equal(merged.settings['latex-workshop.message.error.show'], false);
});

test('mergeLocalReplicaLatexWorkshopSettings upgrades the legacy generated latexmk toolset', () => {
    const legacyTools = [
        {
            name: 'latexmk',
            command: 'latexmk',
            args: [
                '-synctex=1',
                '-interaction=nonstopmode',
                '-file-line-error',
                '-pdf',
                '-outdir=%OUTDIR%',
                '-auxdir=%AUXDIR%',
                '-emulate-aux-dir',
                '%DOC%',
            ],
            env: {},
        },
        {
            name: 'lualatexmk',
            command: 'latexmk',
            args: [
                '-synctex=1',
                '-interaction=nonstopmode',
                '-file-line-error',
                '-lualatex',
                '-outdir=%OUTDIR%',
                '-auxdir=%AUXDIR%',
                '-emulate-aux-dir',
                '%DOC%',
            ],
            env: {},
        },
        {
            name: 'xelatexmk',
            command: 'latexmk',
            args: [
                '-synctex=1',
                '-interaction=nonstopmode',
                '-file-line-error',
                '-xelatex',
                '-outdir=%OUTDIR%',
                '-auxdir=%AUXDIR%',
                '-emulate-aux-dir',
                '%DOC%',
            ],
            env: {},
        },
        {
            name: 'latexmk_rconly',
            command: 'latexmk',
            args: ['%DOC%'],
            env: {},
        },
    ];

    const merged = mergeLocalReplicaLatexWorkshopSettings({
        'latex-workshop.latex.tools': legacyTools,
    }, '.output');

    assert.equal(merged.changed, true);
    assert.ok(merged.settings['latex-workshop.latex.tools'].every((tool) => {
        return tool.name==='latexmk_rconly' || tool.args.includes('-f');
    }));
});

test('mergeLocalReplicaLatexWorkshopSettings preserves custom latexmk toolsets', () => {
    const merged = mergeLocalReplicaLatexWorkshopSettings({
        'latex-workshop.latex.tools': [{
            args: ['-pdf', '%DOC%'],
            command: 'latexmk',
            env: {},
            name: 'latexmk',
        }],
    }, '.output');

    assert.equal(merged.changed, true);
    assert.deepEqual(merged.settings['latex-workshop.latex.tools'], [{
        args: ['-pdf', '%DOC%'],
        command: 'latexmk',
        env: {},
        name: 'latexmk',
    }]);
});

test('mergeLocalReplicaLatexWorkshopSettings preserves explicit latex-workshop popup notification preferences', () => {
    const merged = mergeLocalReplicaLatexWorkshopSettings({
        'latex-workshop.message.error.show': true,
        'latex-workshop.message.warning.show': true,
    }, '.output');

    assert.equal(merged.changed, true);
    assert.equal(merged.settings['latex-workshop.message.warning.show'], true);
    assert.equal(merged.settings['latex-workshop.message.error.show'], true);
});
