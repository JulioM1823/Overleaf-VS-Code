# Milestone Map

This document replaces the stale umbrella planning in GitHub issue `#3` with milestone-sized workstreams that map directly to current open issues.

## M0: Foundation and Triage Hygiene

- Build test harnesses for Overleaf HTTP, realtime handshakes, local-replica temp workspaces, compile logs, and PDFs.
- Keep governance and release operations explicit and repo-owned.
- Relevant issues:
  - `#3`
  - `#312`
  - `#94` (blocked/partial)
  - `#254` (blocked/partial)

## M1: Data Safety First

- Eliminate silent overwrite and ambiguous sync state.
- Relevant issues:
  - `#180`
  - `#183`
  - `#323`
  - `#353`

## M2: Connection and Compile Recovery

- Make reconnect, join, compile, and status recovery deterministic.
- Relevant issues:
  - `#234`
  - `#287`
  - `#309`

## M3: PDF and Diagnostics Reliability

- Make compile outputs, PDF delivery, reverse SyncTeX, and Problems reporting trustworthy.
- Relevant issues:
  - `#187`
  - `#297`
  - `#299`
  - `#164`
  - `#55`

## M4: Editor UX, Navigation, and Search

- Ship the lowest-risk user-facing wins once sync and compile are stable.
- Relevant issues:
  - `#44`
  - `#60`
  - `#261`
  - `#328`

## M5: Partial or Platform-Constrained Feature Work

- Tackle features that depend on history metadata, auth UX, or third-party editor behavior.
- Relevant issues:
  - `#21`
  - `#252`
  - `#271`
  - `#94`
  - `#254`

## Milestone Rules

- Do not merge work into later milestones while an earlier milestone still lacks a deterministic regression harness.
- Use the blocked-items document for anything constrained by VS Code, Cursor, Copilot, or undocumented Overleaf behavior.
- Close or repurpose umbrella issues when the milestone map becomes the clearer source of truth.
