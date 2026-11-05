# Claude sbx Status

Runs the Claude Code VS Code extension inside a Docker Sandbox (`sbx`) and shows a status bar badge for it.

## Setup

Run **Claude sbx: Set Up Sandboxed Claude** from the command palette (you're also asked on first start). It installs the bundled `claude-sbx` wrapper to `~/bin/claude-sbx`, sets `claudeCode.claudeProcessWrapper`, finds or creates the sandbox for the open folder, checks that `claude --version` works inside it, and offers to reload. **Claude sbx: Remove Sandboxed Claude Setup** undoes it.

## Badge

The status bar badge shows whether the Claude Code VS Code extension is running Claude inside a Docker Sandbox (`sbx`) through the `claude-sbx` wrapper.

| Badge | Meaning |
|---|---|
| `sbx: claude-sandbox ✓` | Wrapper is set, sandbox is running, this folder is mounted in it |
| `sbx: <name> ⚠` | Sandbox is stopped, or this folder isn't mounted in it |
| `sbx: no sandbox` | No sandbox mounts this folder. You'll be asked whether to create one |
| `sbx: <name> not found` / `sbx: error` / `sbx: wrapper missing` | Something is misconfigured; hover for details |
| `Claude: local` | `claudeCode.claudeProcessWrapper` isn't set to `claude-sbx` |

Click the badge to refresh, switch the wrapper on or off (then reload the window), start a stopped sandbox, or create a sandbox for this folder.

In sandboxed mode only (the wrapper is set), opening a folder that no sandbox mounts asks once per window: **Create sandbox** runs `sbx create --name claude-<folder> claude <folder>`. *Don't ask for this folder* remembers your choice.

The badge reflects your settings and the sandbox state (`sbx ls --json`). It can't look inside the Claude panel, so after changing the wrapper setting, reload the window before trusting it.

## Settings

- `claudeSbx.sandboxName`: use one fixed sandbox. Empty (default) means: `CLAUDE_SBX_NAME`, else the sandbox whose workspace contains the open folder, same as the wrapper
- `claudeSbx.offerCreate`: offer to create a sandbox for unmounted folders in sandboxed mode (default true)
- `claudeSbx.sbxPath`: full path to `sbx` if VS Code can't find it
- `claudeSbx.wrapperPath`: wrapper to use when turning the sandbox on (default `~/bin/claude-sbx`)
- `claudeSbx.refreshIntervalSeconds`: default 15
- `claudeSbx.showWhenLocal`: show the `Claude: local` badge (default true)

## Safety checks

The project folder is mounted read-write in the sandbox, so code inside it can write `.vscode/settings.json`. Because of that:

- `sandboxName`, `sbxPath` and `wrapperPath` are read from **user settings only**. Workspace values are ignored.
- If workspace settings set `claudeCode.claudeProcessWrapper`, the badge shows `Claude: workspace wrapper` ⚠ and nothing is run. Setup sets the wrapper in user settings and removes the workspace value.
- The badge shows ✓ only if the wrapper is the bundled one (or one you chose to keep during setup), and only if the wrapper and `sbx` are owned by you or root, not writable by group or others, and outside every folder a sandbox mounts. Otherwise it shows `sbx: wrapper not trusted` ⚠.
- Setup won't install the wrapper inside a mounted folder, or write an `sbx` path containing shell characters into it.
- Remove Setup only offers to delete the file if it's the wrapper.
- **Files that run on this machine:** in sandboxed mode, the open folders a sandbox mounts (and git repos one level down) are checked for git config entries that run commands (`core.fsmonitor`, `core.pager`, `diff.*.textconv`, `alias.* = !…`, `include.path`, …), executable git hooks, and `.vscode/tasks.json` tasks with `"runOn": "folderOpen"`. A new or changed entry shows a notification and turns the badge ⚠. Use **Review files that run on this machine** in the menu to mark entries you made yourself; editing an entry brings it back. This detects changes but can't prevent them. For untrusted code use `sbx create --clone`.
- **Create sandbox** refuses to mount your home folder (or a parent of it) or a folder containing the wrapper or `sbx`. If several folders are open, it lists them all and asks first.
