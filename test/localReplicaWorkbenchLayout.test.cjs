const test = require('node:test');
const assert = require('node:assert/strict');

const {
    closeAuxiliaryBarIfPresent,
    consumePendingLocalReplicaAuxiliaryBarClose,
    hasPendingLocalReplicaAuxiliaryBarClose,
    rememberPendingLocalReplicaAuxiliaryBarClose,
} = require('../out/core/localReplicaWorkbenchLayout.js');

function createContext(initialWorkspaceRoots = []) {
    let store = {
        'overleaf-workshop.localReplica.pendingAuxiliaryBarCloseWorkspaceRoots': [...initialWorkspaceRoots],
    };
    return {
        globalState: {
            get(key, defaultValue) {
                return store[key] ?? defaultValue;
            },
            async update(key, value) {
                store[key] = value;
            },
        },
    };
}

function createCommands(availableCommands) {
    const executedCommands = [];
    return {
        executedCommands,
        registry: {
            async getCommands() {
                return availableCommands;
            },
            async executeCommand(command) {
                executedCommands.push(command);
            },
        },
    };
}

function createWorkspaceRoot(uri = 'file:///workspace/project') {
    return {
        toString() {
            return uri;
        },
    };
}

test('rememberPendingLocalReplicaAuxiliaryBarClose records the workspace once', async () => {
    const context = createContext();
    const workspaceRoot = createWorkspaceRoot();

    await rememberPendingLocalReplicaAuxiliaryBarClose(context, workspaceRoot);
    await rememberPendingLocalReplicaAuxiliaryBarClose(context, workspaceRoot);

    assert.equal(hasPendingLocalReplicaAuxiliaryBarClose(context, workspaceRoot), true);
    assert.deepEqual(
        context.globalState.get('overleaf-workshop.localReplica.pendingAuxiliaryBarCloseWorkspaceRoots', []),
        ['file:///workspace/project'],
    );
});

test('closeAuxiliaryBarIfPresent prefers the close command when available', async () => {
    const commands = createCommands([
        'workbench.action.closeAuxiliaryBar',
        'workbench.action.closeSecondarySideBar',
    ]);

    const result = await closeAuxiliaryBarIfPresent(commands.registry);

    assert.deepEqual(result, {
        commandId: 'workbench.action.closeAuxiliaryBar',
        didClose: true,
    });
    assert.deepEqual(commands.executedCommands, ['workbench.action.closeAuxiliaryBar']);
});

test('consumePendingLocalReplicaAuxiliaryBarClose closes once and clears the marker', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const context = createContext([workspaceRoot.toString()]);
    const commands = createCommands(['workbench.action.closeAuxiliaryBar']);

    const result = await consumePendingLocalReplicaAuxiliaryBarClose(
        context,
        workspaceRoot,
        commands.registry,
    );

    assert.deepEqual(result, {
        commandId: 'workbench.action.closeAuxiliaryBar',
        didClose: true,
        wasPending: true,
    });
    assert.deepEqual(commands.executedCommands, ['workbench.action.closeAuxiliaryBar']);
    assert.equal(hasPendingLocalReplicaAuxiliaryBarClose(context, workspaceRoot), false);
});
