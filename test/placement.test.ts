import { describe, it, expect } from "vitest";
import { fold } from "../src/compiler.js";
import { biomeOf } from "../src/rules/placement.js";
import type { PixelEvent } from "../src/types.js";

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
