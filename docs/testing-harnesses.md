# Testing Harnesses

This repository now includes repo-owned Phase 0 test harnesses for deterministic debugging of Overleaf integration behavior.

## Harnesses

- `test/support/mockOverleafHttpServer.cjs`
  Provides a configurable local HTTP server for login, project-page, archive-download, and arbitrary route tests.
- `test/support/mockSocketServer.cjs`
  Provides a configurable local handshake server with `v1` and `v2` modes for realtime transport tests.
- `test/support/tempLocalReplicaWorkspace.cjs`
  Creates a disposable `.overleaf` workspace layout for local-replica and SCM tests.
- `test/support/compileLogFixtures.cjs`
  Loads compile-log fixtures from `test/fixtures/compile`.
- `test/support/pdfFixtures.cjs`
  Loads deterministic PDF fixtures from `test/fixtures/pdf`.

## Diagnostics

- Every harness records structured events with a stable `scope`, `event`, and `sequence`.
- Set `OVERLEAF_WORKSHOP_TEST_LOGS=1` when running node tests locally if you want the harness events mirrored to stderr.
- The harnesses are intentionally isolated under `test/` so they do not affect the shipped extension runtime.

## Fixtures

- Compile logs:
  - `test/fixtures/compile/basic-error.log`
  - `test/fixtures/compile/package-warning.log`
- PDFs:
  - `test/fixtures/pdf/minimalPdf.cjs`

## Recommended Usage

1. Compile the extension with `npm run compile`.
2. Run the node regression suite with `npm run test:node`.
3. Use the harnesses for new integration-style tests before touching the live Overleaf runtime path.
