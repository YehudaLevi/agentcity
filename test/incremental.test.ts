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

// Regression guards for BUG-1 (day arithmetic). The live server polls poll()
// -> foldIncremental repeatedly, often with events on the SAME calendar day as
// the checkpoint. The old code forced fromDay = st.day + 1, which dropped those
// same-day events AND advanced the day counter on every poll — so model.day ran
// away (7 -> 132 in real dogfooding) while lastActiveDay stayed put, and every
// lot wrongly decayed (idle = day - lastActiveDay crossed 90).
describe("BUG-1: day == calendar diff in full AND incremental folds", () => {
  const base = Date.parse("2026-07-01T09:00:00Z");
  const mk = (repo: string, secOff: number, kind: string, extra: Record<string, unknown> = {}) => ({
    ts: new Date(base + secOff * 1000).toISOString(),
    session: `s-${repo}`,
    agent: "u",
    source: "t",
    repo,
    kind,
    ...extra,
  }) as any;
  const activity = (repo: string, secOff: number) => [
    mk(repo, secOff, "tool.pre", { tool: "Edit", detail: "a.ts" }),
    mk(repo, secOff + 1, "tool.post", { tool: "Edit", detail: "a.ts" }),
    mk(repo, secOff + 2, "turn.end"),
  ];

  it("repeated same-day polls never inflate day or trigger false decay", () => {
    const seed = "runaway";
    let events: any[] = [mk("alpha", 0, "session.start"), ...activity("alpha", 1)];
    let res = fold(events, seed);
    expect(res.model.day).toBe(0);

    // 130 same-day incremental steps (mirrors the server's poll loop)
    for (let i = 0; i < 130; i++) {
      const more = activity("alpha", 100 + i * 10);
      res = foldIncremental(res.checkpoint, more);
      events = [...events, ...more];
    }

    // day stays at the calendar diff (0) — NOT ~130
    expect(res.model.day).toBe(0);
    const lot = res.model.lots.find((l) => l.repo === "alpha")!;
    expect(lot.lastActiveDay).toBe(0);
    expect(lot.decay).toBe(0); // active today -> never decays
    // and it is byte-identical to a single full fold of everything
    expect(stableStringify(res.model)).toBe(stableStringify(fold(events, seed).model));
  });

  it("a mid-day (non-boundary) split reconstructs byte-identically", () => {
    const seed = "midday";
    // day 0 activity both before AND after the split instant (a straddled day)
    const events = [
      mk("alpha", 0, "session.start"),
      ...activity("alpha", 1), // 09:00
      ...activity("alpha", 6 * 3600), // 15:00 (same calendar day)
      mk("beta", 6 * 3600 + 10, "session.start"),
      ...activity("beta", 6 * 3600 + 11),
    ];
    const cut = new Date(base + 3 * 3600 * 1000).toISOString(); // 12:00, mid-day 0
    const first = events.filter((e) => e.ts < cut);
    const second = events.filter((e) => e.ts >= cut);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);

    const full = fold(events, seed);
    const inc = foldIncremental(fold(first, seed).checkpoint, second);
    expect(stableStringify(inc.model)).toBe(stableStringify(full.model));
    expect(full.model.day).toBe(0);
  });
});
