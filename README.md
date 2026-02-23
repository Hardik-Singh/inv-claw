# invariance-audit

Passive audit logging plugin for [OpenClaw](https://openclaw.dev) agents. Every tool call, file read, web fetch, email, and exec gets recorded to a local SQLite database with an instant browser dashboard.

**Zero config. Zero dependencies beyond Node + Python 3.**

## Quick Start

```bash
# Install the plugin in your OpenClaw project
npm install invariance-audit

# Or clone and link
git clone https://github.com/Hardik-Singh/invariance-audit
cd invariance-audit && npm install && npm run build
```

OpenClaw will auto-discover the plugin via `package.json` → `openclaw.hooks`.

## Dashboard

The audit dashboard launches automatically on **http://localhost:7749** when the plugin loads.

You can also start it manually:

```bash
python3 server.py
```

### Features
- Real-time activity feed with 3-second polling
- Filter by action type: file, web, exec, email, message, LLM
- Searchable event history
- Tag editor for organizing events
- Light/dark theme toggle
- Mock data fallback for demo/empty databases

## What It Logs

| Action Type | What's Captured | Enrichment (V1) |
|-------------|----------------|------------------|
| **file** | Read/write/edit/delete | File contents (< 50KB) |
| **web** | HTTP fetches, navigation | Re-fetched response body |
| **email** | Send/receive | Full message metadata |
| **message** | Slack, Discord, chat | Full message content |
| **exec** | Shell commands | Command + args |
| **llm** | Model API calls | Model + prompt preview |

## API

All endpoints served on `http://localhost:7749`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/events` | List events (query: `type`, `session`, `q`, `limit`) |
| `GET` | `/api/events/:id` | Single event detail |
| `GET` | `/api/stats` | Aggregate statistics |
| `PUT` | `/api/events/:id/tags` | Update event tags |

## Storage

Events are stored in `~/.invariance-audit/audit.db` (SQLite, WAL mode). Override with:

```bash
export INVARIANCE_AUDIT_DB=/custom/path/audit.db
```

## On-Chain Upgrade Path

invariance-audit is the local-first entry point to the [Invariance Protocol](https://invariance.dev). When you're ready for cryptographic verification and on-chain enforcement:

1. **Local** → SQLite audit log (this plugin)
2. **Signed** → Cryptographic provenance via Invariance SDK
3. **On-chain** → Immutable execution logs on Base L2

```bash
npm install @invariance/sdk
```

See [invariance.dev/docs](https://invariance.dev/docs) for the upgrade guide.

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `INVARIANCE_AUDIT_DB` | `~/.invariance-audit/audit.db` | Database path |
| `INVARIANCE_AUDIT_PORT` | `7749` | Dashboard port |

## License

MIT
