import * as vscode from 'vscode';
import { ELEGANT_NAME, ROOT_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import {
    clearDiagnosticBuffer,
    collectDiagnosticSnapshot,
    configureDiagnostics,
    DIAGNOSTIC_CATEGORIES,
    DIAGNOSTIC_LEVELS,
    DiagnosticCategory,
    DiagnosticLevel,
    getDiagnosticsRuntimeConfiguration,
    logDiagnostic,
    registerDiagnosticStateProvider,
    setDiagnosticSink,
} from '../utils/diagnostics';

type CategoryQuickPickItem = vscode.QuickPickItem & {
    category: DiagnosticCategory,
};

function isDiagnosticCategory(value: string): value is DiagnosticCategory {
    return DIAGNOSTIC_CATEGORIES.includes(value as DiagnosticCategory);
}

function isDiagnosticLevel(value: string): value is DiagnosticLevel {
    return DIAGNOSTIC_LEVELS.includes(value as DiagnosticLevel);
}

export class DiagnosticsManager {
    readonly triggers: vscode.Disposable[];

    private readonly outputChannel: vscode.OutputChannel;
    private readonly stateProviderRegistrations: Array<{dispose: () => void}>;
    private outputChannelEnabled = true;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel(`${ELEGANT_NAME} Diagnostics`);
        this.stateProviderRegistrations = [
            registerDiagnosticStateProvider('extension', () => this.collectExtensionState()),
            registerDiagnosticStateProvider('eventBus', () => EventBus.getDiagnosticsState()),
        ];
        setDiagnosticSink((_scope, formattedRecord) => {
            if (this.outputChannelEnabled) {
                this.outputChannel.appendLine(formattedRecord);
            }
        });

        this.applySettings('initialization');

        this.triggers = [
            this.outputChannel,
            new vscode.Disposable(() => {
                this.stateProviderRegistrations.splice(0).forEach((registration) => registration.dispose());
                setDiagnosticSink(undefined);
            }),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration(ROOT_NAME)) {
                    this.applySettings('configuration_changed');
                }
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.diagnostics.showOutput`, () => {
                this.outputChannel.show(true);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.diagnostics.dumpState`, () => {
                void this.dumpState();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.diagnostics.clearBuffer`, () => {
                this.clearBuffer();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.diagnostics.toggleEnabled`, () => {
                void this.toggleEnabled();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.diagnostics.toggleVerbose`, () => {
                void this.toggleVerbose();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.diagnostics.setLevel`, () => {
                void this.setMinimumLevel();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.diagnostics.setSubsystemFilter`, () => {
                void this.setSubsystemFilter();
            }),
        ];

        logDiagnostic('Diagnostics', 'diagnostics.manager_initialized', {
            extensionVersion: String(this.context.extension.packageJSON.version ?? 'unknown'),
            workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
        }, undefined, {
            category: 'core',
            level: 'info',
        });
    }

    private applySettings(reason: 'initialization' | 'configuration_changed') {
        const configuration = vscode.workspace.getConfiguration(ROOT_NAME);
        const configuredLevel = configuration.get<string>('diagnostics.level', 'warning');
        const minLevel = isDiagnosticLevel(configuredLevel) ? configuredLevel : 'warning';

        const rawCategories = configuration.get<string[]>('diagnostics.enabledCategories', []);
        const enabledCategories = rawCategories.filter(isDiagnosticCategory);

        this.outputChannelEnabled = configuration.get<boolean>('diagnostics.outputChannel.enabled', true);

        configureDiagnostics({
            enabled: configuration.get<boolean>('diagnostics.enabled', false),
            verbose: configuration.get<boolean>('diagnostics.verbose', false),
            minLevel,
            enabledCategories,
            maxBufferRecords: configuration.get<number>('diagnostics.maxBufferRecords', 800),
            includeErrorStack: configuration.get<boolean>('diagnostics.includeErrorStack', false),
            consoleEnabled: configuration.get<boolean>('diagnostics.consoleEnabled', true),
        });

        const runtimeConfiguration = getDiagnosticsRuntimeConfiguration();
        logDiagnostic('Diagnostics', 'diagnostics.settings_applied', {
            enabled: runtimeConfiguration.enabled,
            enabledCategories: runtimeConfiguration.enabledCategories,
            includeErrorStack: runtimeConfiguration.includeErrorStack,
            maxBufferRecords: runtimeConfiguration.maxBufferRecords,
            minLevel: runtimeConfiguration.minLevel,
            outputChannelEnabled: this.outputChannelEnabled,
            reason,
            verbose: runtimeConfiguration.verbose,
        }, undefined, {
            category: 'core',
            level: 'info',
        });
    }

    private clearBuffer() {
        clearDiagnosticBuffer();
        this.outputChannel.clear();
        this.outputChannel.appendLine(`[${new Date().toISOString()}] diagnostics.buffer_cleared`);
        logDiagnostic('Diagnostics', 'diagnostics.buffer_cleared', {}, undefined, {
            category: 'core',
            level: 'info',
        });
    }

    private async dumpState() {
        const snapshot = collectDiagnosticSnapshot({recentLimit: 200});
        const serialized = JSON.stringify(snapshot, null, 2);

        this.outputChannel.appendLine(`[${new Date().toISOString()}] diagnostics.snapshot_requested`);
        this.outputChannel.appendLine(serialized);
        this.outputChannel.show(true);

        try {
            await vscode.env.clipboard.writeText(serialized);
            vscode.window.showInformationMessage(`${ELEGANT_NAME}: diagnostics snapshot copied to clipboard.`);
        } catch (error) {
            logDiagnostic('Diagnostics', 'diagnostics.snapshot_clipboard_failed', {}, error, {
                category: 'core',
                level: 'warning',
            });
        }
    }

    private async toggleVerbose() {
        const configuration = vscode.workspace.getConfiguration(ROOT_NAME);
        const nextVerbose = !configuration.get<boolean>('diagnostics.verbose', false);

        await configuration.update('diagnostics.verbose', nextVerbose, this.resolveConfigurationTarget());

        vscode.window.showInformationMessage(
            `${ELEGANT_NAME}: verbose diagnostics ${nextVerbose ? 'enabled' : 'disabled'}.`,
        );
    }

    private async toggleEnabled() {
        const configuration = vscode.workspace.getConfiguration(ROOT_NAME);
        const nextEnabled = !configuration.get<boolean>('diagnostics.enabled', false);

        await configuration.update('diagnostics.enabled', nextEnabled, this.resolveConfigurationTarget());

        vscode.window.showInformationMessage(
            `${ELEGANT_NAME}: diagnostics ${nextEnabled ? 'enabled' : 'disabled'}.`,
        );
    }

    private async setMinimumLevel() {
        const configuration = vscode.workspace.getConfiguration(ROOT_NAME);
        const currentLevel = configuration.get<string>('diagnostics.level', 'warning');

        const selected = await vscode.window.showQuickPick(
            DIAGNOSTIC_LEVELS.map((level) => ({
                description: level===currentLevel ? 'Current' : undefined,
                label: level,
            })),
            {
                placeHolder: 'Select minimum diagnostics level',
                title: `${ELEGANT_NAME}: Diagnostics Level`,
            },
        );

        if (!selected) {
            return;
        }

        await configuration.update('diagnostics.level', selected.label, this.resolveConfigurationTarget());
    }

    private async setSubsystemFilter() {
        const configuration = vscode.workspace.getConfiguration(ROOT_NAME);
        const currentSelection = new Set(
            configuration
                .get<string[]>('diagnostics.enabledCategories', [])
                .filter(isDiagnosticCategory),
        );

        const categoryItems: CategoryQuickPickItem[] = DIAGNOSTIC_CATEGORIES
            .filter((category) => category!=='unknown')
            .map((category) => ({
                category,
                description: currentSelection.has(category) ? 'Selected' : undefined,
                label: category,
                picked: currentSelection.has(category),
            }));

        const selected = await vscode.window.showQuickPick(categoryItems, {
            canPickMany: true,
            placeHolder: 'Select subsystems to include. Leave empty to include all.',
            title: `${ELEGANT_NAME}: Diagnostics Subsystem Filter`,
        });

        if (!selected) {
            return;
        }

        const nextSelection = selected.map((item) => item.category);
        await configuration.update('diagnostics.enabledCategories', nextSelection, this.resolveConfigurationTarget());
    }

    private collectExtensionState(): Record<string, unknown> {
        const activeEditor = vscode.window.activeTextEditor;
        return {
            activeEditor: activeEditor
                ? {
                    languageId: activeEditor.document.languageId,
                    scheme: activeEditor.document.uri.scheme,
                }
                : null,
            extensionVersion: String(this.context.extension.packageJSON.version ?? 'unknown'),
            runtimeConfiguration: getDiagnosticsRuntimeConfiguration(),
            textDocumentCount: vscode.workspace.textDocuments.length,
            workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
                name: folder.name,
                scheme: folder.uri.scheme,
            })),
        };
    }

    private resolveConfigurationTarget(): vscode.ConfigurationTarget {
        return (vscode.workspace.workspaceFolders?.length ?? 0) > 0
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
    }
}
