import { describe, it, expect } from "vitest";
import { fold } from "../src/compiler.js";
import { biomeOf, widenAvenue, type Geo } from "../src/rules/placement.js";
import { generateDemoEvents } from "../src/demo-events.js";
import type { PixelEvent, Coord } from "../src/types.js";

function apiRepo(repo: string, days = 3): PixelEvent[] {
  const out: PixelEvent[] = [];
  for (let d = 0; d < days; d++) {
    const base = Date.parse(`2026-04-0${d + 1}T09:00:00Z`);
    let s = 0;
    const ts = () => new Date(base + s++ * 1000).toISOString();
    out.push({ ts: ts(), session: `s${d}`, agent: "u", source: "t", repo, kind: "session.start" });
    for (let i = 0; i < 4; i++) {
      out.push({ ts: ts(), session: `s${d}`, agent: "u", source: "t", repo, kind: "tool.pre", tool: "Bash", detail: "curl https://api.example/v1" });
      out.push({ ts: ts(), session: `s${d}`, agent: "u", source: "t", repo, kind: "tool.post", tool: "Bash", detail: "curl https://api.example/v1" });
    }
    out.push({ ts: ts(), session: `s${d}`, agent: "u", source: "t", repo, kind: "turn.end" });
  }
  return out;
}

function touchesWater(pos: [number, number], water: [number, number][]): boolean {
  const set = new Set(water.map(([x, y]) => `${x},${y}`));
  const [x, y] = pos;
  return [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ].some(([nx, ny]) => set.has(`${nx},${ny}`));
}

describe("harbor rule: api lots touch water (carving an inlet if needed)", () => {
  const seeds = ["alpha", "beta", "hills99", "lakeland", "x7", "s-water-1", "s-water-2"];

  it("every api lot touches water across biomes", () => {
    for (const seed of seeds) {
      const { model } = fold(apiRepo("harbor-svc"), seed);
      const lot = model.lots.find((l) => l.repo === "harbor-svc")!;
      expect(lot.category).toBe("api");
      expect(touchesWater(lot.pos as [number, number], model.biome.water as [number, number][])).toBe(true);
    }
  });

  it("at least one hills seed carves a fresh inlet (non-empty carvedWater)", () => {
    const carvingSeeds = seeds.filter((s) => {
      const { checkpoint } = fold(apiRepo("harbor-svc"), s);
      return checkpoint.state.carvedWater.length > 0;
    });
    expect(carvingSeeds.length).toBeGreaterThan(0);
  });
});

describe("lot spacing & street invariants (game-rules §5)", () => {
  // A few representative seeds folded over the full demo (14 repos, 90 days).
  const seeds = ["street-a", "street-b", "street-c", "hills99"];

  it("no two lots are orthogonally adjacent (every lot keeps a 1-tile ring)", () => {
    for (const seed of seeds) {
      const { model } = fold(generateDemoEvents(seed), seed);
      const occ = new Set(model.lots.map((l) => `${l.pos[0]},${l.pos[1]}`));
      for (const l of model.lots) {
        const [x, y] = l.pos;
        for (const [nx, ny] of [
          [x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1],
        ]) {
          expect(occ.has(`${nx},${ny}`)).toBe(false);
        }
      }
    }
  });

  it("every lot fronts a street (orthogonally adjacent to a road tile)", () => {
    for (const seed of seeds) {
      const { model } = fold(generateDemoEvents(seed), seed);
      const roadTiles = new Set<string>();
      for (const r of model.roads) for (const [x, y] of r.path) roadTiles.add(`${x},${y}`);
      // baseline plaza road counts too
      for (const [x, y] of model.baseline.roadPath) roadTiles.add(`${x},${y}`);
      for (const l of model.lots) {
        const [x, y] = l.pos;
        const fronts = [
          [x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1],
        ].some(([nx, ny]) => roadTiles.has(`${nx},${ny}`));
        expect(fronts).toBe(true);
      }
    }
  });

  it("no diagonal lot cluster exceeds a 2x2 tile footprint (block rule)", () => {
    for (const seed of seeds) {
      const { model } = fold(generateDemoEvents(seed), seed);
      const pts = model.lots.map((l) => l.pos as Coord);
      const present = new Set(pts.map(([x, y]) => `${x},${y}`));
      const seen = new Set<string>();
      const KING: Coord[] = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
      ];
      for (const [sx, sy] of pts) {
        const k0 = `${sx},${sy}`;
        if (seen.has(k0)) continue;
        // king-connected component footprint
        const stack: Coord[] = [[sx, sy]];
        seen.add(k0);
        let minx = sx, maxx = sx, miny = sy, maxy = sy;
        while (stack.length) {
          const [x, y] = stack.pop()!;
          minx = Math.min(minx, x); maxx = Math.max(maxx, x);
          miny = Math.min(miny, y); maxy = Math.max(maxy, y);
          for (const [ox, oy] of KING) {
            const nk = `${x + ox},${y + oy}`;
            if (present.has(nk) && !seen.has(nk)) {
              seen.add(nk);
              stack.push([x + ox, y + oy]);
            }
          }
        }
        expect(maxx - minx + 1).toBeLessThanOrEqual(2);
        expect(maxy - miny + 1).toBeLessThanOrEqual(2);
      }
    }
  });

  it("widenAvenue lays parallel road tiles alongside a straight corridor", () => {
    // minimal Geo with a fully-revealed grassy grid and a straight road run.
    const geo: Geo = {
      seed: "ave",
      biome: "coastal",
      growthVec: { x: 1, y: 0 },
      growthDir: "E",
      origin: { x: 5, y: 5 },
      ground: [],
      occupied: new Set(),
      roadSet: new Set(),
      revealed: new Set(),
      lotsGeo: [],
    };
    for (let y = 0; y < 20; y++) {
      geo.ground[y] = [];
      for (let x = 0; x < 20; x++) geo.ground[y]![x] = { t: "grass", elev: 0 };
    }
    for (let cx = 0; cx < 2; cx++) for (let cy = 0; cy < 2; cy++) geo.revealed.add(`${cx},${cy}`);
    const path: Coord[] = [[3, 5], [4, 5], [5, 5], [6, 5]];
    for (const [x, y] of path) {
      geo.ground[y]![x]!.t = "road";
      geo.roadSet.add(`${x},${y}`);
    }
    const extra = widenAvenue(geo, path);
    expect(extra.length).toBe(path.length); // one parallel tile per path tile
    // each parallel tile is orthogonally adjacent to its path tile and now a road
    for (const [x, y] of extra) {
      expect(geo.roadSet.has(`${x},${y}`)).toBe(true);
    }
    // the corridor is genuinely 2 tiles wide (a path tile has a road neighbour off-axis)
    const widened = path.some(([x, y]) => geo.roadSet.has(`${x},${y + 1}`) || geo.roadSet.has(`${x},${y - 1}`));
    expect(widened).toBe(true);
  });
});

describe("uniqueness (Rule 6): different seeds -> structurally different cities", () => {
  it("differs in biome or origin for distinct seeds", () => {
    const a = fold(apiRepo("r1"), "seedA").model;
    const b = fold(apiRepo("r1"), "seedB").model;
    const different =
      a.biome.kind !== b.biome.kind ||
      a.biome.origin[0] !== b.biome.origin[0] ||
      a.biome.origin[1] !== b.biome.origin[1] ||
      a.biome.growthDir !== b.biome.growthDir;
    expect(different).toBe(true);
  });

  it("biomeOf spans all four biomes across seeds", () => {
    const kinds = new Set<string>();
    for (let i = 0; i < 60; i++) kinds.add(biomeOf(`probe-${i}`));
    expect(kinds).toEqual(new Set(["coastal", "river", "lakes", "hills"]));
  });
});
