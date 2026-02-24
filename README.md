# inv-claw

Track everything your Claw does. Every change, every command ran, full results — all logged to a local SQLite database with an instant browser dashboard.

**Zero config. Pure Node. No Python.**

## Install

```bash
# Via OpenClaw CLI
openclaw plugins install inv-claw

# Or install locally for development
git clone https://github.com/Hardik-Singh/inv-claw
cd inv-claw && npm install && npm run build
openclaw plugins install -l .
```

OpenClaw discovers the plugin via `openclaw.plugin.json` + `package.json` → `openclaw.extensions`.

## Dashboard

The audit dashboard launches automatically on **http://localhost:7749** when the plugin loads.

Start it standalone:

```bash
node dist/server.js
```

### Features
- Real-time activity feed (3s polling)
- Filter by action type: file, web, exec, email, message, LLM
- Searchable event history
- Tag editor for organizing events
- Light/dark theme toggle
- Mock data fallback for demo

## What It Captures (V1)

| Action Type | Source | Enrichment |
|-------------|--------|------------|
| **message** | `message:received`, `message:sent` hooks | Full content, channel, sender/recipient |
| **file** | Context-detected file operations | Reads file contents (< 50KB) |
| **web** | Context-detected HTTP operations | Re-fetches URL, captures status + body |
| **email** | Context-detected email operations | To, from, subject, body from params |
| **exec** | `command:*` hooks | Command, args, and full results |
| **llm** | Context-detected LLM calls | Model + prompt preview (no response — needs hook bridge) |

### Coming in V2 (when OpenClaw bridges internal hooks)

- `tool:after_call` — capture tool name, params, result, duration
- `llm:input` / `llm:output` — capture full LLM request/response
- See [openclaw/openclaw#20575](https://github.com/openclaw/openclaw/discussions/20575)

## Slash Command

```
/audit        — show last 5 audit events
/audit 20     — show last 20 audit events
```

## REST API

All endpoints on `http://localhost:7749`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/events` | List events (`type`, `session`, `q`, `limit`) |
| `GET` | `/api/events/:id` | Single event detail |
| `GET` | `/api/stats` | Aggregate statistics |
| `PUT` | `/api/events/:id/tags` | Update event tags |

## Configuration

Plugin config in your OpenClaw config file:

```yaml
plugins:
  entries:
    inv-claw:
      enabled: true
      config:
        dbPath: ~/.invariance-audit/audit.db
        dashboardPort: 7749
        enableDashboard: true
```

## Storage

Events stored in `~/.invariance-audit/audit.db` (SQLite, WAL mode).

## On-Chain Upgrade Path

inv-claw is the local-first entry point to [Invariance](https://useinvariance.com):

1. **Local** — SQLite audit log (this plugin)
2. **Signed** — Cryptographic provenance via `@invariance/sdk`
3. **On-chain** — Immutable execution logs on Base L2

See [useinvariance.com/docs](https://useinvariance.com/docs) for the upgrade guide.

## License

MIT
