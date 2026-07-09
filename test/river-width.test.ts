import { describe, it, expect } from "vitest";
import {
  biomeOf,
  genTerrain,
  allWater,
  GRID,
  RIVER_R,
  type Geo,
} from "../src/rules/placement.js";
import type { Coord } from "../src/types.js";

// River min-width invariant (user requirement, 2026-07): the open water channel
// of a `river` biome must be at least 3 tiles wide EVERYWHERE along its course,
// bends included. The old per-scanline band pinched to ~1 tile where the river
// turned to flow along the scan axis; the swept-disk carve (RIVER_R) fixes it.
//
// INVARIANT ASSERTED (water-set only, robust to meander hairpins):
//   Erode biome.water with a 3x3 structuring element — a water tile survives iff
//   ALL 8 of its neighbours are also water ("core" tiles). If the channel is
//   >= 3 tiles wide everywhere along its course, this core is NON-EMPTY and forms
//   exactly ONE 4-connected component (a continuous spine running the whole
//   river). Any place the channel narrows to <= 2 tiles erodes away completely
//   and SPLITS the core into multiple pieces — which is exactly the pinch we are
//   forbidding. (A thin land sliver between two hairpin legs does NOT split the
//   core: each 6-wide leg keeps its spine and they rejoin at the bend.)
//
// This same erosion on the OLD band terrain produced 5-12 components; the fix
// yields 1.

function riverGeo(seed: string): Geo {
  const g: Geo = {
    seed,
    biome: biomeOf(seed),
    growthVec: { x: 1, y: 0 },
    growthDir: "E",
    origin: { x: 30, y: 30 },
    ground: [],
    occupied: new Set(),
    roadSet: new Set(),
    surveyed: new Set(),
    lotsGeo: [],
  };
  genTerrain(g); // pure f(seed) — no events, no api inlets
  return g;
}

/** Collect the first `n` seeds whose seed-derived biome is `river`. */
function riverSeeds(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < n && i < 5000; i++) {
    const s = `river-probe-${i}`;
    if (biomeOf(s) === "river") out.push(s);
  }
  return out;
}

/** 3x3 erosion followed by 4-connected component count over a water set. */
function erodeCoreComponents(water: Coord[]): { core: number; components: number } {
  const set = new Set(water.map(([x, y]) => `${x},${y}`));
  const isWater = (x: number, y: number) => set.has(`${x},${y}`);
  const core = new Set<string>();
  for (const [x, y] of water) {
    let solid = true;
    for (let dy = -1; dy <= 1 && solid; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (!isWater(x + dx, y + dy)) {
          solid = false;
          break;
        }
    if (solid) core.add(`${x},${y}`);
  }
  const seen = new Set<string>();
  let components = 0;
  for (const k of core) {
    if (seen.has(k)) continue;
    components++;
    const stack = [k];
    seen.add(k);
    while (stack.length) {
      const [cx, cy] = stack.pop()!.split(",").map(Number) as [number, number];
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nk = `${cx + dx},${cy + dy}`;
        if (core.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push(nk);
        }
      }
    }
  }
  return { core: core.size, components };
}

describe("river channel min width >= 3 (no meander-bend pinch)", () => {
  const seeds = [...riverSeeds(6), "riviera"]; // riviera = the seed from the bug report

  it("collects several river-biome worlds to test", () => {
    expect(seeds.length).toBeGreaterThanOrEqual(6);
    for (const s of seeds) expect(biomeOf(s)).toBe("river");
  });

  it("the channel is >= 3 tiles wide everywhere: 3x3 erosion leaves one connected spine", () => {
    for (const seed of seeds) {
      const water = allWater(riverGeo(seed));
      const { core, components } = erodeCoreComponents(water);
      // a >=3-wide channel always has interior (all-8-neighbours-water) tiles ...
      expect(core, `seed ${seed}: eroded core is empty (channel <3 wide)`).toBeGreaterThan(0);
      // ... and they form a single continuous spine (no <=2-wide pinch splits it)
      expect(
        components,
        `seed ${seed}: eroded core split into ${components} pieces => a channel pinch <3 wide`,
      ).toBe(1);
    }
  });

  it("erosion invariant is meaningful: a synthetic 1-tile-wide channel fails it", () => {
    // Guard against the test silently passing on a degenerate metric: a genuine
    // 1-wide river must be rejected (empty core), and a 3-wide one accepted.
    const oneWide: Coord[] = [];
    for (let a = 5; a < GRID - 5; a++) oneWide.push([a, 30]);
    expect(erodeCoreComponents(oneWide).core).toBe(0);

    const threeWide: Coord[] = [];
    for (let a = 5; a < GRID - 5; a++)
      for (let w = -1; w <= 1; w++) threeWide.push([a, 30 + w]);
    const r = erodeCoreComponents(threeWide);
    expect(r.core).toBeGreaterThan(0);
    expect(r.components).toBe(1);
  });

  it("RIVER_R gives straight sections their expected ~7-tile width", () => {
    // sanity on the carve radius the invariant relies on
    expect(RIVER_R).toBe(3);
  });
});
