// agentcity — persistence (Contract 4). Layout under a root (default
// ~/.agentcity, injectable so tests never touch the real dir):
//
//   archive/events-YYYY-MM.jsonl.gz  ingested raw events (NEVER pruned) — the
//                                    city is a pure function of these
//   album/                           card PNGs (created lazily)
//   config.json                      {seed?, historyInfluence, aliases, federation?}
//   federation.json                  federation push watermark {ts}
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
import type { CityConfig, PixelEvent } from "./types.js";

export function defaultRoot(): string {
  return join(homedir(), ".agentcity");
}

export interface Paths {
  root: string;
  archiveDir: string;
  albumDir: string;
  config: string;
  federation: string;
}

export function paths(root: string): Paths {
  return {
    root,
    archiveDir: join(root, "archive"),
    albumDir: join(root, "album"),
    config: join(root, "config.json"),
    federation: join(root, "federation.json"),
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

// ============================ federation cursor ============================
// The newest gamified-fact ts already forwarded to the hub, so each poll re-sends
// only the (possibly grown) open day onward (see src/federate.ts). An absolute
// ts (not a day index) so a shifted stream epoch can't renumber it. Structurally
// matches federate's Cursor; kept untyped-of-federation to avoid a layer cycle.

export interface FederationState {
  cursor: { ts: string };
}

const ZERO_CURSOR = { ts: "" };

export function readFederationState(root: string): FederationState {
  const file = paths(root).federation;
  if (!existsSync(file)) return { cursor: { ...ZERO_CURSOR } };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<FederationState>;
    return { cursor: parsed.cursor ?? { ...ZERO_CURSOR } };
  } catch {
    return { cursor: { ...ZERO_CURSOR } };
  }
}

export function writeFederationState(root: string, state: FederationState): void {
  ensureLayout(root);
  atomicWrite(paths(root).federation, stableStringify(state));
}
