# Samare

Samare is a local Markdown editor for macOS. Open a folder on your Mac, write in the desktop app, then give an agent a link to the same file. Edits from the browser and the desktop go back to the file you opened. Samare also opens CSV, TSV, JSON and JSON Lines as editable tables, fields or records.

![Samare with the sample folder open on macOS](docs/workspace.png)

## Install on Apple Silicon

Download **Samare-0.1.0-arm64.dmg** from [GitHub Releases](https://github.com/Digidai/samare/releases/latest), open the disk image and drag Samare into Applications. The download uses ad-hoc signing and has no Apple notarization. If Gatekeeper blocks it, you can build Samare from source using the instructions below. Intel users can build on an Intel Mac.

The release build checks for signed updates on GitHub. Builds you make yourself only check a feed when you configure one.

## Build and open

Use a Mac with the Xcode Command Line Tools installed. The build downloads checksum-pinned copies of Sparkle and a standalone Python runtime for your Mac’s architecture. The app targets macOS 12 or later. Building on Apple Silicon produces an arm64 application, and building on an Intel Mac produces an x86_64 application.

```sh
git clone https://github.com/Digidai/samare.git
cd samare
./build.sh
open build/Samare.app
```

The browser assets ship in the source tree, so a normal app build needs neither npm nor an installed copy of another editor. Local builds use ad-hoc code signing. To make a drag-to-Applications disk image, run `Updates/package-dmg.sh`. The disk image appears in `build/Samare.dmg`.

## Try it with your own files

1. Choose **Add workspace** and select a folder. You can also open the included `Samples` folder.
2. Open a Markdown file. Use **⌘K** for commands, **⌘P** to find a file and **⌘F** to search the current document.
3. To work with an agent, open **Settings → Use in Agent**. Samare can install its local command and client instructions for Codex, Claude Code and Cursor. You can copy the instructions for an already running chat.
4. With the file open, press **⌘L** to copy its link. From a terminal, the equivalent command is:

```sh
"$HOME/.local/bin/samare" url "$PWD/Samples/Workspace.md"
```

The bridge listens on loopback. A browser on the same Mac can edit the registered document through the link. Treat the link as permission to read and write that document. Samare keeps its registration database under `~/Library/Application Support/Samare/Bridge/`. To inspect the service, run `"$HOME/.local/bin/samare" doctor`. Background operation after the app closes is a separate setting.

Markdown supports progressive rendering for long documents, wiki links, Mermaid, math, source editing, external-edit conflict review, HTML/PDF export and Finder Quick Look. On the Mac where you use Samare, Finder may offer more than one Markdown preview extension.

## Develop and test

The native host and Quick Look extension are in `Native/`. The editor and workspace are in `Resources/`. The Python bridge, its CLI and the browser entry point are in `Bridge/`. Update packaging and signature verification live in `Updates/`.

```sh
npm ci
npm run vendor
Native/test.sh
```

The tests below use real browser processes and temporary documents. Install Google Chrome for the bridge tests. For the editor tests, use the Playwright-managed Chromium browser or set `CHROME_PATH` to a local Chrome executable.

```sh
npx playwright install chromium
npm run test:editor
PLAYWRIGHT_MODULE=playwright npm run test:bridge
```

The interface icons can be regenerated independently with `npm ci --prefix tools/icons` and `npm run generate --prefix tools/icons`. The application icon and installer artwork also have editable sources in this repository.

## Publish updates for your own build

An ordinary source build opens and edits files without release credentials. To enable signed automatic updates, generate a new Ed25519 key outside the repository and set `SAMARE_UPDATE_PUBLIC_KEY` and `SAMARE_UPDATE_FEED_URL` when building. Supply the public key printed by the following command and an HTTPS appcast URL you control.

```sh
swift Updates/new-key.swift /path/outside/the/repository/ed25519
# After setting the two variables in your shell:
./build.sh
python3 Updates/package-release.py --key /path/outside/the/repository/ed25519 --channel /path/to/release-output
```

Host the generated appcast and archive together. If your feed redirects or the archive lives elsewhere, pass `--archive-base-url` with the public HTTPS directory containing the archive. Keep the private key with the publisher. Apple Developer ID signing and notarization are separate from Sparkle’s update signatures.

## 中文简介

在 Samare 中打开 Mac 上的文件夹，选中一份 Markdown，然后按 ⌘L。把复制的链接交给同一台 Mac 上的 Agent，它在浏览器中所作的修改会写回这份文件。CSV、TSV、JSON 和 JSONL 也可以在这个工作区里查看和编辑。

首次使用 Agent 时，在 **Settings → Use in Agent** 启用本地命令和需要的客户端。仓库提供桌面端、浏览器编辑器、Bridge、Quick Look 扩展、构建脚本和签名更新工具的源码。

## License

Samare is an independent project inspired by [Dawn](https://getdawn.co/) and its workflow for local documents. Samare’s original code and artwork use the [MIT License](LICENSE). Bundled open-source libraries and fonts retain their own licenses and copyright notices. See [third-party notices](THIRD-PARTY-NOTICES.txt).
