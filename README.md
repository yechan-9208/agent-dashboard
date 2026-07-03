# Agent Dashboard (AAD)

> **Claude Code · OpenAI Codex** skills, agents, and instructions sync dashboard.
> Runs locally on `127.0.0.1`; no account, cloud service, or telemetry required.

AAD helps you see whether your Claude Code and Codex setup files are aligned across your home directory and project folders, then sync selected items through a preview-first workflow.

## What it does

- Shows a local dashboard for Claude/Codex instructions and skills.
- Compares items across tools and folders with a matrix view.
- Syncs through a two-step flow: preview diff → explicit apply.
- Keeps backups before writes.
- Guards real filesystem access behind `AAD_ALLOW_REAL=1`.
- Ignores known secret/session/database paths by denylist.

## Install as a Claude Code plugin

```bash
/plugin marketplace add <owner>/<repo>
/plugin install aad@aad
/aad:serve
```

Then open the printed local URL, usually:

```text
http://127.0.0.1:4319
```

Stop the server:

```bash
/aad:stop
```

Plugin runtime data is stored outside the plugin cache in Claude's persistent plugin data directory:

```text
~/.claude/plugins/data/aad/
```

That folder holds installed Node dependencies, local canonical backup data, registry cache, logs, and server PID files.

## Run directly from the repo

```bash
npm install
npm run serve       # safe dummy mode
```

To point the dashboard at your real local Claude/Codex files:

```bash
npm run serve:real
```

CLI examples:

```bash
AAD_ALLOW_REAL=1 node bin/aad.js matrix --kind skill
AAD_ALLOW_REAL=1 node bin/aad.js status
node bin/aad.js help
```

Without `AAD_ALLOW_REAL=1`, the app falls back to dummy fixtures and does not touch real Claude/Codex files.

## Repository layout

| Path | Purpose |
|---|---|
| `.claude-plugin/` | Claude Code plugin metadata. |
| `commands/` | Plugin slash commands: `/aad:serve`, `/aad:stop`. |
| `scripts/` | Plugin server start/stop scripts. |
| `bin/` | CLI entrypoint. |
| `cli/` | Core sync, scan, transform, backup, registry, and usage logic. |
| `server/` | Local `127.0.0.1` HTTP server. |
| `dashboard/` | Browser UI. |
| `catalog/` | Bundled local catalog and public registry seeds. |
| `fixtures/` | Dummy-mode sample files. |
| `docs/` | Usage and architecture notes. |

## Safety model

- Localhost only: the server binds to `127.0.0.1`.
- Real mode requires explicit opt-in: `AAD_ALLOW_REAL=1`.
- Writes require preview first and explicit apply.
- Existing files are backed up before overwrite.
- Secret/session/database paths such as `.env`, keys, auth files, sqlite files, and session logs are denied.
- External network access is limited to user-triggered public git registry refreshes.

## License

MIT
