type LocalReplicaLatexWorkshopSettings = Record<string, unknown>;

function buildLatexmkTool(name: string, modeArg?: string, options: {
    forceContinue?: boolean,
} = {}) {
    return {
        name,
        command: 'latexmk',
        args: [
            ...(options.forceContinue===false ? [] : ['-f']),
            '-synctex=1',
            '-interaction=nonstopmode',
            '-file-line-error',
            ...(modeArg ? [modeArg] : []),
            '-outdir=%OUTDIR%',
            '-auxdir=%AUXDIR%',
            '-emulate-aux-dir',
            '%DOC%',
        ],
        env: {},
    };
}

function buildLocalReplicaLatexWorkshopSettingsInternal(outputFolderName: string, options: {
    forceContinue?: boolean,
} = {}): LocalReplicaLatexWorkshopSettings {
    return {
        'latex-workshop.latex.outDir': '%DIR%',
        'latex-workshop.latex.auxDir': `%WORKSPACE_FOLDER%/${outputFolderName}`,
        'latex-workshop.message.warning.show': false,
        'latex-workshop.message.error.show': false,
        'latex-workshop.latex.tools': [
            buildLatexmkTool('latexmk', '-pdf', options),
            buildLatexmkTool('lualatexmk', '-lualatex', options),
            buildLatexmkTool('xelatexmk', '-xelatex', options),
            {
                name: 'latexmk_rconly',
                command: 'latexmk',
                args: ['%DOC%'],
                env: {},
            },
        ],
        'latex-workshop.latex.recipes': [
            {
                name: 'latexmk',
                tools: ['latexmk'],
            },
            {
                name: 'lualatexmk',
                tools: ['lualatexmk'],
            },
            {
                name: 'xelatexmk',
                tools: ['xelatexmk'],
            },
            {
                name: 'latexmk (latexmkrc only)',
                tools: ['latexmk_rconly'],
            },
        ],
    };
}

function buildLegacyLocalReplicaLatexWorkshopSettings(outputFolderName: string) {
    return buildLocalReplicaLatexWorkshopSettingsInternal(outputFolderName, {
        forceContinue: false,
    });
}

function isJsonEqual(left: unknown, right: unknown) {
    return JSON.stringify(left)===JSON.stringify(right);
}

function shouldUpgradeLegacyGeneratedLocalReplicaSetting(
    key: string,
    value: unknown,
    outputFolderName: string,
) {
    if (key!=='latex-workshop.latex.tools') {
        return false;
    }
    const legacySettings = buildLegacyLocalReplicaLatexWorkshopSettings(outputFolderName);
    return isJsonEqual(value, legacySettings[key]);
}

export function buildLocalReplicaLatexWorkshopSettings(outputFolderName: string): LocalReplicaLatexWorkshopSettings {
    return buildLocalReplicaLatexWorkshopSettingsInternal(outputFolderName);
}

export function mergeLocalReplicaLatexWorkshopSettings(
    existingSettings: LocalReplicaLatexWorkshopSettings,
    outputFolderName: string,
) {
    const nextSettings: LocalReplicaLatexWorkshopSettings = {...existingSettings};
    let changed = false;
    for (const [key, value] of Object.entries(buildLocalReplicaLatexWorkshopSettings(outputFolderName))) {
        if (shouldUpgradeLegacyGeneratedLocalReplicaSetting(key, nextSettings[key], outputFolderName)) {
            nextSettings[key] = value;
            changed = true;
            continue;
        }
        if (nextSettings[key]!==undefined) {
            continue;
        }
        nextSettings[key] = value;
        changed = true;
    }
    return {
        changed,
        settings: nextSettings,
    };
}
