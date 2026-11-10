# Compatibility Notes

This document records editor and platform constraints that affect how Overleaf-VS Code can behave.
It exists to keep implementation plans realistic and to reduce repeated investigation work during issue triage.

## Visual Studio Code

Overleaf-VS Code is developed and validated against Visual Studio Code's extension APIs.
The extension's core workflows are expected to work in VS Code:

- server authentication
- project listing and opening
- virtual-workspace editing and syncing
- compile and PDF preview
- project history and local replica mode

## Cursor

- Status: partially feasible compatibility target.
- Constraint:
  - Cursor is derived from VS Code, but it is not guaranteed to preserve all VS Code extension behavior or extension-host assumptions.
  - Differences in virtual workspace support, webview lifecycle, or editor-supplied AI features can affect the extension even when the extension code is correct.
- Supported expectation:
  - Core Overleaf workflows may work if Cursor preserves the relevant VS Code APIs.
  - Compatibility must be treated as a smoke-tested best effort, not guaranteed parity.
- Current recommendation:
  - Validate login, open project, edit/save, compile, PDF open, and local replica mode in the specific Cursor build before promising support.
  - Prefer local replica mode if Cursor-specific tooling rejects virtual files.

## Copilot and Other AI Edit Tools on Virtual Files

- Status: partially constrained by editor platform behavior.
- Constraint:
  - AI editing tools can require `file:`-backed resources and may not fully operate on custom filesystem schemes such as `overleaf-workshop:`.
  - This is not always fixable inside the extension without introducing unsafe filesystem bridging behavior.
- Supported expectation:
  - Standard text editing in Overleaf-VS Code files is supported.
  - AI-assisted bulk edit or agentic edit flows may fail or be degraded on virtual resources.
- Current recommendation:
  - Use local replica mode for AI editing workflows that require normal filesystem files.
  - Keep the virtual workspace as the default for live collaboration and server-backed editing.

## Authentication

- Status: browser-based embedded auth is partially feasible only.
- Constraint:
  - Overleaf authentication can involve SSO, captcha, or browser-managed cookies that are difficult to capture safely inside an extension-managed flow.
  - The extension should not assume privileged cookie access or undocumented auth hooks.
- Supported expectation:
  - Email/password login works where the server supports it directly.
  - Cookie-based login remains the reliable path for SSO or captcha-enabled servers.
- Current recommendation:
  - For official Overleaf and other SSO-backed deployments, document cookie login clearly and keep login diagnostics explicit.

## Review Panel and Comments

- Status: blocked for full parity.
- Constraint:
  - Full review-panel support would require stable access to comment, reply, resolve, and tracked-change data that is not documented as a public extension API surface.
- Supported expectation:
  - Deep links and read-only alternatives are feasible if reliable payloads are available.
- Current recommendation:
  - Treat full review-panel support as blocked until stable backend data access is demonstrated.
