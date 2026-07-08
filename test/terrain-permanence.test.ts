import { describe, it, expect } from "vitest";
import { fold } from "../src/compiler.js";
import { stableStringify } from "../src/types.js";
import type { PixelEvent } from "../src/types.js";

// Terrain (biome/water/elevation layout) MUST derive ONLY from the seed — the
// event stream never reshapes geography, with the single documented exception of
// api-water carving (an inlet dug so a harbor lot can touch water). These tests
// pin that invariant now that fog-of-war is gone and the full terrain is visible
// from day 0.

let sec = 0;
function ev(repo: string, day: number, kind: string, tool?: string, detail?: string): PixelEvent {
  const base = Date.parse("2026-04-01T00:00:00Z") + day * 86400000;
  return {
    ts: new Date(base + sec++ * 1000).toISOString(),
    session: `s-${repo}-${day}`,
    agent: "u",
    source: "t",
    repo,
    kind: kind as PixelEvent["kind"],
    ...(tool ? { tool } : {}),
    ...(detail ? { detail } : {}),
  };
}

/** A tiny, quiet non-api stream: one repo editing source over two days. */
function quietStream(): PixelEvent[] {
  const out: PixelEvent[] = [];
  for (let d = 0; d < 2; d++) {
    out.push(ev("solo", d, "session.start"));
    out.push(ev("solo", d, "tool.pre", "Edit", "src/a.ts"));
    out.push(ev("solo", d, "tool.post", "Edit", "src/a.ts"));
    out.push(ev("solo", d, "turn.end"));
  }
  return out;
}

/** A wildly different non-api stream: many repos, many days, huge volume, forks,
 * all-nighters, spanning several categories — but never api (no curl/http). */
function busyStream(): PixelEvent[] {
  const out: PixelEvent[] = [];
  const repos = [" residential", "labwork", "shipyard", "planroom", "glasshouse"].map((r) => r.trim());
  const details: [string, string][] = [
    ["Edit", "src/main.ts"], // code
    ["Edit", "src/feature.test.ts"], // tests
    ["Bash", "docker build ."], // infra
    ["Read", "notes.md"], // research
    ["WebFetch", "docs"], // web
    ["TodoWrite", "plan"], // planning
  ];
  for (let d = 0; d < 60; d++) {
    for (const repo of repos) {
      out.push(ev(repo, d, "session.start"));
      if (d % 3 === 0) out.push(ev(repo, d, "fork.start"));
      for (let i = 0; i < 8; i++) {
        const [tool, detail] = details[i % details.length]!;
        out.push(ev(repo, d, "tool.pre", tool, detail));
        out.push(ev(repo, d, "tool.post", tool, detail));
      }
      out.push(ev(repo, d, "turn.end"));
    }
  }
  return out;
}

/** An api stream that forces harbor placement (curl details -> api category). */
function apiStream(): PixelEvent[] {
  const out: PixelEvent[] = [];
  for (let d = 0; d < 4; d++) {
    out.push(ev("harbor", d, "session.start"));
    for (let i = 0; i < 5; i++) {
      out.push(ev("harbor", d, "tool.pre", "Bash", "curl https://api.example/v1"));
      out.push(ev("harbor", d, "tool.post", "Bash", "curl https://api.example/v1"));
    }
    out.push(ev("harbor", d, "turn.end"));
  }
  return out;
}

const SEEDS = ["terra-a", "terra-b", "hills99", "lakeland", "river-x"];

describe("terrain permanence: geography = f(seed) only", () => {
  it("same seed + wildly different (non-api) event streams => identical terrain", () => {
    for (const seed of SEEDS) {
      const a = fold(quietStream(), seed).model;
      const b = fold(busyStream(), seed).model;
      // biome identity
      expect(b.biome.kind).toBe(a.biome.kind);
      expect(b.biome.growthDir).toBe(a.biome.growthDir);
      expect(stableStringify(b.biome.origin)).toBe(stableStringify(a.biome.origin));
      // the actual geography: every water tile is identical (no api carving here)
      expect(stableStringify(b.biome.water)).toBe(stableStringify(a.biome.water));
      // sanity: there IS terrain to compare
      expect(a.biome.water.length).toBeGreaterThan(0);
    }
  });

  it("api-water carving is additive-only: base water is a subset of carved water", () => {
    for (const seed of SEEDS) {
      const base = new Set(fold(quietStream(), seed).model.biome.water.map(([x, y]) => `${x},${y}`));
      const carved = new Set(fold(apiStream(), seed).model.biome.water.map(([x, y]) => `${x},${y}`));
      for (const k of base) expect(carved.has(k)).toBe(true); // carving never removes terrain water
    }
  });

  it("re-folding (and event reordering) is byte-identical for terrain", () => {
    for (const seed of SEEDS) {
      const events = busyStream();
      const shuffled = events.slice().reverse(); // fold sorts internally
      const a = fold(events, seed).model.biome;
      const b = fold(shuffled, seed).model.biome;
      expect(stableStringify(b)).toBe(stableStringify(a));
    }
  });
});
