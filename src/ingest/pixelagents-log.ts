// agentcity — ingest pixelagents logs into PixelEvent[].
// Reads <dir>/events.jsonl and <dir>/archive/*.jsonl.gz (gzip via node zlib).
// pixelagents already emits the shared PixelEvent shape, so lines are parsed
// straight through. Tolerant of corrupt/partial lines (never throws on them).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { PixelEvent, EventKind } from "../types.js";

const KINDS = new Set<EventKind>([
  "session.start",
  "session.end",
  "turn.start",
  "turn.end",
  "tool.pre",
  "tool.post",
  "fork.start",
  "fork.end",
  "waiting.human",
  "waiting.permission",
  "other",
]);

function coerce(obj: unknown): PixelEvent | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.ts !== "string") return null;
  if (typeof o.kind !== "string" || !KINDS.has(o.kind as EventKind)) return null;
  const repo = typeof o.repo === "string" ? o.repo : "unknown";
  const ev: PixelEvent = {
    ts: o.ts,
    session: typeof o.session === "string" ? o.session : "unknown",
    agent: typeof o.agent === "string" ? o.agent : "user",
    source: typeof o.source === "string" ? o.source : "pixelagents",
    repo,
    kind: o.kind as EventKind,
  };
  if (typeof o.cwd === "string") ev.cwd = o.cwd;
  if (typeof o.tool === "string") ev.tool = o.tool;
  if (typeof o.detail === "string") ev.detail = o.detail;
  return ev;
}

function parseLines(text: string, out: PixelEvent[]): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // corrupt line
    }
    const ev = coerce(obj);
    if (ev) out.push(ev);
  }
}

/** Parse pixelagents events.jsonl + archived gz logs into a ts-sorted array. */
export function parsePixelagentsLog(dir: string): PixelEvent[] {
  const out: PixelEvent[] = [];

  // live events.jsonl
  try {
    parseLines(readFileSync(join(dir, "events.jsonl"), "utf8"), out);
  } catch {
    /* absent is fine */
  }

  // archived monthly gz logs
  const archiveDir = join(dir, "archive");
  let names: string[] = [];
  try {
    names = readdirSync(archiveDir).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl.gz")) continue;
    try {
      const buf = gunzipSync(readFileSync(join(archiveDir, name)));
      parseLines(buf.toString("utf8"), out);
    } catch {
      continue; // corrupt archive tolerated
    }
  }

  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}
