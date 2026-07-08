// agentcity — the founding flow (wave 2). Turns raw agent activity into a
// served, persistent city and keeps it live:
//
//   FOUND (no checkpoint in root): ingest claude-history + pixelagents logs,
//     merge+sort, archive the raw events (rule 4: never pruned), full fold,
//     write checkpoint + deltas.jsonl + config, hand back the founding bundle.
//   INCREMENTAL (checkpoint present): ingest only events strictly after the
//     checkpoint's upToTs, archive them, foldIncremental, append the new
//     deltas, update the checkpoint, hand back {model, full delta log}.
//   POLL: one incremental step on demand (the server calls this on a timer);
//     returns just the newly-produced deltas so the server can push them.
//
// Everything is injectable (sources, seed, clock-free) so tests never read a
// real home dir or hit the network.

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PixelEvent, CityConfig, Checkpoint, CityModel, CityDelta } from "./types.js";
import { fold, foldIncremental } from "./compiler.js";
import { parseClaudeHistory } from "./ingest/claude-history.js";
import { parsePixelagentsLog } from "./ingest/pixelagents-log.js";
import {
  readCheckpoint,
  writeCheckpoint,
  appendDeltas,
  readDeltas,
  archiveEvents,
  readArchive,
  readConfig,
  writeConfig,
  paths,
} from "./persist.js";
import { deriveSeed } from "./seed.js";

export interface Sources {
  /** claude-code transcripts dir (default ~/.claude/projects). */
  historyDir: string;
  /** pixelagents log dir (default ~/.pixelagents). */
  pixelagentsDir: string;
}

export function defaultSources(): Sources {
  return {
    historyDir: join(homedir(), ".claude", "projects"),
    pixelagentsDir: join(homedir(), ".pixelagents"),
  };
}

/** Merge both ingest sources into one ts-sorted stream (tolerant of absent dirs). */
export function ingestSources(sources: Sources): PixelEvent[] {
  const events: PixelEvent[] = [];
  events.push(...parseClaudeHistory(sources.historyDir));
  events.push(...parsePixelagentsLog(sources.pixelagentsDir));
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return events;
}

/** Resolve the persistent seed: config wins, then an explicit override, else a
 * machine+user derived stable seed. Persisted on found so resumes never drift. */
function resolveSeed(root: string, override?: string): string {
  const cfg = readConfig(root);
  if (cfg.seed) return cfg.seed;
  if (override) return override;
  // deriveSeed is deterministic given machine+user; keep it out of the compiler
  // (rule 2) — it only picks WHICH deterministic city, never mutates the fold.
  return deriveSeed(process.env.AGENTCITY_MACHINE ?? "agentcity", process.env.USER ?? "user");
}

export interface BootResult {
  founded: boolean; // true if this boot founded a fresh city
  model: CityModel;
  deltas: CityDelta[]; // FULL delta log (timelapse source for the served bundle)
  checkpoint: Checkpoint;
  upToTs: string;
}

export interface FoundOptions {
  seed?: string; // explicit override (CLI --seed); config.seed still wins
  config?: Partial<CityConfig>;
}

/** Full fold from an explicit event list. Archives, writes checkpoint + deltas
 * + config. Shared by found() and the --demo path (which supplies demo events). */
export function foundFromEvents(
  root: string,
  events: PixelEvent[],
  seed: string,
  config: Partial<CityConfig> = {}
): BootResult {
  const sorted = events.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const result = fold(sorted, seed, config);
  archiveEvents(root, sorted);
  writeCheckpoint(root, result.checkpoint);
  // fresh deltas.jsonl: replace any stale log with this fold's COMMITTED stream.
  // The still-open day (re-derived on every resume) is served live via the model
  // but not persisted, so a later poll appends its final deltas exactly once.
  writeDeltaLog(root, committedDeltas(result));
  writeConfig(root, {
    seed,
    historyInfluence: config.historyInfluence ?? "full",
    aliases: config.aliases ?? {},
  });
  return {
    founded: true,
    model: result.model,
    deltas: result.deltas,
    checkpoint: result.checkpoint,
    upToTs: result.checkpoint.upToTs,
  };
}

/** Found a brand-new city by ingesting the live sources. */
export function found(root: string, sources: Sources, opts: FoundOptions = {}): BootResult {
  const seed = resolveSeed(root, opts.seed);
  return foundFromEvents(root, ingestSources(sources), seed, opts.config);
}

/**
 * Resume an existing city: ingest only events strictly after the checkpoint's
 * upToTs, archive+fold them, append deltas, update the checkpoint. Byte-identical
 * to a full fold over all events (compiler guarantees incremental ≡ full).
 * Returns the full delta log for the served bundle.
 */
export function incremental(
  root: string,
  cp: Checkpoint,
  sources: Sources,
  opts: FoundOptions = {}
): BootResult {
  const seed = cp.seed;
  const newEvents = ingestSources(sources).filter((e) => e.ts > cp.upToTs);
  if (!newEvents.length) {
    // nothing new — serve the persisted state verbatim.
    return {
      founded: false,
      model: cp.model,
      deltas: readDeltas(root),
      checkpoint: cp,
      upToTs: cp.upToTs,
    };
  }
  const result = foldIncremental(cp, newEvents, opts.config);
  archiveEvents(root, newEvents);
  // Persist only days that just became COMPLETE (> the previous committed
  // frontier, ≤ the new one). The open day is re-derived, so it is never
  // appended; it reaches the log once a later fold completes it.
  appendDeltas(root, newlyCommittedDeltas(cp, result));
  writeCheckpoint(root, result.checkpoint);
  void seed; // seed is fixed by the checkpoint; resolveSeed not consulted on resume
  return {
    founded: false,
    model: result.model,
    // full served stream: persisted committed history + this fold's open day.
    deltas: [...readDeltas(root), ...openDayDeltas(result)],
    checkpoint: result.checkpoint,
    upToTs: result.checkpoint.upToTs,
  };
}

/** Boot: found if no checkpoint, else incremental. The one call the CLI makes. */
export function boot(root: string, sources: Sources, opts: FoundOptions = {}): BootResult {
  const cp = readCheckpoint(root);
  if (!cp) return found(root, sources, opts);
  return incremental(root, cp, sources, opts);
}

export interface PollResult {
  model: CityModel;
  newDeltas: CityDelta[];
  checkpoint: Checkpoint;
}

/**
 * One incremental step for the background live loop. Reads the current
 * checkpoint, folds any events newer than it, persists, and returns ONLY the
 * newly-produced deltas (so the server can push them over SSE). Returns null
 * when there is nothing new or no checkpoint yet.
 */
export function poll(root: string, sources: Sources, opts: FoundOptions = {}): PollResult | null {
  const cp = readCheckpoint(root);
  if (!cp) return null;
  const newEvents = ingestSources(sources).filter((e) => e.ts > cp.upToTs);
  if (!newEvents.length) return null;
  const result = foldIncremental(cp, newEvents, opts.config);
  archiveEvents(root, newEvents);
  appendDeltas(root, newlyCommittedDeltas(cp, result));
  writeCheckpoint(root, result.checkpoint);
  // Push everything past the previous committed frontier to SSE clients: the
  // days that just finalized plus the live (still-open) day.
  const newDeltas = result.deltas.filter((d) => d.day > cp.state.day);
  return { model: result.model, newDeltas, checkpoint: result.checkpoint };
}

// ============================ delta partitioning (open vs committed) ============================
//
// A fold commits only COMPLETE days into checkpoint.state (state.day = openDay-1)
// and re-derives the open day from checkpoint.pending on every resume. These
// helpers split a fold's delta stream accordingly so the append-only log never
// duplicates the re-derived open day.

/** Deltas for days already committed in this result (day ≤ state.day). */
function committedDeltas(result: { deltas: CityDelta[]; checkpoint: Checkpoint }): CityDelta[] {
  const frontier = result.checkpoint.state.day;
  return result.deltas.filter((d) => d.day <= frontier);
}

/** Deltas for days that became complete in THIS fold (prevFrontier < day ≤ new). */
function newlyCommittedDeltas(
  prev: Checkpoint,
  result: { deltas: CityDelta[]; checkpoint: Checkpoint }
): CityDelta[] {
  const frontier = result.checkpoint.state.day;
  return result.deltas.filter((d) => d.day > prev.state.day && d.day <= frontier);
}

/** Deltas for the still-open day (day > state.day) — served live, never persisted. */
function openDayDeltas(result: { deltas: CityDelta[]; checkpoint: Checkpoint }): CityDelta[] {
  const frontier = result.checkpoint.state.day;
  return result.deltas.filter((d) => d.day > frontier);
}

/**
 * Re-found from the permanent archives + current sources (rule 4: the city is
 * re-derivable forever). Callers must wipe the checkpoint/deltas first (see the
 * CLI `refound` command); this rebuilds the full fold and rewrites both.
 */
export function refound(root: string, sources: Sources, opts: FoundOptions = {}): BootResult {
  const archived = readArchive(root);
  const live = ingestSources(sources);
  // de-dupe by identity (archive already holds previously-ingested live events).
  const seen = new Set<string>();
  const merged: PixelEvent[] = [];
  for (const e of [...archived, ...live]) {
    const k = `${e.ts}|${e.session}|${e.kind}|${e.repo}|${e.tool ?? ""}|${e.detail ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(e);
  }
  const seed = resolveSeed(root, opts.seed);
  return foundFromEvents(root, merged, seed, opts.config);
}

// deltas.jsonl is normally append-only (persist.appendDeltas). A fresh full
// fold (found / refound) must REPLACE it, not append onto a stale log — do that
// via the same atomic tmp+rename persist uses, kept local to avoid widening
// persist's API surface for other waves.
function writeDeltaLog(root: string, deltas: CityDelta[]): void {
  const file = paths(root).deltas;
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = deltas.map((d) => JSON.stringify(d)).join("\n") + (deltas.length ? "\n" : "");
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}
