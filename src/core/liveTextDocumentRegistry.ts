import * as vscode from 'vscode';

export type ManagedTextDocumentState = 'pending' | 'syncing' | 'live' | 'offline-queued' | 'recovery-required';

interface ManagedTextDocumentEntry {
    sessionKey?: string,
    state: ManagedTextDocumentState,
}

const entriesByUriKey = new Map<string, ManagedTextDocumentEntry>();
const uriKeysBySessionKey = new Map<string, Set<string>>();

function toUriKey(uri: vscode.Uri) {
    return uri.toString();
}

export function markManagedDocumentPending(uri: vscode.Uri) {
    const uriKey = toUriKey(uri);
    const existingEntry = entriesByUriKey.get(uriKey);
    if (existingEntry) {
        return existingEntry.state;
    }
    entriesByUriKey.set(uriKey, {
        state: 'pending',
    });
    return 'pending';
}

export function linkManagedDocumentUri(
    sessionKey: string,
    uri: vscode.Uri,
    state: Exclude<ManagedTextDocumentState, 'pending'>,
) {
    const uriKey = toUriKey(uri);
    entriesByUriKey.set(uriKey, {
        sessionKey,
        state,
    });
    const sessionUriKeys = uriKeysBySessionKey.get(sessionKey) ?? new Set<string>();
    sessionUriKeys.add(uriKey);
    uriKeysBySessionKey.set(sessionKey, sessionUriKeys);
}

export function setManagedDocumentSessionState(
    sessionKey: string,
    state: Exclude<ManagedTextDocumentState, 'pending'>,
) {
    const sessionUriKeys = uriKeysBySessionKey.get(sessionKey);
    if (!sessionUriKeys) {
        return;
    }
    for (const uriKey of sessionUriKeys) {
        const entry = entriesByUriKey.get(uriKey);
        if (!entry || entry.sessionKey!==sessionKey) {
            continue;
        }
        entriesByUriKey.set(uriKey, {
            ...entry,
            state,
        });
    }
}

export function clearManagedDocumentUri(uri: vscode.Uri) {
    const uriKey = toUriKey(uri);
    const entry = entriesByUriKey.get(uriKey);
    if (!entry) {
        return;
    }
    entriesByUriKey.delete(uriKey);
    if (!entry.sessionKey) {
        return;
    }
    const sessionUriKeys = uriKeysBySessionKey.get(entry.sessionKey);
    if (!sessionUriKeys) {
        return;
    }
    sessionUriKeys.delete(uriKey);
    if (sessionUriKeys.size===0) {
        uriKeysBySessionKey.delete(entry.sessionKey);
    }
}

export function clearManagedDocumentSession(sessionKey: string) {
    const sessionUriKeys = uriKeysBySessionKey.get(sessionKey);
    if (!sessionUriKeys) {
        return;
    }
    for (const uriKey of sessionUriKeys) {
        entriesByUriKey.delete(uriKey);
    }
    uriKeysBySessionKey.delete(sessionKey);
}

export function getManagedDocumentState(uri: vscode.Uri): ManagedTextDocumentState | undefined {
    return entriesByUriKey.get(toUriKey(uri))?.state;
}

export function resetManagedTextDocumentRegistryForTest() {
    entriesByUriKey.clear();
    uriKeysBySessionKey.clear();
}
