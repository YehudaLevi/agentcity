import { describe, it, expect } from "vitest";
import { render } from "./support.js";
import { generateDemoEvents } from "../src/demo-events.js";
import { stableStringify } from "../src/types.js";
import type { CityDelta, CityModel } from "../src/types.js";

// A reducer mirroring the renderer's (web/fixture-city.js): replaying the delta
// stream must arrive at the FULL map state of a direct fold, including exact
// per-lot wu/wuIntoTier/wuNextTier/lastActiveDay — the final sync.lots delta
// closes the gap that WU accrual within a tier used to leave.
function replay(deltas: CityDelta[]) {
  const lotById = new Map<string, any>();
  const roadById = new Map<string, any>();
  const rails: any[] = [];
  const chunks: any[] = [];
  const landmarks: any[] = [];
  let ships = 0;
  let population = 0;
  let pets = 0;
  let streakDays = 0;
  let allNighterYesterday = false;

  for (const d of deltas) {
    switch (d.kind) {
      case "chunk.reveal":
        chunks.push({ x: d.x, y: d.y });
        break;
      case "lot.found":
        lotById.set(d.id as string, {
          id: d.id,
          repo: d.repo,
          alias: d.alias,
          category: d.category,
          secondary: d.secondary,
          pos: d.pos,
          tier: d.tier,
          wu: d.wu,
          wuIntoTier: d.wuIntoTier,
          wuNextTier: d.wuNextTier,
          decay: 0,
          foundedDay: d.foundedDay,
          lastActiveDay: d.lastActiveDay,
          variant: d.variant,
        });
        break;
      case "lot.upgrade": {
        const l = lotById.get(d.id as string);
        if (l) {
          l.tier = d.tier;
          l.wu = d.wu;
          l.wuIntoTier = d.wuIntoTier;
          l.wuNextTier = d.wuNextTier;
          l.lastActiveDay = d.lastActiveDay;
        }
        break;
      }
      case "lot.decay": {
        const l = lotById.get(d.id as string);
        if (l) l.decay = d.level;
        break;
      }
      case "lot.renovate": {
        const l = lotById.get(d.id as string);
        if (l) {
          l.decay = 0;
          l.lastActiveDay = d.lastActiveDay;
        }
        break;
      }
      case "road.add":
        roadById.set(d.id as string, { id: d.id, path: d.path, tier: d.tier });
        break;
      case "road.upgrade": {
        const r = roadById.get(d.id as string);
        if (r) {
          r.tier = d.tier;
          if (d.path) r.path = d.path; // top-tier avenues widen: carry new path
        }
        break;
      }
      case "rail.add":
        rails.push({ between: d.between, path: d.path });
        break;
      case "landmark.add":
        landmarks.push({ kind: d.landmarkKind, pos: d.pos });
        break;
      case "ship.arrive":
        ships++;
        break;
      case "population.set":
        population = d.population as number;
        pets = d.pets as number;
        if (d.streakDays != null) streakDays = d.streakDays as number;
        if (d.allNighterYesterday != null) allNighterYesterday = d.allNighterYesterday as boolean;
        break;
      case "sync.lots":
        for (const s of d.lots as any[]) {
          const l = lotById.get(s.id as string);
          if (l) {
            l.wu = s.wu;
            l.wuIntoTier = s.wuIntoTier;
            l.wuNextTier = s.wuNextTier;
            l.lastActiveDay = s.lastActiveDay;
            l.decay = s.decay;
          }
        }
        break;
      default:
        break;
    }
  }
  return { lotById, roadById, rails, chunks, landmarks, ships, population, pets, streakDays, allNighterYesterday };
}

function lotProjection(m: CityModel) {
  return m.lots
    .map((l) => ({
      id: l.id,
      repo: l.repo,
      alias: l.alias,
      category: l.category,
      secondary: l.secondary,
      pos: l.pos,
      tier: l.tier,
      wu: l.wu,
      wuIntoTier: l.wuIntoTier,
      wuNextTier: l.wuNextTier,
      decay: l.decay,
      foundedDay: l.foundedDay,
      lastActiveDay: l.lastActiveDay,
      variant: l.variant,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

describe("deltas replay == model (map state)", () => {
  const { model, deltas } = render(generateDemoEvents("replay-seed"), "replay-seed");
  const r = replay(deltas);

  it("lots reconstruct identically (full deep equality incl. wu/progress/lastActiveDay)", () => {
    const replayed = [...r.lotById.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(stableStringify(replayed)).toBe(stableStringify(lotProjection(model)));
  });

  it("roads reconstruct with matching tiers", () => {
    const replayed = [...r.roadById.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const expected = model.roads.map((rd) => ({ id: rd.id, path: rd.path, tier: rd.tier })).sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(stableStringify(replayed)).toBe(stableStringify(expected));
  });

  it("rails and landmarks reconstruct identically", () => {
    expect(stableStringify(r.rails)).toBe(stableStringify(model.rails));
    expect(stableStringify(r.landmarks)).toBe(stableStringify(model.landmarks.map((l) => ({ kind: l.kind, pos: l.pos }))));
  });

  it("model chunks are ALL revealed from day 0 (fog-of-war removed)", () => {
    // full terrain visible: every chunk of the 6x6 world is revealed on day 0.
    expect(model.chunks.length).toBe(36);
    expect(model.chunks.every((c) => c.revealed && c.revealedDay === 0)).toBe(true);
  });

  it("chunk.reveal deltas are 'district surveyed' moments (subset of the map)", () => {
    // No longer emitted for map-existence; each carries {surveyed:true} and must
    // land on a real chunk of the (all-revealed) model.
    const surveyDeltas = deltas.filter((d) => d.kind === "chunk.reveal");
    expect(surveyDeltas.length).toBeGreaterThan(0);
    const mchunks = new Set(model.chunks.map((c) => `${c.x},${c.y}`));
    for (const d of surveyDeltas) {
      expect(d.surveyed).toBe(true);
      expect(mchunks.has(`${d.x},${d.y}`)).toBe(true);
    }
    // the founding district (center 2x2) is surveyed on day 0
    const day0 = new Set(surveyDeltas.filter((d) => d.day === 0).map((d) => `${d.x},${d.y}`));
    for (const k of ["2,2", "2,3", "3,2", "3,3"]) expect(day0.has(k)).toBe(true);
  });

  it("stats (ships/pop/pets/streak/all-nighter) reconstruct from deltas", () => {
    expect(r.ships).toBe(model.stats.ships);
    expect(r.population).toBe(model.stats.population);
    expect(r.pets).toBe(model.stats.pets);
    expect(r.streakDays).toBe(model.stats.streakDays);
    expect(r.allNighterYesterday).toBe(model.stats.allNighterYesterday);
  });
});
