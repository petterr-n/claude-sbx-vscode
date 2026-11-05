# claude-sbx-vscode

Run the Claude Code VS Code extension with Claude inside a Docker Sandbox (`sbx`).

## Setup

1. Copy `claude-sbx` to `~/bin/` and make it executable:
   ```bash
   cp claude-sbx ~/bin/claude-sbx && chmod +x ~/bin/claude-sbx
   ```
2. In VS Code `settings.json`:
   ```json
   "claudeCode.claudeProcessWrapper": "/Users/<you>/bin/claude-sbx"
   ```

The wrapper runs Claude in the sandbox that mounts the open folder (found with `sbx ls --json`). Create one per project with `sbx create claude <folder>`, or set `CLAUDE_SBX_NAME` to always use one sandbox.

## Security: what the sandbox does and doesn't isolate

Claude's shell commands, network access and processes run inside the sandbox. **But the project folder is mounted read-write, and tools on your Mac read config from it.** Code in the sandbox (for example Claude following instructions hidden in a file it read) can write files that your Mac then runs:

- **`.git/config`**: `core.fsmonitor`, `core.pager`, `core.sshCommand`, `diff.*.textconv`, `filter.*`, `alias.* = !…`, `include.path` and others are commands git runs. VS Code's Git extension runs `git status` by itself, so `core.fsmonitor` can run **without you doing anything**.
- **`.git/hooks/*`**: run by git on commit, checkout, push and so on.
- **`.vscode/tasks.json`** (`"runOn": "folderOpen"`), **`.vscode/settings.json`** (paths to interpreters, linters and other tools), `.envrc`, `package.json` scripts, `Makefile`: anything you run or open on your Mac.

What helps:

- **For code you don't trust, use clone mode:** `sbx create --clone claude <folder>`. The sandbox works on its own clone and your Mac's files change only when you fetch from it.
- The status extension **ignores workspace values** for its own settings and the Claude wrapper. It **warns** when git config, git hooks or auto-run tasks in a mounted folder would run code. It checks every few seconds and when those files change. That's detection, not prevention: by the time it warns, `core.fsmonitor` may already have run.
- Before running git or other tools on your Mac in a sandboxed project, check `git diff`, and look at `.git/config`, `.git/hooks/` and `.vscode/`.
- Don't open your home folder (or a folder containing `~/bin`) with a sandbox. The extension refuses to create one for those.
