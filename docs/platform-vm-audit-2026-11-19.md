# Platform VM and hosted-runner audit — 2026-11-19

> Historical 0.16.7 platform evidence. See the [0.16.8 release-readiness follow-up](release-readiness-2026-11-19.md) for the newer candidate, additional corrections and new execution results. Hashes and failures below continue to identify their original artifacts.

This report supplements [the pre-release audit](pre-release-audit-2026-11-19.md) with actual execution outside the development Mac. The final **330 candidate** passed fresh Ubuntu ARM64 VM verification and **all six hosted Windows/Linux/macOS jobs** on VS Code 1.80.0 and 1.147.0: **739/739 regression tests per job**, installed-package checks and native production-provider chat/PDF fixtures. The Windows default-graphics diagnostic JSONs also passed independently of the workflow summaries. Earlier failures and superseded snapshots remain recorded below.

## Final result

The final distribution is SHA-256 `330d58b7721e37d78de290d38f00e31380e9477887989a859c0ad6f20f9468fc`; its 358-file corresponding source archive is `d07e3d8b1affa34b8f9673fd0f966cf14a4c45641611a296dc60d2cd66e83645`. [Hosted run 44680671646](https://github.com/JulioM1823/Overleaf-VS-Code/actions/runs/44680671646) completed successfully at tested code commit `e44c8ac74f0709f867910782b3cf85bf687df87c`. The temporary public branch was explicitly authorized; main remained `0839e6fc45bb1781c9fbc7046cbf730b483e6fa0`. No Marketplace publication occurred.

| Actually tested configuration | VS Code versions | Final evidence |
| --- | --- | --- |
| Ubuntu 22.04.5 ARM64, local UTM VM, unprivileged user | 1.80.0 / 1.147.0 | Fresh 739/739 source tests, exact source hash reproduced, exact final VSIX installed/lifecycle checks passed. Earlier native chat/PDF evidence is identified by its original artifact hash; all runtime/resources are byte-identical. |
| Ubuntu 22.04.5 x64, hosted VM / Xvfb | 1.80.0 / 1.147.0 | Both 739/739 jobs, exact final and separate rebuilt VSIX checks, chat and PDF fixtures passed. |
| macOS 26.7.2 ARM64, hosted runners | 1.80.0 / 1.147.0 | Both 739/739 jobs, exact final and separate rebuilt VSIX checks, chat and PDF fixtures passed. |
| Windows Server 2025 Datacenter 10.0.26100 x64, hosted VMs | 1.80.0 / 1.147.0 | Both 739/739 jobs; exact final VSIX with default/software graphics, separate rebuilt package, chat and PDF fixtures passed. Native renderer fixtures used software graphics. |

These checks establish the named installation and synthetic workflows. **Unrestricted release readiness is not established:** authenticated server workflows remain untested, and explicit alternative-mode replacement uploads retain the conditional high data-integrity risk described in the main audit. No unresolved confirmed critical defect was identified. Variable large-PDF print preparation, other OS editions/architectures and long-running/enterprise configurations remain limitations. The owned Linux VM was gracefully stopped; the existing pre-existing user VM was untouched.

The sections below preserve the test sequence and distinguish initial failures, intermediate snapshots and final verification.

## Evidence and artifact identity

The original distribution tested was `AstroJulio.orbitleaf` version `0.16.7`, displayed as **Overleaf-VS Code**. Hashes identify the tested snapshots; later rebuilds must not be treated as these exact artifacts.

| Artifact | SHA-256 |
| --- | --- |
| Original `overleaf-vs-code-audited-0.16.7.vsix` | `bf3c1120a600dccaf6bc0ce9a4566ae2ed5b70064db512b487d7b3a2b9ac19ad` |
| Corresponding source bundled in that original VSIX | `da51a75d5e2df42754f2db6c3505683702c670e8fc18ecdfaf39a166ab01c3fe` |
| Source regenerated in the Linux ARM64 guest after copying only the timestamp-test correction | `e4e6bc687244f3a2b22cb027bd70e9c9981c7a50b5ffc0a16bd53b708ab1e63f` |
| Corrected guest `test/commentTimestamps.test.cjs` | `6d15ee2ad1657a3ab59468d6f5651d648393a6d7ca29aeaf05e97a3d62cedd56` |
| Corresponding source bundled in the first hosted-runner rebuilds | `b5b12a990bde82a230af5c62061b7db42adf57ded236f5246e6e6d358e17dd5e` |

The original source ZIP and VSIX were copied into the VM and their hashes checked again there. No development accounts, settings, sessions, credentials, or user extensions were copied. Installed-package smoke tests resolve the extension from the isolated VSIX installation and explicitly check that it is not loaded from the source checkout. The chat and PDF renderer checks separately load production providers and built resources from the guest source checkout with synthetic local fixtures.

Primary machine-readable evidence is in [`output/vm-audit/linux-arm64/results.json`](../output/vm-audit/linux-arm64/results.json). Its companion environment log, original failing log, corrected passing log, native JSON reports, and source-validation logs are retained in that directory. Hosted results are tied to [GitHub Actions run 44677356383](https://github.com/JulioM1823/Overleaf-VS-Code/actions/runs/44677356383), attempt 1, commit `6911b3703166a1cb9196c179a5aafba5142ebdd8`; the captured job/step conclusions are in [`ci-status.json`](../output/vm-audit/ci-status.json).

## Environments actually executed

This inventory identifies the initial environments. Later snapshot checks, including the successful corrected macOS stable runs, are recorded in sequence below.

| Environment | Build/test toolchain | VS Code actually launched | Result established |
| --- | --- | --- | --- |
| Fresh UTM 4.7.4/QEMU ARM64 VM: Ubuntu 22.04.5 LTS, kernel `5.15.0-203-generic`, glibc 2.35; 2 vCPUs, 3,911 MiB RAM, 12 GiB virtual root disk, no swap, UTC | Node 22.23.5; npm 10.9.9 | Linux ARM64 1.80.0 and 1.147.0 | Clean build/tests after fixture correction; original VSIX installation/activation; production chat and PDF renderer checks passed on both editors |
| Hosted `ubuntu-22.04`: Ubuntu 22.04.5 x64; runner image `20261116.365.1` | Node 22.23.5; npm 10.9.9 | Linux x64 1.80.0 and 1.147.0 | Clean source tests, packaging, original VSIX and freshly rebuilt VSIX installed-package checks passed in both matrix jobs |
| Hosted `macos-latest`: macOS 26.7.2 build `25G332`, ARM64; floor-job image `macos-26-arm64/20261117.0516.1` | Node 22.23.5; npm 10.9.9 | macOS ARM64 1.80.0 | Clean source tests, packaging, original VSIX and freshly rebuilt VSIX installed-package checks passed |
| Hosted macOS stable job: macOS 26.7.2 build `25G332`, ARM64; image `macos-26-arm64/20261112.0504.1` | Node 22.23.5; npm 10.9.9 | 1.147.0 downloaded, but not launched by that attempt | Source tests and packaging passed; launcher could not locate the downloaded executable, so installed-package verification failed before activation |

VS Code 1.80.0 used extension-host Node 16.17.1 and Electron 22.3.14. VS Code 1.147.0 used extension-host Node 24.22.1 and Electron 43.8.9. These versions and architectures are read from the installed-package JSON reports, rather than inferred from the build Node version or the runner label.

The VM used an unprivileged `audit` user (UID 2000), Xvfb, and a D-Bus session. It retained Electron's sandbox, VS Code workspace-trust controls, and the production webview content security policy. It had no host directory or clipboard sharing and only a loopback SSH forward for test administration. The existing pre-existing user VM was not started or modified. This was a Linux guest test, not a macOS process emulating Node's platform string.

The official Ubuntu ARM64 cloud image was 689,801,728 bytes and matched the official HTTPS SHA-256 manifest: `e429865ad84a083a84fdbd51bf6fd6e4174bbb1610ba0d72ca01014c656d45bc`. Cloud-init expanded the disk and installed SSH, guest-agent, Xvfb, and the required desktop libraries. Package installation and the running guest-agent were checked directly. Cloud-init reported no errors but did retain one recoverable warning for optional bare `{}` vendor-data; it reported `degraded done`, not an entirely clean provision status. The subsequent package, service, OS, and test checks established that required provisioning completed.

## Linux ARM64 source tests and correction

Both clean installs (`npm ci` at the root and under `views/chat-view`) passed, including verified vendor downloads and patches. The production TypeScript/Vue build passed. ESLint reported 0 errors and 35 warnings.

The first complete source run on the original source ZIP registered **723 tests: 721 passed, 2 failed, 0 skipped**. The failures were in `test/commentTimestamps.test.cjs`. Two expected strings assumed the developer's America/Denver local timezone even though the runtime intentionally formats local time. In the UTC guest, the corresponding outputs were `8 April, 12:16pm` and `9 April 2025, 12:16am`, rather than the Denver values. The differing day in the second case confirmed that this was not merely a clock-label difference.

The correction preserves date-string parsing in the tests but derives their input ISO strings from locally constructed dates. It also adds independent child-process assertions for UTC, America/Denver, and Asia/Kolkata. No extension timestamp runtime behavior was changed. After copying only that corrected test file into the guest, the complete suite registered **724 tests: 724 passed, 0 failed, 0 skipped**, and the build/lint checks passed again. The original failure remains in [`source-build-tests.log`](../output/vm-audit/linux-arm64/source-build-tests.log); the corrected result is in [`source-build-tests-corrected.log`](../output/vm-audit/linux-arm64/source-build-tests-corrected.log).

Source packaging and release validation passed for both snapshots. Packaging the unchanged original source on Linux reproduced the same original source ZIP hash as macOS. The post-correction guest ZIP has the separate hash listed above and must not be confused with the first CI snapshot, which also contains its workflow changes.

Severity: **medium for portability of the release test gate; no extension-runtime defect established**. The original suite falsely failed under a normal UTC installation. The three timezone subprocess assertions now directly cover that assumption.

## Installed original VSIX checks

On both Linux ARM64 editor versions, the exact original `bf3c1120…` VSIX was installed into a fresh isolated extensions directory and user-data directory, activated, uninstalled, and reinstalled. The JSON reports record `exactVsixInstalled: true`, `sandboxDisabled: false`, `credentialsCopied: false`, and preservation of settings across reinstall/uninstall-reinstall.

Checks exercised the actual first-run project-manager view and its default unauthenticated `https://www.overleaf.com/` server; extension ID/version/display name/localized command category; the registered primary project, compile, search, comment, and diagnostics commands; compile-on-save/output-folder defaults; the 256×256 icon; README attribution; compiled entrypoint; chat/PDF/language resources; license and third-party notices; and the bundled corresponding-source archive and its declared hash. No account was required to reach or inspect that first-run state.

Reports: [`installed-1.80.json`](../output/vm-audit/linux-arm64/installed-1.80.json) and [`installed-stable.json`](../output/vm-audit/linux-arm64/installed-stable.json). These checks do not claim authenticated project editing, compilation against a live service, or installed-package PDF rendering. Production renderer behavior was tested separately as described below.

## Native Linux chat renderer

The real ChatViewProvider and production Vue bundle ran in native VS Code webviews on both Linux ARM64 1.80.0 and 1.147.0. The test retained the production CSP and normal sandbox, used the panel adapter and synthetic VFS/session delivery, and made no fixture external-network requests. Both reports identify Vue bundle SHA-256 `d5a53f5a8cb1bc67093d6ecd6432f5627772926338c9c1ed60de666be9ee062e`.

Both versions passed queued-before-ready composer insertion, insertion after readiness, focused composer behavior, a single Enter producing exactly one send, synthetic queued/delivered state changes, own-message action display, and panel disposal with an empty queue and removed owned listeners. HTML-looking author/message text remained literal text: zero injected elements and no executed injected script. There were no recorded renderer errors or rejected promises, and exactly one ready message. The recorded fixture interactions took 507 ms on 1.80.0 and 811 ms on 1.147.0; those figures exclude editor startup and are not controlled performance benchmarks.

Reports: [`chat-1.80.json`](../output/vm-audit/linux-arm64/chat-1.80.json) and [`chat-stable.json`](../output/vm-audit/linux-arm64/chat-stable.json). Network authentication and server delivery remained synthetic and are not established by this result.

## Native Linux PDF renderer and resource checks

The production PDF provider and vendored PDF.js parser/renderer ran in real VS Code webviews against synthetic PDFs on both Linux ARM64 editor versions. Each run passed **20 replacement/reload cycles**, download and print checks, corrupt-PDF failure/recovery, a replacement burst, hidden/revealed view restoration, navigation to the last page of a 60-page PDF, and final teardown.

| Measurement | VS Code 1.80.0 | VS Code 1.147.0 |
| --- | --- | --- |
| Overall status | Passed | Passed |
| Harness elapsed time | 240,455 ms | 240,602 ms |
| Document proxies created / destroyed at teardown | 27 / 27 | 27 / 27 |
| Active proxies at teardown / peak during replacement | 0 / 2 | 0 / 2 |
| Unhandled errors / unexpected failure types | 0 / none | 0 / none |
| Active blob URLs at teardown | 0 | 0 |
| Final PDF page / printed pages | 60 / 60 | 60 / 60 |
| PDF scripting / eval enabled | false / false | false / false |
| First 60-page print preparation | 58,849 ms | 58,761 ms |
| Later recorded 60-page print preparation | 59,649 ms | 59,544 ms |

The single recorded PDF error in each run is the deliberately corrupt input; both recovered and completed the following cases. The reports show correct disposal and bounded proxy overlap for these sequences. They do not prove that every type of resource is leak-free or establish overnight behavior.

The approximately one second per printed page is a material performance caveat. All 60 pages were prepared successfully, but large-document printing remained slow in this environment. Multiple print preparation checks account for most of each four-minute run. The two editor tests overlapped on independent Xvfb displays in a 2-vCPU VM, so their latency figures are observations rather than a controlled editor comparison. These tests capture generated print pages and lifecycle behavior; they do not operate a physical printer or verify a desktop print-dialog workflow.

Xvfb lacked hardware graphics and emitted GPU-initialization/fallback warnings. VS Code completed the checks with software rendering and normal security controls; this evidence does not establish physical GPU or Wayland behavior. Reports: [`pdf-1.80.json`](../output/vm-audit/linux-arm64/pdf-1.80.json) and [`pdf-stable.json`](../output/vm-audit/linux-arm64/pdf-stable.json).

## First hosted matrix: Linux x64 and macOS ARM64

The independent hosted source checkout used the timestamp correction and ran `npm ci` for both packages, `npm test`, and VSCE 4.1.0 packaging. Both Ubuntu x64 jobs and both macOS jobs completed **724/724 tests, 0 failures, 0 skipped**, with 0 lint errors and 35 warnings. The Linux floor/stable and macOS floor jobs also passed exact installation checks for both their rebuilt package and the original audited distribution. Hosted checks did not run the native chat/PDF renderer suites in this first matrix.

| Hosted job | Rebuilt VSIX SHA-256 | Original VSIX installed smoke | Rebuilt VSIX installed smoke |
| --- | --- | --- | --- |
| Ubuntu x64 / 1.80.0 | `12868600f9d626d9f11926a7ae7b7b387f68217fe2b762e463fb0ab483056f34` | Passed | Passed |
| Ubuntu x64 / 1.147.0 | `6bf0c902f191956e81edef720378d85f048eee5d9e751ef26412c9af217ca033` | Passed | Passed |
| macOS ARM64 / 1.80.0 | `e62e4830d357bbccf2c06329d2977703fb32a3cb6856c7b017e6c63b1e3b41a2` | Passed | Passed |
| macOS ARM64 / stable attempt | Not used to establish runtime compatibility | Failed before editor launch | Failed before editor launch |

All six successful installed-package JSONs record the actual expected OS/architecture, preserved reinstall settings, and normal sandbox. The rebuilt packages are separate artifacts and their differing ZIP hashes are not evidence that the original distribution changed.

The hosted macOS stable job successfully downloaded official VS Code 1.147.0, then printed `Set RELEASE_SMOKE_CODE to the installed VS Code executable`. The failure occurred in locating the executable before the extension-host test. This is a test-launcher portability problem; that attempt establishes neither success nor an extension-runtime failure on hosted macOS stable. Its log is retained as [`stable-first-attempt.log`](../output/vm-audit/hosted-macos/stable-first-attempt.log).

Hosted Linux JSONs and full job logs are in `output/vm-audit/hosted-linux-x64-1.80/` and `output/vm-audit/hosted-linux-x64-stable/`. Hosted macOS floor JSONs and full job log are in `output/vm-audit/hosted-macos-1.80/`. The corresponding `distribution-*.json` files identify the original `bf3c1120…` artifact; `rebuilt-*.json` identify the CI rebuilds.

## Frozen c85 snapshot: Linux ARM64 verification

After the platform test-infrastructure corrections, a separate release snapshot was frozen and transferred to the same Linux VM. It was subsequently retained as the **c85 second-attempt snapshot** while further Windows test-harness corrections were prepared; it is not a final-publication claim. Its identities differ from the original distribution recorded above:

| Frozen c85 artifact | SHA-256 |
| --- | --- |
| Audited c85 VSIX | `c85e4852b961821061d7c4c6f1b84e23181092000e2ce2bd36df990ab086b2b0` |
| Corresponding c85 source ZIP, 356 files | `cd09efa1aade038fbf45a1b0815db554fec3dd26cde899dd577ae438b0909985` |

Both hashes were checked again inside the guest. The source ZIP was extracted into a separate empty directory; neither the previous node_modules nor previous build outputs were reused. Fresh root/chat dependency installs, the production build, and lint passed under Node 22.23.5/npm 10.9.9. The snapshot suite registered **733 tests: 733 passed, 0 failed, 0 skipped**; lint remained at 0 errors and 35 warnings. Source packaging regenerated all 356 files and reproduced the exact frozen `cd09efa1…` ZIP hash, followed by a passing release validation. The original 723-test failure and corrected 724-test evidence remain retained separately.

The exact `c85e4852…` VSIX then passed fresh isolated installed-package verification on **Linux ARM64 VS Code 1.80.0 and 1.147.0**. Both JSONs record the c85 VSIX hash, bundled `cd09efa1…` source hash, successful activation, registered commands, first-run server/view state, required assets, preserved reinstall settings, and `sandboxDisabled: false`. These are direct installed c85 results, recorded as [`final-installed-1.80.json`](../output/vm-audit/linux-arm64/final-installed-1.80.json) and [`final-installed-stable.json`](../output/vm-audit/linux-arm64/final-installed-stable.json).

An independent ZIP-entry comparison found **512 runtime/resource entries byte-identical** between the original `bf3c1120…` and c85 packages. Only `extension/package.json`, `extension/source/manifest.json`, and the source ZIP changed. The earlier native chat/PDF tests were not rerun in this c85 Linux pass: they remain direct renderer evidence for the original snapshot, with byte-equivalence evidence for the c85 production runtime/assets. This distinction is recorded in [`final-runtime-equivalence.json`](../output/vm-audit/linux-arm64/final-runtime-equivalence.json).

c85 source/build/test and lifecycle evidence is summarized in [`final-results.json`](../output/vm-audit/linux-arm64/final-results.json), with the complete command output in [`final-source-build-tests.log`](../output/vm-audit/linux-arm64/final-source-build-tests.log). After all c85 checks completed, UTM was asked to power down the guest gracefully and its state was verified as **stopped**. The separately created empty audit VM was verified by UUID/name, stopped state, and zero-byte drives, then removed; removal was read back. The tested VM was retained stopped, and Homebridge was not started or modified.

## Second hosted matrix: c85 Linux x64 and macOS ARM64

[Run 44678949200](https://github.com/JulioM1823/Overleaf-VS-Code/actions/runs/44678949200), attempt 1, commit `c017ee9aaec72a5fd4b70addd220b31c6362bc97`, reran the matrix after launcher/fixture corrections and added production chat/PDF renderer tests. **All four Linux/macOS jobs completed successfully.** This is a four-job scope result; it does not state that the entire six-job run passed. The c85 snapshot was subsequently retained while further Windows test-harness corrections were prepared, so this section is not the final-publication verification.

Every one of the four jobs performed clean root/chat installs, a successful build, **733/733 tests with 0 failed and 0 skipped**, lint with 0 errors and 35 warnings, and VSCE packaging. Each then installed both its separate CI rebuild and the exact audited `c85e4852…` package in clean profiles. All **eight installed-package checks passed**, with normal sandbox, no copied credentials, preserved reinstall settings, and the expected architecture. Each audited package reports its bundled source as `cd09efa1aade038fbf45a1b0815db554fec3dd26cde899dd577ae438b0909985`.

| Hosted environment / editor | Runner image version | Build Node / npm | Separate CI-rebuilt VSIX SHA-256 |
| --- | --- | --- | --- |
| Ubuntu 22.04.5 x64 / 1.80.0 | `ubuntu-22.04/20261116.365.1` | 22.23.5 / 10.9.9 | `b1627a60a527416f993170b625f36ae7343c3d58c8d21ffd21fb1baa6ce01503` |
| Ubuntu 22.04.5 x64 / 1.147.0 | `ubuntu-22.04/20261111.360.2` | 22.23.4 / 10.9.9 | `d35110143651d89d4618bc295b85ebc31777088a438e8ff7bebd07b3b6f4beed` |
| macOS 26.7.2 ARM64 / 1.80.0 | `macos-26-arm64/20261112.0504.1` | 22.23.5 / 10.9.9 | `cf8eb369c1894b0e8e241f9661d3dcc08eeaf1df204c3ea28714fb34419921bd` |
| macOS 26.7.2 ARM64 / 1.147.0 | `macos-26-arm64/20261102.0473.1` | 22.23.4 / 10.9.9 | `0c8fe4b3ca519743186d33aa1c0083ed644f773bbe4469187cc5e938a001b456` |

The Linux jobs report kernel `6.8.0-1070-azure`; the macOS jobs report OS build `25G332` and Darwin `25.6.0`. Extension-host versions remain Node 16.17.1/Electron 22.3.14 for VS Code 1.80.0, and Node 24.22.1/Electron 43.8.9 for 1.147.0. The four CI rebuilds bundle source SHA-256 `072645a66d686c28192b82c09b15e51491b838128fff8b3d1f99cd19ce95bc72`, identifying the CI workflow snapshot separately from the audited package's source. Downloaded VSIX bytes were independently hashed against each JSON report. No explicit `--disable-gpu` option was requested by these Linux/macOS tests; this is not a claim about physical GPU hardware.

The previously failing hosted macOS stable executable lookup now reaches the actual editor and passes installed-package, chat, and PDF checks. All four production chat suites preserve CSP/workspace trust/sandbox and identify the same production Vue bundle hash `d5a53f5a8cb1bc67093d6ecd6432f5627772926338c9c1ed60de666be9ee062e`. Each reports exactly one ready message and successful panel disposal with an empty queue and removed listeners; authentication and delivery remain synthetic.

Each PDF suite passed 20 reload cycles plus corruption/recovery, replacement burst, visibility restoration, 60-page navigation/download/printing, and disposal. All four report **27 proxies created and 27 destroyed, 0 active at teardown, peak 2, 0 unhandled errors, no unexpected failure types, 0 retained blob URLs, 60 printed pages, scripting disabled, and eval disabled**. The one PDF error per run is the intentional corrupt-input case.

| Native renderer run | Chat fixture time | PDF harness time | First / later 60-page print preparation |
| --- | --- | --- | --- |
| Linux x64 / 1.80.0 | 314 ms | 238,290 ms | 58,451 / 59,202 ms |
| Linux x64 / 1.147.0 | 867 ms | 6,112 ms | 999 / 160 ms |
| macOS ARM64 / 1.80.0 | 478 ms | 258,235 ms | 62,820 / 63,053 ms |
| macOS ARM64 / 1.147.0 | 1,510 ms | 263,214 ms | 65,177 / 63,701 ms |

These measurements confirm functional printing but also a substantial, nonuniform performance caveat: several environments spent approximately one second per page preparing the 60-page fixture, while hosted Linux stable completed much faster. The evidence does not establish the cause, and it does not support treating either latency as universal. Times describe synthetic page preparation rather than physical printing and are not a controlled benchmark between operating systems.

All four artifact directories and full per-job API logs are retained under `output/vm-audit/final-hosted-{linux-x64,macos-arm64}-{1.80,stable}/`; those historical directory names contain “final” but their tested identity is explicitly the c85 snapshot. The summary and exact report paths are in [`hosted-run-44678949200-results.json`](../output/vm-audit/hosted-run-44678949200-results.json); [`hosted-final-results.json`](../output/vm-audit/hosted-final-results.json) now tracks the later final 330 snapshot. All first-attempt evidence remains separate.

## 805 snapshot: Linux ARM64 verification and hosted timing failure

The next candidate was audited VSIX SHA-256 `805c68a485beba02705997b4e13544ffc426c8ab08c74f155821fc6526c08adc`, with 358-file corresponding source SHA-256 `359e9f89fbaf61bd064945b6678258c0bdc451964c6aa9de985489c7b10e9809`. This snapshot is retained independently of c85 and of subsequent candidates.

Only the owned Linux ARM64 audit VM was restarted. Guest-side artifact hashes matched; the source was extracted into another empty directory, installed cleanly, rebuilt, and tested. **739/739 tests passed, 0 failed, 0 skipped**, with 0 lint errors and 35 warnings. Source packaging reproduced the exact frozen `359e9f89…` ZIP hash for all 358 files, and release validation passed. The exact `805c68a4…` VSIX passed fresh isolated installed-package checks on both VS Code 1.80.0 and 1.147.0 with the new observer companion from that same source archive. Both JSONs identify the actual loaded state module inside the installed extension's `out/` directory, bundled source hash, normal sandbox, no explicit GPU-disable option, and preserved reinstall settings. The independent comparison again found all 512 runtime/resource entries byte-identical to the original bf3 package.

Evidence is summarized in [`linux-arm64/release-final-739-results.json`](../output/vm-audit/linux-arm64/release-final-739-results.json), with separate `release-final-739-*` logs and installed-package JSONs. After completion, graceful guest shutdown was requested and **stopped** state was verified again; Homebridge remained untouched.

In [hosted run 44679946606](https://github.com/JulioM1823/Overleaf-VS-Code/actions/runs/44679946606), commit `505ec9445d12c13e8d81b06ca0fa213946f92cd8`, the Linux x64 stable job passed **739/739 source tests** and installed-package checks for both exact 805 and its separate CI rebuild. It then failed the chat native fixture at `test/integration/chatWebviewSmoke.cjs:128`: the renderer already showed the correct queued text, literal safe history, and focused composer with one ready message and no renderer errors/rejections, while the provider's internal pending queue still had one item. The strict wrapper stopped there; **PDF was not run in this job**. This job is a failure, not a compatibility pass for all renderer checks.

The underlying test assumption was that observing the DOM implied every host `postMessage` promise had settled. The pre-ready fixture queues both text insertion and focus. Production removes each item only after its awaited delivery promise resolves, so the DOM can already be correct while the final host-side queue update is pending. The fixture was corrected to require zero pending messages and zero pending text **inside the same existing bounded 20-second initial wait**, together with its original DOM predicates. Existing queue, security, and later DOM assertions remain intact; no production code or timeout was changed. This is a **test-harness timing defect**, and this failure did not establish lost text or a production-runtime defect. Its failed JSON, full job log, exact installed-package results, and cause are retained in [`release-final-739-hosted-linux-x64-stable/triage.json`](../output/vm-audit/release-final-739-hosted-linux-x64-stable/triage.json). Later snapshot verification must establish the corrected fixture's result separately.

## Latest frozen 330 candidate: Linux and macOS verification

The latest candidate's exact identities are:

| Candidate artifact | SHA-256 |
| --- | --- |
| Audited VSIX, version 0.16.7 | `330d58b7721e37d78de290d38f00e31380e9477887989a859c0ad6f20f9468fc` |
| Corresponding source ZIP, 358 files | `d07e3d8b1affa34b8f9673fd0f966cf14a4c45641611a296dc60d2cd66e83645` |

The Linux ARM64 VM was restarted solely for this candidate. After guest-side hash verification, another empty source directory received the exact source ZIP, fresh root/chat dependency installs, a successful production build, **739/739 passing tests with 0 failed and 0 skipped**, and lint with 0 errors and 35 warnings. Source packaging reproduced the exact frozen `d07e3d8b…` archive hash, followed by passing release validation. The exact 330 VSIX passed fresh isolated installation/activation/first-run/reinstall checks on **both Linux ARM64 editor versions**, using the corrected companion from that same source. Its actual installed state-module location and bundled source hash were verified in both JSONs. No explicit GPU-disable flag or sandbox/trust bypass was used. The guest was then gracefully powered down and **stopped** state read back.

This direct Linux ARM64 evidence is summarized in [`candidate-330-results.json`](../output/vm-audit/linux-arm64/candidate-330-results.json); the directory contains separate `candidate-330-*` logs, installed JSONs, and guest identity records. An independent package comparison again verified 512 byte-identical runtime/resource entries against bf3, with only the same three metadata/source entries changed. Linux ARM64 native renderer checks remain direct evidence from the original snapshot plus this byte-equivalence evidence; they were not repeated merely to relabel the final artifact.

[Hosted run 44680671646](https://github.com/JulioM1823/Overleaf-VS-Code/actions/runs/44680671646), attempt 1, commit `e44c8ac74f0709f867910782b3cf85bf687df87c`, tested the corrected candidate. **All four Linux/macOS jobs passed.** Each independently completed clean installs, the production build, 739/739 tests, lint at 0 errors/35 warnings, packaging, installed checks for both exact 330 and its separate CI rebuild, and native chat plus 20-cycle PDF checks. This statement is scoped to those four jobs; Windows conclusions are recorded separately.

| Hosted environment / actual editor | Runner image | Build Node / npm | Separate CI-rebuilt VSIX SHA-256 |
| --- | --- | --- | --- |
| Ubuntu 22.04.5 x64 / 1.80.0 | `ubuntu-22.04/20261116.365.1` | 22.23.5 / 10.9.9 | `11df92ed337f567ddf33797c19e1b4c88d8b46835b04acd13f208ecf1c58ecd0` |
| Ubuntu 22.04.5 x64 / 1.147.0 | `ubuntu-22.04/20261111.360.2` | 22.23.4 / 10.9.9 | `7a6594d797ec5a1bc60576c9e9e7a36280d002775df5a45afac5bd3f73a5ae5f` |
| macOS 26.7.2 ARM64 / 1.80.0 | `macos-26-arm64/20261102.0473.1` | 22.23.4 / 10.9.9 | `f794e98b48ab71ba8c86014a2366a02670f6a0413af23c5754b1dfcdf8693769` |
| macOS 26.7.2 ARM64 / 1.147.0 | `macos-26-arm64/20261102.0473.1` | 22.23.4 / 10.9.9 | `e28b586901eeaed5d77312e523f52e8032850f3389a9a0aee7bb9cd451039041` |

The Linux kernel was `6.8.0-1070-azure`; macOS reported build `25G332` and Darwin `25.6.0`. Actual extension-host versions remained Node 16.17.1/Electron 22.3.14 at the VS Code floor and Node 24.22.1/Electron 43.8.9 at stable. All four separate CI rebuilds bundle source hash `2893c07f36f16a03434d1fd9e18f101cb072b3c6a540e8634e3c731ba28fa8c8`, distinguishing the CI workflow checkout from the audited package's `d07e3d8b…` source. All eight downloaded VSIX files were independently hashed against their passing reports. All four exact audited-package reports identify the expected `330d58b7…` VSIX and `d07e3d8b…` source hashes, preserve reinstall settings, and retain the normal sandbox. No explicit GPU-disable flag was requested in these Linux/macOS jobs.

The corrected chat predicate passed on all four native editor/OS combinations. Its existing timeout and all original DOM, security, ordering, single-send, queue, and disposal assertions remained enabled. Every report identifies the unchanged production Vue bundle hash, exactly one ready message, preserved CSP/workspace trust/sandbox, no copied credentials, empty disposed queue, and removal of owned listeners. Real authentication/network delivery remained synthetic.

Every PDF report again records **20 reload cycles, 27 document proxies created/27 destroyed, 0 active at teardown, peak 2, 0 unhandled errors, no unexpected failure types, 0 retained blob URLs, all 60 pages printed, and scripting/eval disabled**. The one recorded PDF error is intentional corruption, followed by recovery.

| Native renderer run | Chat fixture time | PDF harness time | First / later 60-page print preparation |
| --- | --- | --- | --- |
| Linux x64 / 1.80.0 | 639 ms | 239,516 ms | 58,537 / 59,294 ms |
| Linux x64 / 1.147.0 | 1,009 ms | 89,338 ms | 993 / 59,251 ms |
| macOS ARM64 / 1.80.0 | 1,386 ms | 262,200 ms | 64,167 / 63,261 ms |
| macOS ARM64 / 1.147.0 | 1,390 ms | 8,817 ms | 662 / 656 ms |

Printing remained functionally correct in these synthetic sequences, but preparation time varied sharply, even within a stable-version run and between otherwise similar runs. The approximate one-second-per-page cases remain a performance caveat; the evidence does not establish a universal OS-specific cause. These measurements do not test physical printer output, and the short suites do not prove absence of long-session leaks.

The four complete artifact/log sets are under `output/vm-audit/candidate-330-hosted-{linux-x64,macos-arm64}-{1.80,stable}/`. The current four-job summary is [`hosted-final-results.json`](../output/vm-audit/hosted-final-results.json), archived independently as [`hosted-run-44680671646-results.json`](../output/vm-audit/hosted-run-44680671646-results.json). All bf3/c85/805 evidence remains retained separately, including the failed pre-correction chat run. These passes are actual execution results for the named snapshot and configurations, not extrapolated compatibility claims.

## Windows x64 — final verified package

Both Windows jobs in [final run 44680671646](https://github.com/JulioM1823/Overleaf-VS-Code/actions/runs/44680671646), attempt 1, commit `e44c8ac74f0709f867910782b3cf85bf687df87c`, completed successfully. The downloaded artifacts and **all 12 actual JSON reports** were independently checked. This includes the two default-graphics diagnostic steps: their JSON status was checked directly because `continue-on-error` can make a failed diagnostic appear successful in the jobs API.

The exact Mac-built universal distribution tested was SHA-256 `330d58b7721e37d78de290d38f00e31380e9477887989a859c0ad6f20f9468fc`, containing corresponding source SHA-256 `d07e3d8b1affa34b8f9673fd0f966cf14a4c45641611a296dc60d2cd66e83645`. Both downloaded Windows artifact copies matched that VSIX hash; each installed report checked the bundled source hash. Each Windows job also built, packaged, and installed its own separate CI rebuild, whose bytes were independently hashed against its report.

| Actual hosted environment | VS Code / extension-host runtime | Build Node / npm | Result |
| --- | --- | --- | --- |
| Windows Server 2025 Datacenter `10.0.26100`, x64; image `windows-2025-vs2026/20261116.315.1` | 1.80.0; Node 16.17.1, Electron 22.3.14 | 22.23.5 / 10.9.9 | 739/739 tests, 0 failed, 0 skipped; packaging and all six report types passed |
| Windows Server 2025 Datacenter `10.0.26100`, x64; image `windows-2025-vs2026/20261103.298.1` | 1.147.0; Node 24.22.1, Electron 43.8.9 | 22.23.4 / 10.9.9 | 739/739 tests, 0 failed, 0 skipped; packaging and all six report types passed |

Both jobs performed clean root/chat dependency installations, TypeScript/Vue builds, lint, source validation, and VSCE packaging. Lint reported **0 errors and 35 warnings**. These were actual Windows x64 editors running in hosted VMs, not tests that changed a Node platform string. Windows 10/11 client editions and Windows ARM64 were not tested.

| Actual JSON report type, once per editor | VS Code 1.80.0 | VS Code 1.147.0 |
| --- | --- | --- |
| Clean editor, default graphics, audited extension absent | Passed | Passed |
| Exact final distribution installed, default graphics | Passed | Passed |
| Separate CI rebuild installed, software graphics | Passed | Passed |
| Exact final distribution installed, software graphics | Passed | Passed |
| Production chat provider and Vue bundle in a native webview, software graphics | Passed | Passed |
| Production PDF provider/renderer, 20 cycles plus additional cases, software graphics | Passed | Passed |

The installed-package checks used separate empty extension/user-data profiles without copied credentials. They resolved and activated the installed VSIX, checked its identity, public branding, localized category, registered primary commands, default settings, valid 256×256 PNG icon, README attribution, required compiled/webview/language/license resources, and corresponding-source archive. The real project-manager tree contained the expected unauthenticated `https://www.overleaf.com/` default server. Repeated installation, uninstall/reinstall, and preservation of unrelated settings passed. `sandboxDisabled` remained false throughout. Software rendering was explicitly requested with `--disable-gpu` and is recorded separately; workspace trust and production webview CSP were retained.

The native chat tests used the production provider and built Vue resources from the checkout with a panel adapter and synthetic VFS/session delivery. They passed queued-before-ready insertion, subsequent insertion/focus, exactly one send per Enter, queued/delivered states, safe literal HTML-looking author/message text, and disposal with zero queued messages and removed listeners. Each reported one ready event and no injected elements, executed injected script, renderer errors, or rejected promises. These are actual native-renderer checks, while authenticated Overleaf transport remained synthetic.

The PDF tests used synthetic documents and passed corrupt-input recovery, replacement bursts, hidden/revealed restoration, 60-page navigation/download/print-page preparation, and teardown in addition to the 20-cycle sequence. On both editors, **27 document proxies were created and 27 destroyed, with 0 active at disposal, peak overlap 2, 0 unhandled errors, no unexpected failure types, and 0 retained blob URLs**. The single PDF error was the deliberately malformed input. Scripting and eval remained disabled. These short sequences establish their recorded lifecycle invariants, not days-long memory stability.

| Final Windows software-graphics measurement | 1.80.0 | 1.147.0 |
| --- | --- | --- |
| Chat fixture elapsed time, excluding editor startup | 596 ms | 881 ms |
| PDF harness elapsed time | 241,050 ms | 240,095 ms |
| First 60-page print preparation | 58,749 ms | 58,624 ms |
| Later recorded 60-page print preparation | 59,567 ms | 59,406 ms |

Large-document print preparation is a material performance caveat. The fixture prepares the 60-page document four times, accounting for most of each four-minute suite. The measured interval wraps PDF.js `renderPages()`, including serial canvas image encoding/loading; it excludes a native printer dialog and physical printing. The preceding 805 snapshot's Windows stable suite completed much faster (4,262 ms overall; 937 ms for its first 60-page preparation), while the same snapshot's 1.80 suite took approximately four minutes. This variability and the final run do **not** establish a version-specific defect or a hardware-GPU regression. The cause was not profiled; no runtime change was made on an assumed explanation.

### Defects exposed by Windows execution

The confirmed corrections concern test infrastructure, with **medium severity for the reliability of the release gate**:

- `chatViewProvider.test.cjs` and `compileManager.test.cjs` matched only POSIX separators in parent module paths. Windows bypassed mocks; the compile suite crashed during import and omitted 17 intended cases. Normalizing backslashes restored the complete test denominator.
- `localReplicaResolution.test.cjs` hardcoded POSIX home paths despite native Windows path normalization. Its fixtures now use `path.join` and `os.tmpdir` while preserving ordering and duplicate assertions.
- `localReplicaWorkspace.test.cjs` assumed POSIX mode `0644` on Windows. It now compares the actual target mode before/after the operation and still verifies that a symlink target is not changed.
- The installed-package runner assumed `resources/app/out/cli.js` was at the Windows application root. The official 1.147.0 archive instead places it under a version directory. The runner reads the official `bin/code.cmd` relative CLI argument as data, checks containment, and directly invokes the executable/JS entrypoint without a command shell. Six regression cases cover the layouts and rejected paths.
- The project-tree observer required an installed path whose drive was `C:`, while the active CommonJS module was already loaded through `c:`. The passing reports preserve both actual paths. The helper now observes the existing installed module using Windows-only filename case folding, rejects divergent-export aliases/outside paths, and requests a fresh tree read through the real registered refresh command. Six regressions and all final installed checks pass; the actual context/default-server assertions remain intact.

The first 1.80 installed attempt also recorded a GPU/renderer access violation (`0xC0000005`). Its cause remains unknown. Later clean-editor and exact-installed-package default-graphics controls passed on both editors, so that first failure was **not reproduced** and does not establish an extension-specific GPU defect. All failing attempts remain archived; none is relabeled as a pass. The separate chat handshake timing correction is described in the preceding hosted-run section and was verified by the final Windows native checks as well.

Machine-readable final evidence is [`windows-x64/results.json`](../output/vm-audit/windows-x64/results.json) and [`run-44680671646-attempt-1/summary.json`](../output/vm-audit/windows-x64/run-44680671646-attempt-1/summary.json). Full logs, both VSIX files per job, and every original JSON are retained in that run directory. Earlier first/second failing evidence and the successful 805 snapshot remain in separate run directories.

No unresolved critical or high-severity extension-runtime defect was established in the Windows paths exercised. Authenticated remote editing/compilation, real interrupted-network recovery, restricted enterprise policies, hardware GPUs, physical printers, offline Windows installation, client Windows editions, Windows ARM64, and long-duration usage remain outside this evidence. Native production-provider renderer checks complement the exact-installed-package lifecycle checks; they do not represent a full authenticated installed-extension workflow.

## Findings, limits, and release evidence

The Linux ARM64 execution found a reproducible timezone-dependent test defect and verified its correction; it did not establish an extension-runtime defect in the exercised paths. Hosted testing additionally exposed test-infrastructure platform assumptions, including executable lookup and the native chat queue observation timing. Corrected runs are recorded alongside their original failures. No unresolved critical or high-severity extension-runtime defect was demonstrated by the exercised Linux ARM64/Linux x64/macOS ARM64 paths. This is scoped evidence rather than a claim about all functionality or environments; Windows assessment is recorded separately.

This platform evidence materially expands the original development-Mac coverage: Ubuntu ARM64 and x64 have actual editor execution at the declared floor and the resolved stable version; independent hosted macOS ARM64 images and Windows Server x64 VMs have actual floor and stable execution, including the final production renderer fixtures. It does not justify a universal compatibility or bug-free claim. In particular:

- Authenticated remote editing, service-side compilation, real reconnect/network interruption behavior, server permissions, and external integrations were not exercised with a fresh real account by these VM/hosted runs. Earlier live tests, if any, have their own evidence scope.
- The installed-package checks and development-provider renderer checks are complementary; the latter do not claim that all authenticated production UI flows were exercised through the installed VSIX.
- Other Linux distributions, older/newer system libraries, Linux desktop/Wayland configurations, restricted enterprise policies, physical GPUs, physical printers, Windows 10/11 desktop editions, Windows ARM64, and macOS Intel were not tested here.
- Twenty PDF cycles and short chat sequences check specific lifecycle invariants; they do not establish days-long stability, memory behavior in every workload, or performance on large real projects.
- The current 330 snapshot has direct Linux ARM64 source/installed-package verification and direct hosted Linux x64/macOS ARM64/Windows x64 source, installed-package, and native renderer checks above. Older failed gates were not counted as passing runs, and later artifact changes would require their own evidence.

