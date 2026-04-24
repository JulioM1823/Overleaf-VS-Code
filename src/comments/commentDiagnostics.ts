import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import {
    DiagnosticLevel,
    logDiagnostic,
    registerDiagnosticStateProvider,
} from '../utils/diagnostics';

export type CommentDiagnosticsSubsystem =
    | 'inline'
    | 'panel'
    | 'sync'
    | 'lifecycle'
    | 'eventBus'
    | 'invariants';

export type CommentDiagnosticsRuntimeConfiguration = {
    enabled: boolean,
    inline: boolean,
    panel: boolean,
    sync: boolean,
    lifecycle: boolean,
    eventBus: boolean,
    invariants: boolean,
};

const defaultRuntimeConfiguration: CommentDiagnosticsRuntimeConfiguration = {
    enabled: false,
    inline: true,
    panel: true,
    sync: true,
    lifecycle: true,
    eventBus: true,
    invariants: true,
};

let runtimeConfiguration: CommentDiagnosticsRuntimeConfiguration = {
    ...defaultRuntimeConfiguration,
};
let initialized = false;

function resolveRuntimeConfiguration(): CommentDiagnosticsRuntimeConfiguration {
    const configuration = vscode.workspace.getConfiguration(ROOT_NAME);
    return {
        enabled: configuration.get<boolean>('comments.debug.enabled', defaultRuntimeConfiguration.enabled),
        eventBus: configuration.get<boolean>('comments.debug.eventBus', defaultRuntimeConfiguration.eventBus),
        inline: configuration.get<boolean>('comments.debug.inline', defaultRuntimeConfiguration.inline),
        invariants: configuration.get<boolean>('comments.debug.invariants', defaultRuntimeConfiguration.invariants),
        lifecycle: configuration.get<boolean>('comments.debug.lifecycle', defaultRuntimeConfiguration.lifecycle),
        panel: configuration.get<boolean>('comments.debug.panel', defaultRuntimeConfiguration.panel),
        sync: configuration.get<boolean>('comments.debug.sync', defaultRuntimeConfiguration.sync),
    };
}

function isSubsystemEnabled(subsystem: CommentDiagnosticsSubsystem): boolean {
    if (!runtimeConfiguration.enabled) {
        return false;
    }

    switch (subsystem) {
        case 'inline':
            return runtimeConfiguration.inline;
        case 'panel':
            return runtimeConfiguration.panel;
        case 'sync':
            return runtimeConfiguration.sync;
        case 'lifecycle':
            return runtimeConfiguration.lifecycle;
        case 'eventBus':
            return runtimeConfiguration.eventBus;
        case 'invariants':
            return runtimeConfiguration.invariants;
    }
}

function applyRuntimeConfiguration(reason: 'configuration_changed' | 'initialization') {
    runtimeConfiguration = resolveRuntimeConfiguration();
    logDiagnostic('CommentDiagnostics', 'comments.debug_settings_applied', {
        reason,
        ...runtimeConfiguration,
    }, undefined, {
        category: 'comments',
        level: 'info',
    });
}

export function initializeCommentDiagnosticsRuntime(): vscode.Disposable[] {
    if (initialized) {
        return [];
    }

    initialized = true;
    applyRuntimeConfiguration('initialization');

    const stateRegistration = registerDiagnosticStateProvider('commentsDebug', () => ({
        ...runtimeConfiguration,
    }));

    const settingsSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(`${ROOT_NAME}.comments.debug`)) {
            return;
        }
        applyRuntimeConfiguration('configuration_changed');
    });

    const disposeHandle = new vscode.Disposable(() => {
        initialized = false;
        stateRegistration.dispose();
    });

    return [
        settingsSubscription,
        disposeHandle,
    ];
}

export function getCommentDiagnosticsRuntimeConfiguration(): CommentDiagnosticsRuntimeConfiguration {
    return {
        ...runtimeConfiguration,
    };
}

export function shouldLogCommentDiagnostics(subsystem: CommentDiagnosticsSubsystem): boolean {
    return isSubsystemEnabled(subsystem);
}

export function shouldCheckCommentDiagnosticsInvariants(): boolean {
    return runtimeConfiguration.enabled && runtimeConfiguration.invariants;
}

export function logCommentDiagnostics(
    scope: string,
    subsystem: CommentDiagnosticsSubsystem,
    event: string,
    fields: Record<string, unknown> = {},
    error?: unknown,
    options: {
        level?: DiagnosticLevel,
    } = {},
) {
    if (!isSubsystemEnabled(subsystem)) {
        return;
    }

    logDiagnostic(scope, event, {
        commentSubsystem: `comments:${subsystem}`,
        ...fields,
    }, error, {
        category: 'comments',
        level: options.level ?? 'warning',
    });
}
