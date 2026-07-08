// agentcity — ingest Claude Code transcripts (~/.claude/projects/**/*.jsonl)
// into PixelEvent[]. Directory is injectable (tests never touch real ~/.claude).
//
// PRIVACY (AGENTS.md rule 3): detail is ONLY ever a file_path or a command's
// first line, truncated to 120 chars. Message text, edit bodies, tool_result
// content, and any other content field NEVER leak into PixelEvent.detail.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, sep } from "node:path";
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

/**
 * BUG-2 fix (subagent worktrees). A subagent launched with worktree isolation
 * runs with cwd `<repo>/.claude/worktrees/agent-<id>`, so a naive basename would
 * mint a phantom repo "agent-<id>" (its own building) instead of crediting the
 * parent repo. Strip anything from a `.claude/` path segment onward so the repo
 * root is recovered (`.../prom-manager/.claude/worktrees/agent-x` -> `prom-manager`).
 * Returns "" when the cwd yields no usable repo (caller applies a project fallback).
 */
function repoFromCwd(cwd: string | undefined): string {
  if (!cwd) return "";
  const cut = cwd.replace(/[/\\]\.claude[/\\].*$/, "");
  const b = basename(cut || cwd);
  return b;
}

/** Immediate child of `root` on the path to `file` (the Claude "project" dir). */
function projectDirOf(root: string, file: string): string {
  let rel = file.startsWith(root) ? file.slice(root.length) : file;
  while (rel.startsWith(sep)) rel = rel.slice(1);
  const seg = rel.split(sep)[0] ?? "";
  return seg ? join(root, seg) : root;
}

/** First usable (sanitized) repo from any cwd line in a transcript file. */
function firstCwdRepo(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || !t.includes('"cwd"')) continue;
    try {
      const cwd = (JSON.parse(t) as RawLine).cwd;
      const repo = repoFromCwd(cwd);
      if (repo) return repo;
    } catch {
      /* tolerate */
    }
  }
  return "";
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
function parseFile(file: string, fallbackRepo: string): PixelEvent[] {
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
  // Entries lacking a usable cwd (or subagent worktrees, before sanitizing)
  // inherit the parent project's repo — never a phantom "agent-<id>".
  let repo = fallbackRepo || "unknown";

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
    if (raw.cwd) repo = repoFromCwd(raw.cwd) || fallbackRepo || "unknown";
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
  const files = [...walkJsonl(dir)];
  // A "project" dir (immediate child of `dir`) encodes one repo's cwd; all its
  // transcripts — main session AND subagent worktrees — share that repo. Derive
  // a per-project fallback repo (sanitized) so cwd-less / worktree entries are
  // attributed to the parent project instead of becoming phantom "agent-*" lots.
  const fallbackByProject = new Map<string, string>();
  const fallbackFor = (file: string): string => {
    const proj = projectDirOf(dir, file);
    let fb = fallbackByProject.get(proj);
    if (fb === undefined) {
      fb = "";
      for (const f of files) {
        if (projectDirOf(dir, f) !== proj) continue;
        const r = firstCwdRepo(f);
        if (r) {
          fb = r;
          break;
        }
      }
      fallbackByProject.set(proj, fb);
    }
    return fb;
  };

  const all: PixelEvent[] = [];
  for (const file of files) {
    all.push(...parseFile(file, fallbackFor(file)));
  }
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return all;
}
