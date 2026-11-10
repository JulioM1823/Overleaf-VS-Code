# Overleaf-VS Code

Work on Overleaf projects in VS Code with **real-time, bidirectional synchronization**: your edits reach Overleaf, and collaborators’ edits appear in your editor. Compile on your Overleaf server and view the PDF beside your source.

This extension is built on the source code of [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop), developed by iamhyc and the Overleaf Workshop contributors.

Published by **AstroJulio**. Overleaf-VS Code is independently maintained and is not an official Overleaf product.

## Real-time collaboration and offline editing

- **Real-time, bidirectional synchronization:** edit collaboratively across VS Code and Overleaf, with shared editing, chat, and comments synchronized while connected.
- **Keep editing offline:** continue working on previously opened, cached documents when your connection drops. Offline edits are retained locally and automatically synchronized on reconnection. Compatible local and remote edits are merged; overlapping changes that cannot be merged safely require conflict resolution.

Open the project and the documents you need while online before going offline. Live chat, remote updates, and server compilation require a connection. Offline editing lets you keep contributing to a shared project; collaborators receive those changes after reconnection.

## Get started

You need desktop **VS Code 1.80 or later**, an Overleaf account with access to a project, and an internet connection for initial setup and server features. Server compilation does not require a local TeX installation. Compatible self-hosted Overleaf servers are also supported.

1. Install **Overleaf-VS Code** by **AstroJulio** from Extensions.
2. Select **Overleaf-VS Code** in the Activity Bar. In **Projects**, right-click **www.overleaf.com** → **Login to Server** → **Login with Cookies**.
3. Use **Google Chrome** to sign in to Overleaf and open its project dashboard. **Safari and Firefox have not yet been tested** for this cookie sign-in method. Open Chrome's developer tools → **Network**, then reload the dashboard.
4. Select the authenticated `project` request. Under request headers, copy the **Cookie** value. Paste it into Overleaf-VS Code's masked login input and press Enter. Treat this value like a password.
5. Expand the server, right-click your project → **Open Project in Current Window**, then open the main `.tex` file.
6. In the Command Palette, run **Overleaf-VS Code: Compile Project**, then **Overleaf-VS Code: View Compiled PDF**.

For another server, run **Overleaf-VS Code: Add New Server** before signing in. To create a project, right-click the signed-in server → **New Project** → **Example Project**.

## Edit, compile and read

Compile-on-save is enabled by default. You can also compile with **⌘⌥B** on macOS or **Ctrl+Alt+B** on Windows/Linux. Open the PDF with **⌘⌥V** or **Ctrl+Alt+V**.

Use **Overleaf-VS Code: Jump to PDF** to navigate from source to PDF; double-click the PDF to return to source. **Overleaf-VS Code: Set Root Document** and **Overleaf-VS Code: Set Compiler** change the server build settings.

Collaborate in real time with shared project editing, **Chat**, and comments in **Review** synchronized with Overleaf while connected. Available actions depend on your server and project permissions. LaTeX completion, formatting, and project search are also included.

## Settings and local copies

Search **Overleaf-VS Code** in Settings to adjust compile-on-save, the output folder, PDF colors, scrolling and page spreads.

Right-click a project → **Open Project Locally ...** to work with a synchronized local copy. Server compilation still needs a connection. Offline local compilation requires **LaTeX Workshop** and a working local TeX installation.

## Source and license

Overleaf-VS Code uses the **GNU Affero General Public License v3.0**. The installed extension includes the corresponding source for this exact version, build instructions and original license notices.

Run **Developer: Open Extensions Folder**, open `astrojulio.orbitleaf-<version>`, then open `source/README.md`. The source archive is in `source/`; the extension license and dependency notices are in `LICENSE.txt` and `THIRD_PARTY_NOTICES.md`.

## Source and issues

Source code: [Overleaf-VS-Code on GitHub](https://github.com/JulioM1823/Overleaf-VS-Code). Report bugs in the [issue tracker](https://github.com/JulioM1823/Overleaf-VS-Code/issues). Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=AstroJulio.orbitleaf).
