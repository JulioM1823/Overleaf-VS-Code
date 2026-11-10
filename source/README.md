# Corresponding source for Overleaf-VS Code

The maintained repository is [JulioM1823/Overleaf-VS-Code](https://github.com/JulioM1823/Overleaf-VS-Code). Bugs are tracked in its [issue tracker](https://github.com/JulioM1823/Overleaf-VS-Code/issues). The Marketplace identifier remains `AstroJulio.orbitleaf`.

This directory is included in the installed extension and its VSIX. The `*-source.zip` archive contains the corresponding source of this exact extension version, including TypeScript, webview source, lockfiles, patches, static assets, license notices, and build/install scripts. `manifest.json` records the extension ID, version, archive SHA-256, and a SHA-256 for every archived file. Source access does not require access to the publisher's GitHub repository.

In VS Code, run **Developer: Open Extensions Folder**, open this extension's directory, then open `source`. A VSIX is also a ZIP archive: extract it and find this directory under `extension/source`.

Extract the source archive into an empty directory. With Node.js 22 and npm installed, run:

```sh
HUSKY=0 npm ci
npm ci --prefix views/chat-view
npm run compile
npm run lint
npm run test:node
node scripts/package-source.cjs
npx @vscode/vsce@4.0.0 package
```

The dependency installation requires network access. The lockfiles pin npm and Git dependencies. `scripts/install-vendor.cjs` fetches integrity-checked PDF.js 3.10.111 and LaTeX Basics v1.5.4 distributions and applies the included PDF.js patch. Dependency patches are included under `patches` and `views/chat-view/patches`. Build outputs are regenerated rather than stored in the source archive. Local integration tests that use sockets require permission to listen on loopback.

The extension is built on [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop), developed by iamhyc and the Overleaf Workshop contributors. See the archive's `LICENSE` for the GNU Affero General Public License version 3 and `THIRD_PARTY_NOTICES.md` for dependency notices. Existing upstream copyright and license notices are preserved. A modified version can be built and run from this source; publishing it requires a publisher account under your control.
