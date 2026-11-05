# claude-sbx-vscode

Use the Claude Code VS Code extension with Claude running inside a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) (`sbx`) instead of directly on your machine.

You keep the normal Claude panel in VS Code. Claude's file edits, shell commands and network requests happen inside the sandbox.

It has two parts:

- **`claude-sbx`**: a wrapper script. The Claude extension starts Claude through it (the `claudeCode.claudeProcessWrapper` setting), and it runs `claude` in the sandbox that mounts the open folder.
- **Claude sbx Status** (`vscode-extension/`): a VS Code extension that sets this up with one command and shows in the status bar whether Claude is sandboxed.

## Requirements

- macOS or Linux
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) (`sbx` CLI)
- VS Code with the Claude Code extension
- Node.js, to build the extension

## Install

```bash
git clone https://github.com/petterr-n/claude-sbx-vscode.git
cd claude-sbx-vscode/vscode-extension
npx @vscode/vsce package
code --install-extension claude-sbx-status-*.vsix
```

## Setup

1. Open your project folder in VS Code.
2. Run **Claude sbx: Set Up Sandboxed Claude** from the command palette, or accept the prompt shown on first start. It installs the wrapper to `~/.local/bin/claude-sbx`, points the Claude extension at it, finds or creates a sandbox for the folder, and checks that Claude starts inside it.
3. Click **Reload Window** when asked.

The status bar shows `sbx: <sandbox> ✓` when Claude runs in the sandbox. To undo, run **Claude sbx: Uninstall Sandbox Wrapper**.

### Manual setup (without the extension)

```bash
mkdir -p ~/.local/bin
cp claude-sbx ~/.local/bin/claude-sbx && chmod +x ~/.local/bin/claude-sbx
sbx create claude ~/path/to/project
```

Then add this to your VS Code user `settings.json` and reload the window:

```json
"claudeCode.claudeProcessWrapper": "/Users/<you>/.local/bin/claude-sbx"
```

If VS Code can't find `sbx`, set `CLAUDE_SBX_BIN=/full/path/to/sbx`. To always use one sandbox, set `CLAUDE_SBX_NAME=<name>`.
