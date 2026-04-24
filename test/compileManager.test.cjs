const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const noop = () => {};
const originalLoad = Module._load;
const warningMessages = [];
const errorMessages = [];
const executedCommands = [];
let availableCommands = [];
let localReplicaSettings;
let saveAllCount = 0;
let onDidSaveTextDocumentHandler;

function createUri(value, path = '/project/main.tex') {
    return {
        path,
        scheme: 'overleaf-workshop',
        toString() {
            return value;
        },
        with(next) {
            return createUri(value, next?.path ?? path);
        },
    };
}

const vscodeMock = {
    DiagnosticSeverity: {
        Error: 0,
        Information: 1,
        Warning: 2,
    },
    languages: {
        createDiagnosticCollection: () => ({
            clear: noop,
            delete: noop,
            dispose: noop,
            set: noop,
        }),
    },
    l10n: {
        t: (value) => value,
    },
    MarkdownString: class MarkdownString {
        constructor() {
            this.value = '';
        }
        appendMarkdown(value) {
            this.value += value;
        }
    },
    StatusBarAlignment: {
        Left: 0,
    },
    ThemeColor: class ThemeColor {
        constructor(value) {
            this.value = value;
        }
    },
    window: {
        createStatusBarItem: () => ({
            backgroundColor: undefined,
            command: undefined,
            hide: noop,
            show: noop,
            text: '',
            tooltip: '',
        }),
        showWarningMessage: async (message) => {
            warningMessages.push(message);
        },
        showErrorMessage: async (message) => {
            errorMessages.push(message);
        },
    },
    workspace: {
        getConfiguration: () => ({
            get: (_key, fallback) => fallback,
        }),
        saveAll: async () => {
            saveAllCount += 1;
            return true;
        },
        workspaceFolders: [],
        fs: {
            createDirectory: async () => {},
            writeFile: async () => {},
        },
        onDidSaveTextDocument: (handler) => {
            onDidSaveTextDocumentHandler = handler;
            return {dispose: noop};
        },
    },
    commands: {
        executeCommand: async (command, ...args) => {
            executedCommands.push({args, command});
            if (command==='latex-workshop.build') {
                return true;
            }
            return false;
        },
        getCommands: async () => availableCommands,
        registerCommand: () => ({dispose: noop}),
    },
    ProgressLocation: {
        Notification: 0,
    },
    Uri: {
        file: (value) => createUri(`file://${value}`, value),
    },
};

Module._load = function patchedLoad(request, parent, isMain) {
    if (request==='vscode') {
        return vscodeMock;
    }
    if (request==='../core/remoteFileSystemProvider' && parent?.id?.endsWith('/compileManager.js')) {
        return {
            RemoteFileSystemProvider: class {},
            VirtualFileSystem: class {},
            parseUri: (uri) => ({
                identifier: 'project-id',
                pathParts: uri.path.split('/').filter(Boolean).slice(1),
                projectName: 'project',
            }),
        };
    }
    if (request==='../core/pdfViewEditorProvider' && parent?.id?.endsWith('/compileManager.js')) {
        return {
            PdfDocument: class {},
        };
    }
    if (request==='../utils/eventBus' && parent?.id?.endsWith('/compileManager.js')) {
        return {
            EventBus: {
                on: () => ({dispose: noop}),
            },
        };
    }
    if (request==='../utils/diagnostics' && parent?.id?.includes('/compileManager.js')) {
        return {
            logDiagnostic: noop,
            registerDiagnosticStateProvider: () => ({dispose: noop}),
            startDiagnosticSpan: () => ({
                end: noop,
                fail: noop,
            }),
        };
    }
    if (request==='../scm/localReplicaSCM' && parent?.id?.endsWith('/compileManager.js')) {
        return {
            LocalReplicaSCMProvider: {
                readSettings: async () => localReplicaSettings,
            },
        };
    }
    if (request==='./compileLogParser' && parent?.id?.endsWith('/compileManager.js')) {
        return {
            ErrorSchema: class {},
            LatexParser: class {
                parse() {
                    return {all: [], errors: [], information: [], warnings: []};
                }
            },
        };
    }
    if (request==='./compileArtifacts' && parent?.id?.endsWith('/compileManager.js')) {
        return {
            normalizeCompileArtifactPath: (value) => value,
            normalizeSyncResultFilePath: (value) => value,
        };
    }
    if (request==='../core/pdfReliability' && parent?.id?.endsWith('/compileManager.js')) {
        return {
            isLikelyPdfPayload: () => true,
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { CompileManager } = require('../out/compile/compileManager.js');

test.beforeEach(() => {
    warningMessages.length = 0;
    errorMessages.length = 0;
    executedCommands.length = 0;
    availableCommands = [];
    localReplicaSettings = undefined;
    saveAllCount = 0;
    onDidSaveTextDocumentHandler = undefined;
});

test('compile blocks before remote compile when session preflight is not ready', async () => {
    const uri = createUri('overleaf-workshop://server/project/main.tex');
    const compileCalls = [];
    const updateCalls = [];
    const preflightCalls = [];
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => ({fileId: 'doc-1'}),
            compile: async () => {
                compileCalls.push('compile');
                return false;
            },
            getRootDocName: () => '/main.tex',
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
        }),
    }, {
        prepareProjectForRemoteOperation: async (projectUri, reason) => {
            preflightCalls.push({projectUri: projectUri.toString(), reason});
            return 'blocked';
        },
    });
    const originalCheck = CompileManager.check;
    CompileManager.check = async () => uri;
    manager.update = async (status) => {
        updateCalls.push(status);
        return uri;
    };

    try {
        await manager.compile(true);
    } finally {
        CompileManager.check = originalCheck;
    }

    assert.equal(saveAllCount, 1);
    assert.deepEqual(preflightCalls, [{
        projectUri: 'overleaf-workshop://server/project/main.tex',
        reason: 'compile_preflight',
    }]);
    assert.deepEqual(updateCalls, [undefined]);
    assert.deepEqual(compileCalls, []);
    assert.deepEqual(warningMessages, ['Overleaf is still synchronizing open documents. Please wait a moment and try again.']);
});

test('save-triggered compile blocks preflight without showing a warning notification', async () => {
    const uri = createUri('overleaf-workshop://server/project/main.tex');
    const compileCalls = [];
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => ({fileId: 'doc-1'}),
            compile: async () => {
                compileCalls.push('compile');
                return false;
            },
            getRootDocName: () => '/main.tex',
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
        }),
    }, {
        prepareProjectForRemoteOperation: async () => 'blocked',
    });
    const originalCheck = CompileManager.check;
    CompileManager.check = async () => uri;
    manager.update = async () => uri;

    try {
        await manager.compile(false, {source: 'save'});
        manager.clearPendingCompileRequests();
    } finally {
        CompileManager.check = originalCheck;
    }

    assert.equal(saveAllCount, 1);
    assert.deepEqual(compileCalls, []);
    assert.deepEqual(warningMessages, []);
});

test('compile waits for session preflight before invoking remote compile', async () => {
    const uri = createUri('overleaf-workshop://server/project/main.tex');
    const events = [];
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => ({fileId: 'doc-1'}),
            compile: async () => {
                events.push('compile');
                return false;
            },
            getRootDocName: () => '/main.tex',
            openFile: async () => {
                throw new Error('configured root compile should not probe the source file');
            },
        }),
    }, {
        prepareProjectForRemoteOperation: async () => {
            events.push('preflight');
            return 'ready';
        },
    });
    const originalCheck = CompileManager.check;
    CompileManager.check = async () => uri;
    manager.update = async (status) => {
        events.push(`update:${String(status)}`);
        return uri;
    };

    try {
        await manager.compile(true);
    } finally {
        CompileManager.check = originalCheck;
    }

    assert.equal(saveAllCount, 1);
    assert.deepEqual(events.slice(0, 3), [
        'preflight',
        'update:compiling',
        'compile',
    ]);
});

test('save-triggered compile queues while another compile is running', async () => {
    const uri = createUri('overleaf-workshop://server/project/main.tex');
    const compileCalls = [];
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => ({fileId: 'doc-1'}),
            compile: async () => {
                compileCalls.push('compile');
                return false;
            },
            getRootDocName: () => '/main.tex',
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
        }),
    }, {
        prepareProjectForRemoteOperation: async () => 'ready',
    });
    const originalCheck = CompileManager.check;
    CompileManager.check = async () => uri;
    manager.update = async () => uri;
    manager.inCompiling = true;

    try {
        await manager.compile(false, {source: 'save', targetUri: uri});
        manager.inCompiling = false;
        await manager.drainPendingCompileRequest('test');
    } finally {
        CompileManager.check = originalCheck;
    }

    assert.equal(saveAllCount, 0);
    assert.deepEqual(compileCalls, ['compile']);
});

test('save-triggered compile retries after blocked preflight', async () => {
    const uri = createUri('overleaf-workshop://server/project/main.tex');
    const compileCalls = [];
    const preflightStates = ['blocked', 'ready'];
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => ({fileId: 'doc-1'}),
            compile: async () => {
                compileCalls.push('compile');
                return false;
            },
            getRootDocName: () => '/main.tex',
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
        }),
    }, {
        prepareProjectForRemoteOperation: async () => preflightStates.shift() ?? 'ready',
    });
    const originalCheck = CompileManager.check;
    const originalRetryDelayMs = CompileManager.COMPILE_RETRY_DELAY_MS;
    CompileManager.check = async () => uri;
    CompileManager.COMPILE_RETRY_DELAY_MS = 0;
    manager.update = async () => uri;

    try {
        await manager.compile(false, {source: 'save', targetUri: uri});
        await manager.drainPendingCompileRequest('test');
    } finally {
        CompileManager.check = originalCheck;
        CompileManager.COMPILE_RETRY_DELAY_MS = originalRetryDelayMs;
    }

    assert.equal(saveAllCount, 0);
    assert.deepEqual(compileCalls, ['compile']);
    assert.deepEqual(warningMessages, []);
});

test('compile timeout clears the compiling state and stops the remote compile', async () => {
    const uri = createUri('overleaf-workshop://server/project/main.tex');
    const updateCalls = [];
    let stopCompileCalls = 0;
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => ({fileId: 'doc-1'}),
            compile: async () => await new Promise(() => {}),
            getRootDocName: () => '/main.tex',
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
            realtimeConnectionPhase: 'live',
            stopCompile: async () => {
                stopCompileCalls += 1;
                return true;
            },
        }),
    }, {
        prepareProjectForRemoteOperation: async () => 'ready',
    });
    const originalCheck = CompileManager.check;
    const originalTimeoutMs = CompileManager.COMPILE_REQUEST_TIMEOUT_MS;
    CompileManager.check = async () => uri;
    CompileManager.COMPILE_REQUEST_TIMEOUT_MS = 10;
    manager.update = async (status) => {
        updateCalls.push(status);
        return uri;
    };

    try {
        await manager.compile(true);
    } finally {
        CompileManager.check = originalCheck;
        CompileManager.COMPILE_REQUEST_TIMEOUT_MS = originalTimeoutMs;
    }

    assert.deepEqual(updateCalls, ['compiling', 'failed']);
    assert.equal(stopCompileCalls, 1);
    assert.deepEqual(errorMessages, ['Compilation timed out. Please try again.']);
});

test('compile timeout also clears compiling state when root document loading hangs', async () => {
    const uri = createUri('overleaf-workshop://server/project/chapter.tex', '/project/chapter.tex');
    const updateCalls = [];
    const compileCalls = [];
    let resolveOpenFile;
    let stopCompileCalls = 0;
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => {
                throw new Error('resolve should not run when openFile hangs');
            },
            compile: async () => {
                compileCalls.push('compile');
                return false;
            },
            getRootDocName: () => '/main.tex',
            openFile: async () => await new Promise((resolve) => {
                resolveOpenFile = () => resolve(Buffer.from('\\documentclass{article}\n'));
            }),
            realtimeConnectionPhase: 'live',
            stopCompile: async () => {
                stopCompileCalls += 1;
                return true;
            },
        }),
    }, {
        prepareProjectForRemoteOperation: async () => 'ready',
    });
    const originalCheck = CompileManager.check;
    const originalTimeoutMs = CompileManager.COMPILE_REQUEST_TIMEOUT_MS;
    CompileManager.check = async () => uri;
    CompileManager.COMPILE_REQUEST_TIMEOUT_MS = 10;
    manager.update = async (status) => {
        updateCalls.push(status);
        if (status!==undefined) {
            manager.inCompiling = status==='compiling';
        }
        return uri;
    };

    try {
        await manager.compile(true);
    } finally {
        CompileManager.check = originalCheck;
        CompileManager.COMPILE_REQUEST_TIMEOUT_MS = originalTimeoutMs;
    }

    assert.deepEqual(updateCalls, ['compiling', 'failed']);
    assert.equal(manager.inCompiling, false);
    assert.equal(stopCompileCalls, 1);
    assert.deepEqual(errorMessages, ['Compilation timed out. Please try again.']);

    resolveOpenFile();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(compileCalls, []);
});

test('compile status connection updates match document uris inside the project origin', () => {
    const manager = new CompileManager({
        prefetch: async () => {
            throw new Error('prefetch should not be needed for uri matching');
        },
    });
    const documentUri = createUri(
        'overleaf-workshop://server/project/main.tex?user=user-1&project=project-1',
        '/project/main.tex',
    );
    const origin = 'overleaf-workshop://server/project?user=user-1&project=project-1';
    const otherOrigin = 'overleaf-workshop://server/project?user=user-1&project=project-2';

    assert.equal(manager.isUriWithinConnectionOrigin(documentUri, origin), true);
    assert.equal(manager.isUriWithinConnectionOrigin(documentUri, otherOrigin), false);
});

test('compile still runs when root document probing fails', async () => {
    const uri = createUri('overleaf-workshop://server/project/chapter.tex', '/project/chapter.tex');
    const compileCalls = [];
    const updateCalls = [];
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => {
                throw new Error('root probe failed');
            },
            compile: async (_force, _draft, _stopOnFirstError, rootDocId) => {
                compileCalls.push(rootDocId);
                return true;
            },
            getRootDocName: () => '/main.tex',
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
            realtimeConnectionPhase: 'live',
        }),
    }, {
        prepareProjectForRemoteOperation: async () => 'ready',
    });
    const originalCheck = CompileManager.check;
    CompileManager.check = async () => uri;
    manager.update = async (status) => {
        updateCalls.push(status);
        return uri;
    };

    try {
        await manager.compile(true);
    } finally {
        CompileManager.check = originalCheck;
    }

    assert.deepEqual(compileCalls, [undefined]);
    assert.deepEqual(updateCalls, ['compiling', 'success']);
});

test('compile success does not become unavailable when diagnostics check fails', async () => {
    const uri = createUri('overleaf-workshop://server/project/main.tex');
    const updateCalls = [];
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => ({fileId: 'doc-1'}),
            compile: async () => true,
            getRootDocName: () => '/main.tex',
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
            realtimeConnectionPhase: 'live',
        }),
    }, {
        prepareProjectForRemoteOperation: async () => 'ready',
    });
    const originalCheck = CompileManager.check;
    const originalExecuteCommand = vscodeMock.commands.executeCommand;
    CompileManager.check = async () => uri;
    vscodeMock.commands.executeCommand = async (command, ...args) => {
        executedCommands.push({args, command});
        if (command==='overleaf-workshop.compileManager.compileErrorCheck') {
            throw new Error('diagnostics unavailable');
        }
        return false;
    };
    manager.update = async (status) => {
        updateCalls.push(status);
        return uri;
    };

    try {
        await manager.compile(true);
    } finally {
        CompileManager.check = originalCheck;
        vscodeMock.commands.executeCommand = originalExecuteCommand;
    }

    assert.deepEqual(updateCalls, ['compiling', 'success']);
});

test('offline command compile falls back to a local LaTeX Workshop build in a local replica', async () => {
    const uri = createUri('overleaf-workshop://server/project/main.tex');
    const localUri = {
        path: '/tmp/project/main.tex',
        scheme: 'file',
        toString() {
            return 'file:///tmp/project/main.tex';
        },
        with(next) {
            return {
                ...this,
                path: next?.path ?? this.path,
            };
        },
    };
    localReplicaSettings = {
        enableCompileNPreview: true,
        uri: 'overleaf-workshop://server/project',
    };
    availableCommands = ['latex-workshop.build'];

    const compileCalls = [];
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => ({fileId: 'doc-1'}),
            compile: async () => {
                compileCalls.push('compile');
                return false;
            },
            getRootDocName: () => '/main.tex',
            isOfflineMode: true,
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
        }),
    }, {
        prepareProjectForRemoteOperation: async () => 'blocked',
    });
    const originalCheck = CompileManager.check;
    CompileManager.check = async () => uri;
    manager.update = async () => uri;

    try {
        await manager.compile(true, {targetUri: localUri});
    } finally {
        CompileManager.check = originalCheck;
    }

    assert.equal(saveAllCount, 1);
    assert.deepEqual(compileCalls, []);
    assert.deepEqual(executedCommands.map(({command}) => command), ['latex-workshop.build']);
    assert.deepEqual(warningMessages, []);
});

test('offline command compile shows an offline-specific warning when no local fallback is available', async () => {
    const uri = createUri('overleaf-workshop://server/project/main.tex');
    const compileCalls = [];
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => ({fileId: 'doc-1'}),
            compile: async () => {
                compileCalls.push('compile');
                return false;
            },
            getRootDocName: () => '/main.tex',
            isOfflineMode: true,
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
        }),
    }, {
        prepareProjectForRemoteOperation: async () => 'blocked',
    });
    const originalCheck = CompileManager.check;
    CompileManager.check = async () => uri;
    manager.update = async () => uri;

    try {
        await manager.compile(true);
    } finally {
        CompileManager.check = originalCheck;
    }

    assert.equal(saveAllCount, 1);
    assert.deepEqual(compileCalls, []);
    assert.deepEqual(warningMessages, [
        'Overleaf server compilation is unavailable while offline. Reconnect to compile on Overleaf, or use a local LaTeX build in the local replica.',
    ]);
});

test('local-replica command compile prefers the local LaTeX Workshop build path', async () => {
    const uri = createUri('overleaf-workshop://server/project/main.tex');
    const localUri = {
        path: '/tmp/project/main.tex',
        scheme: 'file',
        toString() {
            return 'file:///tmp/project/main.tex';
        },
        with(next) {
            return {
                ...this,
                path: next?.path ?? this.path,
            };
        },
    };
    localReplicaSettings = {
        enableCompileNPreview: true,
        uri: 'overleaf-workshop://server/project',
    };
    availableCommands = ['latex-workshop.build'];

    const compileCalls = [];
    const preflightCalls = [];
    const manager = new CompileManager({
        prefetch: async () => ({
            _resolveUri: async () => ({fileId: 'doc-1'}),
            compile: async () => {
                compileCalls.push('compile');
                return false;
            },
            getRootDocName: () => '/main.tex',
            openFile: async () => Buffer.from('\\documentclass{article}\n'),
        }),
    }, {
        prepareProjectForRemoteOperation: async () => {
            preflightCalls.push('preflight');
            return 'ready';
        },
    });
    const originalCheck = CompileManager.check;
    CompileManager.check = async () => uri;
    manager.update = async () => uri;

    try {
        await manager.compile(true, {targetUri: localUri});
    } finally {
        CompileManager.check = originalCheck;
    }

    assert.equal(saveAllCount, 1);
    assert.deepEqual(preflightCalls, []);
    assert.deepEqual(compileCalls, []);
    assert.deepEqual(executedCommands.map(({command}) => command), ['latex-workshop.build']);
});

test('compile-on-save keeps the saved local-replica file as the compile target', async () => {
    const overleafUri = createUri('overleaf-workshop://server/project/main.tex');
    const localUri = {
        path: '/tmp/project/main.tex',
        scheme: 'file',
        toString() {
            return 'file:///tmp/project/main.tex';
        },
    };
    localReplicaSettings = {
        enableCompileNPreview: true,
        uri: 'overleaf-workshop://server/project',
    };

    const scheduledTargets = [];
    const manager = new CompileManager({
        prefetch: async () => ({
            getRootDocName: () => '/main.tex',
        }),
    });
    const originalCheck = CompileManager.check;
    CompileManager.check = async () => overleafUri;
    manager.scheduleCompileOnSave = (uri) => {
        scheduledTargets.push(uri.toString());
    };
    manager.triggers;

    try {
        await onDidSaveTextDocumentHandler({
            fileName: '/tmp/project/main.tex',
            uri: localUri,
        });
    } finally {
        CompileManager.check = originalCheck;
    }

    assert.deepEqual(scheduledTargets, ['file:///tmp/project/main.tex']);
});
