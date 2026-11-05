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
