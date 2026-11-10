# Diagnostics and Debugging

This document describes the extension diagnostics runtime introduced in the first observability implementation phase.

## Structured Log Schema

All diagnostics records are emitted as JSON with a stable shape:

- `event`: event name (for example `session.flush_failed`)
- `timestamp`: ISO timestamp
- `sequence`: monotonic runtime emission counter for ordering events that share similar timestamps
- `scope`: subsystem logger scope
- `level`: `debug`, `info`, `warning`, or `error`
- `category`: subsystem category such as `sync`, `chat`, `comments`, `filesystem`, `network`, `compile`, `offline`, `scm`, `intellisense`, `project`, or `core`
- optional contextual fields (for example document IDs, retry counts, durations)
- normalized error details (`errorName`, `errorMessage`, optional `errorCode`, optional `errorStack`)

## Runtime Controls

The following settings are available under `overleaf-workshop.diagnostics.*`:

- `enabled`: enables advanced diagnostics filtering and snapshots
- `verbose`: forces debug-level emission when diagnostics are enabled
- `level`: minimum level threshold (`debug|info|warning|error`)
- `enabledCategories`: optional category filter (empty means all)
- `maxBufferRecords`: in-memory ring-buffer size for recent diagnostics
- `includeErrorStack`: includes `errorStack` for `Error` values
- `consoleEnabled`: mirrors diagnostics to extension host console output
- `outputChannel.enabled`: mirrors diagnostics to the diagnostics output channel

When diagnostics are disabled, warning and error records still emit for low-overhead operational visibility.

## Privacy

Document/message bodies, credentials, names, identifiers and path/URL fields are
redacted before console output, buffering, snapshots or clipboard export. Sensitive
objects and arrays are redacted as complete containers, including their keys.
Free-form error messages and stacks are redacted; arbitrary thrown objects become
a fixed error marker. Operational event names, error classes/codes, counts,
durations and status values remain available.

Redacted strings use a process-local keyed digest. Matching values can be correlated
within one extension-host process; their digests change after a restart and cannot
be compared to a public SHA-256 dictionary. These remain pseudonyms, not a claim of
complete anonymization. Normalization bounds depth, collections and total values,
and replaces cycles, so malformed diagnostics cannot recurse indefinitely.

## Developer Commands

Use the command palette with these commands:

- `Show Diagnostics Output`
- `Dump Diagnostics Snapshot`
- `Clear Diagnostics Buffer`
- `Dump Active Project Diagnostics`
- `Retry Active Project Sync`
- `Toggle Diagnostics`
- `Toggle Verbose Diagnostics`
- `Set Diagnostics Level`
- `Set Diagnostics Subsystem Filter`

`Dump Diagnostics Snapshot` writes state and recent records to the diagnostics output channel and copies the snapshot JSON to the clipboard.
`Dump Active Project Diagnostics` opens a project-scoped JSON snapshot with queue summaries, recent project records, EventBus state, offline storage, and document-sync journal coverage.
`Retry Active Project Sync` manually nudges realtime recovery when disconnected or initializing, then retries deferred synchronization and refreshes comment/review state.

Deferred synchronization queue changes are logged with `offline.queue_transition`. These records include a `queueRevision`, before/after operation counts, counts by operation kind, and a sanitized operation sample without message/comment body content.

## Tracing and Timing Utilities

`src/utils/diagnostics.ts` now exposes helper APIs for deeper instrumentation:

- `createDiagnosticTraceContext(...)`
- `withDiagnosticTraceFields(...)`
- `startDiagnosticSpan(...)`

Use `startDiagnosticSpan(...)` for long-running operations to record `started`, `completed`, and `failed` lifecycle events with `durationMs`.

Key workflows now instrumented with spans:

- sync recovery: `sync_recovery.resume`, `sync_recovery.replay`
- chat send lifecycle: `chat.message_send`
- comment lifecycle: `comments.lifecycle.create`, `comments.lifecycle.reply`, `comments.lifecycle.edit`, `comments.lifecycle.delete_message`, `comments.lifecycle.resolve_thread`, `comments.lifecycle.delete_thread`
- compile pipeline: `compile.pipeline`

## Failure Taxonomy

High-value error paths now include a `failureClass` field with one of:

- `transient`: likely recoverable transport/connectivity/rate-limit conditions
- `persistent`: repeated or replay-blocking failures that likely require investigation
- `user-actionable`: user input or project state likely needs correction
- `internal`: unexpected extension/runtime defects or invariants violated

Use `failureClass` with `event`, `category`, and `traceId` to prioritize troubleshooting.

## State Introspection

The diagnostics runtime supports pluggable state providers via `registerDiagnosticStateProvider(...)`.

The extension currently registers:

- `extension` provider: extension version, workspace/editor metadata, runtime diagnostics config
- `eventBus` provider: listener inventory by event plus registered listener metadata
- `documentSessions` provider: open document-session status, pending flush/recovery state, local-delta flags, and suppressed edit state
- `compileManager` provider: compile status, pending compile-on-save/queued compile requests, and active PDF views
- `filesystem:provider` provider: active VFS/project inventory across the extension host
- `sync` provider: connection phase, sync mode, recovery state, queue/retry state, deferred queue revision
- `chat` provider: message counts, queue/replay/confirmation state, chat transport availability
- `comments` provider: thread/range counts, load state, resolved-thread counts
- `filesystem` provider: root/cache/watch status, document counts, output build markers
- `network` provider: socket scheme/session/transport/connectivity state
- `offline` provider: deferred operation counts/kinds, sanitized queue samples, queue revision, and offline persistence/retry scheduling

Additional subsystem providers can be added incrementally without changing core behavior.

## Comment Recovery Debugging

The comment diagnostics snapshot now includes comment-specific recovery and parity data intended for maintaining inline/review synchronization:

- active Overleaf workspace binding and project identity
- recent comment bridge events (inline render, review authoritative render, review refresh requests, manual reconcile)
- review panel refresh history from the resolved provider
- rendered inline snapshot coverage for the active project
- per-document inline vs review parity summaries
- comment VFS anomaly counts for threads without ranges, ranges without threads, and sampled alias mappings

Use `Overleaf-VS Code: Dump Comment Diagnostics Snapshot` after reproducing a reconnect/import issue. The snapshot is designed to answer three questions quickly:

1. Did the VFS load both thread messages and anchor ranges?
2. Did inline render the imported thread for the affected document?
3. Did the review bridge and panel refresh consume that same thread state?

## Inline Comment Create Debugging

The inline comment diagnostics snapshot now includes an `interactionState` section under `inlineProviderState` for the instant-open / no-auto-open workflow.

Use `Overleaf-VS Code: Dump Comment Diagnostics` after reproducing a comment creation or project-open issue, then check:

- `inlineProviderState.interactionState.pendingCreatedCommentFocus`
  - shows queued pending create-focus requests per URI
  - includes request age, selection coordinates, and whether stale requests were left behind
- `inlineProviderState.interactionState.panelSuppression`
  - shows whether startup or first-thread-create suppression timers are active
  - includes suppression delays, retry cadence, attempt limits, and the remaining startup window
- `inlineProviderState.interactionState.recentCreateFocusEvents`
  - captures the enqueue, wait, fulfill, removal, expiry, and direct-focus completion events for new threads
- `inlineProviderState.interactionState.recentPanelSuppressionEvents`
  - captures every runtime-only panel suppression decision plus scheduled, applied, and failed close-panel attempts

The most useful event names for this workflow are:

- `comment_thread.pending_focus_enqueued`
- `comment_thread.pending_focus_waiting_for_render`
- `comment_thread.pending_focus_fulfilling`
- `comment_thread.pending_focus_fulfilled`
- `comment_thread.pending_focus_removed`
- `comment_thread.pending_focus_expired`
- `create_comment_thread.inline_focus_completed`
- `create_comment_thread.inline_focus_deferred_to_pending_request`
- `comments_panel_auto_open_runtime_only`
- `comments_panel_auto_open_suppression_scheduled_startup`
- `comments_panel_auto_open_suppression_scheduled_after_first_thread_create`

For low-noise investigation, enable:

- `overleaf-workshop.comments.debug.enabled`
- `overleaf-workshop.comments.debug.inline`
- `overleaf-workshop.comments.debug.panel`

That combination is enough to determine whether a new thread rendered immediately, whether focus was applied locally or deferred to the comment-change event, and whether the extension attempted to close the Comments panel at the right times.
