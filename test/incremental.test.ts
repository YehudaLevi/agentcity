import { describe, it, expect } from "vitest";
import { fold, foldIncremental } from "../src/compiler.js";
import { generateDemoEvents } from "../src/demo-events.js";
import { stableStringify } from "../src/types.js";

describe("incremental fold == full fold", () => {
  const seed = "inc-seed";
  const events = generateDemoEvents(seed);
  // split on a clean day boundary (~day 45 from founding 2026-04-01)
  const cut = "2026-05-16T00:00:00.000Z";
  const first = events.filter((e) => e.ts < cut);
  const second = events.filter((e) => e.ts >= cut);

  it("produces a byte-identical model when resumed from a checkpoint", () => {
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);

    const full = fold(events, seed);
    const half = fold(first, seed);
    expect(half.checkpoint.state.day).toBeLessThan(45);

    const inc = foldIncremental(half.checkpoint, second);
    expect(stableStringify(inc.model)).toBe(stableStringify(full.model));
  });

  it("continues delta seq strictly increasing across the resume", () => {
    const half = fold(first, seed);
    const lastSeq = half.deltas[half.deltas.length - 1]!.seq;
    const inc = foldIncremental(half.checkpoint, second);
    const all = [...half.deltas, ...inc.deltas];
    for (let i = 1; i < all.length; i++) expect(all[i]!.seq).toBeGreaterThan(all[i - 1]!.seq);
    if (inc.deltas.length) expect(inc.deltas[0]!.seq).toBeGreaterThan(lastSeq);
  });

  it("splitting at a different boundary still reconstructs the same model", () => {
    const cut2 = "2026-05-01T00:00:00.000Z"; // ~day 30
    const f = events.filter((e) => e.ts < cut2);
    const s = events.filter((e) => e.ts >= cut2);
    const full = fold(events, seed);
    const inc = foldIncremental(fold(f, seed).checkpoint, s);
    expect(stableStringify(inc.model)).toBe(stableStringify(full.model));
  });
});
