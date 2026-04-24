const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveCommentsOpenViewSuppressionDecision,
    shouldSuppressStartupPanelAfterRender,
} = require('../out/comments/commentPanelAutoOpenPolicy.js');

test('resolveCommentsOpenViewSuppressionDecision keeps current-window comment creation eligible for workspace suppression', () => {
    assert.equal(resolveCommentsOpenViewSuppressionDecision({
        mode: 'currentWindow',
        openView: 'firstFile',
        workspaceFolderCount: 1,
    }), 'update_workspace');

    assert.equal(resolveCommentsOpenViewSuppressionDecision({
        mode: 'localReplica',
        openView: 'file',
        workspaceFolderCount: 1,
    }), 'update_workspace');
});

test('resolveCommentsOpenViewSuppressionDecision only skips when there is no workspace context at all', () => {
    assert.equal(resolveCommentsOpenViewSuppressionDecision({
        openView: 'never',
        workspaceFolderCount: 1,
    }), 'already_disabled');

    assert.equal(resolveCommentsOpenViewSuppressionDecision({
        mode: 'currentWindow',
        openView: 'firstFile',
        workspaceFolderCount: 0,
    }), 'skip_no_workspace');

    assert.equal(resolveCommentsOpenViewSuppressionDecision({
        openView: 'firstFile',
        workspaceFolderCount: 1,
    }), 'skip_unmanaged_workspace');
});

test('shouldSuppressStartupPanelAfterRender only targets startup hydration flows', () => {
    const baseOptions = {
        expiresAtMs: 1_000,
        isProviderDisposed: false,
        mode: 'currentWindow',
        now: 100,
        renderPath: '/main.tex',
        snapshotThreadCount: 1,
    };

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        reason: 'initial_visible_editors',
    }), true);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        reason: 'comments_changed_event:comments_threads_hydrated',
    }), true);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        reason: 'queued:comments_changed_event:comments_threads_hydrated',
    }), true);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        reason: 'queued:comments_changed_event:comments_project_index_hydrated',
    }), true);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        mode: 'localReplica',
        reason: 'local_replica_settings_created',
    }), true);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        mode: 'localReplica',
        reason: 'local_replica_settings_changed',
    }), true);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        mode: 'localReplica',
        reason: 'local_replica_settings_deleted',
    }), true);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        reason: 'comments_changed_event:thread_created',
    }), false);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        reason: 'create_comment_materialize',
    }), false);
});

test('shouldSuppressStartupPanelAfterRender handles mixed queued hydration reason variants', () => {
    const baseOptions = {
        expiresAtMs: 1_000,
        isProviderDisposed: false,
        mode: 'currentWindow',
        now: 100,
        renderPath: '/main.tex',
        snapshotThreadCount: 1,
    };

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        reason: 'queued:comments_changed_event:thread_created|comments_changed_event:comments_threads_hydrated',
    }), true);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        reason: 'queued:comments_changed_event:thread_message_created|comments_changed_event:comments_project_index_hydrated',
    }), true);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        ...baseOptions,
        reason: 'queued:comments_changed_event:thread_created|comments_changed_event:thread_message_created',
    }), false);
});

test('shouldSuppressStartupPanelAfterRender rejects non-startup contexts', () => {
    assert.equal(shouldSuppressStartupPanelAfterRender({
        expiresAtMs: 100,
        isProviderDisposed: false,
        mode: 'currentWindow',
        now: 101,
        reason: 'initial_visible_editors',
        renderPath: '/main.tex',
        snapshotThreadCount: 1,
    }), false);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        expiresAtMs: 100,
        isProviderDisposed: true,
        mode: 'currentWindow',
        now: 10,
        reason: 'initial_visible_editors',
        renderPath: '/main.tex',
        snapshotThreadCount: 1,
    }), false);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        expiresAtMs: 100,
        isProviderDisposed: false,
        mode: 'unsupported',
        now: 10,
        reason: 'initial_visible_editors',
        renderPath: '/main.tex',
        snapshotThreadCount: 1,
    }), false);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        expiresAtMs: 100,
        isProviderDisposed: false,
        mode: 'localReplica',
        now: 10,
        reason: 'thread_created',
        renderPath: '/main.tex',
        snapshotThreadCount: 1,
    }), false);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        expiresAtMs: 100,
        isProviderDisposed: false,
        mode: 'currentWindow',
        now: 10,
        reason: 'initial_visible_editors',
        renderPath: '/main.bib',
        snapshotThreadCount: 1,
    }), false);

    assert.equal(shouldSuppressStartupPanelAfterRender({
        expiresAtMs: 100,
        isProviderDisposed: false,
        mode: 'currentWindow',
        now: 10,
        reason: 'initial_visible_editors',
        renderPath: '/main.tex',
        snapshotThreadCount: 0,
    }), false);
});
