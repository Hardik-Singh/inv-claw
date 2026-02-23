#!/usr/bin/env python3
"""invariance-audit · Dashboard server (stdlib only). Port 7749."""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

# Allow running from any cwd
sys.path.insert(0, str(Path(__file__).parent))
import db

PORT = int(os.environ.get("INVARIANCE_AUDIT_PORT", "7749"))
DASHBOARD_HTML = Path(__file__).parent / "dashboard" / "index.html"


# ── Mock data for demo / empty DB ──────────────────────────────────

def _mock_events() -> list[dict]:
    now = datetime.now(timezone.utc)
    return [
        {
            "id": 1, "timestamp": (now - timedelta(minutes=30)).isoformat(),
            "session_id": "demo-session-001", "action_type": "file",
            "summary": "Read config.yaml",
            "detail_json": json.dumps({"command": "read", "path": "/app/config.yaml"}),
            "tags": '["config", "startup"]',
            "enrichment_json": json.dumps({"file_path": "/app/config.yaml", "file_size": 1240, "content_preview": "server:\\n  port: 8080\\n  host: 0.0.0.0"}),
        },
        {
            "id": 2, "timestamp": (now - timedelta(minutes=25)).isoformat(),
            "session_id": "demo-session-001", "action_type": "web",
            "summary": "Fetch https://api.example.com/data",
            "detail_json": json.dumps({"command": "fetch", "url": "https://api.example.com/data"}),
            "tags": '["api"]',
            "enrichment_json": json.dumps({"url": "https://api.example.com/data", "status": 200, "body_preview": '{"results": []}'}),
        },
        {
            "id": 3, "timestamp": (now - timedelta(minutes=20)).isoformat(),
            "session_id": "demo-session-001", "action_type": "exec",
            "summary": "bash: npm install",
            "detail_json": json.dumps({"command": "bash", "args": "npm install"}),
            "tags": '["build"]',
            "enrichment_json": "{}",
        },
        {
            "id": 4, "timestamp": (now - timedelta(minutes=15)).isoformat(),
            "session_id": "demo-session-001", "action_type": "email",
            "summary": "Send report to team@example.com",
            "detail_json": json.dumps({"command": "send_email", "to": "team@example.com", "subject": "Daily Report"}),
            "tags": '["report", "daily"]',
            "enrichment_json": json.dumps({"to": "team@example.com", "subject": "Daily Report", "body_preview": "Attached is the daily summary..."}),
        },
        {
            "id": 5, "timestamp": (now - timedelta(minutes=10)).isoformat(),
            "session_id": "demo-session-001", "action_type": "message",
            "summary": "Slack: #engineering — deploy complete",
            "detail_json": json.dumps({"command": "slack_send", "channel": "#engineering", "text": "Deploy complete ✓"}),
            "tags": '["slack", "deploy"]',
            "enrichment_json": json.dumps({"channel": "#engineering", "text": "Deploy complete ✓"}),
        },
        {
            "id": 6, "timestamp": (now - timedelta(minutes=5)).isoformat(),
            "session_id": "demo-session-001", "action_type": "llm",
            "summary": "claude: summarize PR diff",
            "detail_json": json.dumps({"command": "llm_call", "model": "claude-sonnet-4-6", "prompt_preview": "Summarize this PR diff..."}),
            "tags": '["llm", "review"]',
            "enrichment_json": "{}",
        },
        {
            "id": 7, "timestamp": (now - timedelta(minutes=2)).isoformat(),
            "session_id": "demo-session-001", "action_type": "file",
            "summary": "Write deploy.log",
            "detail_json": json.dumps({"command": "write", "path": "/var/log/deploy.log"}),
            "tags": '["deploy", "log"]',
            "enrichment_json": json.dumps({"file_path": "/var/log/deploy.log", "file_size": 4520}),
        },
    ]


# ── HTTP Handler ───────────────────────────────────────────────────

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        pass  # silence request logs

    def _json(self, data: object, status: int = 200) -> None:
        body = json.dumps(data, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, path: Path) -> None:
        content = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        # Dashboard
        if parsed.path in ("/", "/index.html"):
            if DASHBOARD_HTML.exists():
                self._html(DASHBOARD_HTML)
            else:
                self._json({"error": "dashboard/index.html not found"}, 404)
            return

        conn = db.get_conn()

        # API: events list
        if parsed.path == "/api/events":
            events = db.get_events(
                conn,
                limit=int(qs.get("limit", ["200"])[0]),
                action_type=qs.get("type", [None])[0],
                session_id=qs.get("session", [None])[0],
                search=qs.get("q", [None])[0],
            )
            if not events:
                events = _mock_events()
            self._json(events)
            return

        # API: stats
        if parsed.path == "/api/stats":
            stats = db.get_stats(conn)
            if stats["total"] == 0:
                mock = _mock_events()
                by_type: dict[str, int] = {}
                for e in mock:
                    by_type[e["action_type"]] = by_type.get(e["action_type"], 0) + 1
                stats = {"total": len(mock), "by_type": by_type, "sessions": 1}
            self._json(stats)
            return

        # API: single event
        if parsed.path.startswith("/api/events/"):
            try:
                eid = int(parsed.path.split("/")[-1])
                rows = conn.execute("SELECT * FROM events WHERE id = ?", (eid,)).fetchall()
                if rows:
                    self._json(dict(rows[0]))
                else:
                    mock = _mock_events()
                    match = [e for e in mock if e["id"] == eid]
                    self._json(match[0] if match else {"error": "not found"}, 200 if match else 404)
            except ValueError:
                self._json({"error": "invalid id"}, 400)
            return

        self._json({"error": "not found"}, 404)

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/events/") and parsed.path.endswith("/tags"):
            try:
                eid = int(parsed.path.split("/")[-2])
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length))
                conn = db.get_conn()
                db.update_tags(conn, eid, body.get("tags", []))
                self._json({"ok": True})
            except Exception as exc:
                self._json({"error": str(exc)}, 400)
            return
        self._json({"error": "not found"}, 404)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


# ── Main ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[invariance-audit] Dashboard → http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[invariance-audit] Stopped.")
        server.server_close()
