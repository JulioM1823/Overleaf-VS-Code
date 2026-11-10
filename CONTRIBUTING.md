# Contributing to Overleaf-VS Code
The Overleaf-VS Code extension is an open source project and we welcome contributions of all kinds from the community.
There are many ways to contribute, from improving the documentation, submitting bug reports and feature requests or writing code which can be incorporated into the extension itself.

In this document, we will mainly elaborate on how to make code contributions to the project.

## Contribution Guidance

> [!WARNING]
> We will not accept any pull request that is not associated with an issue.
> If you have any question about the project, please create an issue or discuss it in the [Issues](https://github.com/JulioM1823/Overleaf-VS-Code/issues) section.

To make a contribution to this project, please follow the steps below:

1. Create or find an `Bug Report` or `Feature Request` issue on [GitHub](https://github.com/JulioM1823/Overleaf-VS-Code/issues).
   
   If you are creating a new issue, please make sure that it is not a duplicate of an existing issue.

2. Fork this repository and create a new branch from `main` branch.

   It is recommended to name the branch with the issue number, e.g., `issue-123`, or related keywords, e.g., `fix-xxx`, `feat-xxx`.

3. Make your changes and commit them to the new branch.

   Please make sure that your commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification.

4. Create a pull request to the `main` branch of this repository.
   
   Please make sure that the pull request is associated with the issue you are working on. If you do not know how to do this, please refer to [Linking a pull request to an issue](https://docs.github.com/en/github/managing-your-work-on-github/linking-a-pull-request-to-an-issue).

5. Wait for the assigned reviewer to review your pull request.
   
   If there are any problems, please fix them and commit the changes to the same branch with rebase. If the reviewer approves your pull request, it will be merged into the `main` branch.

6. After the pull request is merged, the associated issue will be closed automatically.


## Maintainer and Release Governance

Repository governance, release ownership, and Marketplace continuity constraints are documented in [docs/governance.md](./docs/governance.md).
Contributors should not change the extension `publisher` or Marketplace identifier as part of routine issue work.


## Development Guidance

### Prerequisites
- [Node.js LTS](https://nodejs.org/en/) (22)
- Visual Studio Code (>= 1.80.0)
  > Recommended extensions: [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint), [JavaScript and TypeScript Nightly](https://marketplace.visualstudio.com/items?itemName=ms-vscode.vscode-typescript-next), [Vue Language Features (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.volar), [TypeScript Vue Plugin (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.vscode-typescript-vue-plugin)
- Operating System with common Unix commands.
  > If you are using Windows, please refer to [Windows Subsystem for Linux](https://docs.microsoft.com/en-us/windows/wsl/install-win10), [Cygwin](https://www.cygwin.com/) or [Git Bash](https://gitforwindows.org/).
  > You can also use [gow](https://github.com/bmatzelle/gow) installed with [scoop](https://scoop.sh/).

### Build

```bash
# Clone the Repository and Change Directory
git clone https://github.com/JulioM1823/Overleaf-VS-Code.git
cd Overleaf-VS-Code

# Install dependencies
npm ci
npm ci --prefix views/chat-view

# Build the Extension
npm run compile

# Generate corresponding source and validate release metadata
npm run package:source
npm run validate:release

# Run the node regression suite
npm run test:node

# [Optional] Package the Extension
npx @vscode/vsce@4.1.0 package
```

### Testing
In VSCode, press <kbd>F5</kbd> to start debugging. A new VSCode window will be opened with the extension loaded.

For deterministic repo-owned harnesses and fixtures, see [docs/testing-harnesses.md](./docs/testing-harnesses.md).

### Documentation
- [VSCode Extension API](https://code.visualstudio.com/api/references/vscode-api)
- [Overleaf-VS Code Extension Documentation](https://github.com/JulioM1823/Overleaf-VS-Code/blob/main/docs/README.md)
