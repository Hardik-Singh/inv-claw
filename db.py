"""invariance-audit · SQLite helpers (stdlib only)."""

import json
import os
import sqlite3
from pathlib import Path
from typing import Any

DB_PATH = os.environ.get(
    "INVARIANCE_AUDIT_DB",
    str(Path.home() / ".invariance-audit" / "audit.db"),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT    NOT NULL,
    session_id      TEXT    NOT NULL,
    action_type     TEXT    NOT NULL,
    summary         TEXT    NOT NULL DEFAULT '',
    detail_json     TEXT    NOT NULL DEFAULT '{}',
    tags            TEXT    NOT NULL DEFAULT '[]',
    enrichment_json TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type    ON events(action_type);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(timestamp);
"""


def get_conn() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def insert_event(
    conn: sqlite3.Connection,
    *,
    timestamp: str,
    session_id: str,
    action_type: str,
    summary: str = "",
    detail_json: str = "{}",
    tags: str = "[]",
    enrichment_json: str = "{}",
) -> int:
    cur = conn.execute(
        """INSERT INTO events (timestamp, session_id, action_type, summary, detail_json, tags, enrichment_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (timestamp, session_id, action_type, summary, detail_json, tags, enrichment_json),
    )
    conn.commit()
    return cur.lastrowid  # type: ignore[return-value]


def get_events(
    conn: sqlite3.Connection,
    *,
    limit: int = 200,
    action_type: str | None = None,
    session_id: str | None = None,
    search: str | None = None,
) -> list[dict[str, Any]]:
    q = "SELECT * FROM events WHERE 1=1"
    params: list[Any] = []
    if action_type:
        q += " AND action_type = ?"
        params.append(action_type)
    if session_id:
        q += " AND session_id = ?"
        params.append(session_id)
    if search:
        q += " AND (summary LIKE ? OR detail_json LIKE ?)"
        params.extend([f"%{search}%", f"%{search}%"])
    q += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(q, params).fetchall()
    return [dict(r) for r in rows]


def get_stats(conn: sqlite3.Connection) -> dict[str, Any]:
    total = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    by_type = dict(
        conn.execute(
            "SELECT action_type, COUNT(*) FROM events GROUP BY action_type"
        ).fetchall()
    )
    sessions = conn.execute("SELECT COUNT(DISTINCT session_id) FROM events").fetchone()[0]
    return {"total": total, "by_type": by_type, "sessions": sessions}


def update_tags(conn: sqlite3.Connection, event_id: int, tags: list[str]) -> None:
    conn.execute("UPDATE events SET tags = ? WHERE id = ?", (json.dumps(tags), event_id))
    conn.commit()
