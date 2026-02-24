import * as fs from "fs";
import { ensureDb, insertEvent, getEvents, closeDb } from "./db";
import { startServer, stopServer } from "./server";
import type Database from "better-sqlite3";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  error?: string;
  durationMs?: number;
  sessionKey?: string;
  timestamp?: Date;
}

interface LLMInputEvent {
  model: string;
  prompt: unknown;
  sessionKey?: string;
  timestamp?: Date;
}

interface LLMOutputEvent {
  model: string;
  response: unknown;
  usage: { inputTokens?: number; outputTokens?: number };
  sessionKey?: string;
  timestamp?: Date;
}

interface MessageEvent {
  from: string;
  to: string;
  content: string;
  sessionKey?: string;
  timestamp?: Date;
}

interface ToolResultPersistEvent {
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  sessionKey?: string;
  timestamp?: Date;
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
    handler: (event: unknown) => void | Promise<void>,
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
/*  Action type from tool name                                         */
/* ------------------------------------------------------------------ */

function toolNameToActionType(toolName: string): string {
  const t = toolName.toLowerCase();
  if (/^(read|write|edit|glob|mkdir|rm|file)/.test(t)) return "file";
  if (/^(email|smtp|send_?mail)/.test(t)) return "email";
  if (/^(web_?fetch|fetch|http|curl|browse|navigate|url)/.test(t)) return "web";
  if (/^(exec|bash|shell|run|spawn)/.test(t)) return "exec";
  if (/^(browser|click|screenshot|form)/.test(t)) return "browser";
  return "tool";
}

/* ------------------------------------------------------------------ */
/*  Enrichment helpers                                                 */
/* ------------------------------------------------------------------ */

function enrichFile(params: Record<string, unknown>): Record<string, unknown> {
  const filePath = String(params.path ?? params.file_path ?? params.filename ?? "");
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

/* ------------------------------------------------------------------ */
/*  Hook handlers                                                      */
/* ------------------------------------------------------------------ */

function defaults(event: { sessionKey?: string; timestamp?: Date }) {
  return {
    ts: (event.timestamp ?? new Date()).toISOString(),
    sid: event.sessionKey ?? "default",
  };
}

function createHandlers(db: Database.Database) {
  /** after_tool_call — captures every tool invocation with full params + result */
  function handleToolCall(event: ToolCallEvent): void {
    const { ts, sid } = defaults(event);
    const actionType = toolNameToActionType(event.toolName);

    let summary = `${event.toolName}`;
    const p = event.params;
    if (p.path || p.file_path) summary += `: ${String(p.path ?? p.file_path)}`;
    else if (p.url) summary += `: ${String(p.url)}`;
    else if (p.command) summary += `: ${String(p.command).slice(0, 120)}`;
    else if (p.action) summary += `: ${String(p.action)}`;

    let enrichment: Record<string, unknown> = {};
    if (actionType === "file") enrichment = enrichFile(p);
    if (actionType === "web") enrichment = { url: p.url, status: (event.result as Record<string, unknown>)?.status };
    if (actionType === "email") {
      enrichment = {
        to: p.to ?? p.recipient ?? "",
        from: p.from ?? p.sender ?? "",
        subject: p.subject ?? "",
        body_preview: String(p.body ?? p.text ?? p.content ?? "").slice(0, 2000),
      };
    }

    insertEvent(db, {
      timestamp: ts,
      session_id: sid,
      action_type: actionType,
      summary: summary.slice(0, 200),
      detail_json: JSON.stringify({
        toolName: event.toolName,
        params: event.params,
        result: typeof event.result === "string" ? event.result.slice(0, 5000) : event.result,
        error: event.error,
        durationMs: event.durationMs,
      }),
      tags: JSON.stringify([]),
      enrichment_json: JSON.stringify(enrichment),
    });
  }

  /** llm_input — captures every LLM call (prompt going out) */
  function handleLLMInput(event: LLMInputEvent): void {
    const { ts, sid } = defaults(event);
    const promptStr = typeof event.prompt === "string"
      ? event.prompt
      : JSON.stringify(event.prompt);

    insertEvent(db, {
      timestamp: ts,
      session_id: sid,
      action_type: "llm",
      summary: `llm_input: ${event.model}`,
      detail_json: JSON.stringify({
        direction: "input",
        model: event.model,
        prompt_preview: promptStr.slice(0, 5000),
      }),
      tags: JSON.stringify([]),
      enrichment_json: JSON.stringify({ model: event.model }),
    });
  }

  /** llm_output — captures every LLM response */
  function handleLLMOutput(event: LLMOutputEvent): void {
    const { ts, sid } = defaults(event);
    const respStr = typeof event.response === "string"
      ? event.response
      : JSON.stringify(event.response);

    insertEvent(db, {
      timestamp: ts,
      session_id: sid,
      action_type: "llm",
      summary: `llm_output: ${event.model} (${event.usage?.inputTokens ?? "?"}in/${event.usage?.outputTokens ?? "?"}out)`,
      detail_json: JSON.stringify({
        direction: "output",
        model: event.model,
        response_preview: respStr.slice(0, 5000),
        usage: event.usage,
      }),
      tags: JSON.stringify([]),
      enrichment_json: JSON.stringify({ model: event.model, usage: event.usage }),
    });
  }

  /** message_received — inbound messages */
  function handleMessageReceived(event: MessageEvent): void {
    const { ts, sid } = defaults(event);
    insertEvent(db, {
      timestamp: ts,
      session_id: sid,
      action_type: "message",
      summary: `msg_in: ${event.from} -> ${event.to}`,
      detail_json: JSON.stringify({
        direction: "received",
        from: event.from,
        to: event.to,
        content: event.content.slice(0, 5000),
      }),
      tags: JSON.stringify([]),
      enrichment_json: JSON.stringify({
        from: event.from,
        to: event.to,
        content_preview: event.content.slice(0, 2000),
      }),
    });
  }

  /** message_sent — outbound messages */
  function handleMessageSent(event: MessageEvent): void {
    const { ts, sid } = defaults(event);
    insertEvent(db, {
      timestamp: ts,
      session_id: sid,
      action_type: "message",
      summary: `msg_out: ${event.from} -> ${event.to}`,
      detail_json: JSON.stringify({
        direction: "sent",
        from: event.from,
        to: event.to,
        content: event.content.slice(0, 5000),
      }),
      tags: JSON.stringify([]),
      enrichment_json: JSON.stringify({
        from: event.from,
        to: event.to,
        content_preview: event.content.slice(0, 2000),
      }),
    });
  }

  /** tool_result_persist — full transcript entry for tool results */
  function handleToolResultPersist(event: ToolResultPersistEvent): void {
    const { ts, sid } = defaults(event);
    insertEvent(db, {
      timestamp: ts,
      session_id: sid,
      action_type: "transcript",
      summary: `persist: ${event.toolName}`,
      detail_json: JSON.stringify({
        toolName: event.toolName,
        params: event.params,
        result: typeof event.result === "string" ? event.result.slice(0, 10000) : event.result,
      }),
      tags: JSON.stringify([]),
      enrichment_json: "{}",
    });
  }

  return {
    handleToolCall,
    handleLLMInput,
    handleLLMOutput,
    handleMessageReceived,
    handleMessageSent,
    handleToolResultPersist,
  };
}

/* ------------------------------------------------------------------ */
/*  Plugin entry                                                       */
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
    const h = createHandlers(db);

    // Tool calls — captures read, write, edit, exec, web_fetch, browser, etc.
    api.registerHook("after_tool_call", h.handleToolCall as (e: unknown) => void, {
      name: "inv-claw.tool-call",
      description: "Log every tool call (file, exec, web, browser, email) to audit trail",
    });

    // LLM calls — prompt going out
    api.registerHook("llm_input", h.handleLLMInput as (e: unknown) => void, {
      name: "inv-claw.llm-input",
      description: "Log LLM prompts to audit trail",
    });

    // LLM calls — response coming back
    api.registerHook("llm_output", h.handleLLMOutput as (e: unknown) => void, {
      name: "inv-claw.llm-output",
      description: "Log LLM responses to audit trail",
    });

    // Messages — inbound
    api.registerHook("message_received", h.handleMessageReceived as (e: unknown) => void, {
      name: "inv-claw.msg-in",
      description: "Log inbound messages to audit trail",
    });

    // Messages — outbound
    api.registerHook("message_sent", h.handleMessageSent as (e: unknown) => void, {
      name: "inv-claw.msg-out",
      description: "Log outbound messages to audit trail",
    });

    // Full transcript persistence
    api.registerHook("tool_result_persist", h.handleToolResultPersist as (e: unknown) => void, {
      name: "inv-claw.persist",
      description: "Log full tool result transcript entries",
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
      `[inv-claw] Registered 6 hooks (after_tool_call, llm_input, llm_output, message_received, message_sent, tool_result_persist). Dashboard: http://localhost:${dashboardPort}`
    );
  },
};
