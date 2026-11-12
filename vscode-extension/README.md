# Claude sbx Status

Runs the Claude Code VS Code extension inside a Docker Sandbox (`sbx`) and shows a status bar badge for it.

## Setup

Run **Claude sbx: Set Up Sandboxed Claude** from the command palette (you're also asked on first start). It installs the bundled `claude-sbx` wrapper to `~/.local/bin/claude-sbx`, sets `claudeCode.claudeProcessWrapper`, finds or creates the sandbox for the open folder, checks that `claude --version` works inside it, and offers to reload. **Claude sbx: Uninstall Sandbox Wrapper** undoes it.

## Badge

The status bar badge shows whether the Claude Code VS Code extension is running Claude inside a Docker Sandbox (`sbx`) through the `claude-sbx` wrapper.

| Badge | Meaning |
|---|---|
| `sbx: claude-sandbox ✓` | Wrapper is set, sandbox is running, this folder is mounted in it |
| `sbx: <name> ⚠` | Sandbox is stopped, or this folder isn't mounted in it |
| `sbx: no sandbox` | No sandbox mounts this folder. You'll be asked whether to create one |
| `sbx: <name> not found` / `sbx: error` / `sbx: wrapper missing` | Something is misconfigured; hover for details |
| `Claude: no sandbox` | `claudeCode.claudeProcessWrapper` isn't set to `claude-sbx` |

Click the badge to refresh, switch between running Claude inside and outside the sandbox (opens a new Claude tab; only the very first switch on after an uninstall reloads the window), start a stopped sandbox, create a sandbox for this folder (then open a new Claude tab, no reload needed), or remove it (`sbx rm`, asks first; your project files stay).

In sandboxed mode only (the wrapper is set), opening a folder that no sandbox mounts asks once per window: **Create sandbox** runs `sbx create --name claude-<folder> claude <folder>`. *Don't ask for this folder* remembers your choice.

The badge reflects your settings and the sandbox state (`sbx ls --json`). It can't look inside the Claude panel, so after changing `claudeCode.claudeProcessWrapper` by hand, reload the window before trusting it. Switching from the menu keeps that setting and creates or deletes `~/.config/claude-sbx/local` instead, which the wrapper checks every time Claude starts.

## Settings

- `claudeSbx.sandboxName`: use one fixed sandbox. Empty (default) means: `CLAUDE_SBX_NAME`, else the sandbox whose workspace contains the open folder, same as the wrapper
- `claudeSbx.offerCreate`: offer to create a sandbox for unmounted folders in sandboxed mode (default true)
- `claudeSbx.sbxPath`: full path to `sbx` if VS Code can't find it
- `claudeSbx.wrapperPath`: wrapper to use when turning the sandbox on (default `~/.local/bin/claude-sbx`)
- `claudeSbx.refreshIntervalSeconds`: default 15
- `claudeSbx.showWhenLocal`: show the `Claude: no sandbox` badge (default true)
