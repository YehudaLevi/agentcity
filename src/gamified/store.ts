// agentcity — the hub's gamified event store.
//
// Every GamifiedEvent the hub accepts, keyed by (project, contributor, day):
// re-sends of a still-open day UPSERT (gamify re-aggregates a growing day to a
// higher WU — last wins), so at-least-once delivery and open-day resends are
// idempotent. The file is append-only JSONL (rule 4: archived, never pruned);
// the in-memory view collapses to last-wins per key on load. Because the hub
// re-folds the whole day-sorted set, a late joiner's historic backlog lands in
// correct chronological position — time-travel by determinism, not mutation.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { stableStringify } from "../types.js";
import { coerce, factKey, type GamifiedEvent } from "./types.js";

/** Two facts are the same iff every field matches (not just wu/ts) — a changed
 * category/forks/turns must re-fold, not be dropped as a duplicate. */
function sameFact(a: GamifiedEvent, b: GamifiedEvent): boolean {
  return stableStringify(a) === stableStringify(b);
}

export interface GamifiedStore {
  /** Upsert a batch; returns true if anything changed (a new or updated fact). */
  upsert(events: GamifiedEvent[]): boolean;
  /** The deduped set, deterministically ordered (day, then project, then by). */
  all(): GamifiedEvent[];
}

function ordered(map: Map<string, GamifiedEvent>): GamifiedEvent[] {
  return [...map.values()].sort(
    (a, b) => a.day - b.day || (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : factKey(a) < factKey(b) ? -1 : 1)
  );
}

export class MemoryGamifiedStore implements GamifiedStore {
  private byKey = new Map<string, GamifiedEvent>();

  upsert(events: GamifiedEvent[]): boolean {
    let changed = false;
    for (const e of events) {
      const k = factKey(e);
      const prev = this.byKey.get(k);
      if (!prev || !sameFact(prev, e)) {
        this.byKey.set(k, e);
        changed = true;
      }
    }
    return changed;
  }

  all(): GamifiedEvent[] {
    return ordered(this.byKey);
  }
}

export class FileGamifiedStore implements GamifiedStore {
  private byKey = new Map<string, GamifiedEvent>();

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        continue; // tolerate a corrupt line
      }
      const ev = coerce(parsed);
      if (ev) this.byKey.set(factKey(ev), ev); // later lines win (upsert on replay)
    }
  }

  upsert(events: GamifiedEvent[]): boolean {
    const fresh: GamifiedEvent[] = [];
    for (const e of events) {
      const k = factKey(e);
      const prev = this.byKey.get(k);
      if (prev && sameFact(prev, e)) continue; // exact duplicate
      this.byKey.set(k, e);
      fresh.push(e);
    }
    if (!fresh.length) return false;
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.file, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return true;
  }

  all(): GamifiedEvent[] {
    return ordered(this.byKey);
  }
}
