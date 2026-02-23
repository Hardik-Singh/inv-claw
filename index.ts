import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import { ensureDb, insertEvent, getEvents, closeDb } from "./db";
import { startServer, stopServer } from "./server";
import type Database from "better-sqlite3";

/* ------------------------------------------------------------------ */
/*  Types — real OpenClaw plugin API                                   */
/* ------------------------------------------------------------------ */

interface HookEvent {
  type: "command" | "session" | "agent" | "gateway" | "message";
  action: string;
  sessionKey: string;
  timestamp: Date;
  messages: string[];
  context: Record<string, unknown>;
}

interface HookMetadata {
  name: string;
  description: string;
}

interface ServiceConfig {
  id: string;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
}

interface CommandContext {
  senderId: string;
  channel: string;
  isAuthorizedSender: boolean;
  args: string;
}

interface CommandConfig {
  name: string;
  description: string;
  acceptsArgs: boolean;
  requireAuth: boolean;
  handler: (ctx: CommandContext) => { text: string };
}

interface PluginConfig {
  dbPath?: string;
  dashboardPort?: number;
  enableDashboard?: boolean;
}

interface OpenClawPluginAPI {
  registerHook(
    event: string,
    handler: (event: HookEvent) => void | Promise<void>,
    metadata: HookMetadata
  ): void;
  registerService(config: ServiceConfig): void;
  registerCommand(config: CommandConfig): void;
  logger: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  config: {
    plugins?: { entries?: Record<string, { config?: PluginConfig }> };
  };
}

/* ------------------------------------------------------------------ */
/*  Action type detection                                              */
/* ------------------------------------------------------------------ */

function detectActionType(event: HookEvent): string {
  if (event.type === "message") return "message";
  if (event.type === "command") return "exec";
  if (event.type === "agent") return "exec";
  if (event.type === "gateway") return "exec";

  const ctx = event.context;
  const cmd = String(
    ctx.command ?? ctx.tool ?? ctx.type ?? ""
  ).toLowerCase();
  if (/read|write|edit|glob|file|mkdir|rm/.test(cmd)) return "file";
  if (/email|smtp|send_?mail/.test(cmd)) return "email";
  if (/fetch|http|curl|browse|web|url|navigate/.test(cmd)) return "web";
  if (/exec|bash|shell|run|spawn/.test(cmd)) return "exec";
  if (/llm|claude|gpt|openai|anthropic|completion/.test(cmd)) return "llm";

  return "unknown";
}

/* ------------------------------------------------------------------ */
/*  Enrichment helpers                                                 */
/* ------------------------------------------------------------------ */

/** Read file contents for file actions. */
function enrichFile(ctx: Record<string, unknown>): Record<string, unknown> {
  const filePath = String(ctx.path ?? ctx.file_path ?? ctx.filename ?? "");
  if (!filePath) return {};
  try {
    const stat = fs.statSync(filePath);
    const content =
      stat.size < 50_000
        ? fs.readFileSync(filePath, "utf-8")
        : `[file too large: ${stat.size} bytes]`;
    return {
      file_path: filePath,
      file_size: stat.size,
      content_preview: content.slice(0, 2000),
    };
  } catch {
    return { file_path: filePath, error: "could not read file" };
  }
}

/** Re-fetch URL for web actions. */
function enrichWeb(
  ctx: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const url = String(ctx.url ?? ctx.href ?? "");
  if (!url) return Promise.resolve({});
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () =>
        resolve({
          url,
          status: res.statusCode,
          body_preview: body.slice(0, 2000),
        })
      );
    });
    req.on("error", () => resolve({ url, error: "fetch failed" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ url, error: "timeout" });
    });
  });
}

/** Extract email fields from params. */
function enrichEmail(ctx: Record<string, unknown>): Record<string, unknown> {
  return {
    to: ctx.to ?? ctx.recipient ?? "",
    from: ctx.from ?? ctx.sender ?? "",
    subject: ctx.subject ?? "",
    body_preview: String(ctx.body ?? ctx.text ?? ctx.content ?? "").slice(
      0,
      2000
    ),
  };
}

/** Extract message fields from OpenClaw message event context. */
function enrichMessage(event: HookEvent): Record<string, unknown> {
  const ctx = event.context;
  return {
    from: ctx.from ?? "",
    to: ctx.to ?? "",
    content: String(ctx.content ?? "").slice(0, 2000),
    channel: ctx.channelId ?? "",
    messageId: ctx.messageId ?? "",
    success: ctx.success,
  };
}

/* ------------------------------------------------------------------ */
/*  Event handler factory                                              */
/* ------------------------------------------------------------------ */

function createHandler(db: Database.Database) {
  return async (event: HookEvent): Promise<void> => {
    const actionType = detectActionType(event);
    const ctx = event.context;

    // Build summary
    let summary = "";
    if (event.type === "message" && event.action === "received") {
      summary = `${String(ctx.channelId ?? "?")} <- ${String(ctx.from ?? "unknown").slice(0, 40)}`;
    } else if (event.type === "message" && event.action === "sent") {
      summary = `${String(ctx.channelId ?? "?")} -> ${String(ctx.to ?? "unknown").slice(0, 40)}`;
    } else if (event.type === "command") {
      summary = `/${event.action}`;
    } else {
      summary = String(
        ctx.summary ?? ctx.command ?? ctx.tool ?? event.action ?? ""
      ).slice(0, 200);
    }

    // Enrich based on action type
    let enrichment: Record<string, unknown> = {};
    if (actionType === "file") enrichment = enrichFile(ctx);
    if (actionType === "web") enrichment = await enrichWeb(ctx);
    if (actionType === "email") enrichment = enrichEmail(ctx);
    if (actionType === "message") enrichment = enrichMessage(event);

    insertEvent(db, {
      timestamp: event.timestamp.toISOString(),
      session_id: event.sessionKey,
      action_type: actionType,
      summary,
      detail_json: JSON.stringify(ctx),
      tags: JSON.stringify([]),
      enrichment_json: JSON.stringify(enrichment),
    });
  };
}

/* ------------------------------------------------------------------ */
/*  Plugin entry — real OpenClaw plugin API                            */
/* ------------------------------------------------------------------ */

export default {
  id: "inv-claw",
  name: "Inv-Claw Audit",

  register(api: OpenClawPluginAPI): void {
    const pluginConfig =
      api.config?.plugins?.entries?.["inv-claw"]?.config ?? {};
    const dbPath = pluginConfig.dbPath;
    const dashboardPort = pluginConfig.dashboardPort ?? 7749;
    const enableDashboard = pluginConfig.enableDashboard ?? true;

    const db = ensureDb(dbPath);
    const handler = createHandler(db);

    // Hook: inbound messages (full content in context)
    api.registerHook("message:received", handler, {
      name: "inv-claw.msg-in",
      description: "Log inbound messages to audit trail",
    });

    // Hook: outbound messages (full content in context)
    api.registerHook("message:sent", handler, {
      name: "inv-claw.msg-out",
      description: "Log outbound messages to audit trail",
    });

    // Hook: all command events (new, reset, stop)
    api.registerHook("command", handler, {
      name: "inv-claw.command",
      description: "Log session commands to audit trail",
    });

    // Hook: agent bootstrap
    api.registerHook("agent:bootstrap", handler, {
      name: "inv-claw.bootstrap",
      description: "Log agent bootstrap events",
    });

    // Hook: gateway startup
    api.registerHook("gateway:startup", handler, {
      name: "inv-claw.startup",
      description: "Log gateway startup",
    });

    // Service: dashboard lifecycle
    if (enableDashboard) {
      api.registerService({
        id: "inv-claw-dashboard",
        start: () => startServer(dashboardPort, dbPath),
        stop: async () => {
          await stopServer();
          closeDb();
        },
      });
    }

    // Slash command: /audit [count]
    api.registerCommand({
      name: "audit",
      description: "Show recent audit events",
      acceptsArgs: true,
      requireAuth: true,
      handler: (ctx: CommandContext) => {
        const limit = ctx.args ? parseInt(ctx.args, 10) || 5 : 5;
        const events = getEvents(db, { limit });
        if (events.length === 0) {
          return { text: "No audit events recorded yet." };
        }
        const lines = events.map(
          (e) => `[${e.action_type}] ${e.summary} (${e.timestamp})`
        );
        return {
          text: `Last ${events.length} audit events:\n${lines.join("\n")}`,
        };
      },
    });

    api.logger.info(
      `[inv-claw] Registered. Dashboard: http://localhost:${dashboardPort}`
    );
  },
};
