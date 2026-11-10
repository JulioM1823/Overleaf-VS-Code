const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

// No Overleaf extension, network connection, or authentication is needed to
// reproduce the native renderer defect. Only synthetic text is opened here.
exports.activate = async context => {
    const phase = process.env.OVERLEAF_GLYPH_AUDIT_PHASE;
    assert(['baseline', 'first-line'].includes(phase));
    const directory = process.env.OVERLEAF_GLYPH_AUDIT_DIRECTORY;
    assert(directory && path.isAbsolute(directory));
    const reportPath = path.join(directory, `${phase}.json`);
    const controller = vscode.comments.createCommentController('overleaf-glyph-audit', 'Glyph renderer audit');
    context.subscriptions.push(controller);
    const text = ['\\documentclass{article}', '\\begin{document}', '',
        'A single logical source line. ' + 'Wrapped native comment glyph audit. '.repeat(40),
        '\\end{document}', ''].join('\n');
    const uri = vscode.Uri.file(path.join(directory, `${phase}.tex`));
    await fs.writeFile(uri.fsPath, text, {mode: 0o600});
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, {preview: false});
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closePanel');
    editor.selection = new vscode.Selection(3, 2, 3, 2);
    const threads = [];
    let nextId = 1;
    const addThread = (label, column) => {
        const thread = controller.createCommentThread(uri, new vscode.Range(3, column, 3, column + 1), [{
            body: label, author: {name: 'Synthetic audit'}, mode: vscode.CommentMode.Preview,
        }]);
        thread.label = label;
        thread.contextValue = 'audit';
        thread.canReply = true;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        thread.state = vscode.CommentThreadState.Unresolved;
        threads.push({id: nextId++, thread});
        return thread;
    };
    addThread('Single wrapped-line comment', 2);
    const checkpoints = [];
    const record = async stage => {
        const checkpoint = {
            phase, stage, vscodeVersion: vscode.version,
            logicalLineLength: document.lineAt(3).text.length,
            wordWrap: vscode.workspace.getConfiguration('editor', uri).get('wordWrap'),
            nativeThreads: threads.map(({id, thread}) => ({id, label: thread.label,
                range: {startLine: thread.range.start.line, startCharacter: thread.range.start.character,
                    endLine: thread.range.end.line, endCharacter: thread.range.end.character}})),
        };
        checkpoints.push(checkpoint);
        await fs.writeFile(reportPath, JSON.stringify({...checkpoint, checkpoints}, null, 2), {mode: 0o600});
    };
    context.subscriptions.push(
        vscode.commands.registerCommand('overleaf-glyph-audit.addSecondThread', async () => {
            if (threads.length === 1) { addThread('Second independent comment', 600); }
            await record('multiple-comments');
        }),
        vscode.commands.registerCommand('overleaf-glyph-audit.disposeThreads', async () => {
            threads.splice(0).forEach(({thread}) => thread.dispose());
            await record('disposed');
        }),
        vscode.commands.registerCommand('overleaf-glyph-audit.restoreThread', async () => {
            if (!threads.length) { addThread('Restored wrapped-line comment', 2); }
            await record('restored');
        }),
    );
    await record('single-comment');
};
