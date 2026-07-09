import { describe, it, expect } from "vitest";
import { fold, foldIncremental } from "../src/compiler.js";
import type { PixelEvent, FoldResult } from "../src/types.js";

// Regression for the day7:52 duplicate-reveal bug. chunk.reveal marks a
// "district surveyed" milestone and MUST fire at most once per chunk across a
// city's whole lifetime (a full fold or ANY sequence of incremental folds).
//
// Root cause: the checkpoint commits geo.surveyed through the last COMPLETE day
// (openDay-1), then re-derives the OPEN day on every resume. Growth surveys that
// landed on the open day were therefore re-surveyed and re-emitted on every poll
// — the live server saw one duplicate chunk.reveal per poll (52 in one day on a
// real city). The fix defers the open day's chunk.reveal until the day commits,
// so it emits exactly once, on the same day, whether reached by a full fold or a
// stream of incremental folds.

const base = Date.parse("2026-07-01T09:00:00Z");
function mk(repo: string, dayOff: number, secOff: number, kind: string, extra: Record<string, unknown> = {}): PixelEvent {
  return {
    ts: new Date(base + dayOff * 86400000 + secOff * 1000).toISOString(),
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

/** A stream that founds NEW repos every day (so growth surveys keep firing on
 * later days, including the still-open one) over `days` days. */
function staggeredStream(days: number): PixelEvent[] {
  const out: PixelEvent[] = [];
  let repoId = 0;
  for (let d = 0; d < days; d++) {
    for (let n = 0; n < 3; n++) {
      const repo = `repo${repoId++}`;
      out.push(mk(repo, d, n * 100, "session.start"));
      for (let k = 0; k < 6; k++) out.push(...activity(repo, d, n * 100 + 1 + k * 3));
    }
    for (let r = 0; r < repoId; r++)
      for (let k = 0; k < 3; k++) out.push(...activity(`repo${r}`, d, 500 + r * 20 + k * 3));
  }
  return out;
}

const revealKeys = (r: FoldResult) =>
  r.deltas.filter((d) => d.kind === "chunk.reveal").map((d) => `${d.x},${d.y}`);

describe("chunk.reveal emits at most once per chunk (day7:52 regression)", () => {
  const seed = "riviera";

  it("a repeated same-day incremental poll loop never re-emits a chunk.reveal", () => {
    const events = staggeredStream(8);
    // split partway INTO the last day (day 7), then poll the tail one event at a
    // time — exactly what the live server does while a day stays open.
    const cut = base + 7 * 86400000 + 5 * 1000;
    const first = events.filter((e) => Date.parse(e.ts) < cut);
    const rest = events.filter((e) => Date.parse(e.ts) >= cut);
    expect(rest.length).toBeGreaterThan(0);

    let res = fold(first, seed);
    const all = [...revealKeys(res)];
    for (const ev of rest) {
      res = foldIncremental(res.checkpoint, [ev]);
      all.push(...revealKeys(res));
    }

    // the whole concatenated lifetime stream has no chunk twice
    const counts = new Map<string, number>();
    for (const k of all) counts.set(k, (counts.get(k) ?? 0) + 1);
    const dupes = [...counts].filter(([, n]) => n > 1);
    expect(dupes).toEqual([]);
    // sanity: growth really did survey beyond the founding 2x2 (else vacuous)
    expect(counts.size).toBeGreaterThan(4);
  });

  it("a deferred open-day survey still emits EXACTLY once when the day commits", () => {
    const events = staggeredStream(8);
    const cut = base + 7 * 86400000 + 5 * 1000;
    const first = events.filter((e) => Date.parse(e.ts) < cut);
    const rest = events.filter((e) => Date.parse(e.ts) >= cut);

    // fold day 7 as the open day (its survey is deferred, not yet emitted)...
    let res = fold(first, seed);
    const openReveals = revealKeys(res); // committed days only — day 7 deferred
    let poll = foldIncremental(res.checkpoint, rest);
    const life: string[] = [...openReveals, ...revealKeys(poll)];

    // ...then advance to day 8 so day 7 becomes COMMITTED and its survey emits.
    const day8 = [mk("late", 8, 0, "session.start"), ...activity("late", 8, 1)];
    poll = foldIncremental(poll.checkpoint, day8);
    life.push(...revealKeys(poll));

    // no chunk ever fired twice across the whole lifetime
    const counts = new Map<string, number>();
    for (const k of life) counts.set(k, (counts.get(k) ?? 0) + 1);
    expect([...counts].filter(([, n]) => n > 1)).toEqual([]);

    // and the lifetime set equals a single full fold over the SAME span (days
    // 0..8, day 8 open): the day-7 survey deferred earlier now shows up exactly
    // once, so a day surveyed while open is never lost from the timelapse.
    const full = new Set(revealKeys(fold([...events, ...day8], seed)));
    expect([...new Set(life)].sort()).toEqual([...full].sort());
    expect(full.size).toBeGreaterThan(openReveals.length); // day 7 really added one
  });
});

describe("incremental chunk.reveal set == full-fold set", () => {
  const seed = "riviera";

  it("a day-boundary split reconstructs the same unique chunk.reveal set", () => {
    const events = staggeredStream(8);
    const full = new Set(revealKeys(fold(events, seed)));

    // split at a clean day boundary (start of day 4)
    const cut = base + 4 * 86400000;
    const first = events.filter((e) => Date.parse(e.ts) < cut);
    const second = events.filter((e) => Date.parse(e.ts) >= cut);
    const a = fold(first, seed);
    const b = foldIncremental(a.checkpoint, second);

    const inc = new Set([...revealKeys(a), ...revealKeys(b)]);
    expect([...inc].sort()).toEqual([...full].sort());
  });

  it("a per-event incremental stream yields the same unique set as one full fold", () => {
    const events = staggeredStream(6);
    const full = new Set(revealKeys(fold(events, seed)));

    // fold the very first event, then feed the rest one at a time
    let res = fold(events.slice(0, 1), seed);
    const seen = new Set(revealKeys(res));
    for (const ev of events.slice(1)) {
      res = foldIncremental(res.checkpoint, [ev]);
      for (const k of revealKeys(res)) seen.add(k);
    }
    expect([...seen].sort()).toEqual([...full].sort());
  });
});
