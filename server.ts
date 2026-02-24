import Fastify, { FastifyInstance } from "fastify";
import * as fs from "fs";
import * as path from "path";
import {
  ensureDb,
  getEvents,
  getEvent,
  getStats,
  updateTags,
} from "./db";

let app: FastifyInstance | null = null;

const DASHBOARD_HTML = path.join(__dirname, "dashboard", "index.html");

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
    return getEvents(db, {
      limit: q.limit ? parseInt(q.limit, 10) : 200,
      action_type: q.type || null,
      session_id: q.session || null,
      search: q.q || null,
    });
  });

  // API: single event
  app.get<{ Params: { id: string } }>("/api/events/:id", async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      reply.status(400).send({ error: "invalid id" });
      return;
    }
    const ev = getEvent(db, id);
    if (!ev) {
      reply.status(404).send({ error: "not found" });
      return;
    }
    return ev;
  });

  // API: stats
  app.get("/api/stats", async () => {
    return getStats(db);
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
