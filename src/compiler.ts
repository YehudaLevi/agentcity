// agentcity — the compiler. renderCity(gamifiedEvents, seed, opts) ->
// {model, deltas, dropped}, day-granular and PURE (no Date.now/Math.random):
// the ONE pipeline both the local server (scene "solo") and the federation hub
// (scene "shared") fold through.

import type {
  CityConfig,
  CityModel,
  CityDelta,
  ILot,
  IRoad,
  Rail,
  Chunk,
  Landmark,
  Baseline,
  Category,
  Coord,
  DeltaKind,
  LandmarkKind,
} from "./types.js";
import { variantOf, rand } from "./seed.js";
import type { GamifiedEvent, ProjectId } from "./gamified/types.js";
import { tileId, isTreehouse } from "./gamified/types.js";
import { cappedTier, tierCapFor, tierProgress, TIER_THRESHOLDS, MAX_TIER } from "./rules/tiers.js";
import { decayLevel } from "./rules/tiers.js";
import { citizensFor, petsFor, SHIP_PER_WU } from "./rules/population.js";
import { newMilestones } from "./rules/milestones.js";
import type { MilestoneFlags } from "./rules/milestones.js";
import {
  type Geo,
  biomeOf,
  growthDirOf,
  genTerrain,
  chunkOf,
  isRevealed,
  isWater,
  tileFree,
  setRoad,
  pathRoad,
  placeLot,
  maybeSurvey,
  railPath,
  allWater,
  widenAvenue,
  CHUNK,
  GRID,
  GRIDCH,
  CENTER,
} from "./rules/placement.js";

const DEFAULT_CONFIG: CityConfig = { historyInfluence: "full", aliases: {} };

// ============================ time helpers ============================

function dateKey(ts: string): string {
  return ts.slice(0, 10);
}
function dayIndex(ts: string, foundedKey: string): number {
  const a = Date.parse(`${dateKey(ts)}T00:00:00Z`);
  const b = Date.parse(`${foundedKey}T00:00:00Z`);
  return Math.round((a - b) / 86400000);
}
// ============================ internal state ============================

/**
 * `scene` = what KIND of city this is. "solo" = one founder's city (founder
 * cottage + hamlet props, tiers capped by the user's historyInfluence); "shared"
 * = a merged multi-contributor city (no single founder, tiers uncapped since
 * per-user caps already applied). The local server renders a SOLO city; the hub
 * renders a SHARED one — same pipeline, different scene.
 */
export type Scene = "solo" | "shared";

interface State {
  seed: string;
  config: CityConfig;
  scene: Scene;
  dropped: number; // lots that couldn't be placed (world full) — reported, not lost
  geo: Geo;
  ilots: ILot[];
  lotByRepo: Map<string, ILot>;
  iroads: IRoad[];
  rails: Rail[];
  railPairs: Set<string>;
  chunks: Chunk[];
  landmarks: Landmark[];
  baseline: Baseline;
  // economy / aux
  globalWU: number;
  nextShipWU: number;
  shipCount: number;
  cumTurns: number;
  cumForks: number;
  repoCount: number;
  perDayWU: number[];
  perDayForks: number[];
  milestones: MilestoneFlags;
  allNighterUntilDay: number;
  sessionRepos: Map<string, string[]>;
  lotOrder: string[];
  population: number;
  pets: number;
  streak: number;
  allNighter: boolean;
  // running
  seq: number;
  day: number;
  foundedTs: string;
  deltas: CityDelta[];
}

function emit(st: State, kind: DeltaKind, fields: Record<string, unknown>): void {
  st.deltas.push({ day: st.day, seq: st.seq++, kind, ...fields });
}

// ============================ init ============================

function snapOrigin(geo: Geo, x: number, y: number): { x: number; y: number } {
  if (isRevealed(geo, x, y) && !isWater(geo, x, y)) return { x, y };
  for (let r = 1; r < 14; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (isRevealed(geo, nx, ny) && !isWater(geo, nx, ny)) return { x: nx, y: ny };
      }
    }
  }
  return { x, y };
}

function initState(seed: string, config: CityConfig, scene: Scene = "solo"): State {
  const biome = biomeOf(seed);
  const growth = growthDirOf(seed);
  const geo: Geo = {
    seed,
    biome,
    growthVec: growth.vec,
    growthDir: growth.name,
    origin: { x: CENTER, y: CENTER },
    ground: [],
    occupied: new Set(),
    roadSet: new Set(),
    surveyed: new Set(),
    lotsGeo: [],
  };
  genTerrain(geo);
  // Fog-of-war removed (game-rules §5, amended 2026-07-09): generate the ENTIRE
  // world's terrain from seed and mark EVERY chunk revealed on day 0 (geography
  // before buildings). model.chunks keeps its Contract shape; the renderer still
  // reads it, now finding all chunks revealed.
  const chunks: Chunk[] = [];
  for (let cx = 0; cx < GRIDCH; cx++) {
    for (let cy = 0; cy < GRIDCH; cy++) {
      chunks.push({ x: cx, y: cy, revealed: true, revealedDay: 0 });
    }
  }
  // The founding district (center 2x2 chunks, tiles 20..39) is "surveyed" at
  // founding; further districts are surveyed as the city grows (maybeSurvey).
  for (const cx of [2, 3]) for (const cy of [2, 3]) geo.surveyed.add(`${cx},${cy}`);
  // seed-chosen origin (NOT center)
  const q = Math.floor(rand(seed, "origin:q") * 4);
  const ox = CENTER + (q & 1 ? -1 : 1) * (3 + Math.floor(rand(seed, "origin:dx") * 4));
  const oy = CENTER + (q & 2 ? -1 : 1) * (3 + Math.floor(rand(seed, "origin:dy") * 4));
  geo.origin = snapOrigin(geo, ox, oy);

  const st: State = {
    seed,
    config,
    scene,
    dropped: 0,
    geo,
    ilots: [],
    lotByRepo: new Map(),
    iroads: [],
    rails: [],
    railPairs: new Set(),
    chunks,
    landmarks: [],
    baseline: { housePos: [geo.origin.x, geo.origin.y], roadPath: [], props: [] },
    globalWU: 0,
    nextShipWU: SHIP_PER_WU,
    shipCount: 0,
    cumTurns: 0,
    cumForks: 0,
    repoCount: 0,
    perDayWU: [],
    perDayForks: [],
    milestones: { fountain: false, statue: false, fireworks: false, plaque: false },
    allNighterUntilDay: -1,
    sessionRepos: new Map(),
    lotOrder: [],
    population: 0,
    pets: 0,
    streak: 0,
    allNighter: false,
    seq: 0,
    day: 0,
    foundedTs: "",
    deltas: [],
  };

  buildBaseline(st);
  return st;
}

function buildBaseline(st: State): void {
  const { geo } = st;
  const ox = geo.origin.x;
  const oy = geo.origin.y;
  // dirt-road bend (L shape) through the plaza so first lots can path to it
  const roadPath: Coord[] = [];
  const bend: Coord[] = [
    [ox, oy],
    [ox + 1, oy],
    [ox + 2, oy],
    [ox, oy + 1],
    [ox, oy + 2],
  ];
  for (const [x, y] of bend) {
    setRoad(geo, x, y, x === ox && y === oy ? "stone" : "road");
    roadPath.push([x, y]);
  }
  // props: well + tree, plus a boat if water is near
  const props: Baseline["props"] = [
    { kind: "well", pos: [ox + 1, oy + 1] },
    { kind: "tree", pos: [ox - 1, oy - 1] },
  ];
  let boat: Coord | null = null;
  for (let r = 1; r <= 10 && !boat; r++) {
    for (let dy = -r; dy <= r && !boat; dy++)
      for (let dx = -r; dx <= r && !boat; dx++) {
        if (isWater(geo, ox + dx, oy + dy)) boat = [ox + dx, oy + dy];
      }
  }
  if (boat) props.push({ kind: "boat", pos: boat });
  // A SHARED city has no single founder: keep the central plaza road, drop the
  // founder cottage + hamlet props. A SOLO city (local, single-user) keeps the
  // founder hamlet — Yehuda's original.
  st.baseline = st.scene === "shared"
    ? { housePos: [ox, oy], roadPath, props: [], hamlet: false }
    : { housePos: [ox, oy], roadPath, props };

  // baseline.init carries the renderer bootstrap (seed/foundedTs/biome/baseline).
  // biome.water and foundedTs are back-patched at finalize (final revealed water,
  // first-event date) so the renderer's delta-replay reconstructs model.biome.
  emit(st, "baseline.init", {
    seed: st.seed,
    foundedTs: st.foundedTs,
    biome: {
      kind: st.geo.biome,
      water: [] as Coord[],
      origin: [st.geo.origin.x, st.geo.origin.y],
      growthDir: st.geo.growthDir,
    },
    baseline: st.baseline,
  });
  // chunk.reveal is no longer emitted for map-existence (all chunks are revealed
  // in the model from day 0). It now marks a "district surveyed" moment: emit one
  // per founding-district chunk on day 0; growth surveys further chunks later.
  for (const k of [...st.geo.surveyed].sort()) {
    const [cx, cy] = k.split(",").map(Number) as [number, number];
    emit(st, "chunk.reveal", { x: cx, y: cy, revealedDay: 0, surveyed: true });
  }
}

// ============================ day step ============================

/** A per-(tile, day) merged fact — renderCity's unit of work. `repo` is the
 * stable tile identity; `display` is the shown name. */
interface Activity {
  repo: string;
  display: string;
  firstTs: string;
  turns: number;
  forks: number;
  founding: boolean;
  allnighter: boolean;
  sessionIds: Set<string>;
  wu: number; // day's WU (already economy-capped upstream by gamify)
  category: Category;
  secondary: Category | null;
  contributors: string[]; // handles active on this tile so far (cumulative)
  personal: boolean; // non-repo workspace -> treehouse
}

function foundLot(st: State, a: Activity): void {
  const category = a.category ?? "code";
  const secondary = a.secondary ?? null;
  const placeIdx = st.lotOrder.length;
  // Uniform placement (classic affinity) for git and per-user projects alike —
  // per-user tiles are an identity/dedup concept, never a spatial one.
  const placed = placeLot(st.geo, category, placeIdx);
  if (!placed) {
    st.dropped++;
    return;
  }
  const [x, y] = placed.pos;
  const alias = `building-${placeIdx + 1}`;
  const lot: ILot = {
    id: `h(${a.repo})`,
    repo: a.display ?? a.repo,
    alias,
    category,
    secondary,
    x,
    y,
    wu: 0,
    tier: 0,
    prevTier: 0,
    foundedDay: st.day,
    lastActiveDay: st.day,
    decay: 0,
    variant: variantOf(st.seed, a.repo),
    roadId: null,
    lastUpgradeDay: -1,
    lastRenovateDay: -1,
    contributors: a.contributors,
    personal: a.personal,
  };
  st.ilots.push(lot);
  st.lotByRepo.set(a.repo, lot);
  st.lotOrder.push(a.repo);
  st.repoCount++;
  if (!st.foundedTs) st.foundedTs = dateKey(a.firstTs);

  emit(st, "lot.found", {
    id: lot.id,
    repo: lot.repo,
    alias: lot.alias,
    category: lot.category,
    secondary: lot.secondary,
    pos: [x, y],
    tier: 0,
    wu: 0,
    wuIntoTier: 0,
    wuNextTier: TIER_THRESHOLDS[1],
    variant: lot.variant,
    foundedDay: st.day,
    lastActiveDay: st.day,
    contributors: lot.contributors,
    personal: lot.personal,
  });

  // road from lot to nearest road
  const carved = pathRoad(st.geo, x, y);
  if (carved.length) {
    const road: IRoad = { id: `r${st.iroads.length}`, path: carved, tier: 0, usage: 0, lotRepo: a.repo };
    st.iroads.push(road);
    lot.roadId = road.id;
    emit(st, "road.add", { id: road.id, path: road.path, tier: road.tier });
  }

  // ship arrives on founding
  st.shipCount++;
  emit(st, "ship.arrive", { cargo: "founding", repo: a.repo });

  // growth may survey a new district
  surveyStep(st);
}

/** If lot density has grown enough, survey one new district and log the moment.
 * Emits chunk.reveal{surveyed:true}; terrain existence is NOT touched (all chunks
 * are already revealed in the model). renderCity folds the whole stream in one
 * deterministic pass, so each survey emits exactly once. */
function surveyStep(st: State): void {
  const picked = maybeSurvey(st.geo, st.geo.surveyed.size);
  if (picked) {
    emit(st, "chunk.reveal", { x: picked.cx, y: picked.cy, revealedDay: st.day, surveyed: true });
  }
}

function detectCoupling(st: State, acts: Activity[]): void {
  // Session-based rails, uniform across classic and gamified paths: projects
  // worked in the same agent session (shared hashed session id) get railed. In
  // the gamified stream this couples collaborators naturally — a session id
  // hashes identically for every contributor who shared it.
  // record today's session->repos, then rail newly co-occurring founded pairs
  const touched = new Set<string>();
  for (const a of acts) {
    for (const s of a.sessionIds) {
      touched.add(s);
      const list = st.sessionRepos.get(s) ?? [];
      if (!list.includes(a.repo)) list.push(a.repo);
      st.sessionRepos.set(s, list);
    }
  }
  for (const s of [...touched].sort()) {
    const repos = (st.sessionRepos.get(s) ?? []).slice().sort();
    for (let i = 0; i < repos.length; i++) {
      for (let j = i + 1; j < repos.length; j++) {
        const ra = repos[i]!;
        const rb = repos[j]!;
        const la = st.lotByRepo.get(ra);
        const lb = st.lotByRepo.get(rb);
        if (!la || !lb) continue;
        const pk = `${ra}|${rb}`;
        if (st.railPairs.has(pk)) continue;
        st.railPairs.add(pk);
        const path = railPath([la.x, la.y], [lb.x, lb.y]);
        const rail: Rail = { between: [la.id, lb.id], path };
        st.rails.push(rail);
        emit(st, "rail.add", { between: rail.between, path: rail.path });
      }
    }
  }
}

function applyEconomy(st: State, acts: Activity[]): void {
  // WU is already economy-capped upstream by gamify (per-repo warehouse + global
  // cap), so the fold takes it as-is. Tier cap (scene): a SOLO city honors the
  // user's historyInfluence; a SHARED city sums per-user-capped WU across
  // contributors, so it caps at MAX_TIER.
  const cap = st.scene === "shared" ? MAX_TIER : tierCapFor(st.config.historyInfluence);
  const spendables = acts.map((a) => ({ repo: a.repo, spendable: a.wu ?? 0, a }));
  // deterministic order by repo name
  spendables.sort((p, q) => (p.repo < q.repo ? -1 : p.repo > q.repo ? 1 : 0));
  let dayWU = 0;
  let dayForks = 0;
  const activeCount = acts.length;
  for (const s of spendables) {
    const spend = s.spendable;
    const lot = st.lotByRepo.get(s.repo);
    if (!lot) continue;
    // accumulate real turns/forks for milestones (uncapped)
    st.cumTurns += s.a.turns;
    st.cumForks += s.a.forks;
    dayForks += s.a.forks;
    lot.lastActiveDay = st.day;
    if (s.a.allnighter) st.allNighterUntilDay = st.day + 1;
    // renovation on revival
    if (lot.decay > 0) {
      lot.decay = 0;
      lot.lastRenovateDay = st.day;
      emit(st, "lot.renovate", { id: lot.id, lastActiveDay: st.day });
    }
    lot.wu += spend;
    st.globalWU += spend;
    dayWU += spend;
    // keep the contributor set current, and surface a change even when it doesn't
    // cross a tier (so attribution updates live as new contributors join a tile).
    let contribChanged = false;
    if (s.a.contributors) {
      const next = s.a.contributors.join(",");
      if ((lot.contributors ?? []).join(",") !== next) {
        lot.contributors = s.a.contributors;
        contribChanged = true;
      }
    }
    // tier check
    const nt = cappedTier(lot.wu, cap);
    const tierUp = nt > lot.tier;
    if (tierUp) {
      lot.prevTier = lot.tier;
      lot.tier = nt;
      lot.lastUpgradeDay = st.day;
    }
    if (tierUp || contribChanged) {
      const tp = tierProgress(lot.wu, lot.tier);
      emit(st, "lot.upgrade", {
        id: lot.id,
        tier: lot.tier,
        wu: lot.wu,
        wuIntoTier: tp.wuIntoTier,
        wuNextTier: tp.wuNextTier,
        lastActiveDay: st.day,
        contributors: lot.contributors,
      });
      if (tierUp) surveyStep(st);
    }
    // road usage: busy corridors upgrade (repo worked alongside neighbors)
    if (lot.roadId && activeCount >= 2) {
      const road = st.iroads.find((r) => r.id === lot.roadId);
      if (road) {
        road.usage++;
        const rt = roadTier(road.usage);
        if (rt > road.tier) {
          road.tier = rt;
          const fields: Record<string, unknown> = { id: road.id, tier: rt };
          // top-tier corridors become 2-tile-wide avenues: lay parallel road
          // tiles and carry the widened path on the delta so replay matches.
          if (rt >= 3) {
            const extra = widenAvenue(st.geo, road.path);
            if (extra.length) {
              road.path = [...road.path, ...extra];
              fields.path = road.path;
            }
          }
          emit(st, "road.upgrade", fields);
        }
      }
    }
  }
  st.perDayWU[st.day] = (st.perDayWU[st.day] ?? 0) + dayWU;
  st.perDayForks[st.day] = (st.perDayForks[st.day] ?? 0) + dayForks;
}

function roadTier(usage: number): number {
  if (usage >= 30) return 3;
  if (usage >= 15) return 2;
  if (usage >= 5) return 1;
  return 0;
}

function shipsAndMilestones(st: State): void {
  while (st.globalWU >= st.nextShipWU) {
    st.shipCount++;
    st.nextShipWU += SHIP_PER_WU;
    emit(st, "ship.arrive", { shipKind: "cargo" });
  }
  const earned = newMilestones(st.milestones, {
    repoCount: st.repoCount,
    cumForks: st.cumForks,
    cumTurns: st.cumTurns,
    founded: !!st.foundedTs,
  });
  for (const kind of earned) placeLandmark(st, kind);
}

function placeLandmark(st: State, kind: LandmarkKind): void {
  const ox = st.geo.origin.x;
  const oy = st.geo.origin.y;
  let pos: Coord;
  if (kind === "fountain") pos = [ox, oy + 1];
  else if (kind === "statue") pos = [ox - 1, oy];
  else if (kind === "plaque") {
    const oldTown = st.ilots[0];
    pos = oldTown ? [oldTown.x, oldTown.y] : [ox, oy];
  } else pos = [ox, oy - 1]; // fireworks-spot
  const lm: Landmark = { kind, pos, day: st.day };
  st.landmarks.push(lm);
  // delta carries the landmark type as "landmarkKind" ("kind" is the delta type)
  emit(st, "landmark.add", { landmarkKind: kind, pos });
}

function decayPass(st: State): void {
  for (const lot of st.ilots) {
    const idle = st.day - lot.lastActiveDay;
    const nd = decayLevel(idle);
    if (nd !== lot.decay) {
      lot.decay = nd;
      emit(st, "lot.decay", { id: lot.id, level: nd });
    }
  }
}

function currentStreak(st: State): number {
  let streak = 0;
  for (let d = st.day; d >= 0; d--) {
    if ((st.perDayWU[d] ?? 0) > 0) streak++;
    else break;
  }
  return streak;
}

function populationPass(st: State): void {
  const pop = citizensFor(st.perDayWU, st.day);
  const pets = petsFor(st.perDayForks, st.day);
  const streak = currentStreak(st);
  const allNighter = st.allNighterUntilDay === st.day;
  if (
    pop !== st.population ||
    pets !== st.pets ||
    streak !== st.streak ||
    allNighter !== st.allNighter
  ) {
    st.population = pop;
    st.pets = pets;
    st.streak = streak;
    st.allNighter = allNighter;
    emit(st, "population.set", {
      population: pop,
      pets,
      streakDays: streak,
      allNighterYesterday: allNighter,
    });
  }
}

function stepActivities(st: State, acts: Activity[]): void {
  // foundings in first-appearance order
  const founders = acts.filter((a) => a.founding).sort((p, q) => (p.firstTs < q.firstTs ? -1 : p.firstTs > q.firstTs ? 1 : p.repo < q.repo ? -1 : 1));
  for (const a of founders) foundLot(st, a);
  detectCoupling(st, acts);
  applyEconomy(st, acts);
  shipsAndMilestones(st);
  decayPass(st);
  populationPass(st);
}

// ============================ model assembly ============================

function assembleModel(st: State): CityModel {
  const lots = st.ilots
    .slice()
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
    .map((l) => {
      const { wuIntoTier, wuNextTier } = tierProgress(l.wu, l.tier);
      return {
        id: l.id,
        repo: l.repo,
        alias: l.alias,
        category: l.category,
        secondary: l.secondary,
        pos: [l.x, l.y] as Coord,
        tier: l.tier,
        wu: l.wu,
        wuIntoTier,
        wuNextTier,
        foundedDay: l.foundedDay,
        lastActiveDay: l.lastActiveDay,
        decay: l.decay,
        underConstruction: l.lastUpgradeDay === st.day || l.lastRenovateDay === st.day,
        variant: l.variant,
        contributors: l.contributors,
        personal: l.personal,
      };
    });
  const roads = st.iroads.map((r) => ({ id: r.id, path: r.path, tier: r.tier }));
  const chunks = st.chunks.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const landmarks = st.landmarks.slice();
  const water = allWater(st.geo);

  return {
    version: 1,
    seed: st.seed,
    day: st.day,
    foundedTs: st.foundedTs || dateKey(new Date(0).toISOString()),
    biome: {
      kind: st.geo.biome,
      water,
      origin: [st.geo.origin.x, st.geo.origin.y],
      growthDir: st.geo.growthDir,
    },
    chunks,
    roads,
    rails: st.rails.slice(),
    lots,
    landmarks,
    stats: {
      totalWu: st.globalWU,
      population: st.population,
      pets: st.pets,
      ships: st.shipCount,
      streakDays: st.streak,
      allNighterYesterday: st.allNighter,
    },
    baseline: st.baseline,
  };
}

/**
 * Emit exactly ONE sync.lots as the FINAL delta of a fold. Per-lot wu/progress/
 * lastActiveDay/decay only change the model between lot.upgrade/lot.decay deltas
 * (WU keeps accruing within a tier with no delta of its own), so delta replay
 * would otherwise land on stale wu fields. This final overwrite makes replayed
 * state deep-equal the model. Deterministic order: sorted by repo (matches
 * assembleModel's lot order).
 */
function emitSyncLots(st: State): void {
  const lots = st.ilots
    .slice()
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
    .map((l) => {
      const { wuIntoTier, wuNextTier } = tierProgress(l.wu, l.tier);
      return {
        id: l.id,
        wu: l.wu,
        wuIntoTier,
        wuNextTier,
        lastActiveDay: l.lastActiveDay,
        decay: l.decay,
        // Seam fix: assembleModel derives underConstruction from
        // lastUpgradeDay/lastRenovateDay === current day, but the delta stream
        // has no signal a replayer can use to reconstruct it (lot.found seeds
        // it false and nothing flips it). Carry the exact value on the final
        // sync.lots so delta-replay lands byte-equal to the model. Only affects
        // deltas (not the model), so golden-model stays byte-identical.
        underConstruction: l.lastUpgradeDay === st.day || l.lastRenovateDay === st.day,
      };
    });
  emit(st, "sync.lots", { lots });
}

/** Back-patch the baseline.init delta with final biome/foundedTs for renderer replay. */
function patchBaselineDelta(st: State): void {
  const water = allWater(st.geo);
  for (const d of st.deltas) {
    if (d.kind === "baseline.init") {
      d.foundedTs = st.foundedTs;
      d.biome = {
        kind: st.geo.biome,
        water,
        origin: [st.geo.origin.x, st.geo.origin.y],
        growthDir: st.geo.growthDir,
      };
      break;
    }
  }
}

// ============================ renderCity (THE shared pipeline) ============================

/**
 * The one rendering pipeline: fold a gamified event stream into a CityModel +
 * delta timeline. Local (single contributor) and the federation hub (all
 * contributors merged) call the SAME function — the only difference is the
 * breadth of the input stream. Deterministic given (events, seed).
 *
 * Merge policy comes from the stream itself, via `tileId`:
 *   • git projects share a tile keyed by the remote — different contributors'
 *     work on the same repo merges into one building.
 *   • local (no-remote) projects get a per-user tile — never merged, rendered
 *     as a treehouse.
 * Days are recomputed against a SHARED calendar epoch (earliest ts across the
 * whole stream) so independently-gamified contributor streams align in time.
 */
export interface RenderResult {
  model: CityModel;
  deltas: CityDelta[];
  dropped: number;
}

interface TileDay {
  firstTs: string;
  wu: number;
  forks: number;
  turns: number;
  allnighter: boolean;
  sessions: Set<string>;
  today: Set<string>; // contributor handles active this day
  catWu: Map<Category, number>; // category weighted by wu (min 1) to pick a dominant
}

interface Tile {
  proj: ProjectId;
  display: string;
  personal: boolean;
  days: Map<number, TileDay>;
}

function pickCategory(catWu: Map<Category, number>): Category {
  let best: Category = "code";
  let bestWu = -1;
  for (const [c, w] of [...catWu.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (w > bestWu) {
      best = c;
      bestWu = w;
    }
  }
  return best;
}

export interface RenderOpts {
  config?: Partial<CityConfig>;
  /** "solo" (default) = founder's city; "shared" = merged multi-contributor hub. */
  scene?: Scene;
  /** Fold idle days through this day (time-travel) even past the last event. */
  throughDay?: number;
}

export function renderCity(events: GamifiedEvent[], seed: string, opts: RenderOpts = {}): RenderResult {
  const { config = {}, scene = "solo", throughDay } = opts;
  const cfg: CityConfig = { ...DEFAULT_CONFIG, ...config, aliases: config.aliases ?? {} };
  const st = initState(seed, cfg, scene);

  if (!events.length) {
    st.day = throughDay ?? 0;
    patchBaselineDelta(st);
    emitSyncLots(st);
    return { model: assembleModel(st), deltas: st.deltas, dropped: 0 };
  }

  // shared calendar: earliest timestamp across the merged stream is day 0.
  const epochKey = dateKey(events.reduce((m, e) => (e.ts < m ? e.ts : m), events[0]!.ts));
  st.foundedTs = epochKey;

  const tiles = new Map<string, Tile>();
  for (const e of events) {
    const tid = tileId(e.proj, e.by);
    let tile = tiles.get(tid);
    if (!tile) {
      tile = { proj: e.proj, display: e.name, personal: isTreehouse(e.proj), days: new Map() };
      tiles.set(tid, tile);
    }
    const day = Math.max(0, dayIndex(e.ts, epochKey));
    let td = tile.days.get(day);
    if (!td) {
      td = { firstTs: e.ts, wu: 0, forks: 0, turns: 0, allnighter: false, sessions: new Set(), today: new Set(), catWu: new Map() };
      tile.days.set(day, td);
    }
    if (e.ts < td.firstTs) td.firstTs = e.ts;
    td.wu += e.wu;
    td.forks += e.forks;
    td.turns += e.turns;
    td.allnighter ||= e.allnighter;
    for (const s of e.sessions) td.sessions.add(s);
    td.today.add(e.by);
    td.catWu.set(e.category, (td.catWu.get(e.category) ?? 0) + Math.max(1, e.wu));
  }

  // Build per-day activities, tile by tile, accumulating the cumulative
  // contributor set so attribution grows as new handles touch a project.
  const byDay = new Map<number, Activity[]>();
  let maxDay = 0;
  for (const [tid, tile] of tiles) {
    const days = [...tile.days.keys()].sort((a, b) => a - b);
    const firstDay = days[0]!;
    const cum = new Set<string>();
    for (const d of days) {
      const td = tile.days.get(d)!;
      for (const by of td.today) cum.add(by);
      maxDay = Math.max(maxDay, d);
      const act: Activity = {
        repo: tid,
        display: tile.display,
        firstTs: td.firstTs,
        turns: td.turns,
        forks: td.forks,
        founding: d === firstDay,
        allnighter: td.allnighter,
        sessionIds: td.sessions,
        wu: td.wu,
        category: pickCategory(td.catWu),
        secondary: null,
        contributors: [...cum].sort(),
        personal: tile.personal,
      };
      const arr = byDay.get(d) ?? [];
      arr.push(act);
      byDay.set(d, arr);
    }
  }

  const endDay = Math.max(maxDay, throughDay ?? maxDay);
  for (let d = 0; d <= endDay; d++) {
    st.day = d;
    stepActivities(st, byDay.get(d) ?? []);
  }
  st.day = endDay;
  patchBaselineDelta(st);
  emitSyncLots(st);
  return { model: assembleModel(st), deltas: st.deltas, dropped: st.dropped };
}

/** Shared-calendar epoch key (YYYY-MM-DD of the earliest event) for a gamified
 * stream — the day-0 reference renderCity folds against. */
export function epochKeyOf(events: GamifiedEvent[]): string {
  if (!events.length) return dateKey(new Date(0).toISOString());
  return dateKey(events.reduce((m, e) => (e.ts < m ? e.ts : m), events[0]!.ts));
}

/** Day index of a timestamp against a shared epoch key (renderCity's calendar). */
export function sharedDay(ts: string, epochKey: string): number {
  return Math.max(0, dayIndex(ts, epochKey));
}

// re-export handy bits for CLI/tests
export { chunkOf, tileFree, CHUNK, GRID, CENTER };
