import * as fs from 'fs/promises';
import * as vscode from 'vscode';

async function chmodFileUri(uri: vscode.Uri, mode: number) {
    if (process.platform === 'win32' || uri.scheme !== 'file') {
        return;
    }

    try {
        await fs.chmod(uri.fsPath, mode);
    } catch {
        // Permission tightening is best effort. The extension must still work on
        // non-POSIX filesystems and managed workspace providers.
    }
}

export async function restrictPrivateDirectoryPermissions(uri: vscode.Uri) {
    await chmodFileUri(uri, 0o700);
}

export async function restrictPrivateFilePermissions(uri: vscode.Uri) {
    await chmodFileUri(uri, 0o600);
}
