# Github Actions Overview

We use Github Actions to automate various tasks in this repository. The following workflows are currently enabled:

- **lock-threads.yml**: Locks closed issues and pull requests after a period of inactivity.

- **vsce-package.yml**: Builds and uploads an `orbitleaf.vsix` artifact when a pull request targeting `main` is opened, reopened, or updated, or on manual dispatch. The package uses the display name **Overleaf-VS Code** and the Marketplace identifier `AstroJulio.orbitleaf`.

- **vsce-publish.yml**: Tests, packages, and publishes the extension on manual dispatch. Packaging compiles the extension, generates the corresponding-source archive, and validates release metadata. Publishing requires the repository secret `VSCE_PAT`.

The maintained source repository is [JulioM1823/Overleaf-VS-Code](https://github.com/JulioM1823/Overleaf-VS-Code).
