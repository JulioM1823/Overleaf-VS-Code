# Governance and Release Operations

This document records the repository-owned governance and release process for Overleaf Workshop. It captures the feasible maintenance cleanup from the open governance issues without changing the published extension identifier.

## Ownership and Scope

- The source repository is maintained under the `overleaf-workshop/Overleaf-Workshop` GitHub organization.
- The published VS Code Marketplace identifier currently remains `iamhyc.overleaf-workshop`.
- Do not change the `publisher` field or extension identifier as part of routine maintenance. A publisher migration needs a dedicated plan because it can break upgrade continuity, existing Marketplace links, and badge references.

## Maintainer Responsibilities

- Triage new issues and keep labels, milestones, or execution phases up to date.
- Group active work into actionable milestones or issue clusters instead of relying on a long-lived umbrella roadmap issue.
- Keep user-facing documentation accurate. Do not promise a feature for a named release unless the work is scheduled and staffed.
- Review pull requests only after build, lint, and issue-specific tests pass.
- Restrict release-version changes and publish operations to maintainers with access to the required repository secrets.

## Release Automation

- [`vsce-package.yml`](../.github/workflows/vsce-package.yml) builds a temporary `.vsix` artifact for pull requests targeting `master`.
- [`vsce-publish.yml`](../.github/workflows/vsce-publish.yml) runs on manual dispatch and on a daily schedule.
- The publish workflow only proceeds when `package.json` changed within the previous 24 hours.
- Publishing requires the repository secrets `VSCE_PAT` and `OVSX_TOKEN`.
- Before bumping `package.json`, verify the extension builds cleanly and the relevant tests for the release scope have passed.

## Roadmap Management

- Use GitHub issues as the system of record for bugs, enhancements, and technical debt.
- Prefer explicit phase names such as sync safety, compile and PDF reliability, editor UX, and governance over a generic "towards v1.0" bucket.
- Track the current milestone map in [roadmap/milestones.md](./roadmap/milestones.md).
- Keep platform-constrained work explicit in [roadmap/blocked-items.md](./roadmap/blocked-items.md) so maintainers do not repeatedly reopen infeasible work without new information.
- Close, split, or repurpose umbrella issues once they stop carrying actionable state.
- Treat documentation promises as release commitments. Remove or rewrite stale version-targeted notes when plans change.

## Release Checklist

1. Confirm the intended release changes are merged to `master`.
2. Update the version in `package.json` in a dedicated change.
3. Verify `npm run compile`, `npm run lint`, and the issue-specific regression tests for the release scope.
4. Run `npm run validate:release` to verify the release metadata, workflow files, and roadmap docs remain coherent.
5. Confirm `VSCE_PAT` and `OVSX_TOKEN` are configured in repository secrets.
6. Run or monitor the publish workflow and verify both VS Code Marketplace and Open VSX publication succeed.
7. Update user-facing documentation when release behavior or constraints changed.
