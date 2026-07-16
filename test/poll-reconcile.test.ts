import { describe, it, expect } from "vitest";
import { gamify } from "../src/gamified/gamify.js";
import { GamifiedCity } from "../src/gamified/city.js";
import { testResolver } from "./support.js";
import type { CityDelta, PixelEvent } from "../src/types.js";

// Regression coverage for the NEW pipeline (gamify -> GamifiedCity.reconcile via
// the server poll loop; renderCity full-refolds; the renderer's applyLiveDelta
// drops days >= fromDay before splicing the tail). These replace the deleted
// incremental.test.ts cases, adapted to renderCity/reconcile:
//   • chunk.reveal (district surveyed) fires AT MOST ONCE per chunk in what a
//     client actually replays, across a REPEATED poll loop over a growing stream;
//   • the day counter never runs away: events spanning N days never fold to a
//     model.day beyond N-1, no matter how many polls re-reconcile the same stream.

const base = Date.parse("2026-05-01T09:00:00Z");
function mk(repo: string, dayOff: number, secOff: number, kind: string, extra: Record<string, unknown> = {}): PixelEvent {
  return {
    ts: new Date(base + dayOff * 86_400_000 + secOff * 1000).toISOString(),
    session: `s-${repo}`,
    agent: "u",
    source: "t",
    repo,
    kind: kind as PixelEvent["kind"],
    ...extra,
  };
}
function activity(repo: string, dayOff: number, secOff: number): PixelEvent[] {
  return [
    mk(repo, dayOff, secOff, "tool.pre", { tool: "Edit", detail: "a.ts" }),
    mk(repo, dayOff, secOff + 1, "tool.post", { tool: "Edit", detail: "a.ts" }),
    mk(repo, dayOff, secOff + 2, "turn.end"),
  ];
}

/** The client's live-delta applier (mirrors the renderer's applyLiveDelta /
 * replaceFrom): drop everything on days >= fromDay, splice the new tail, keep
 * day/seq order. `sync.lots` is volatile terminal state, not replayed history. */
function applyLiveDelta(client: CityDelta[], fromDay: number, tail: CityDelta[]): CityDelta[] {
  const kept = client.filter((d) => d.day < fromDay);
  return [...kept, ...tail].sort((a, b) => a.day - b.day || a.seq - b.seq);
}

function revealCounts(deltas: CityDelta[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of deltas) if (d.kind === "chunk.reveal") m.set(`${d.x},${d.y}`, (m.get(`${d.x},${d.y}`) ?? 0) + 1);
  return m;
}

describe("server poll loop reconciliation (regression: dup reveals + runaway day)", () => {
  const seed = "riviera";

  it("chunk.reveal fires at most once per chunk in the CLIENT replay across a repeated poll loop", () => {
    // A stream that GROWS every poll: existing repos keep working (same day gets
    // re-gamified to higher WU) AND new repos are founded (new districts surveyed).
    const city = new GamifiedCity(seed, { scene: "solo" });
    let raw: PixelEvent[] = [];
    let client: CityDelta[] = [];
    let repoId = 0;

    for (let poll = 0; poll < 12; poll++) {
      const day = Math.floor(poll / 2); // two polls per calendar day (same-day growth)
      // grow the still-open day: more work on all known repos ...
      for (let r = 0; r < repoId; r++) for (let k = 0; k < 2; k++) raw.push(...activity(`repo${r}`, day, 400 + r * 30 + poll * 3 + k));
      // ... plus a freshly founded repo (new building -> maybe a new survey).
      const fresh = `repo${repoId++}`;
      raw.push(mk(fresh, day, poll * 5, "session.start"));
      for (let k = 0; k < 5; k++) raw.push(...activity(fresh, day, poll * 5 + 1 + k * 3));

      // the real poll path: re-gamify the whole archive, reconcile day-granularly.
      const res = city.reconcile(gamify(raw, testResolver, "me"));
      client = applyLiveDelta(client, res.fromDay, res.deltas);
    }

    // The client's replayed timeline must never carry a chunk revealed twice ...
    const clientDup = [...revealCounts(client)].filter(([, n]) => n > 1);
    expect(clientDup).toEqual([]);
    // ... and it must equal the authoritative full timeline (no drift, no loss).
    const authoritative = revealCounts(city.deltas());
    expect([...revealCounts(client)].sort()).toEqual([...authoritative].sort());
    expect([...authoritative].filter(([, n]) => n > 1)).toEqual([]); // authoritative also clean
    expect(authoritative.size).toBeGreaterThan(4); // districts actually grew past the founding 2x2
  });

  it("runaway-day guard: N calendar days never fold beyond model.day = N-1, however many polls", () => {
    const N = 6;
    const city = new GamifiedCity(seed, { scene: "solo" });
    let raw: PixelEvent[] = [];

    // Poll once per day, then re-poll the SAME stream repeatedly — an incremental
    // folder that double-advanced (the old BUG-1) would inflate model.day here.
    for (let day = 0; day < N; day++) {
      raw.push(mk(`app`, day, 0, "session.start"));
      for (let k = 0; k < 4; k++) raw.push(...activity("app", day, 1 + k * 3));
      city.reconcile(gamify(raw, testResolver, "me"));
      expect(city.model().day).toBe(day); // exactly the current calendar day, never ahead
    }
    // idempotent re-polls of the identical stream must not push the counter up.
    for (let i = 0; i < 5; i++) {
      city.reconcile(gamify(raw, testResolver, "me"));
      expect(city.model().day).toBe(N - 1);
    }
    expect(city.model().day).toBeLessThanOrEqual(N); // hard bound: never runs away
  });
});
