import Fastify, { FastifyInstance } from "fastify";
import * as fs from "fs";
import * as path from "path";
import {
  ensureDb,
  getEvents,
  getEvent,
  getStats,
  updateTags,
  type AuditEvent,
} from "./db";

let app: FastifyInstance | null = null;

const DASHBOARD_HTML = path.join(__dirname, "dashboard", "index.html");

/** Mock events returned when the DB is empty (demo mode). */
function mockEvents(): AuditEvent[] {
  const now = Date.now();
  const iso = (offset: number) => new Date(now - offset).toISOString();
  return [
    {
      id: 1,
      timestamp: iso(30 * 60_000),
      session_id: "demo-session-001",
      action_type: "file",
      summary: "Read config.yaml",
      detail_json: JSON.stringify({ command: "read", path: "/app/config.yaml" }),
      tags: '["config","startup"]',
      enrichment_json: JSON.stringify({
        file_path: "/app/config.yaml",
        file_size: 1240,
        content_preview: "server:\n  port: 8080\n  host: 0.0.0.0",
      }),
    },
    {
      id: 2,
      timestamp: iso(25 * 60_000),
      session_id: "demo-session-001",
      action_type: "web",
      summary: "Fetch https://api.example.com/data",
      detail_json: JSON.stringify({ command: "fetch", url: "https://api.example.com/data" }),
      tags: '["api"]',
      enrichment_json: JSON.stringify({
        url: "https://api.example.com/data",
        status: 200,
        body_preview: '{"results": []}',
      }),
    },
    {
      id: 3,
      timestamp: iso(20 * 60_000),
      session_id: "demo-session-001",
      action_type: "exec",
      summary: "bash: npm install",
      detail_json: JSON.stringify({ command: "bash", args: "npm install" }),
      tags: '["build"]',
      enrichment_json: "{}",
    },
    {
      id: 4,
      timestamp: iso(15 * 60_000),
      session_id: "demo-session-001",
      action_type: "email",
      summary: "Send report to team@example.com",
      detail_json: JSON.stringify({
        command: "send_email",
        to: "team@example.com",
        subject: "Daily Report",
      }),
      tags: '["report","daily"]',
      enrichment_json: JSON.stringify({
        to: "team@example.com",
        subject: "Daily Report",
        body_preview: "Attached is the daily summary...",
      }),
    },
    {
      id: 5,
      timestamp: iso(10 * 60_000),
      session_id: "demo-session-001",
      action_type: "message",
      summary: "Slack: #engineering — deploy complete",
      detail_json: JSON.stringify({
        command: "slack_send",
        channel: "#engineering",
        text: "Deploy complete",
      }),
      tags: '["slack","deploy"]',
      enrichment_json: JSON.stringify({
        channel: "#engineering",
        text: "Deploy complete",
      }),
    },
    {
      id: 6,
      timestamp: iso(5 * 60_000),
      session_id: "demo-session-001",
      action_type: "llm",
      summary: "claude: summarize PR diff",
      detail_json: JSON.stringify({
        command: "llm_call",
        model: "claude-sonnet-4-6",
        prompt_preview: "Summarize this PR diff...",
      }),
      tags: '["llm","review"]',
      enrichment_json: "{}",
    },
    {
      id: 7,
      timestamp: iso(2 * 60_000),
      session_id: "demo-session-001",
      action_type: "file",
      summary: "Write deploy.log",
      detail_json: JSON.stringify({ command: "write", path: "/var/log/deploy.log" }),
      tags: '["deploy","log"]',
      enrichment_json: JSON.stringify({ file_path: "/var/log/deploy.log", file_size: 4520 }),
    },
  ];
}

export async function startServer(
  port = 7749,
  dbPath?: string
): Promise<void> {
  if (app) return;

  const db = ensureDb(dbPath);

  app = Fastify({ logger: false });

  // CORS
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type");
  });

  app.options("*", async (_req, reply) => {
    reply.status(204).send();
  });

  // Dashboard
  app.get("/", async (_req, reply) => {
    if (fs.existsSync(DASHBOARD_HTML)) {
      const html = fs.readFileSync(DASHBOARD_HTML, "utf-8");
      reply.type("text/html").send(html);
    } else {
      reply.status(404).send({ error: "dashboard/index.html not found" });
    }
  });

  // API: events list
  app.get("/api/events", async (req) => {
    const q = req.query as Record<string, string>;
    let events = getEvents(db, {
      limit: q.limit ? parseInt(q.limit, 10) : 200,
      action_type: q.type || null,
      session_id: q.session || null,
      search: q.q || null,
    });
    if (events.length === 0) events = mockEvents();
    return events;
  });

  // API: single event
  app.get<{ Params: { id: string } }>("/api/events/:id", async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      reply.status(400).send({ error: "invalid id" });
      return;
    }
    const ev = getEvent(db, id);
    if (ev) return ev;
    const mock = mockEvents().find((e) => e.id === id);
    if (mock) return mock;
    reply.status(404).send({ error: "not found" });
  });

  // API: stats
  app.get("/api/stats", async () => {
    const stats = getStats(db);
    if (stats.total === 0) {
      const mock = mockEvents();
      const by_type: Record<string, number> = {};
      for (const e of mock) by_type[e.action_type] = (by_type[e.action_type] || 0) + 1;
      return { total: mock.length, by_type, sessions: 1 };
    }
    return stats;
  });

  // API: update tags
  app.put<{ Params: { id: string }; Body: { tags: string[] } }>(
    "/api/events/:id/tags",
    async (req, reply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        reply.status(400).send({ error: "invalid id" });
        return;
      }
      try {
        updateTags(db, id, req.body.tags ?? []);
        return { ok: true };
      } catch (err) {
        reply.status(400).send({ error: String(err) });
      }
    }
  );

  await app.listen({ host: "127.0.0.1", port });
  console.log(`[inv-claw] Dashboard → http://localhost:${port}`);
}

export async function stopServer(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
  }
}

// Standalone mode
if (require.main === module) {
  const port = parseInt(process.env.INVARIANCE_AUDIT_PORT ?? "7749", 10);
  startServer(port).catch((err) => {
    console.error("[inv-claw] Failed to start:", err);
    process.exit(1);
  });
}
