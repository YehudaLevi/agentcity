// agentcity — ingest Claude Code transcripts (~/.claude/projects/**/*.jsonl)
// into PixelEvent[]. Directory is injectable (tests never touch real ~/.claude).
//
// PRIVACY (AGENTS.md rule 3): detail is ONLY ever a file_path or a command's
// first line, truncated to 120 chars. Message text, edit bodies, tool_result
// content, and any other content field NEVER leak into PixelEvent.detail.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { PixelEvent, EventKind } from "../types.js";

const MAX_DETAIL = 120;
const SOURCE = "claude-code";

function truncate(s: string): string {
  const oneLine = s.split(/\r?\n/, 1)[0] ?? "";
  return oneLine.length > MAX_DETAIL ? oneLine.slice(0, MAX_DETAIL) : oneLine;
}

/** Extract a privacy-safe detail from a tool_use input. Only file_path / command. */
function detailFor(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  if (typeof obj.file_path === "string") return truncate(obj.file_path);
  if (typeof obj.notebook_path === "string") return truncate(obj.notebook_path);
  if (typeof obj.command === "string") return truncate(obj.command);
  if (toolName === "Task" && typeof obj.description === "string") return truncate(obj.description);
  return undefined;
}

function* walkJsonl(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkJsonl(full);
    } else if (name.endsWith(".jsonl")) {
      yield full;
    }
  }
}

function repoFromCwd(cwd: string | undefined): string {
  if (!cwd) return "unknown";
  const b = basename(cwd);
  return b || "unknown";
}

interface RawLine {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: {
    role?: string;
    stop_reason?: string | null;
    content?: unknown;
  };
}

/**
 * Parse one transcript file into events. Session id comes from the sessionId
 * field when present, otherwise the file basename.
 */
function parseFile(file: string): PixelEvent[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const fileSession = basename(file).replace(/\.jsonl$/, "");
  const out: PixelEvent[] = [];
  // Task tool_use id -> true, so tool_result for it maps to fork.end.
  const taskIds = new Set<string>();
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let session = fileSession;
  let repo = "unknown";

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: RawLine;
    try {
      raw = JSON.parse(trimmed) as RawLine;
    } catch {
      continue; // tolerate corrupt lines
    }
    const ts = raw.timestamp;
    if (!ts) continue;
    if (raw.sessionId) session = raw.sessionId;
    if (raw.cwd) repo = repoFromCwd(raw.cwd);
    if (!firstTs) firstTs = ts;
    lastTs = ts;

    const push = (kind: EventKind, extra: Partial<PixelEvent> = {}) =>
      out.push({ ts, session, agent: "user", source: SOURCE, cwd: raw.cwd, repo, kind, ...extra });

    const content = raw.message?.content;
    const blocks = Array.isArray(content) ? content : [];

    if (raw.type === "assistant") {
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use" && typeof b.name === "string") {
          const toolName = b.name;
          const id = typeof b.id === "string" ? b.id : "";
          const detail = detailFor(toolName, b.input);
          if (toolName === "Task") {
            if (id) taskIds.add(id);
            push("fork.start", { tool: toolName, detail });
          } else {
            push("tool.pre", { tool: toolName, detail });
          }
        }
      }
      if (raw.message?.stop_reason === "end_turn" || blocks.every((b) => (b as any)?.type === "text")) {
        push("turn.end");
      }
    } else if (raw.type === "user") {
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_result") {
          const useId = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
          if (useId && taskIds.has(useId)) {
            push("fork.end");
          } else {
            push("tool.post");
          }
        }
      }
    }
  }

  // session.start / session.end bracket, using first/last observed ts.
  const bracketed: PixelEvent[] = [];
  if (firstTs) {
    bracketed.push({ ts: firstTs, session, agent: "user", source: SOURCE, repo, kind: "session.start" });
  }
  bracketed.push(...out);
  if (lastTs) {
    bracketed.push({ ts: lastTs, session, agent: "user", source: SOURCE, repo, kind: "session.end" });
  }
  return bracketed;
}

/** Parse all transcripts under `dir` into a ts-sorted PixelEvent[]. */
export function parseClaudeHistory(dir: string): PixelEvent[] {
  const all: PixelEvent[] = [];
  for (const file of walkJsonl(dir)) {
    all.push(...parseFile(file));
  }
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return all;
}
