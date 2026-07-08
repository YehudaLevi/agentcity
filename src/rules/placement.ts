// agentcity — placement & map growth (game-rules §5-6): biome, origin, district
// affinity, water carving, road A*/BFS, rails, chunk expansion.
//
// Determinism: NO RNG stream. Every "random" choice is a pure function of
// (seed, context-key) via seed.ts helpers, so state rebuilt from a checkpoint
// makes identical choices as a full fold.

import type { BiomeKind, GrowthDir, Category, Coord } from "../types.js";
import { rand, randInt } from "../seed.js";

export const CHUNK = 10; // chunk size fixed at 10 (renderer contract)
export const GRIDCH = 6; // chunks per axis -> matches renderer's 60x60 fixture world
export const GRID = CHUNK * GRIDCH; // 60 tiles per axis
export const CENTER = GRID / 2; // 30

export const BIOMES: BiomeKind[] = ["coastal", "river", "lakes", "hills"];

export type TileType = "grass" | "grass2" | "water" | "sand" | "road" | "stone";
export interface Cell {
  t: TileType;
  elev: number;
}

export interface Geo {
  seed: string;
  biome: BiomeKind;
  growthVec: { x: number; y: number };
  growthDir: GrowthDir;
  origin: { x: number; y: number };
  ground: Cell[][];
  occupied: Set<string>;
  roadSet: Set<string>;
  revealed: Set<string>; // chunk keys "cx,cy"
  lotsGeo: { x: number; y: number; cat: Category }[];
}

const key = (x: number, y: number) => `${x},${y}`;
const chKey = (cx: number, cy: number) => `${cx},${cy}`;
const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < GRID && y < GRID;

const NEIGHBORS: Coord[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// ============================ seed-driven world identity ============================

export function biomeOf(seed: string): BiomeKind {
  return BIOMES[randInt(seed, "biome", BIOMES.length)]!;
}

export function growthDirOf(seed: string): { vec: { x: number; y: number }; name: GrowthDir } {
  const ang = rand(seed, "growth:angle") * Math.PI * 2;
  const vec = { x: Math.cos(ang), y: Math.sin(ang) };
  const names: GrowthDir[] = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
  // map angle [0,2pi) to 8 compass names (x->E, y->S in tile space)
  const idx = Math.round((ang / (Math.PI * 2)) * 8) % 8;
  return { vec, name: names[idx]! };
}

// ============================ terrain ============================

function setWater(g: Geo, x: number, y: number): void {
  if (inBounds(x, y)) {
    g.ground[y]![x]!.t = "water";
    g.ground[y]![x]!.elev = 0;
  }
}

/** Generate base terrain (water/elev/sand) deterministically from the seed. */
export function genTerrain(g: Geo): void {
  const { seed, biome } = g;
  g.ground = [];
  for (let y = 0; y < GRID; y++) {
    g.ground[y] = [];
    for (let x = 0; x < GRID; x++) {
      g.ground[y]![x] = { t: (x + y) & 1 ? "grass" : "grass2", elev: 0 };
    }
  }
  if (biome === "coastal") {
    const edge = randInt(seed, "coast:edge", 4);
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const n = Math.sin(x * 0.5 + y * 0.3) * 3;
        let w = false;
        if (edge === 0) w = x + n < 14;
        else if (edge === 1) w = x - n > GRID - 15;
        else if (edge === 2) w = y + n < 14;
        else w = y - n > GRID - 15;
        if (w) setWater(g, x, y);
      }
    }
  } else if (biome === "river") {
    const vert = rand(seed, "river:vert") < 0.5;
    const phase = rand(seed, "river:phase") * 6.28;
    for (let a = 0; a < GRID; a++) {
      const c = Math.round(CENTER + Math.sin(a * 0.16 + phase) * 16 + Math.sin(a * 0.5) * 5);
      for (let w = -3; w <= 3; w++) {
        if (vert) setWater(g, c + w, a);
        else setWater(g, a, c + w);
      }
    }
  } else if (biome === "lakes") {
    const nl = 2 + randInt(seed, "lakes:n", 3);
    for (let i = 0; i < nl; i++) {
      const lx = 14 + Math.floor(rand(seed, `lakes:x:${i}`) * (GRID - 28));
      const ly = 14 + Math.floor(rand(seed, `lakes:y:${i}`) * (GRID - 28));
      const r = 6 + rand(seed, `lakes:r:${i}`) * 7;
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          const d = Math.hypot(x - lx, y - ly) + Math.sin(x * 0.7) * 0.8;
          if (d < r) setWater(g, x, y);
        }
      }
    }
  } else {
    // hills: raised blobs + a small pond
    const nh = 2 + randInt(seed, "hills:n", 3);
    for (let i = 0; i < nh; i++) {
      const hx = 18 + Math.floor(rand(seed, `hills:x:${i}`) * (GRID - 36));
      const hy = 18 + Math.floor(rand(seed, `hills:y:${i}`) * (GRID - 36));
      const r = 8 + rand(seed, `hills:r:${i}`) * 7;
      const e = 5 + rand(seed, `hills:e:${i}`) * 6;
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          const d = Math.hypot(x - hx, y - hy);
          if (d < r) g.ground[y]![x]!.elev = Math.max(g.ground[y]![x]!.elev, Math.round(e * (1 - d / r)));
        }
      }
    }
    const px = 40 + Math.floor(rand(seed, "hills:pondx") * 40);
    const py = 40 + Math.floor(rand(seed, "hills:pondy") * 40);
    for (let y = py - 3; y <= py + 3; y++)
      for (let x = px - 3; x <= px + 3; x++) if (Math.hypot(x - px, y - py) < 3.4) setWater(g, x, y);
  }
  addSandRim(g);
}

function addSandRim(g: Geo): void {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const c = g.ground[y]![x]!;
      if (c.t !== "grass" && c.t !== "grass2") continue;
      let near = false;
      for (const [ox, oy] of NEIGHBORS) if (isWater(g, x + ox, y + oy)) near = true;
      if (near) {
        c.t = "sand";
        c.elev = 0;
      }
    }
  }
}

/** Rebuild ground from seed then overlay a known water set (checkpoint resume). */
export function rebuildTerrain(g: Geo, water: Coord[]): void {
  genTerrain(g);
  for (const [x, y] of water) setWater(g, x, y);
  addSandRim(g);
}

// ============================ chunk / tile helpers ============================

export function chunkOf(x: number, y: number): { cx: number; cy: number } {
  return { cx: Math.floor(x / CHUNK), cy: Math.floor(y / CHUNK) };
}

export function isRevealed(g: Geo, x: number, y: number): boolean {
  if (!inBounds(x, y)) return false;
  const { cx, cy } = chunkOf(x, y);
  return g.revealed.has(chKey(cx, cy));
}

export function isWater(g: Geo, x: number, y: number): boolean {
  return inBounds(x, y) && g.ground[y]![x]!.t === "water";
}

export function heightAt(g: Geo, x: number, y: number): number {
  return inBounds(x, y) ? g.ground[y]![x]!.elev : 0;
}

export function tileFree(g: Geo, x: number, y: number): boolean {
  if (!isRevealed(g, x, y) || isWater(g, x, y)) return false;
  if (g.occupied.has(key(x, y))) return false;
  const t = g.ground[y]![x]!.t;
  return t !== "road" && t !== "stone";
}

export function setRoad(g: Geo, x: number, y: number, type: "road" | "stone" = "road"): void {
  if (!isRevealed(g, x, y) || isWater(g, x, y)) return;
  const c = g.ground[y]![x]!;
  if (c.t === "road" || c.t === "stone") return;
  c.t = type;
  g.roadSet.add(key(x, y));
}

// ============================ road BFS (A* on uniform grid) ============================

/** BFS from (sx,sy) to the nearest existing road tile; returns carved path. */
export function pathRoad(g: Geo, sx: number, sy: number): Coord[] {
  const start = key(sx, sy);
  const queue: Coord[] = [[sx, sy]];
  const prev = new Map<string, string | null>([[start, null]]);
  let goal: Coord | null = null;
  let head = 0;
  while (head < queue.length) {
    const [x, y] = queue[head++]!;
    if (g.roadSet.has(key(x, y)) && !(x === sx && y === sy)) {
      goal = [x, y];
      break;
    }
    for (const [ox, oy] of NEIGHBORS) {
      const nx = x + ox;
      const ny = y + oy;
      const k = key(nx, ny);
      if (prev.has(k)) continue;
      if (!isRevealed(g, nx, ny) || isWater(g, nx, ny)) continue;
      if (g.occupied.has(k) && !(nx === sx && ny === sy)) continue;
      prev.set(k, key(x, y));
      queue.push([nx, ny]);
    }
  }
  if (!goal) return [];
  const carved: Coord[] = [];
  let cur: string | null = key(goal[0], goal[1]);
  while (cur) {
    const [cx, cy] = cur.split(",").map(Number) as [number, number];
    if (!(cx === sx && cy === sy) && !g.roadSet.has(cur)) {
      setRoad(g, cx, cy);
      carved.push([cx, cy]);
    }
    cur = prev.get(cur) ?? null;
  }
  carved.reverse();
  return carved;
}

// ============================ placement ============================

export function clusterCentroid(g: Geo, cat: Category): { x: number; y: number } {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (const l of g.lotsGeo) {
    const w = l.cat === cat ? 4 : 1;
    sx += l.x * w;
    sy += l.y * w;
    n += w;
  }
  if (!n) return { x: g.origin.x, y: g.origin.y };
  return { x: sx / n, y: sy / n };
}

/** District-affinity placement: ring search around the category centroid with
 * seeded jitter, scoring same-category adjacency + growth-direction bias. */
function affinitySpot(g: Geo, cat: Category, kb: string): Coord | null {
  const cen = clusterCentroid(g, cat);
  let best: Coord | null = null;
  let bestScore = -Infinity;
  for (let r = 1; r <= 9; r++) {
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2 + rand(g.seed, `${kb}:ang:${r}:${a}`) * 0.2;
      const x = Math.round(cen.x + Math.cos(ang) * r + (rand(g.seed, `${kb}:jx:${r}:${a}`) - 0.5) * 1.5);
      const y = Math.round(cen.y + Math.sin(ang) * r + (rand(g.seed, `${kb}:jy:${r}:${a}`) - 0.5) * 1.5);
      if (!tileFree(g, x, y)) continue;
      let score = -r + rand(g.seed, `${kb}:s:${r}:${a}`) * 1.5;
      for (const l of g.lotsGeo) {
        const d = Math.hypot(l.x - x, l.y - y);
        if (d < 3.5) score += l.cat === cat ? (3.5 - d) * 2 : -(3.5 - d) * 0.6;
      }
      score += ((x - g.origin.x) * g.growthVec.x + (y - g.origin.y) * g.growthVec.y) * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = [x, y];
      }
    }
    if (best && r >= 2) break;
  }
  if (!best) {
    // fallback: nearest free tile spiralling out from origin
    outer: for (let r = 1; r < 14; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const x = g.origin.x + dx;
          const y = g.origin.y + dy;
          if (tileFree(g, x, y)) {
            best = [x, y];
            break outer;
          }
        }
  }
  return best;
}

/** Guarantee `spot` touches revealed water (harbor rule): if no neighbour is
 * water, carve a small inlet on the growth-facing side. Deterministic. */
export function ensureWaterNeighbor(g: Geo, spot: Coord, _kb: string): void {
  const [sx, sy] = spot;
  for (const [ox, oy] of NEIGHBORS) {
    if (isWater(g, sx + ox, sy + oy)) {
      const { cx, cy } = chunkOf(sx + ox, sy + oy);
      g.revealed.add(chKey(cx, cy)); // make sure it counts as revealed water
      return;
    }
  }
  const carveable = (x: number, y: number) => {
    if (x < 1 || y < 1 || x >= GRID - 1 || y >= GRID - 1) return false;
    const t = g.ground[y]![x]!.t;
    return t !== "road" && t !== "stone" && !g.occupied.has(key(x, y));
  };
  const cands = NEIGHBORS.map(([ox, oy]) => [sx + ox, sy + oy] as Coord).filter(([x, y]) => carveable(x, y));
  if (!cands.length) return;
  cands.sort((a, b) => {
    const sa = (a[0] - g.origin.x) * g.growthVec.x + (a[1] - g.origin.y) * g.growthVec.y;
    const sb = (b[0] - g.origin.x) * g.growthVec.x + (b[1] - g.origin.y) * g.growthVec.y;
    return sb - sa || a[0] - b[0] || a[1] - b[1];
  });
  const [wx, wy] = cands[0]!;
  g.revealed.add(chKey(chunkOf(wx, wy).cx, chunkOf(wx, wy).cy));
  setWater(g, wx, wy);
  // extend one tile further for a small basin
  const ex = wx + Math.sign(wx - sx);
  const ey = wy + Math.sign(wy - sy);
  if (carveable(ex, ey)) {
    g.revealed.add(chKey(chunkOf(ex, ey).cx, chunkOf(ex, ey).cy));
    setWater(g, ex, ey);
  }
  addSandRim(g);
}

/**
 * Find a placement tile for a new lot of the given category. Harbor (api) lots
 * are guaranteed to touch water (an inlet is carved if none is adjacent).
 * Others cluster by district affinity with seeded jitter. `placeIdx` is the
 * founding index (stable per repo) used as the random context.
 */
export function placeLot(
  g: Geo,
  cat: Category,
  placeIdx: number
): { pos: Coord } | null {
  const kb = `place:${placeIdx}`;
  const want = affinitySpot(g, cat, kb);
  if (!want) return null;
  if (cat === "api") ensureWaterNeighbor(g, want, kb);
  g.occupied.add(key(want[0], want[1]));
  g.lotsGeo.push({ x: want[0], y: want[1], cat });
  return { pos: want };
}

/** All water tiles inside currently-revealed chunks, sorted (model.biome.water). */
export function revealedWater(g: Geo): Coord[] {
  const out: Coord[] = [];
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++)
      if (g.ground[y]![x]!.t === "water" && isRevealed(g, x, y)) out.push([x, y]);
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out;
}

// ============================ expansion (fog recession) ============================

/**
 * Annex one fog chunk in the growth direction when built lots exceed 60% of the
 * revealed area. Returns the newly-revealed chunk (or null).
 */
export function maybeExpand(g: Geo, expandIdx: number): { cx: number; cy: number } | null {
  // "built lots exceed 60% of revealed area": buildings are sparse, so use a
  // lot-density proxy — expand when lots exceed 2.4 per revealed chunk.
  if (g.lotsGeo.length <= g.revealed.size * 2.4) return null;

  const cand: { cx: number; cy: number; score: number }[] = [];
  for (const rk of g.revealed) {
    const [cx, cy] = rk.split(",").map(Number) as [number, number];
    for (const [ox, oy] of NEIGHBORS) {
      const nx = cx + ox;
      const ny = cy + oy;
      if (nx < 0 || ny < 0 || nx >= GRIDCH || ny >= GRIDCH) continue;
      if (g.revealed.has(chKey(nx, ny))) continue;
      const align = (nx - CENTER / CHUNK) * g.growthVec.x + (ny - CENTER / CHUNK) * g.growthVec.y;
      cand.push({ cx: nx, cy: ny, score: align + rand(g.seed, `expand:${expandIdx}:${nx}:${ny}`) * 0.8 });
    }
  }
  if (!cand.length) return null;
  cand.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.cx - b.cx || a.cy - b.cy));
  const pick = cand[0]!;
  g.revealed.add(chKey(pick.cx, pick.cy));
  return { cx: pick.cx, cy: pick.cy };
}

/** A straight-ish rail path between two lot tiles (Manhattan then diagonal). */
export function railPath(a: Coord, b: Coord): Coord[] {
  const path: Coord[] = [];
  let [x, y] = a;
  path.push([x, y]);
  while (x !== b[0] || y !== b[1]) {
    if (x !== b[0]) x += Math.sign(b[0] - x);
    else if (y !== b[1]) y += Math.sign(b[1] - y);
    path.push([x, y]);
  }
  return path;
}
