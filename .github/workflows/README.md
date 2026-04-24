# Github Actions Overview

We use Github Actions to automate various tasks in this repository. The following workflows are currently enabled:

- **lock-threads.yml**: Locks closed issues and pull requests after a period of inactivity.

- **vsce-package.yml**: Builds a temporary `.vsix` package when a pull request targeting the `master` branch is opened, reopened, or updated.

- **vsce-publish.yml**: Publishes the extension on manual dispatch or on the daily schedule, but only when `package.json` changed in the previous 24 hours. The workflow now validates release metadata, compiles the extension, runs lint, and executes the node regression suite before packaging and publishing. It requires the repository secrets `VSCE_PAT` and `OVSX_TOKEN`.
