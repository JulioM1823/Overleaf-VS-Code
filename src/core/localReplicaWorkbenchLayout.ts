const pendingAuxiliaryBarCloseWorkspaceRootsStateKey =
    'overleaf-workshop.localReplica.pendingAuxiliaryBarCloseWorkspaceRoots';

const auxiliaryBarCloseCommandIds = [
    'workbench.action.closeAuxiliaryBar',
    'workbench.action.closeSecondarySideBar',
];

type GlobalStateStore = {
    get<T>(key: string, defaultValue: T): T,
    update(key: string, value: unknown): Thenable<unknown>,
};

type ExtensionStateContext = {
    globalState: GlobalStateStore,
};

type WorkspaceRootLike = {
    toString(): string,
};

type CommandRegistry = {
    getCommands(filterInternal?: boolean): Thenable<string[]>,
    executeCommand(command: string, ...rest: unknown[]): Thenable<unknown>,
};

function toWorkspaceRootKey(workspaceRootUri: WorkspaceRootLike) {
    return workspaceRootUri.toString();
}

function getPendingWorkspaceRootKeys(context: ExtensionStateContext) {
    return context.globalState.get<string[]>(
        pendingAuxiliaryBarCloseWorkspaceRootsStateKey,
        [],
    );
}

export async function rememberPendingLocalReplicaAuxiliaryBarClose(
    context: ExtensionStateContext,
    workspaceRootUri: WorkspaceRootLike,
) {
    const workspaceRootKey = toWorkspaceRootKey(workspaceRootUri);
    const pendingWorkspaceRootKeys = getPendingWorkspaceRootKeys(context);
    if (pendingWorkspaceRootKeys.includes(workspaceRootKey)) {
        return;
    }
    await context.globalState.update(
        pendingAuxiliaryBarCloseWorkspaceRootsStateKey,
        [...pendingWorkspaceRootKeys, workspaceRootKey].sort((left, right) => left.localeCompare(right)),
    );
}

export async function clearPendingLocalReplicaAuxiliaryBarClose(
    context: ExtensionStateContext,
    workspaceRootUri: WorkspaceRootLike,
) {
    const workspaceRootKey = toWorkspaceRootKey(workspaceRootUri);
    const nextPendingWorkspaceRootKeys = getPendingWorkspaceRootKeys(context)
        .filter((key) => key!==workspaceRootKey);
    await context.globalState.update(
        pendingAuxiliaryBarCloseWorkspaceRootsStateKey,
        nextPendingWorkspaceRootKeys,
    );
}

export function hasPendingLocalReplicaAuxiliaryBarClose(
    context: ExtensionStateContext,
    workspaceRootUri: WorkspaceRootLike,
) {
    return getPendingWorkspaceRootKeys(context).includes(toWorkspaceRootKey(workspaceRootUri));
}

export async function closeAuxiliaryBarIfPresent(commands: CommandRegistry) {
    const availableCommands = new Set(await commands.getCommands(true));
    const commandId = auxiliaryBarCloseCommandIds.find((candidate) => availableCommands.has(candidate));
    if (!commandId) {
        return {
            commandId: undefined,
            didClose: false,
        };
    }
    await commands.executeCommand(commandId);
    return {
        commandId,
        didClose: true,
    };
}

export async function consumePendingLocalReplicaAuxiliaryBarClose(
    context: ExtensionStateContext,
    workspaceRootUri: WorkspaceRootLike,
    commands: CommandRegistry,
) {
    if (!hasPendingLocalReplicaAuxiliaryBarClose(context, workspaceRootUri)) {
        return {
            commandId: undefined,
            didClose: false,
            wasPending: false,
        };
    }

    const result = await closeAuxiliaryBarIfPresent(commands);
    if (result.didClose) {
        await clearPendingLocalReplicaAuxiliaryBarClose(context, workspaceRootUri);
    }

    return {
        ...result,
        wasPending: true,
    };
}
