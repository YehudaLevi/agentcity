import { describe, it, expect } from "vitest";
import { renderCity } from "../src/compiler.js";
import { gamify } from "../src/gamified/gamify.js";
import { generateDemoEvents, demoResolver } from "../src/demo-events.js";
import type { CityDelta } from "../src/types.js";

// The guard against silent feature loss: the SOLO demo city, rendered through the
// production pipeline (gamify -> renderCity), must exercise EVERY feature Yehuda
// built. If a refactor drops one, this fails loudly instead of eyeballing a demo.
const stream = gamify(generateDemoEvents("demo"), demoResolver, "me");
const { model, deltas } = renderCity(stream, "demo", { scene: "solo" });
const kinds = new Set(deltas.map((d) => d.kind));
const has = (k: string) => kinds.has(k as CityDelta["kind"]);

describe("feature coverage (no Yehuda feature lost on the solo city)", () => {
  it("founder hamlet: cottage + well/tree/boat props (solo scene)", () => {
    expect(model.baseline.hamlet).not.toBe(false);
    const props = model.baseline.props.map((p) => p.kind);
    expect(props).toContain("well");
    expect(props).toContain("tree");
  });

  it("buildings AND treehouses coexist (git vs no-remote identity)", () => {
    expect(model.lots.some((l) => l.personal === true)).toBe(true); // treehouses
    expect(model.lots.some((l) => l.personal !== true)).toBe(true); // buildings
  });

  it("tiers: projects grow past tier 0", () => {
    expect(Math.max(...model.lots.map((l) => l.tier))).toBeGreaterThan(0);
    expect(has("lot.upgrade")).toBe(true);
  });

  it("economy landmarks: all four kinds are earned over the run", () => {
    const lm = new Set(model.landmarks.map((l) => l.kind));
    for (const k of ["plaque", "fountain", "statue", "fireworks-spot"]) expect(lm.has(k as never)).toBe(true);
  });

  it("ships arrive", () => {
    expect(model.stats.ships).toBeGreaterThan(0);
    expect(has("ship.arrive")).toBe(true);
  });

  it("population, pets and streak accrue", () => {
    expect(model.stats.population).toBeGreaterThan(0);
    expect(model.stats.pets).toBeGreaterThan(0);
    expect(model.stats.streakDays).toBeGreaterThan(0);
  });

  it("session rails link coupled projects", () => {
    expect(model.rails.length).toBeGreaterThan(0);
    expect(has("rail.add")).toBe(true);
  });

  it("roads carve, and busy corridors upgrade to avenues", () => {
    expect(model.roads.length).toBeGreaterThan(0);
    expect(has("road.add")).toBe(true);
    expect(has("road.upgrade")).toBe(true);
  });

  it("idle projects decay", () => {
    expect(model.lots.some((l) => l.decay > 0)).toBe(true);
    expect(has("lot.decay")).toBe(true);
  });

  it("districts are surveyed as the city grows (chunk.reveal)", () => {
    expect(has("chunk.reveal")).toBe(true);
  });
});
