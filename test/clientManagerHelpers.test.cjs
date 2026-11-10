const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_COMMENT_USER_PALETTE,
} = require('../out/comments/commentColors.js');

const {
    COLLABORATOR_CONNECTION_INDICATOR_CONNECTED_HOLD_MS,
    createCollaboratorQuickPickItem,
    didCollaboratorMove,
    escapeCollaboratorMarkdownText,
    formatCollaboratorActivityAge,
    formatCollaboratorCursorInfo,
    resolveCollaboratorConnectionIndicatorState,
    resolveCollaboratorConnectionIndicatorVisualState,
    resolveCollaboratorCursorColor,
    sortCollaboratorQuickPickItems,
} = require('../out/collaboration/clientManagerHelpers.js');

test('escapeCollaboratorMarkdownText escapes remote collaborator markup', () => {
    const escaped = escapeCollaboratorMarkdownText('Ada](command:evil) ![x](https://leak.example/a)\n<img src=x>');

    assert.equal(escaped.includes(']('), false);
    assert.equal(escaped.includes('!['), false);
    assert.equal(escaped.includes('<img src=x>'), false);
    assert.equal(escaped.includes('\n'), false);
    assert.match(escaped, /Ada\\\]/);
    assert.match(escaped, /\\<img src=x\\>/);
});

test('formatCollaboratorCursorInfo keeps first-line locations visible', () => {
    assert.deepEqual(formatCollaboratorCursorInfo('/main.tex', 0), {
        docPath: 'main.tex',
        row: 1,
    });
});

test('formatCollaboratorCursorInfo returns undefined without a document path', () => {
    assert.equal(formatCollaboratorCursorInfo(undefined, 4), undefined);
});

test('formatCollaboratorActivityAge uses readable short relative times', () => {
    assert.equal(formatCollaboratorActivityAge(4_000), 'Active just now');
    assert.equal(formatCollaboratorActivityAge(42_000), 'Active 42s ago');
    assert.equal(formatCollaboratorActivityAge(5 * 60_000), 'Active 5m ago');
});

test('createCollaboratorQuickPickItem keeps cursor and activity details separate', () => {
    assert.deepEqual(
        createCollaboratorQuickPickItem({
            clientId: 'abc',
            cursorInfo: 'At main.tex, Line 9',
            email: 'user@example.com',
            lastActive: 1_000,
            name: 'Julio',
            now: 61_000,
        }),
        {
            clientId: 'abc',
            description: 'user@example.com',
            detail: 'At main.tex, Line 9 • Active 1m ago',
            label: 'Julio',
            lastActive: 1_000,
        },
    );
});

test('sortCollaboratorQuickPickItems orders newest activity first', () => {
    const items = sortCollaboratorQuickPickItems([
        {clientId: 'b', label: 'Beta', lastActive: 100},
        {clientId: 'a', label: 'Alpha', lastActive: 200},
        {clientId: 'c', label: 'Gamma', lastActive: 200},
    ]);
    assert.deepEqual(items.map(item => item.clientId), ['a', 'c', 'b']);
});

test('didCollaboratorMove ignores duplicate cursor updates', () => {
    assert.equal(
        didCollaboratorMove(
            {docId: 'doc-1', row: 5, column: 8},
            {docId: 'doc-1', row: 5, column: 8},
        ),
        false,
    );
});

test('didCollaboratorMove detects document and row changes', () => {
    assert.equal(
        didCollaboratorMove(
            {docId: 'doc-1', row: 5, column: 8},
            {docId: 'doc-2', row: 0, column: 0},
        ),
        true,
    );
    assert.equal(
        didCollaboratorMove(
            {docId: 'doc-1', row: 5, column: 8},
            {docId: 'doc-1', row: 6, column: 8},
        ),
        true,
    );
});

test('resolveCollaboratorCursorColor is deterministic for the same collaborator key', () => {
    const usedColors = new Set(['#0077b6', '#0081a7']);
    const first = resolveCollaboratorCursorColor('user-123', usedColors);
    const second = resolveCollaboratorCursorColor('user-123', usedColors);
    assert.equal(first, second);
});

test('resolveCollaboratorCursorColor avoids currently used collaborator colors', () => {
    const alpha = resolveCollaboratorCursorColor('alpha', new Set());
    const beta = resolveCollaboratorCursorColor('beta', new Set([alpha]));
    const gamma = resolveCollaboratorCursorColor('gamma', new Set([alpha, beta]));
    assert.notEqual(alpha, beta);
    assert.notEqual(beta, gamma);
    assert.notEqual(alpha, gamma);
});

test('resolveCollaboratorCursorColor uses the comment author color tag palette', () => {
    const color = resolveCollaboratorCursorColor('alpha', new Set());
    assert.equal(DEFAULT_COMMENT_USER_PALETTE.includes(color), true);
});

test('resolveCollaboratorCursorColor accepts a custom comment author color tag palette', () => {
    const customPalette = [
        '#ff6b6b',
        '#f7b267',
        '#7bd389',
        '#6ec1e4',
        '#9d8df1',
        '#f45b69',
    ];
    const color = resolveCollaboratorCursorColor('alpha', new Set(), customPalette);
    assert.equal(customPalette.includes(color), true);
});

test('resolveCollaboratorCursorColor falls back to generated comment tag colors when the base palette is exhausted', () => {
    const exhausted = new Set(DEFAULT_COMMENT_USER_PALETTE);
    const color = resolveCollaboratorCursorColor('overflow-user', exhausted);
    assert.match(color, /^#[0-9a-f]{6}$/i);
    assert.equal(exhausted.has(color), false);
});

test('resolveCollaboratorConnectionIndicatorState stays disconnected while the project is offline', () => {
    assert.equal(resolveCollaboratorConnectionIndicatorState({
        connectionPhase: 'recovering',
        synchronizationMode: 'offline',
    }), 'disconnected');
    assert.equal(resolveCollaboratorConnectionIndicatorState({
        connectionPhase: 'live',
        synchronizationMode: 'offline',
    }), 'disconnected');
});

test('resolveCollaboratorConnectionIndicatorState shows reconnecting during recovery before offline is declared', () => {
    assert.equal(resolveCollaboratorConnectionIndicatorState({
        connectionPhase: 'recovering',
        synchronizationMode: 'online',
    }), 'reconnecting');
    assert.equal(resolveCollaboratorConnectionIndicatorState({
        connectionPhase: 'initializing',
        synchronizationMode: 'online',
    }), 'reconnecting');
});

test('resolveCollaboratorConnectionIndicatorState stays connected during document recovery when the socket is healthy', () => {
    assert.equal(resolveCollaboratorConnectionIndicatorState({
        connectionPhase: 'recovering',
        synchronizationMode: 'online',
        transportConnected: true,
    }), 'connected');
    assert.equal(resolveCollaboratorConnectionIndicatorState({
        connectionPhase: 'live',
        synchronizationMode: 'sync-recovery',
        transportConnected: true,
    }), 'connected');
});

test('resolveCollaboratorConnectionIndicatorState returns connected only for stable online phases', () => {
    assert.equal(resolveCollaboratorConnectionIndicatorState({
        connectionPhase: 'live',
        synchronizationMode: 'online',
    }), 'connected');
    assert.equal(resolveCollaboratorConnectionIndicatorState({
        connectionPhase: 'invisible',
        synchronizationMode: 'online',
    }), 'connected');
});

test('resolveCollaboratorConnectionIndicatorVisualState holds a non-connected icon briefly before returning online', () => {
    assert.deepEqual(resolveCollaboratorConnectionIndicatorVisualState({
        currentTimeMs: 5_000,
        lastNonConnectedAtMs: 4_000,
        previousVisualState: 'disconnected',
        requestedState: 'connected',
    }), {
        holdMs: COLLABORATOR_CONNECTION_INDICATOR_CONNECTED_HOLD_MS - 1_000,
        state: 'disconnected',
    });
});

test('resolveCollaboratorConnectionIndicatorVisualState releases to online after the hold expires', () => {
    assert.deepEqual(resolveCollaboratorConnectionIndicatorVisualState({
        currentTimeMs: 10_000,
        lastNonConnectedAtMs: 8_000,
        previousVisualState: 'reconnecting',
        requestedState: 'connected',
    }), {
        holdMs: 0,
        state: 'connected',
    });
});

test('resolveCollaboratorConnectionIndicatorVisualState does not delay initial or already-connected renders', () => {
    assert.deepEqual(resolveCollaboratorConnectionIndicatorVisualState({
        currentTimeMs: 1_000,
        requestedState: 'connected',
    }), {
        holdMs: 0,
        state: 'connected',
    });
    assert.deepEqual(resolveCollaboratorConnectionIndicatorVisualState({
        currentTimeMs: 5_000,
        lastNonConnectedAtMs: 4_800,
        previousVisualState: 'connected',
        requestedState: 'connected',
    }), {
        holdMs: 0,
        state: 'connected',
    });
});
