import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const DEFAULT_DB_DIR = path.join(os.homedir(), ".inv-claw");
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "audit.db");

const SCHEMA = `
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
`;

export interface AuditEvent {
  id?: number;
  timestamp: string;
  session_id: string;
  action_type: string;
  summary: string;
  detail_json: string;
  tags: string;
  enrichment_json: string;
}

export interface EventFilter {
  limit?: number;
  action_type?: string | null;
  session_id?: string | null;
  search?: string | null;
}

export interface Stats {
  total: number;
  by_type: Record<string, number>;
  sessions: number;
}

let _db: Database.Database | null = null;

export function ensureDb(dbPath?: string): Database.Database {
  if (_db) return _db;
  const p = dbPath ?? DEFAULT_DB_PATH;
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  _db = new Database(p);
  _db.pragma("journal_mode = WAL");
  _db.exec(SCHEMA);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function insertEvent(
  db: Database.Database,
  event: Omit<AuditEvent, "id">
): number {
  const stmt = db.prepare(`
    INSERT INTO events (timestamp, session_id, action_type, summary, detail_json, tags, enrichment_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    event.timestamp,
    event.session_id,
    event.action_type,
    event.summary,
    event.detail_json,
    event.tags,
    event.enrichment_json
  );
  return result.lastInsertRowid as number;
}

export function getEvents(
  db: Database.Database,
  filter: EventFilter = {}
): AuditEvent[] {
  const { limit = 200, action_type, session_id, search } = filter;
  let q = "SELECT * FROM events WHERE 1=1";
  const params: unknown[] = [];

  if (action_type) {
    q += " AND action_type = ?";
    params.push(action_type);
  }
  if (session_id) {
    q += " AND session_id = ?";
    params.push(session_id);
  }
  if (search) {
    q += " AND (summary LIKE ? OR detail_json LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }
  q += " ORDER BY id DESC LIMIT ?";
  params.push(limit);

  return db.prepare(q).all(...params) as AuditEvent[];
}

export function getEvent(
  db: Database.Database,
  id: number
): AuditEvent | undefined {
  return db.prepare("SELECT * FROM events WHERE id = ?").get(id) as
    | AuditEvent
    | undefined;
}

export function getStats(db: Database.Database): Stats {
  const total = (
    db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }
  ).c;
  const rows = db
    .prepare("SELECT action_type, COUNT(*) as c FROM events GROUP BY action_type")
    .all() as { action_type: string; c: number }[];
  const by_type: Record<string, number> = {};
  for (const r of rows) by_type[r.action_type] = r.c;
  const sessions = (
    db.prepare("SELECT COUNT(DISTINCT session_id) as c FROM events").get() as {
      c: number;
    }
  ).c;
  return { total, by_type, sessions };
}

export function updateTags(
  db: Database.Database,
  eventId: number,
  tags: string[]
): void {
  db.prepare("UPDATE events SET tags = ? WHERE id = ?").run(
    JSON.stringify(tags),
    eventId
  );
}
