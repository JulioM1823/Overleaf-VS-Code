import * as vscode from 'vscode';
import { ROOT_NAME, ELEGANT_NAME } from './consts';

import { RemoteFileSystemProvider, VirtualFileSystem } from './core/remoteFileSystemProvider';
import { DocumentSessionManager } from './core/documentSessionManager';
import { ProjectManagerProvider } from './core/projectManagerProvider';
import { PdfViewEditorProvider } from './core/pdfViewEditorProvider';
import { DiagnosticsManager } from './core/diagnosticsManager';
import { CompileManager } from './compile/compileManager';
import { LangIntellisenseProvider } from './intellisense';
import { LocalReplicaSCMProvider } from './scm/localReplicaSCM';
import { InlineCommentProvider } from './comments/inlineCommentProvider';
import { initializeCommentDiagnosticsRuntime } from './comments/commentDiagnostics';
import { consumePendingLocalReplicaAuxiliaryBarClose } from './core/localReplicaWorkbenchLayout';
import { resolveActiveProjectWorkspaceBinding } from './core/projectWorkspaceBinding';
import { logDiagnostic } from './utils/diagnostics';

export function activate(context: vscode.ExtensionContext) {
    const diagnosticsManager = new DiagnosticsManager(context);
    context.subscriptions.push(...diagnosticsManager.triggers);
    context.subscriptions.push(...initializeCommentDiagnosticsRuntime());
    void vscode.commands.executeCommand('setContext', `${ROOT_NAME}.chatViewEnabled`, false);
    logDiagnostic('Extension', 'lifecycle.activate_started', {
        extensionVersion: String(context.extension.packageJSON.version ?? 'unknown'),
    }, undefined, {
        category: 'core',
        level: 'info',
    });

    // Register: [core] RemoteFileSystemProvider
    const remoteFileSystemProvider = new RemoteFileSystemProvider(context);
    context.subscriptions.push( ...remoteFileSystemProvider.triggers );

    // Register: [core] DocumentSessionManager for near real-time text sync
    const documentSessionManager = new DocumentSessionManager(remoteFileSystemProvider);
    context.subscriptions.push( ...documentSessionManager.triggers );

    // Register: [core] ProjectManagerProvider on Activitybar
    const projectManagerProvider = new ProjectManagerProvider(context);
    context.subscriptions.push( ...projectManagerProvider.triggers );

    // Register: [core] PdfViewEditorProvider
    const pdfViewEditorProvider = new PdfViewEditorProvider(context);
    context.subscriptions.push( ...pdfViewEditorProvider.triggers );

    // Register: [compile] CompileManager on Statusbar
    const compileManager = new CompileManager(remoteFileSystemProvider, documentSessionManager);
    context.subscriptions.push( ...compileManager.triggers );

    // Register: [comments] InlineCommentProvider
    const inlineCommentProvider = new InlineCommentProvider(context, remoteFileSystemProvider);
    context.subscriptions.push( ...inlineCommentProvider.triggers );

    // Register: [intellisense] LangIntellisenseProvider
    const langIntellisenseProvider = new LangIntellisenseProvider(context, remoteFileSystemProvider);
    context.subscriptions.push( ...langIntellisenseProvider.triggers );

    void resolveActiveProjectWorkspaceBinding()
        .then(async (binding) => {
            if (!binding) {
                logDiagnostic('Extension', 'lifecycle.workspace_runtime_bootstrap_skipped', {
                    reason: 'no_active_overleaf_workspace',
                }, undefined, {
                    category: 'core',
                    level: 'info',
                });
                return;
            }

            await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, true);
            await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.chatViewEnabled`, binding.mode==='localReplica');

            const vfs = (await (await vscode.commands.executeCommand(
                'remoteFileSystem.prefetch',
                binding.overleafProjectUri,
            ))) as VirtualFileSystem;
            await vfs.init({
                autoCompileAfterInitialization: false,
            });

            const warmProjectCommentState = vfs.warmProjectCommentState(
                binding.mode==='localReplica'
                    ? 'workspace_runtime_bootstrap_local_replica'
                    : 'workspace_runtime_bootstrap_current_window',
            );
            void warmProjectCommentState
                .catch((error) => {
                    logDiagnostic('Extension', 'lifecycle.workspace_comment_state_warm_failed', {
                        mode: binding.mode,
                        overleafProjectUri: binding.overleafProjectUri.toString(),
                    }, error, {
                        category: 'core',
                        level: 'warning',
                    });
                });

            if (binding.mode==='localReplica') {
                const auxiliaryBarReset = binding.workspaceRootUri
                    ? await consumePendingLocalReplicaAuxiliaryBarClose(context, binding.workspaceRootUri, vscode.commands)
                    : {commandId: undefined, didClose: false, wasPending: false};
                logDiagnostic('Extension', 'lifecycle.local_replica_auxiliary_bar_reset', {
                    commandId: auxiliaryBarReset.commandId ?? '',
                    didClose: auxiliaryBarReset.didClose,
                    wasPending: auxiliaryBarReset.wasPending,
                    workspaceRootUri: binding.workspaceRootUri?.toString() ?? '',
                }, undefined, {
                    category: 'core',
                    level: 'info',
                });
                const setting = await LocalReplicaSCMProvider.readSettings(binding.workspaceRootUri);
                if (setting?.uri) {
                    await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, true);
                }
            }

            logDiagnostic('Extension', 'lifecycle.workspace_runtime_bootstrap_completed', {
                mode: binding.mode,
                overleafProjectUri: binding.overleafProjectUri.toString(),
                workspaceRootUri: binding.workspaceRootUri?.toString() ?? '',
            }, undefined, {
                category: 'core',
                level: 'info',
            });
        })
        .catch((error) => {
            logDiagnostic('Extension', 'lifecycle.workspace_runtime_bootstrap_failed', {}, error, {
                category: 'core',
                level: 'warning',
            });
        });

    logDiagnostic('Extension', 'lifecycle.activate_completed', {
        extensionVersion: String(context.extension.packageJSON.version ?? 'unknown'),
    }, undefined, {
        category: 'core',
        level: 'info',
    });
}

export function deactivate() {
    logDiagnostic('Extension', 'lifecycle.deactivate', {}, undefined, {
        category: 'core',
        level: 'info',
    });
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.chatViewEnabled`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, false);
}
