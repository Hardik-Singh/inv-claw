import Database from "better-sqlite3";
import { execSync, spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import WebSocket from "ws";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AuditEvent {
  id?: number;
  timestamp: string;
  session_id: string;
  action_type: string;
  summary: string;
  detail_json: string;
  tags: string;
  enrichment_json: string;
}

interface OpenClawAPI {
  on(event: string, cb: (payload: unknown) => void): void;
  getSessionId(): string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DB_DIR = path.join(os.homedir(), ".invariance-audit");
const DB_PATH = path.join(DB_DIR, "audit.db");
const WS_URL = "ws://127.0.0.1:18789";
const WS_RETRY_MS = 10_000;
const DASHBOARD_PORT = 7749;

/* ------------------------------------------------------------------ */
/*  Database                                                           */
/* ------------------------------------------------------------------ */

function ensureDb(): Database.Database {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
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
  `);
  return db;
}

/* ------------------------------------------------------------------ */
/*  Action type detection                                              */
/* ------------------------------------------------------------------ */

function detectActionType(payload: Record<string, unknown>): string {
  const cmd = String(payload.command ?? payload.tool ?? payload.type ?? "").toLowerCase();
  if (/read|write|edit|glob|file|mkdir|rm/.test(cmd)) return "file";
  if (/email|smtp|send_?mail/.test(cmd)) return "email";
  if (/message|chat|slack|discord|send/.test(cmd)) return "message";
  if (/fetch|http|curl|browse|web|url|navigate/.test(cmd)) return "web";
  if (/exec|bash|shell|run|spawn/.test(cmd)) return "exec";
  if (/llm|claude|gpt|openai|anthropic|completion/.test(cmd)) return "llm";
  return "unknown";
}

/* ------------------------------------------------------------------ */
/*  Enrichment helpers                                                 */
/* ------------------------------------------------------------------ */

function enrichFile(payload: Record<string, unknown>): Record<string, unknown> {
  const filePath = String(payload.path ?? payload.file_path ?? payload.filename ?? "");
  if (!filePath) return {};
  try {
    const stat = fs.statSync(filePath);
    const content = stat.size < 50_000 ? fs.readFileSync(filePath, "utf-8") : `[file too large: ${stat.size} bytes]`;
    return { file_path: filePath, file_size: stat.size, content_preview: content.slice(0, 2000) };
  } catch {
    return { file_path: filePath, error: "could not read file" };
  }
}

function enrichWeb(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = String(payload.url ?? payload.href ?? "");
  if (!url) return Promise.resolve({});
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ url, status: res.statusCode, body_preview: body.slice(0, 2000) }));
    });
    req.on("error", () => resolve({ url, error: "fetch failed" }));
    req.on("timeout", () => { req.destroy(); resolve({ url, error: "timeout" }); });
  });
}

/* ------------------------------------------------------------------ */
/*  Dashboard spawner                                                  */
/* ------------------------------------------------------------------ */

let dashboardProc: ChildProcess | null = null;

function spawnDashboard(): void {
  if (dashboardProc && !dashboardProc.killed) return;
  try {
    // Check if port already in use
    execSync(`lsof -i :${DASHBOARD_PORT} -t`, { stdio: "ignore" });
    return; // port already in use, dashboard probably running
  } catch {
    // port free, spawn
  }
  const serverPath = path.join(__dirname, "server.py");
  if (!fs.existsSync(serverPath)) return;
  dashboardProc = spawn("python3", [serverPath], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, INVARIANCE_AUDIT_DB: DB_PATH },
  });
  dashboardProc.unref();
}

/* ------------------------------------------------------------------ */
/*  WebSocket listener                                                 */
/* ------------------------------------------------------------------ */

function connectWs(db: Database.Database, sessionId: string): void {
  const insert = db.prepare(`
    INSERT INTO events (timestamp, session_id, action_type, summary, detail_json, tags, enrichment_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  function connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      setTimeout(connect, WS_RETRY_MS);
      return;
    }

    ws.on("open", () => {
      console.log("[invariance-audit] WS connected");
    });

    ws.on("message", async (raw: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
        const actionType = detectActionType(payload);
        const summary = String(payload.summary ?? payload.command ?? payload.tool ?? "").slice(0, 200);

        let enrichment: Record<string, unknown> = {};
        if (actionType === "file") enrichment = enrichFile(payload);
        if (actionType === "web") enrichment = await enrichWeb(payload);

        insert.run(
          new Date().toISOString(),
          sessionId,
          actionType,
          summary,
          JSON.stringify(payload),
          JSON.stringify(payload.tags ?? []),
          JSON.stringify(enrichment)
        );
      } catch {
        // silently skip malformed messages
      }
    });

    ws.on("close", () => {
      setTimeout(connect, WS_RETRY_MS);
    });

    ws.on("error", () => {
      ws.close();
    });
  }

  connect();
}

/* ------------------------------------------------------------------ */
/*  Plugin entry                                                       */
/* ------------------------------------------------------------------ */

export function register(api: OpenClawAPI): void {
  const db = ensureDb();
  const sessionId = api.getSessionId();

  // Listen for command:new hook events directly
  api.on("command:new", (payload: unknown) => {
    const p = payload as Record<string, unknown>;
    const actionType = detectActionType(p);
    const summary = String(p.summary ?? p.command ?? p.tool ?? "").slice(0, 200);

    const insert = db.prepare(`
      INSERT INTO events (timestamp, session_id, action_type, summary, detail_json, tags, enrichment_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const enrichment = actionType === "file" ? enrichFile(p) : {};
    insert.run(
      new Date().toISOString(),
      sessionId,
      actionType,
      summary,
      JSON.stringify(p),
      JSON.stringify((p.tags as string[]) ?? []),
      JSON.stringify(enrichment)
    );
  });

  // Also listen on WS for broader event capture
  connectWs(db, sessionId);

  // Spawn dashboard
  spawnDashboard();

  console.log(`[invariance-audit] Registered. Dashboard: http://localhost:${DASHBOARD_PORT}`);
}
