// agentcity — persistence (Contract 4). Layout under a root (default
// ~/.agentcity, injectable so tests never touch the real dir):
//
//   checkpoint.json                  {version, seed, upToTs, model, state} atomic
//   deltas.jsonl                     append-only delta log (timelapse source)
//   archive/events-YYYY-MM.jsonl.gz  ingested raw events (NEVER pruned)
//   album/                           card PNGs (created lazily)
//   config.json                      {seed?, historyInfluence, aliases}
//
// AGENTS.md rule 4: archive, never prune — the city stays re-derivable forever.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { stableStringify } from "./types.js";
import type { Checkpoint, CityConfig, CityDelta, PixelEvent } from "./types.js";

export function defaultRoot(): string {
  return join(homedir(), ".agentcity");
}

export interface Paths {
  root: string;
  checkpoint: string;
  deltas: string;
  archiveDir: string;
  albumDir: string;
  config: string;
}

export function paths(root: string): Paths {
  return {
    root,
    checkpoint: join(root, "checkpoint.json"),
    deltas: join(root, "deltas.jsonl"),
    archiveDir: join(root, "archive"),
    albumDir: join(root, "album"),
    config: join(root, "config.json"),
  };
}

export function ensureLayout(root: string): Paths {
  const p = paths(root);
  for (const dir of [p.root, p.archiveDir, p.albumDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return p;
}

function atomicWrite(file: string, data: string | Buffer): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

// ============================ checkpoint ============================

export function writeCheckpoint(root: string, cp: Checkpoint): void {
  ensureLayout(root);
  atomicWrite(paths(root).checkpoint, stableStringify(cp));
}

export function readCheckpoint(root: string): Checkpoint | null {
  const file = paths(root).checkpoint;
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Checkpoint;
  } catch {
    return null;
  }
}

// ============================ deltas ============================

export function appendDeltas(root: string, deltas: CityDelta[]): void {
  if (!deltas.length) return;
  ensureLayout(root);
  const lines = deltas.map((d) => JSON.stringify(d)).join("\n") + "\n";
  const file = paths(root).deltas;
  // append (create if missing)
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  atomicWrite(file, prev + lines);
}

export function readDeltas(root: string): CityDelta[] {
  const file = paths(root).deltas;
  if (!existsSync(file)) return [];
  const out: CityDelta[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as CityDelta);
    } catch {
      /* tolerate */
    }
  }
  return out;
}

// ============================ event archive (monthly gz, never pruned) ============================

function monthOf(ts: string): string {
  return ts.slice(0, 7); // YYYY-MM
}

export function archiveEvents(root: string, events: PixelEvent[]): void {
  if (!events.length) return;
  const p = ensureLayout(root);
  const byMonth = new Map<string, PixelEvent[]>();
  for (const ev of events) {
    const m = monthOf(ev.ts);
    const arr = byMonth.get(m) ?? [];
    arr.push(ev);
    byMonth.set(m, arr);
  }
  for (const [month, evs] of byMonth) {
    const file = join(p.archiveDir, `events-${month}.jsonl.gz`);
    let existing = "";
    if (existsSync(file)) {
      try {
        existing = gunzipSync(readFileSync(file)).toString("utf8");
      } catch {
        existing = "";
      }
    }
    const merged = existing + evs.map((e) => JSON.stringify(e)).join("\n") + "\n";
    atomicWrite(file, gzipSync(Buffer.from(merged, "utf8")));
  }
}

export function readArchive(root: string): PixelEvent[] {
  const p = paths(root);
  const out: PixelEvent[] = [];
  if (!existsSync(p.archiveDir)) return out;
  for (const name of readdirSync(p.archiveDir).sort()) {
    if (!name.endsWith(".jsonl.gz")) continue;
    try {
      const text = gunzipSync(readFileSync(join(p.archiveDir, name))).toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (t) out.push(JSON.parse(t) as PixelEvent);
      }
    } catch {
      /* tolerate corrupt archive */
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

// ============================ config ============================

const DEFAULT_CONFIG: CityConfig = { historyInfluence: "full", aliases: {} };

export function writeConfig(root: string, config: CityConfig): void {
  ensureLayout(root);
  atomicWrite(paths(root).config, stableStringify(config));
}

export function readConfig(root: string): CityConfig {
  const file = paths(root).config;
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<CityConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
