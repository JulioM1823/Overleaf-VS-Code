# Blocked and Platform-Constrained Items

This document exists to stop the team from repeatedly rediscovering the same external constraints during triage.

## `#94` Review Panel Support

- Status: blocked for full support.
- Constraint:
  - Full review-panel parity would require stable access to Overleaf comment, reply, resolve, and tracked-change data.
  - The extension should not assume undocumented APIs exist or remain stable.
- Closest viable alternative:
  - Read-only comment navigation if payloads can be sourced safely.
  - Deep links back to the Overleaf web UI for unsupported review actions.
- Unblock criteria:
  - Stable documented endpoints or a repeatable page-data extraction strategy that survives product changes.

## `#254` Copilot Edit on Overleaf Files

- Status: partially blocked.
- Constraint:
  - Copilot and similar editor tooling can require `file:`-backed workspace resources and may not fully support custom filesystem schemes like `overleaf-workshop:`.
  - This is an editor-platform integration constraint, not purely an extension bug.
- Closest viable alternative:
  - Improve URI capability reporting where possible.
  - Prefer local-replica mode for AI-assisted bulk edit workflows when platform tooling rejects virtual resources.
- Unblock criteria:
  - Verified editor support for virtual/custom filesystem edit sessions, or an extension-level bridge that does not compromise data safety.

## `#271` Cursor Support

- Status: partially feasible.
- Constraint:
  - Cursor is not guaranteed to behave identically to Visual Studio Code for virtual workspaces, custom editors, or AI-driven edit tooling.
  - The extension cannot safely depend on undocumented Cursor-only behaviors.
- Closest viable alternative:
  - Maintain a documented compatibility matrix.
  - Validate and support the core workflows that behave the same as upstream VS Code.
  - Prefer local-replica mode when Cursor-integrated tooling rejects virtual resources.
- Unblock criteria:
  - Reproducible smoke-test coverage across released Cursor builds, or editor-level guarantees for the relevant APIs.

## Triage Rule

- Do not schedule full implementation work for these items unless the unblock criteria are satisfied or the scope is explicitly reduced to the viable alternative above.
