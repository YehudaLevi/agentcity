// agentcity — the central federation hub.
//
// Merges every contributor's gamified stream into ONE shared city using the SAME
// GamifiedCity as the local server — the only difference is the breadth of the
// input. Each ingest upserts the batch into the store, applies any remote-alias
// rules, and reconciles: established activity APPENDS (only new deltas broadcast),
// a late joiner's historic backlog REFOLDS (a reset the renderer replays). The
// store is append-only (rule 4), so the hub resumes all history on restart and
// out-of-order events re-slot at their calendar day.

import type { CityDelta, CityModel, CityConfig } from "../types.js";
import { GamifiedCity, type IngestResult } from "./city.js";
import { MemoryGamifiedStore, type GamifiedStore } from "./store.js";
import { remapProject, type CompiledRule } from "../federation/mapping.js";
import type { GamifiedBatch, GamifiedEvent } from "./types.js";

export interface HubOpts {
  seed: string;
  rules?: CompiledRule[];
  store?: GamifiedStore;
  config?: Partial<CityConfig>;
}

export interface Hub {
  /** Ingest a contributor batch; reconcile. Returns the broadcast (append vs
   * reset) — or null when nothing changed. */
  ingest(batch: GamifiedBatch): IngestResult | null;
  model(): CityModel;
  /** Full day-ordered timeline (renderer replays this: timelapse/play/scrub). */
  deltas(): CityDelta[];
  /** Distinct contributor count across the store. */
  contributors(): number;
  /** Projects dropped because the world is full (0 in a normal-size scene). */
  dropped(): number;
  /** The shared city as of a shared-calendar `day` (time-travel). */
  cityAt(day: number): CityModel;
}

export function createHub(opts: HubOpts): Hub {
  const store = opts.store ?? new MemoryGamifiedStore();
  const rules = opts.rules ?? [];
  const city = new GamifiedCity(opts.seed, { scene: "shared", config: opts.config });

  const remap = (events: GamifiedEvent[]): GamifiedEvent[] =>
    rules.length ? events.map((e) => ({ ...e, proj: remapProject(e.proj, rules) })) : events;

  // fold whatever the store already holds (persistent restart)
  city.reconcile(store.all());

  return {
    ingest(batch: GamifiedBatch): IngestResult | null {
      if (!batch.events.length) return null;
      const changed = store.upsert(remap(batch.events));
      if (!changed) return null;
      const res = city.reconcile(store.all());
      return res.deltas.length ? res : null; // nothing actually changed -> no broadcast
    },
    model: () => city.model(),
    deltas: () => city.deltas(),
    contributors: () => new Set(store.all().map((e) => e.by)).size,
    dropped: () => city.dropped(),
    cityAt: (day: number) => city.cityAt(day),
  };
}
