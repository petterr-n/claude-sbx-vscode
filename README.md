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
