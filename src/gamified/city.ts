// agentcity — GamifiedCity: the reconciliation orchestrator over the shared
// gamified stream, shared by local (scene "solo") and the hub (scene "shared").
//
// Reconciliation is DAY-GRANULAR — the day is the unit that actually changes.
// After re-folding the merged stream, it finds the lowest day whose deltas
// differ (`fromDay`) and returns the timeline from there. The renderer applies
// `replaceFrom(fromDay)`: drop deltas dated >= fromDay, splice the new ones,
// re-fold. This one operation subsumes every case:
//   • pure append  → fromDay past the old frontier (nothing dropped);
//   • same-day work → fromDay = today (only today's deltas are replaced);
//   • late join / reorder → fromDay = the earliest touched day (a partial reset).
//
// The event list is the source of truth (rule 4: archived, never pruned); the
// model + timeline are a pure function of it (renderCity), so the result is
// deterministic regardless of arrival order.

import type { CityConfig, CityModel, CityDelta } from "../types.js";
import { renderCity, epochKeyOf, sharedDay, type Scene } from "../compiler.js";
import { stableStringify } from "../types.js";
import type { GamifiedEvent } from "./types.js";

export interface GamifiedCityOpts {
  /** "solo" (local, one founder) or "shared" (hub, merged contributors). */
  scene?: Scene;
  config?: Partial<CityConfig>;
}

/** Every fold ends with one terminal `sync.lots` dated at the current day — a
 * volatile marker that moves as the timeline grows. Strip it before day-diffing
 * so a plain append doesn't look like a change to the old last day. */
function stripTerminalSync(deltas: CityDelta[]): CityDelta[] {
  const last = deltas[deltas.length - 1];
  return last && last.kind === "sync.lots" ? deltas.slice(0, -1) : deltas;
}

/** Group a delta stream by day (deltas within a day keep their emitted order). */
function groupByDay(deltas: CityDelta[]): Map<number, CityDelta[]> {
  const m = new Map<number, CityDelta[]>();
  for (const d of deltas) {
    const a = m.get(d.day) ?? [];
    a.push(d);
    m.set(d.day, a);
  }
  return m;
}

/** The lowest day at which two timelines' (sync-stripped) deltas differ — the
 * reconciliation boundary. Returns (maxDay + 1) when identical. */
function lowestChangedDay(prev: CityDelta[], next: CityDelta[]): number {
  const a = groupByDay(stripTerminalSync(prev));
  const b = groupByDay(stripTerminalSync(next));
  const maxDay = Math.max(-1, ...a.keys(), ...b.keys());
  for (let d = 0; d <= maxDay; d++) {
    if (stableStringify(a.get(d) ?? []) !== stableStringify(b.get(d) ?? [])) return d;
  }
  return maxDay + 1;
}

/** What an ingest produced. `fromDay` is the changed-day boundary and `deltas`
 * is the new timeline from there — the renderer's `replaceFrom` payload. An
 * empty `deltas` (fromDay past the last day) means nothing changed. */
export interface IngestResult {
  model: CityModel;
  fromDay: number;
  deltas: CityDelta[];
}

/** Wrap a reconciliation as the live wire delta the renderer's `replaceFrom`
 * handler consumes. `seq` orders it against other live deltas. */
export function replaceDelta(res: IngestResult, seq: number): CityDelta {
  return { day: res.model.day, seq, kind: "replace", fromDay: res.fromDay, deltas: res.deltas };
}

export class GamifiedCity {
  private events: GamifiedEvent[];
  private _deltas: CityDelta[];
  private _model: CityModel;
  private _dropped: number;
  private readonly scene: Scene;
  private readonly config: Partial<CityConfig>;

  constructor(private readonly seed: string, opts: GamifiedCityOpts = {}, initial: GamifiedEvent[] = []) {
    this.scene = opts.scene ?? "solo";
    this.config = opts.config ?? {};
    this.events = initial.slice();
    const r = renderCity(this.events, seed, { scene: this.scene, config: this.config });
    this._model = r.model;
    this._deltas = r.deltas;
    this._dropped = r.dropped;
  }

  model(): CityModel {
    return this._model;
  }

  /** Projects that couldn't be placed (the world is full) — reported, not lost. */
  dropped(): number {
    return this._dropped;
  }

  /** The full delta timeline (a fresh page load replays this). */
  deltas(): CityDelta[] {
    return this._deltas;
  }

  /** The backing event stream, for persistence (rule 4). */
  all(): GamifiedEvent[] {
    return this.events;
  }

  /** Time-travel: the model as of an explicit shared-calendar day — folds only
   * events up to that day, then advances idle decay through it. */
  cityAt(day: number): CityModel {
    const epochKey = epochKeyOf(this.events);
    const upto = this.events.filter((e) => sharedDay(e.ts, epochKey) <= day);
    return renderCity(upto, this.seed, { scene: this.scene, config: this.config, throughDay: day }).model;
  }

  /** Append a batch (established-client path) and reconcile. */
  ingest(incoming: GamifiedEvent[]): IngestResult {
    if (!incoming.length) return { model: this._model, fromDay: this._model.day + 1, deltas: [] };
    return this.reconcile([...this.events, ...incoming]);
  }

  /**
   * Reconcile against the FULL desired stream (the local server re-gamifies its
   * whole archive and hands it here). Re-folds, then finds the lowest day whose
   * deltas changed and returns the timeline from there — a `replaceFrom(fromDay)`
   * payload. Correct for every case (append / same-day / late-join) because the
   * renderer drops the affected days before splicing, so nothing double-counts.
   */
  reconcile(fullStream: GamifiedEvent[]): IngestResult {
    const prev = this._deltas;
    const r = renderCity(fullStream, this.seed, { scene: this.scene, config: this.config });
    this.events = fullStream.slice();
    this._model = r.model;
    this._deltas = r.deltas;
    this._dropped = r.dropped;
    let fromDay = lowestChangedDay(prev, r.deltas);
    // The terminal sync.lots (WU/decay reconciliation) is stripped from the diff,
    // so if ONLY it changed (WU accrued within a tier), refresh the last day so
    // the update still reaches clients.
    if (fromDay > r.model.day && stableStringify(prev[prev.length - 1]) !== stableStringify(r.deltas[r.deltas.length - 1])) {
      fromDay = r.model.day;
    }
    return { model: r.model, fromDay, deltas: r.deltas.filter((d) => d.day >= fromDay) };
  }
}
