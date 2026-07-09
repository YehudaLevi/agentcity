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
  surveyed: Set<string>; // chunk keys "cx,cy" that growth has "surveyed" (log
  // moments only — terrain is fully visible from day 0, so this NO LONGER gates
  // visibility or placement; see isRevealed below).
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

// River channel half-width. The swept-disk carve guarantees the open channel is
// at least 2*RIVER_R tiles wide everywhere along the course (>= 3 by a wide
// margin at RIVER_R=3), matching the ~7-wide straight sections of the old band.
export const RIVER_R = 3;

/** Euclidean distance from point (px,py) to segment (ax,ay)-(bx,by). */
function distToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Carve a river by sweeping a disk of radius RIVER_R along the centreline
 * poly-line `centre(0..n-1)`: every tile within RIVER_R of a segment becomes
 * water. Unlike an axis-aligned per-scanline band, a swept disk has a CONSTANT
 * cross-section perpendicular to flow, so the channel never pinches at bends.
 * Pure f(centre): no RNG, so terrain stays seed-deterministic.
 */
function carveChannel(g: Geo, centre: (a: number) => Coord, n: number): void {
  const rc = Math.ceil(RIVER_R);
  for (let a = 0; a < n - 1; a++) {
    const [ax, ay] = centre(a);
    const [bx, by] = centre(a + 1);
    const lox = Math.min(ax, bx) - rc;
    const hix = Math.max(ax, bx) + rc;
    const loy = Math.min(ay, by) - rc;
    const hiy = Math.max(ay, by) + rc;
    for (let y = loy; y <= hiy; y++) {
      for (let x = lox; x <= hix; x++) {
        if (distToSegment(x, y, ax, ay, bx, by) <= RIVER_R) setWater(g, x, y);
      }
    }
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
    // River channel: a fixed-radius disk swept along the meandering centreline
    // (a "capsule" between consecutive centre points). The old per-scanline band
    // (`for w=-3..3`) laid a 7-wide span PERPENDICULAR TO THE SCAN AXIS, so where
    // the river turned to flow *along* that axis its visible width collapsed to
    // ~1 tile (the meander-bend pinch users saw). Sweeping a radius-RIVER_R disk
    // along the actual course keeps the open water >= 2*RIVER_R wide everywhere —
    // bends included — while preserving the exact meander (centreline formula
    // unchanged) and determinism (seed-only: vert/phase from rand, no RNG).
    const vert = rand(seed, "river:vert") < 0.5;
    const phase = rand(seed, "river:phase") * 6.28;
    const centre = (a: number): Coord => {
      const c = Math.round(CENTER + Math.sin(a * 0.16 + phase) * 16 + Math.sin(a * 0.5) * 5);
      return vert ? [c, a] : [a, c];
    };
    carveChannel(g, centre, GRID);
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

// Fog-of-war removed (game-rules §5, amended 2026-07-09): the FULL terrain is
// generated and visible from day 0, so "revealed" == "in bounds". Kept as a
// named predicate (rather than inlining inBounds) so placement reads as
// "is this tile on the visible map"; the `g` arg is unused by design.
export function isRevealed(_g: Geo, x: number, y: number): boolean {
  return inBounds(x, y);
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

// ============================ lot-spacing invariants (game-rules §5) ============================
//
// Real-data dogfooding showed buildings packing wall-to-wall with no streets.
// Three invariants keep the town readable (candidates that violate them are
// rejected in affinitySpot / placeLot):
//   1. SPACING — no two lots may be orthogonally adjacent; every lot keeps a
//      1-tile clear ring (road or ground, never another lot).
//   2. STREET-FRONTING — every lot ends up orthogonally adjacent to a road tile
//      (enforced by the compiler's pathRoad carve, which always lands a road
//      tile next to the lot; see lotTouchesRoad for the assertion helper).
//   3. BLOCK RULE — no king-connected (diagonal) lot cluster may exceed a 2x2
//      tile footprint, so blocks stay small and streets thread between them.

const KING: Coord[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** SPACING: does any orthogonal neighbour already hold a lot? */
export function hasOrthoLot(g: Geo, x: number, y: number): boolean {
  for (const [ox, oy] of NEIGHBORS) if (g.occupied.has(key(x + ox, y + oy))) return true;
  return false;
}

/** STREET-FRONTING assertion helper: is (x,y) orthogonally adjacent to a road? */
export function lotTouchesRoad(g: Geo, x: number, y: number): boolean {
  for (const [ox, oy] of NEIGHBORS) if (g.roadSet.has(key(x + ox, y + oy))) return true;
  return false;
}

/**
 * BLOCK RULE: bounding box of the king-connected (diagonal) lot cluster that
 * placing a lot at (x,y) would join. Lots are never orthogonally adjacent, so
 * clusters form only through diagonal contact; capping the footprint at 2x2
 * tiles breaks long diagonal "walls".
 */
function clusterFootprint(g: Geo, x: number, y: number): { w: number; h: number } {
  const present = new Set(g.lotsGeo.map((l) => key(l.x, l.y)));
  present.add(key(x, y));
  const seen = new Set([key(x, y)]);
  const stack: Coord[] = [[x, y]];
  let minx = x, maxx = x, miny = y, maxy = y;
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    minx = Math.min(minx, cx); maxx = Math.max(maxx, cx);
    miny = Math.min(miny, cy); maxy = Math.max(maxy, cy);
    for (const [ox, oy] of KING) {
      const nk = key(cx + ox, cy + oy);
      if (present.has(nk) && !seen.has(nk)) {
        seen.add(nk);
        stack.push([cx + ox, cy + oy]);
      }
    }
  }
  return { w: maxx - minx + 1, h: maxy - miny + 1 };
}

/** A candidate tile is valid for a new lot if it is free, keeps the 1-tile ring
 * (spacing), and — when `strict` — does not overgrow a diagonal block. */
function lotSiteValid(g: Geo, x: number, y: number, strict: boolean): boolean {
  if (!tileFree(g, x, y)) return false;
  if (hasOrthoLot(g, x, y)) return false;
  if (strict) {
    const bb = clusterFootprint(g, x, y);
    if (bb.w > 2 || bb.h > 2) return false;
  }
  return true;
}

/**
 * ROAD HIERARCHY (game-rules §5): a top-tier corridor becomes a 2-tile-wide
 * avenue. For each tile on `path`, lay one parallel road tile on a free
 * perpendicular side. Returns the newly-laid tiles (sorted) so the caller can
 * extend roads[].path and emit them; the road's tier/id/naming are unchanged.
 */
export function widenAvenue(g: Geo, path: Coord[]): Coord[] {
  const inPath = new Set(path.map(([x, y]) => key(x, y)));
  const added: Coord[] = [];
  const canLay = (x: number, y: number): boolean => {
    if (!inBounds(x, y) || inPath.has(key(x, y))) return false;
    if (!isRevealed(g, x, y) || isWater(g, x, y) || g.occupied.has(key(x, y))) return false;
    const t = g.ground[y]![x]!.t;
    return t !== "road" && t !== "stone";
  };
  for (let i = 0; i < path.length; i++) {
    const [x, y] = path[i]!;
    const ref = path[i + 1] ?? path[i - 1];
    if (!ref) continue;
    const adx = Math.sign(ref[0] - x);
    const ady = Math.sign(ref[1] - y);
    // two perpendicular sides; pick the first free one, deterministically
    for (const [px, py] of [
      [x - ady, y + adx],
      [x + ady, y - adx],
    ] as Coord[]) {
      if (canLay(px, py)) {
        setRoad(g, px, py);
        inPath.add(key(px, py));
        added.push([px, py]);
        break;
      }
    }
  }
  added.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return added;
}

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
      if (!lotSiteValid(g, x, y, true)) continue;
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
    // fallback: nearest tile spiralling out from origin. Try the full invariant
    // set first (spacing + block rule), then relax the soft block rule, then
    // spacing-only, so a lot is still placed when the town gets dense — but the
    // 1-tile spacing ring is only ever dropped as a last resort.
    for (const mode of [2, 1, 0] as const) {
      outer: for (let r = 1; r < 26; r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const x = g.origin.x + dx;
            const y = g.origin.y + dy;
            const ok =
              mode === 2 ? lotSiteValid(g, x, y, true)
              : mode === 1 ? lotSiteValid(g, x, y, false)
              : tileFree(g, x, y);
            if (ok) {
              best = [x, y];
              break outer;
            }
          }
      if (best) break;
    }
  }
  return best;
}

/** Guarantee `spot` touches revealed water (harbor rule): if no neighbour is
 * water, carve a small inlet on the growth-facing side. Deterministic. */
export function ensureWaterNeighbor(g: Geo, spot: Coord, _kb: string): void {
  const [sx, sy] = spot;
  for (const [ox, oy] of NEIGHBORS) {
    if (isWater(g, sx + ox, sy + oy)) return; // already touches (now-always-visible) water
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
  setWater(g, wx, wy);
  // extend one tile further for a small basin
  const ex = wx + Math.sign(wx - sx);
  const ey = wy + Math.sign(wy - sy);
  if (carveable(ex, ey)) setWater(g, ex, ey);
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

/** Every water tile in the world, sorted (model.biome.water). Terrain is fully
 * visible from day 0, so this is the whole seed-derived coastline/lakes/rivers
 * plus any api inlets carved in-place. */
export function allWater(g: Geo): Coord[] {
  const out: Coord[] = [];
  for (let y = 0; y < GRID; y++)
    for (let x = 0; x < GRID; x++)
      if (g.ground[y]![x]!.t === "water") out.push([x, y]);
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out;
}

// ============================ expansion (district surveying) ============================

/**
 * "Survey" one un-surveyed chunk in the growth direction when built lots exceed
 * the density trigger. Fog-of-war is gone — this no longer reveals terrain (it
 * is all visible from day 0); it only marks a "district surveyed" moment the
 * renderer/log shows. Returns the newly-surveyed chunk (or null).
 */
export function maybeSurvey(g: Geo, surveyIdx: number): { cx: number; cy: number } | null {
  // lot-density proxy — survey a new district when lots exceed 2.4 per
  // already-surveyed chunk (same trigger the fog recession used).
  if (g.lotsGeo.length <= g.surveyed.size * 2.4) return null;

  const cand: { cx: number; cy: number; score: number }[] = [];
  for (const rk of g.surveyed) {
    const [cx, cy] = rk.split(",").map(Number) as [number, number];
    for (const [ox, oy] of NEIGHBORS) {
      const nx = cx + ox;
      const ny = cy + oy;
      if (nx < 0 || ny < 0 || nx >= GRIDCH || ny >= GRIDCH) continue;
      if (g.surveyed.has(chKey(nx, ny))) continue;
      const align = (nx - CENTER / CHUNK) * g.growthVec.x + (ny - CENTER / CHUNK) * g.growthVec.y;
      cand.push({ cx: nx, cy: ny, score: align + rand(g.seed, `survey:${surveyIdx}:${nx}:${ny}`) * 0.8 });
    }
  }
  if (!cand.length) return null;
  cand.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.cx - b.cx || a.cy - b.cy));
  const pick = cand[0]!;
  g.surveyed.add(chKey(pick.cx, pick.cy));
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
