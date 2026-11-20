# VS Code Extension Release Audit

Date: November 19, 2026, America/Denver. Extension: Overleaf-VS Code, `AstroJulio.orbitleaf`, version `0.16.7`. Repository baseline: `667358f`, with extensive pre-existing tracked and untracked changes preserved.

The corrected local candidate passes the automated checks and the macOS installation checks described below. Confidence is substantially stronger for first installation, recovery storage, lifecycle cleanup, project selection, bundled resources and transport security. **Unrestricted public-release readiness is not established:** native Windows/Linux and authenticated Overleaf workflows remain unverified, and alternative-mode replacement uploads retain the high data-integrity risk described below. No package was published, pushed or installed into the user's normal VS Code profile.

## Audit coverage

The runtime inventory contains approximately 44,000 TypeScript lines across 120 source files, 71 contributed commands, 25 configuration properties, five language contributions, four views and one PDF custom editor. Review mapped every runtime subsystem and manifest contribution, then examined sensitive execution paths, callers, error handling and relevant tests. This was targeted engineering review across the whole extension, not a claim that every branch or every dependency implementation received exhaustive inspection.

| Area | Coverage and evidence |
| --- | --- |
| Activation and shutdown | Provider registration, startup without an account/project, command availability, deferred startup failures, editor attachment, disposal, pending VFS creation and persistence draining. |
| Editing and synchronization | Real document-session and VFS methods; asynchronous editor updates, OT acknowledgement/revision rules, reconnect recovery, draft checkpoints, conflict preservation, offline queues, interrupted writes and replay fixtures. |
| Local replicas and workspaces | Native temporary files, path containment, symlinks, binary snapshots, multi-root search/compile/status selection, URI authority, drive paths, UNC paths, workspace metadata and saved SCM restoration. |
| Server and account operations | Cookie/password fixtures, CSRF and cookie parsing, account isolation, credential storage failures, HTTP download redirects, timeouts, response limits, uploads and legacy Socket.IO transport. No real account was used. |
| UI and language features | Commands and menus, compile status and diagnostics, chat/review/comment state, composer delivery, collaborator decorations, citation/command completion, spelling, formatting, indexing, history and search tests. |
| PDF | Production provider, bundled PDF.js renderer, malformed PDFs, document replacement, hidden/revealed views, SyncTeX text matching, page/zoom retention, download, print and resource teardown. |
| Distribution and privacy | Manifest/API floor, production dependency graph, clean source reconstruction, source/archive hashes, runtime assets, licenses, ignored development files, credential/path searches and isolated VSIX installation. |
| Security | Independent source review of network-to-filesystem paths, archives, auth/redirects, webview messages/rendering, SecretStorage, diagnostic redaction, workspace trust, vendor integrity and selected dependency implementations. |

`overleaf-main/` and `vscode-in-line-commenting-main/` are upstream reference snapshots, excluded from the shipped runtime and this audit's vulnerability target. The disabled Git Bridge implementation was identified as inactive; it was not represented as a supported, tested feature.

## Confirmed defects and corrections

Severity reflects the observed consequence and its prerequisites. A source-backed defect does not imply exploitation on a live service.

| Severity | Defect and cause | Correction and verification |
| --- | --- | --- |
| High | Two processes could load separate recovery state and overwrite each other's journal/operation snapshots. A native two-process reproduction lost one dirty-document record. | Added lifetime storage ownership before hydration, unique ordered claim files, local dead-process recovery, alias canonicalization and explicit second-writer errors. Tests exercise 64 competing child processes, abrupt death, safe retry and preservation of pending work. |
| High | Shutdown could acquire storage after closure, admit work during closure, or release ownership when one checkpoint rejected while another write was still pending. Providers also retained VFS instances on disposal. | Closed write admission, tracked complete blob-to-journal pipelines, drained all settled work before release, added awaitable VFS/provider shutdown and waited for pending VFS creation. Deterministic gated failure/disposal tests and an independent review verify these cases. |
| Medium | Failed editor attachment left managed-document markers behind; closing during a join resurrected a session; delayed change handling retained an older text snapshot. | Observed startup promises, cleared failed bindings, checked closed documents and processed current editor text. Three regressions failed against the baseline and pass after correction. |
| Medium | Multi-root search, settings, compilation and some local mappings selected the first workspace instead of the active or explicitly targeted project. Prefix-only containment also admitted sibling directories or ignored URI authority. | Bound operations to the resolved project/workspace, enforced directory boundaries and authority, and used URI-based watcher roots. Tests cover the second linked root, explicit targets, unrelated roots and simulated UNC cases. |
| Medium | Rapid compile requests could both pass the busy check before asynchronous preflight set the compiling status. Queued retries could also lose their original target, and background callbacks dropped early failures. | Guarded the whole request lifetime, retained captured targets through waits/queues, handled background failures and refused ambiguous targetless local builds. Two gated concurrency regressions failed before the correction; target-switch and queue controls pass. |
| Medium | Windows drive paths were parsed as URI schemes before the native-path check. Background SCM restoration also dropped URI/stat rejections and could publish watchers after disposal. | Recognized drive/UNC paths first, preserved explicit URIs, caught individual restore failures and disposed late results. Six new cases failed against the original source; preservation controls and all corrected cases pass. |
| Medium | Legacy Socket.IO supplied session cookies to `xmlhttprequest`, whose redirect handler reused all headers across origins and had no hop bound. Reused XHR instances could retain headers or accept stale callbacks. | Tracked dependency patch enforces canonical same-origin HTTP(S) redirects, rejects URL credentials/downgrades, bounds hops, closes bodies, preserves appropriate request semantics and isolates request generations. A real two-origin fixture reproduced cookie leakage before the fix. Twenty regressions include real verified TLS, IPv6, cancellation and reuse. |
| Medium | PDF preview keys omitted server identity; an old panel could remove a newer registration; a PDF event subscription leaked. | Registries include server/account/project identity and instance ownership; subscriptions and replacement panels dispose safely. Tests include 1,000 open/close cycles. |
| Medium | PDF text was treated as an implicit regular expression, so ordinary punctuation such as `[` could throw or match incorrectly. | Escaped literal regex characters before whitespace normalization. Punctuation and ordinary-text navigation regressions pass. |
| Medium | Optional CSpell configuration writes could reject in fresh/restricted profiles, mutate shared setting values or create unhandled failures. Asynchronous status replies could outlive the UI or overwrite a newer workspace selection. | Updated only registered settings, preserved existing values, handled rejected writes and added revision/disposal guards. Active-project spelling/dictionary/status tests pass. |
| Medium | Chat composer polling could continue indefinitely after unavailable/disposed views; delayed HTML initialization could reattach stale handlers. | Used the existing ready handshake, ordered bounded queues, explicit overflow/cancellation reporting, retained failed delivery for retry and lifecycle guards. Tests cover 128 queued requests and late responses. |
| Medium | Collaborator selection decorations and late user/cursor responses survived disposal and could restart timers. | Released native decorations, aliases, colors and timers, with guards on asynchronous completion. Three demonstrated regressions pass after correction. |
| Compatibility | Dictionary selection used `QuickPickItem.iconPath`, absent from declared VS Code 1.80. | Pinned the API type package to exactly 1.80.0 and removed that unsupported decoration while preserving the dictionary action. Real 1.80 installation/activation checks pass. |
| Build reliability | Vendor preparation required Unix `patch`; package inspection required `unzip`; GitHub shorthand resolved the realtime dependency through SSH. | Used the installed JavaScript patch engine, JSZip inspection and an integrity-checked HTTPS archive of the unchanged Socket.IO commit. Clean source installation succeeded with empty npm/Git user configuration. |
| Test portability | Thirteen module-loader fixtures matched only slash-separated filenames. | Normalized fixture paths before matching. Native Windows execution remains a separate uncompleted check. |

## Automated and native verification

The initial suite passed **637/637** tests after granting loopback access. Its restricted-sandbox failures were `listen EPERM` errors; they were rerun rather than classified as extension defects or skipped. The final suite contains **723** tests, with **723 passing, zero failures and zero skips**. TypeScript, Vue type checking and the production build pass. ESLint reports zero errors and 35 existing naming/style warnings.

The shipped corresponding-source archive was extracted into a new temporary directory, installed with Node **22.23.5**, empty npm user configuration, disabled personal Git configuration and no checkout `node_modules`, vendor assets or build outputs. Both dependency installs, vendor integrity/patch preparation, build, lint, the complete suite, source generation and release validation pass. The generated source archive matches the checkout's source hash byte for byte. The main checkout also passes under Node **24.3.0**.

| Actual environment | Observed checks |
| --- | --- |
| macOS 27.2.1, arm64, VS Code 1.147.0, extension-host Node 24.22.1 / Electron 43.8.9 | Isolated VSIX install, activation, primary startup commands, default unauthenticated server state, declared assets/source hash, reinstall, uninstall and settings preservation. Production PDF webview soak: 600 reloads plus malformed replacements, burst updates, visibility changes, 60-page navigation/download/printing and teardown. |
| macOS 27.2.1, arm64, official VS Code 1.80.0, extension-host Node 16.17.1 / Electron 22.3.14 | Isolated installed-package checks and API-floor compilation. Production PDF webview soak: 100 reloads with the same malformed/burst/visibility/60-page/teardown scenarios. |
| macOS native Node 22.23.5 and 24.3.0 | Full regression suites; native filesystem/loopback/TLS tests and real child-process contention/crash tests. VS Code services in many unit tests are controlled mocks. |
| Windows and Linux | Static analysis, portable-path/UNC fixtures and build-tool changes only. A six-job CI matrix for Windows/macOS/Linux and VS Code 1.80/stable is configured, but those remote jobs were not executed during this audit. |

The installed-package runs use fresh profiles and empty extension directories. Production code comes from the installed VSIX; only the separate test companion runs in development mode. No existing login, keychain secret, workspace or installed extension was copied. The Electron sandbox and workspace-trust controls remain enabled.

The PDF runs observed **665/665** task destructions on 1.147 and **115/115** on 1.80, with peak concurrent task count two, zero active tasks/blob URLs after teardown and zero unhandled rejections. The 30 and five parser errors respectively are deliberate corrupt-PDF fixtures followed by recovery, not unexplained failures.

Actual VS Code 1.80 and 1.147 chat webviews also ran the production provider and upgraded Vue bundle with a synthetic project/session. Both verified the ready handshake, literal rendering of unsafe-looking text without injected DOM nodes, ordered pre-ready/live composer insertion, Enter submission, queued-to-delivered presentation and listener cleanup. No renderer errors or unhandled rejections occurred. These tests adapt a real panel to the view interface; they do not establish authenticated view routing or server delivery.

## Dependencies and package contents

The root advisory inventory fell from four affected-package entries to **one moderate entry**; the chat inventory fell from eight entries, including four high entries, to **zero**. Compatible updates include Vue, Vite, source-map dependencies, the chat type checker/TypeScript, build runners and fast-uri; development-only glob was updated separately from runtime dependencies.

The remaining raw advisory is [minimatch glob-part amplification](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249). Its described trigger requires `optimizationLevel >= 2`; the extension's runtime caller explicitly fixes the level at **1**, and regression coverage verifies that path. The fixed major version requires a newer Node runtime than VS Code 1.80 supplies. The advisory remains visible in npm's output; it is not represented as a clean advisory scan or as risk acceptance. This scoped mitigation does not certify every possible minimatch API use.

The local package is `output/release/overleaf-vs-code-audited-0.16.7.vsix`. Exact SHA-256, byte count, source hash, ZIP/import/asset counts and inspection results are recorded in `output/release-audit/artifact-audit.json` and `output/release-audit/release-evidence.json`.

The artifact audit checks both the outer VSIX and nested source archive: path safety, CRCs, manifest assets, production dependency/import resolution, source hashes and freshness, license files, development/private directory exclusions and targeted credential/path patterns. No real credential or private development tree was identified. The nested test source intentionally contains a synthetic self-signed TLS fixture; it has no external authority. Source access is intentional and separate from runtime modules.

## Performance and reliability limits

The controlled 1.147 PDF workload completed in approximately **97.6 seconds**. Tracked PDF resources returned to zero, and final reported JavaScript heap was approximately 12.6 MB. This is not a native-process memory or long-term leak measurement.

VS Code 1.80 completed its shorter workload in approximately **247 seconds**. Its 60-page print operations took approximately **59–60 seconds**, compared with approximately **0.14 seconds** for the same print fixture on 1.147. Output and cleanup succeeded, but the minimum-version printing delay remains a material performance concern. These runs do not isolate browser scheduling, editor age and extension costs sufficiently to assign a sole cause.

Recovery ownership deliberately permits one mutable owner per storage root. A second writer receives an explicit error instead of silently overwriting pending work. Dead local processes can be reclaimed; foreign-host claims fail closed because local PID checks cannot establish remote liveness. Network-filesystem semantics, host/PID reuse and recovery after power loss were not certified. File fsync and rename do not establish complete crash durability on every filesystem/provider, and edits not yet checkpointed can still be lost on forced termination.

Large-project CPU/RAM, multi-hour authenticated reconnect churn, unusual third-party extension combinations, all intermediate VS Code versions, Windows ACL/keychain behavior, Remote SSH, WSL and network mounts were not exercised natively. Read-only configuration and several I/O failure cases use injected failures rather than separate restricted operating-system accounts.

## Unresolved critical and high findings

**No unresolved confirmed critical defect was identified.** The confirmed high shared-cache and shutdown data-loss defects were corrected and regression-tested.

**One conditional high data-integrity risk remains:** alternative-mode **Upload changes** replaces original server files without atomic revision comparison. A collaborator can edit between the preflight read and upload, allowing remote work to be overwritten. The modal warning describes this limitation; **Upload recovery copies** creates separate files and retains the originals/pending drafts. The current server interface does not establish a conditional replacement operation. This audit preserved the explicit replacement feature and does not claim its concurrent safety.

Authenticated hosted/self-hosted Overleaf acceptance, current SSO/captcha behavior, real permission roles, server-side concurrent editing/restart/replay and actual update migration from another installed release remain unverified. Reinstall/uninstall settings preservation is verified; it is not a substitute for every historical upgrade path. Vendored PDF.js 3.10.111 has scripting/evaluation restrictions and tested rendering, but an npm audit does not cover its complete parser or the legacy realtime fork.

## Release assessment and retained evidence

The local candidate is suitable for controlled evaluation on the measured macOS/editor configurations. Broad public reliability across all advertised environments is **not yet established** by this evidence. The unresolved replacement-upload risk, native Windows/Linux coverage gap, credentialed integration gap and observed 1.80 printing delay materially limit a stronger readiness claim.

Detailed evidence is retained under `output/release-audit/`, including installed-package JSON, real webview reports, advisory inventories, clean-source and full-suite logs, before-fix regression logs and the package inspection. Those outputs are excluded from release payloads and source control. New test sources and patches are included in the corresponding-source archive.

The Codex Security workbench accepted the baseline finding draft after a schema correction, but its earlier finalization attempt failed with “The latest saved scan draft is incomplete; continue the scan before completing it.” Finalization was not retried. The local vulnerability reproduction, correction and regression tests completed; **no sealed Codex Security report is claimed**. This administrative limitation is distinct from the engineering evidence above.
