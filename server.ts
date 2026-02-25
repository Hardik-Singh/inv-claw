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

  // Tool categories for UI display
  const TOOL_CATEGORIES: Record<string, string> = {
    // Files
    read: 'file', write: 'file', edit: 'file', glob: 'file',
    // System 
    exec: 'exec', bash: 'exec', rm: 'exec', rmdir: 'exec',
    // Web
    web_fetch: 'web', http: 'web', fetch: 'web', web_search: 'web',
    // Browser
    browser: 'browser', scrape: 'browser', crawl: 'browser',
    // Messaging
    message: 'message', send: 'message',
    telegram: 'message', discord: 'message', slack: 'message', whatsapp: 'message',
    // AI/LLM
    llm: 'llm', model: 'llm', anthropic: 'llm', openai: 'llm',
    // Email
    email: 'email', mail: 'email', gmail: 'email', smtp: 'email', imap: 'email',
    // Memory/Storage
    memory: 'memory', recall: 'memory', memory_search: 'memory',
    // Sessions
    session: 'session', sessions_list: 'session', sessions_history: 'session', sessions_send: 'session',
    // Subagents
    subagent: 'subagent', subagents: 'subagent', spawn: 'subagent',
    // Devices
    nodes: 'nodes', camera: 'nodes', screen: 'nodes', location: 'nodes',
    // Other
    cron: 'cron', gateway: 'gateway', tts: 'tts', canvas: 'canvas', image: 'image',
    agent: 'agent', agents_list: 'agent',
  };

  // Noise filtering config - opt-in model
  const noiseConfig = {
    // Default: only file operations enabled
    enabledTools: ['read', 'write', 'edit', 'glob'],
    excludedPatterns: ['HEARTBEAT', 'heartbeat_poll', 'cron_poll'],
    dedupWindowMs: 5000,
  };

  function isToolEnabled(toolName: string): boolean {
    const tool = (toolName || '').toLowerCase();
    // Check exact match
    if (noiseConfig.enabledTools.includes(tool)) return true;
    // Check category
    const category = TOOL_CATEGORIES[tool];
    if (category && noiseConfig.enabledTools.includes(category)) return true;
    return false;
  }

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

  function shouldExclude(toolName: string, actionType: string, summary: string): boolean {
    // Opt-in model: exclude if neither tool nor action type is enabled
    if (!isToolEnabled(toolName) && !isToolEnabled(actionType)) return true;
    
    // Also exclude patterns in summary
    for (const pattern of noiseConfig.excludedPatterns) {
      if (summary.includes(pattern)) return true;
    }
    return false;
  }

  // API: update noise config
  app.post("/api/config/noise", async (req) => {
    const body = (req.body as Record<string, any>) || {};
    if (body.enabledTools) noiseConfig.enabledTools = body.enabledTools;
    if (body.excludedPatterns) noiseConfig.excludedPatterns = body.excludedPatterns;
    if (body.dedupWindowMs) noiseConfig.dedupWindowMs = body.dedupWindowMs;
    return { ok: true, config: noiseConfig, categories: Object.keys(TOOL_CATEGORIES) };
  });

  // API: get noise config
  app.get("/api/config/noise", async () => {
    return { ...noiseConfig, categories: Object.keys(TOOL_CATEGORIES) };
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
              
              // Get tool call ID for deduplication
              const toolCallId = msg.content?.[0]?.id || msg.toolCallId;
              
              // Assistant tool calls - these have the params
              if (msg.role === 'assistant' && msg.content) {
                for (const block of msg.content) {
                  if (block.type === 'toolCall' && block.name) {
                    const toolName = block.name;
                    const params = block.arguments;
                    const actionType = getActionType(toolName);
                    // Params can be a string or object - parse if string
                    const parsedParams = typeof params === 'string' ? JSON.parse(params || '{}') : (params || {});
                    
                    // Detect rm/rmdir in exec commands - treat as file operation
                    let finalActionType = actionType;
                    let fileOperation = null;
                    if (toolName === 'exec' && parsedParams?.command) {
                      const cmd = String(parsedParams.command);
                      if (cmd.startsWith('rm ') || cmd.startsWith('rm -') || cmd === 'rm' ||
                          cmd.startsWith('rmdir ') || cmd.startsWith('rmdir -') || cmd === 'rmdir') {
                        finalActionType = 'file';
                        const parts = cmd.split(/\s+/);
                        const idx = parts[0] === 'rm' || parts[0] === 'rmdir' ? 1 : 2;
                        if (parts[idx]) {
                          fileOperation = { type: 'delete', path: parts[idx] };
                        }
                      }
                    }
                    
                    const summary = `${toolName}: ${JSON.stringify(parsedParams || {}).slice(0, 80)}`;
                    
                    // Noise filter: check final action type so rm works if file is enabled
                    if (shouldExclude(toolName, finalActionType, summary)) continue;
                    // Skip duplicates based on tool call ID
                    if (toolCallId && recentEvents.has('call:' + toolCallId)) continue;
                    if (toolCallId) recentEvents.set('call:' + toolCallId, Date.now());
                    
                    // Extract file-specific enrichment
                    let enrichment: Record<string, any> = { tool: toolName, type: finalActionType };
                    if (toolName === 'write' && parsedParams?.content) {
                      enrichment.fileContent = String(parsedParams.content).slice(0, 2000);
                      enrichment.filePath = parsedParams.path || parsedParams.file_path;
                    } else if (toolName === 'edit' && parsedParams?.newText) {
                      enrichment.oldText = String(parsedParams.oldText || '').slice(0, 500);
                      enrichment.newText = String(parsedParams.newText).slice(0, 500);
                      enrichment.filePath = parsedParams.path || parsedParams.file_path;
                    } else if (toolName === 'read' && parsedParams?.path) {
                      enrichment.filePath = parsedParams.path;
                    } else if (fileOperation) {
                      enrichment.filePath = fileOperation.path;
                      enrichment.operation = fileOperation.type;
                    }
                    
                    const { insertEvent } = require('./db');
                    insertEvent(db, {
                      timestamp: entry.timestamp || new Date().toISOString(),
                      session_id: sessionId,
                      action_type: finalActionType,
                      summary: summary,
                      detail_json: JSON.stringify({ toolName, params: parsedParams, source: 'transcript' }),
                      tags: '["synced", "call"]',
                      enrichment_json: JSON.stringify(enrichment)
                    });
                    synced++;
                  }
                }
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
              
              // Assistant tool calls - these have the params
              if (msg.role === 'assistant' && msg.content) {
                for (const block of msg.content) {
                  if (block.type === 'toolCall' && block.name) {
                    const toolName = block.name;
                    const params = block.arguments;
                    const actionType = getActionType(toolName);
                    
                    // Parse params
                    const parsedParams = typeof params === 'string' ? JSON.parse(params || '{}') : (params || {});
                    
                    // Detect rm/rmdir in exec commands - treat as file operation
                    let finalActionType = actionType;
                    let fileOperation = null;
                    if (toolName === 'exec' && parsedParams?.command) {
                      const cmd = String(parsedParams.command);
                      if (cmd.startsWith('rm ') || cmd.startsWith('rm -') || cmd === 'rm' ||
                          cmd.startsWith('rmdir ') || cmd.startsWith('rmdir -') || cmd === 'rmdir') {
                        finalActionType = 'file';
                        const parts = cmd.split(/\s+/);
                        const idx = parts[0] === 'rm' || parts[0] === 'rmdir' ? 1 : 2;
                        if (parts[idx]) {
                          fileOperation = { type: 'delete', path: parts[idx] };
                        }
                      }
                    }
                    
                    // Extract file-specific enrichment
                    let enrichment: Record<string, any> = { tool: toolName, type: finalActionType };
                    if (toolName === 'write' && parsedParams?.content) {
                      enrichment.fileContent = String(parsedParams.content).slice(0, 2000);
                      enrichment.filePath = parsedParams.path || parsedParams.file_path;
                    } else if (toolName === 'edit' && parsedParams?.newText) {
                      enrichment.oldText = String(parsedParams.oldText || '').slice(0, 500);
                      enrichment.newText = String(parsedParams.newText).slice(0, 500);
                      enrichment.filePath = parsedParams.path || parsedParams.file_path;
                    } else if (toolName === 'read' && parsedParams?.path) {
                      enrichment.filePath = parsedParams.path;
                    } else if (fileOperation) {
                      enrichment.filePath = fileOperation.path;
                      enrichment.operation = fileOperation.type;
                    }
                    
                    const { insertEvent } = require('./db');
                    insertEvent(db, {
                      timestamp: entry.timestamp || new Date().toISOString(),
                      session_id: sessionId,
                      action_type: finalActionType,
                      summary: `${toolName}: ${JSON.stringify(parsedParams || {}).slice(0, 80)}`,
                      detail_json: JSON.stringify({ toolName, params: parsedParams, source: 'auto-sync' }),
                      tags: '["auto-synced", "call"]',
                      enrichment_json: JSON.stringify(enrichment)
                    });
                  }
                }
              }
              
              // Skip tool results - tool calls already captured with params
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
