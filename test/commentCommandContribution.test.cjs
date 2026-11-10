const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionManifest = require('../package.json');

test('comment reply action is available for overleaf draft threads', () => {
    const threadContextMenu = extensionManifest?.contributes?.menus?.['comments/commentThread/context'];
    assert.ok(Array.isArray(threadContextMenu), 'Expected comments/commentThread/context contribution array.');

    const replyContribution = threadContextMenu.find((item) => item.command==='overleaf-workshop.comments.reply');
    assert.ok(replyContribution, 'Expected overleaf-workshop.comments.reply contribution.');
    assert.equal(replyContribution.precondition, '!commentIsEmpty && commentController == overleaf-workshop.comments');
    assert.match(
        replyContribution.when,
        /resourceScheme == overleaf-workshop/,
        'Expected reply contribution to allow overleaf-workshop draft submit.',
    );
});

test('escape collapse binding applies to focused overleaf comments', () => {
    const keybindings = extensionManifest?.contributes?.keybindings;
    assert.ok(Array.isArray(keybindings), 'Expected keybindings contribution array.');

    const disableDefaultHideComment = keybindings.find((entry) => {
        return entry.key==='escape' && entry.command==='-workbench.action.hideComment';
    });
    assert.ok(disableDefaultHideComment, 'Expected escape override for default hide comment command.');
    assert.match(
        disableDefaultHideComment.when,
        /^\(commentFocused\s+\|\|\s+commentEditorFocused\)\s+&&\s+commentController\s*==\s*overleaf-workshop\.comments$/,
        'Expected hide-comment override to apply when an Overleaf comment or its editor is focused.',
    );

    const collapseThreadBinding = keybindings.find((entry) => {
        return entry.key==='escape' && entry.command==='overleaf-workshop.comments.collapseThread';
    });
    assert.ok(collapseThreadBinding, 'Expected escape binding for overleaf-workshop.comments.collapseThread.');
    assert.match(
        collapseThreadBinding.when,
        /^\(commentFocused\s+\|\|\s+commentEditorFocused\)\s+&&\s+commentController\s*==\s*overleaf-workshop\.comments$/,
        'Expected collapse binding to be active for focused Overleaf comment threads and editors.',
    );

    const visibleCommentCollapseFallbackBinding = keybindings.find((entry) => {
        return entry.key==='escape'
            && entry.command==='overleaf-workshop.comments.collapseThread'
            && entry.when.includes('commentWidgetVisible');
    });
    assert.ok(visibleCommentCollapseFallbackBinding, 'Expected escape fallback binding for visible Overleaf comment widgets.');
    assert.match(
        visibleCommentCollapseFallbackBinding.when,
        /^!commentFocused\s+&&\s+!commentEditorFocused\s+&&\s+commentWidgetVisible\s+&&\s+commentController\s*==\s*overleaf-workshop\.comments$/,
        'Expected visible comment widget escape fallback to collapse unfocused Overleaf comment threads.',
    );
});

test('inline comment provider avoids the proposed active comment API', () => {
    const providerSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'comments', 'inlineCommentProvider.ts'),
        'utf8',
    );

    assert.doesNotMatch(
        providerSource,
        /\bactiveCommentThread\b/,
        'Expected inline comment focus logic to avoid the proposed activeComment API.',
    );
    assert.doesNotMatch(
        providerSource,
        /\bcomments\.activeComment\b/,
        'Expected inline comment focus logic to avoid the proposed activeComment API.',
    );
});

test('current-window command creation skips visible draft threads', () => {
    const providerSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'comments', 'inlineCommentProvider.ts'),
        'utf8',
    );
    const commandStart = providerSource.indexOf('private async createCommentFromCommand');
    const replyStart = providerSource.indexOf('private async replyToThread');
    assert.notEqual(commandStart, -1, 'Expected createCommentFromCommand in inline comment provider.');
    assert.notEqual(replyStart, -1, 'Expected replyToThread in inline comment provider.');
    const commandBody = providerSource.slice(commandStart, replyStart);

    assert.doesNotMatch(
        commandBody,
        /\bcreateManualCurrentWindowDraftThread\b/,
        'Expected current-window command creation to render only the final formatted thread.',
    );
    assert.doesNotMatch(
        commandBody,
        /\bsubmitCurrentWindowDraftThread\b/,
        'Expected current-window command creation to avoid the visible empty draft submit path.',
    );
    assert.match(
        commandBody,
        /create_comment_from_current_window_command/,
        'Expected current-window command creation to use the direct create/focus path.',
    );
});

test('comment creation renders and focuses the final thread before persistence', () => {
    const providerSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'comments', 'inlineCommentProvider.ts'),
        'utf8',
    );
    const createStart = providerSource.indexOf('private async createCommentThreadFromSelection');
    const refreshStart = providerSource.indexOf('private async requestTargetedReviewRefreshForCommentMutation');
    assert.notEqual(createStart, -1, 'Expected createCommentThreadFromSelection in inline comment provider.');
    assert.notEqual(refreshStart, -1, 'Expected requestTargetedReviewRefreshForCommentMutation in inline comment provider.');
    const createBody = providerSource.slice(createStart, refreshStart);

    const optimisticRenderIndex = createBody.indexOf('createOptimisticSubmittedCommentThread');
    const optimisticFocusIndex = createBody.indexOf('_optimistic_thread');
    const backendCreateIndex = createBody.indexOf('vfs.createComment(');

    assert.notEqual(optimisticRenderIndex, -1, 'Expected an optimistic thread render before backend persistence.');
    assert.notEqual(optimisticFocusIndex, -1, 'Expected the optimistic thread to be focused before backend persistence.');
    assert.notEqual(backendCreateIndex, -1, 'Expected backend comment creation.');
    assert.ok(
        optimisticRenderIndex < backendCreateIndex,
        'Expected the final inline thread to be mounted before vfs.createComment is awaited.',
    );
    assert.ok(
        optimisticFocusIndex < backendCreateIndex,
        'Expected the final inline thread to be focused before vfs.createComment is awaited.',
    );
    assert.match(
        createBody,
        /const threadId = generateCommentThreadId\(\);/,
        'Expected create flow to precompute the canonical Overleaf thread id.',
    );
    assert.match(
        createBody,
        /localMessageId,\s*\n\s*localMessageTimestamp,\s*\n\s*threadId,/,
        'Expected create flow to pass stable optimistic ids into VFS persistence.',
    );
    assert.doesNotMatch(
        createBody,
        /scheduleCommentMutationPanelSuppression|workbench\.action\.closePanel/,
        'Expected comment creation to avoid panel close/open side effects.',
    );
    assert.doesNotMatch(
        createBody,
        /suppressAutomaticCommentsPanelActivation\(/,
        'Expected comment creation to avoid per-action comments.openView settings mutation.',
    );
});

test('vfs comment creation accepts precomputed optimistic identifiers', () => {
    const providerSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'core', 'remoteFileSystemProvider.ts'),
        'utf8',
    );
    const createStart = providerSource.indexOf('async createComment(');
    const replyStart = providerSource.indexOf('async replyToComment(');
    assert.notEqual(createStart, -1, 'Expected createComment in remote file system provider.');
    assert.notEqual(replyStart, -1, 'Expected replyToComment in remote file system provider.');
    const createBody = providerSource.slice(createStart, replyStart);

    assert.match(
        createBody,
        /const threadId = options\?\.threadId \?\? generateCommentThreadId\(\);/,
        'Expected VFS createComment to reuse a caller-provided thread id.',
    );
    assert.match(
        createBody,
        /options\?\.localMessageId \?\? `pending-comment-\$\{uuidv4\(\)\}`/,
        'Expected VFS createComment to reuse a caller-provided local message id.',
    );
    assert.match(
        createBody,
        /options\?\.localMessageTimestamp/,
        'Expected VFS createComment to reuse the optimistic local message timestamp.',
    );
});
