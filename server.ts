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
      since: q.since || null,
      until: q.until || null,
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

  // Map tool names to action types
  function getActionType(toolName: string): string {
    const tool = (toolName || '').toLowerCase();
    if (tool === 'read' || tool === 'write' || tool === 'edit' || tool === 'glob') return 'file';
    if (tool === 'exec' || tool === 'bash' || tool === 'command') return 'exec';
    if (tool === 'web_fetch' || tool === 'http' || tool === 'fetch') return 'web';
    if (tool === 'browser' || tool === 'scrape' || tool === 'crawl') return 'browser';
    if (tool.includes('email') || tool.includes('mail') || tool.includes('gmail') || tool.includes('smtp')) return 'email';
    if (tool.includes('message') || tool.includes('send') || tool.includes('telegram') || tool.includes('slack')) return 'message';
    if (tool === 'llm' || tool.includes('model') || tool.includes('anthropic') || tool.includes('openai')) return 'llm';
    return 'other';
  }

  // Noise filtering config
  const noiseConfig = {
    excludedTools: ['heartbeat', 'health', 'status', 'ping', 'pong', 'noop', 'null'],
    excludedPatterns: ['HEARTBEAT', 'heartbeat_poll', 'cron_poll'],
    dedupWindowMs: 5000, // dedupe identical events within 5 seconds
  };

  // Track recent events for deduplication
  const recentEvents = new Map<string, number>();
  
  function isDuplicate(toolName: string, params: any, timestamp: string): boolean {
    const hash = JSON.stringify({ tool: toolName, params });
    const ts = new Date(timestamp).getTime();
    
    // Clean old entries
    const now = Date.now();
    for (const [key, time] of recentEvents.entries()) {
      if (now - time > noiseConfig.dedupWindowMs) {
        recentEvents.delete(key);
      }
    }
    
    if (recentEvents.has(hash)) {
      return true;
    }
    recentEvents.set(hash, ts);
    return false;
  }

  function shouldExclude(toolName: string, summary: string): boolean {
    const tool = (toolName || '').toLowerCase();
    // Exclude certain tools
    if (noiseConfig.excludedTools.includes(tool)) return true;
    // Exclude patterns in summary
    for (const pattern of noiseConfig.excludedPatterns) {
      if (summary.includes(pattern)) return true;
    }
    return false;
  }

  // API: update noise config
  app.post("/api/config/noise", async (req) => {
    const body = (req.body as Record<string, any>) || {};
    if (body.excludedTools) noiseConfig.excludedTools = body.excludedTools;
    if (body.excludedPatterns) noiseConfig.excludedPatterns = body.excludedPatterns;
    if (body.dedupWindowMs) noiseConfig.dedupWindowMs = body.dedupWindowMs;
    return { ok: true, config: noiseConfig };
  });

  // API: get noise config
  app.get("/api/config/noise", async () => {
    return noiseConfig;
  });

  // API: sync from session transcripts (workaround for hooks bug)
  app.get("/api/sync", async () => {
    const sessionsDir = path.join(process.env.HOME || '/home/hardiksingh', '.openclaw', 'agents', 'main', 'sessions');
    let synced = 0;
    
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      
      for (const file of files) {
        const filePath = path.join(sessionsDir, file);
        const sessionId = file.replace('.jsonl', '');
        
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.type !== 'message') continue;
              
              const msg = entry.message;
              if (!msg) continue;
              
              // Assistant tool calls
              if (msg.role === 'assistant' && msg.content) {
                for (const block of msg.content) {
                  if (block.type === 'toolCall' && block.name) {
                    const toolName = block.name;
                    const params = block.arguments;
                    const actionType = getActionType(toolName);
                    const summary = `${toolName}: ${JSON.stringify(params || {}).slice(0, 80)}`;
                    
                    // Noise filter: skip excluded tools
                    if (shouldExclude(toolName, summary)) continue;
                    // Noise filter: skip duplicates
                    if (isDuplicate(toolName, params, entry.timestamp)) continue;
                    
                    // Extract file-specific enrichment
                    let enrichment: Record<string, any> = { tool: toolName, type: actionType };
                    if (toolName === 'write' && params?.content) {
                      enrichment.fileContent = String(params.content).slice(0, 2000);
                      enrichment.filePath = params.path || params.file_path;
                    } else if (toolName === 'edit' && params?.newText) {
                      enrichment.oldText = String(params.oldText || '').slice(0, 500);
                      enrichment.newText = String(params.newText).slice(0, 500);
                      enrichment.filePath = params.path || params.file_path;
                    } else if (toolName === 'read' && params?.path) {
                      enrichment.filePath = params.path;
                    }
                    
                    const { insertEvent } = require('./db');
                    insertEvent(db, {
                      timestamp: entry.timestamp || new Date().toISOString(),
                      session_id: sessionId,
                      action_type: actionType,
                      summary: summary,
                      detail_json: JSON.stringify({ toolName, params, source: 'transcript' }),
                      tags: '["synced"]',
                      enrichment_json: JSON.stringify(enrichment)
                    });
                    synced++;
                  }
                }
              }
              
              // Tool results (contains actual content like emails)
              if (msg.role === 'toolResult' && msg.toolName) {
                const toolName = msg.toolName;
                const result = msg.content;
                const actionType = getActionType(toolName);
                
                // Extract content from tool result
                let contentPreview = '';
                if (Array.isArray(result)) {
                  contentPreview = result.map((r: any) => r.text || r.content || '').join(' ').slice(0, 500);
                } else if (typeof result === 'string') {
                  contentPreview = result.slice(0, 500);
                }
                
                const summary = `${toolName}: ${contentPreview.slice(0, 80)}`;
                
                // Noise filter
                if (shouldExclude(toolName, summary)) continue;
                
                const { insertEvent } = require('./db');
                insertEvent(db, {
                  timestamp: entry.timestamp || new Date().toISOString(),
                  session_id: sessionId,
                  action_type: actionType,
                  summary: summary,
                  detail_json: JSON.stringify({ toolName, result, source: 'transcript' }),
                  tags: '["synced", "result"]',
                  enrichment_json: JSON.stringify({ tool: toolName, type: actionType, preview: contentPreview })
                });
                synced++;
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
    }
    
    return { synced };
  });

  // Auto-sync every 10 seconds (workaround for hooks bug)
  setInterval(() => {
    try {
      const sessionsDir = path.join(process.env.HOME || '/home/hardiksingh', '.openclaw', 'agents', 'main', 'sessions');
      if (!fs.existsSync(sessionsDir)) return;
      
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const filePath = path.join(sessionsDir, file);
        const sessionId = file.replace('.jsonl', '');
        
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim());
          
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.type !== 'message') continue;
              const msg = entry.message;
              if (!msg) continue;
              
              // Assistant tool calls
              if (msg.role === 'assistant' && msg.content) {
                for (const block of msg.content) {
                  if (block.type === 'toolCall' && block.name) {
                    const toolName = block.name;
                    const params = block.arguments;
                    const actionType = getActionType(toolName);
                    
                    const { insertEvent } = require('./db');
                    insertEvent(db, {
                      timestamp: entry.timestamp || new Date().toISOString(),
                      session_id: sessionId,
                      action_type: actionType,
                      summary: `${toolName}: ${JSON.stringify(params || {}).slice(0, 80)}`,
                      detail_json: JSON.stringify({ toolName, params, source: 'auto-sync' }),
                      tags: '["auto-synced"]',
                      enrichment_json: JSON.stringify({ tool: toolName, type: actionType })
                    });
                  }
                }
              }
              
              // Tool results (contains actual content like emails, web fetches)
              if (msg.role === 'toolResult' && msg.toolName) {
                const toolName = msg.toolName;
                const result = msg.content;
                const actionType = getActionType(toolName);
                
                let contentPreview = '';
                if (Array.isArray(result)) {
                  contentPreview = result.map((r: any) => r.text || r.content || '').join(' ').slice(0, 500);
                } else if (typeof result === 'string') {
                  contentPreview = result.slice(0, 500);
                }
                
                const { insertEvent } = require('./db');
                insertEvent(db, {
                  timestamp: entry.timestamp || new Date().toISOString(),
                  session_id: sessionId,
                  action_type: actionType,
                  summary: `${toolName}: ${contentPreview.slice(0, 80)}`,
                  detail_json: JSON.stringify({ toolName, result, source: 'auto-sync' }),
                  tags: '["auto-synced", "result"]',
                  enrichment_json: JSON.stringify({ tool: toolName, type: actionType, preview: contentPreview })
                });
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
    } catch (e) {}
  }, 10000);

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
