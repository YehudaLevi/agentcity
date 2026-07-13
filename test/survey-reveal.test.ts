import { describe, it, expect } from "vitest";
import { render } from "./support.js";
import type { PixelEvent } from "../src/types.js";

// chunk.reveal marks a "district surveyed" milestone and MUST fire at most once
// per chunk over a city's whole lifetime. renderCity folds the full stream
// deterministically (no open-day re-derivation), so surveys emit exactly once by
// construction — this guards that invariant on the production path.

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

/** A stream that founds NEW repos every day so growth surveys keep firing. */
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

describe("chunk.reveal (district surveyed) fires at most once per chunk", () => {
  const seed = "riviera";

  it("no chunk is surveyed twice, and growth surveys beyond the founding 2x2", () => {
    const { deltas } = render(staggeredStream(8), seed);
    const keys = deltas.filter((d) => d.kind === "chunk.reveal").map((d) => `${d.x},${d.y}`);
    const counts = new Map<string, number>();
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    expect([...counts].filter(([, n]) => n > 1)).toEqual([]); // never twice
    expect(counts.size).toBeGreaterThan(4); // grew past the founding 2x2 district
  });

  it("event reordering yields the same unique chunk.reveal set (determinism)", () => {
    const events = staggeredStream(8);
    const keysOf = (evs: PixelEvent[]) =>
      new Set(render(evs, seed).deltas.filter((d) => d.kind === "chunk.reveal").map((d) => `${d.x},${d.y}`));
    const a = keysOf(events);
    const b = keysOf(events.slice().reverse()); // gamify/renderCity sort internally
    expect([...a].sort()).toEqual([...b].sort());
  });
});
