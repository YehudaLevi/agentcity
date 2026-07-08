// agentcity — the compiler. fold(events, seed, config) -> {model, deltas,
// checkpoint}, day-granular and PURE (no Date.now/Math.random). Also an
// incremental fold(checkpoint, newEvents) that is byte-identical to a full fold.

import type {
  PixelEvent,
  CityConfig,
  CityModel,
  CityDelta,
  Checkpoint,
  FoldResult,
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
import {
  rawWu,
  applyRepoCap,
  GLOBAL_DAILY_CAP,
  dominantCategory,
  classifyEvent,
} from "./rules/economy.js";
import { cappedTier, tierCapFor, tierProgress, TIER_THRESHOLDS } from "./rules/tiers.js";
import { decayLevel } from "./rules/tiers.js";
import { citizensFor, petsFor, SHIP_PER_WU } from "./rules/population.js";
import { newMilestones } from "./rules/milestones.js";
import type { MilestoneFlags } from "./rules/milestones.js";
import {
  type Geo,
  biomeOf,
  growthDirOf,
  genTerrain,
  rebuildTerrain,
  chunkOf,
  isRevealed,
  isWater,
  tileFree,
  setRoad,
  pathRoad,
  placeLot,
  maybeExpand,
  railPath,
  revealedWater,
  CHUNK,
  GRID,
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
function hourOf(ts: string): number {
  const m = /T(\d{2})/.exec(ts);
  return m ? parseInt(m[1]!, 10) : 12;
}

// ============================ internal state ============================

interface State {
  seed: string;
  config: CityConfig;
  geo: Geo;
  ilots: ILot[];
  lotByRepo: Map<string, ILot>;
  iroads: IRoad[];
  rails: Rail[];
  railPairs: Set<string>;
  chunks: Chunk[];
  landmarks: Landmark[];
  baseline: Baseline;
  carvedWater: Coord[];
  // economy / aux
  warehouse: Map<string, number>;
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

function initState(seed: string, config: CityConfig): State {
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
    revealed: new Set(),
    lotsGeo: [],
  };
  genTerrain(geo);
  // reveal center 2x2 chunks (chunks 2,3 -> tiles 20..39 in the 60x60 world)
  const chunks: Chunk[] = [];
  for (const cx of [2, 3]) {
    for (const cy of [2, 3]) {
      geo.revealed.add(`${cx},${cy}`);
      chunks.push({ x: cx, y: cy, revealed: true, revealedDay: 0 });
    }
  }
  // seed-chosen origin (NOT center)
  const q = Math.floor(rand(seed, "origin:q") * 4);
  const ox = CENTER + (q & 1 ? -1 : 1) * (3 + Math.floor(rand(seed, "origin:dx") * 4));
  const oy = CENTER + (q & 2 ? -1 : 1) * (3 + Math.floor(rand(seed, "origin:dy") * 4));
  geo.origin = snapOrigin(geo, ox, oy);

  const st: State = {
    seed,
    config,
    geo,
    ilots: [],
    lotByRepo: new Map(),
    iroads: [],
    rails: [],
    railPairs: new Set(),
    chunks,
    landmarks: [],
    baseline: { housePos: [geo.origin.x, geo.origin.y], roadPath: [], props: [] },
    carvedWater: [],
    warehouse: new Map(),
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
  st.baseline = { housePos: [ox, oy], roadPath, props };

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
  // initial chunk reveals
  for (const c of st.chunks) emit(st, "chunk.reveal", { x: c.x, y: c.y, revealedDay: c.revealedDay });
}

// ============================ day step ============================

interface Activity {
  repo: string;
  firstTs: string;
  tools: number;
  turns: number;
  forks: number;
  sessions: number;
  founding: boolean;
  allnighter: boolean;
  sessionIds: Set<string>;
  events: PixelEvent[];
}

function aggregate(st: State, dayEvents: PixelEvent[]): Activity[] {
  const map = new Map<string, Activity>();
  for (const ev of dayEvents) {
    let a = map.get(ev.repo);
    if (!a) {
      a = {
        repo: ev.repo,
        firstTs: ev.ts,
        tools: 0,
        turns: 0,
        forks: 0,
        sessions: 0,
        founding: !st.lotByRepo.has(ev.repo),
        allnighter: false,
        sessionIds: new Set(),
        events: [],
      };
      map.set(ev.repo, a);
    }
    if (ev.ts < a.firstTs) a.firstTs = ev.ts;
    a.events.push(ev);
    a.sessionIds.add(ev.session);
    const h = hourOf(ev.ts);
    if (h >= 0 && h < 5) a.allnighter = true;
    switch (ev.kind) {
      case "tool.post":
        a.tools++;
        break;
      case "turn.end":
        a.turns++;
        break;
      case "fork.start":
        a.forks++;
        break;
      case "session.start":
        a.sessions++;
        break;
      default:
        break;
    }
  }
  return [...map.values()];
}

function foundLot(st: State, a: Activity): void {
  const { category, secondary } = dominantCategory(a.events);
  const placeIdx = st.lotOrder.length;
  const placed = placeLot(st.geo, category, placeIdx);
  if (!placed) return;
  const [x, y] = placed.pos;
  // carving an api inlet may reveal fog chunks — reflect them into the model
  syncRevealedChunks(st);
  const alias = `building-${placeIdx + 1}`;
  const lot: ILot = {
    id: `h(${a.repo})`,
    repo: a.repo,
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

  // expansion check
  if (maybeExpand(st.geo, st.chunks.length)) syncRevealedChunks(st);
}

/** Reflect any geo.revealed chunk not yet in the model as a chunk.reveal delta. */
function syncRevealedChunks(st: State): void {
  const known = new Set(st.chunks.map((c) => `${c.x},${c.y}`));
  const pending = [...st.geo.revealed].filter((k) => !known.has(k)).sort();
  for (const k of pending) {
    const [cx, cy] = k.split(",").map(Number) as [number, number];
    st.chunks.push({ x: cx, y: cy, revealed: true, revealedDay: st.day });
    emit(st, "chunk.reveal", { x: cx, y: cy, revealedDay: st.day });
  }
}

function detectCoupling(st: State, acts: Activity[]): void {
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
  const cap = tierCapFor(st.config.historyInfluence);
  // per-repo cap + warehouse -> spendable
  const spendables: { repo: string; spendable: number; a: Activity }[] = [];
  for (const a of acts) {
    const raw = rawWu(a);
    const wh = st.warehouse.get(a.repo) ?? 0;
    const { spendable, warehouse } = applyRepoCap(raw, wh);
    st.warehouse.set(a.repo, warehouse);
    spendables.push({ repo: a.repo, spendable, a });
  }
  // global daily cap across repos, deterministic order by repo name
  spendables.sort((p, q) => (p.repo < q.repo ? -1 : p.repo > q.repo ? 1 : 0));
  let globalToday = 0;
  let dayWU = 0;
  let dayForks = 0;
  const activeCount = acts.length;
  for (const s of spendables) {
    let spend = s.spendable;
    if (globalToday + spend > GLOBAL_DAILY_CAP) spend = Math.max(0, GLOBAL_DAILY_CAP - globalToday);
    globalToday += spend;
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
    // tier check
    const nt = cappedTier(lot.wu, cap);
    if (nt > lot.tier) {
      lot.prevTier = lot.tier;
      lot.tier = nt;
      lot.lastUpgradeDay = st.day;
      const tp = tierProgress(lot.wu, nt);
      emit(st, "lot.upgrade", {
        id: lot.id,
        tier: nt,
        wu: lot.wu,
        wuIntoTier: tp.wuIntoTier,
        wuNextTier: tp.wuNextTier,
        lastActiveDay: st.day,
      });
      if (maybeExpand(st.geo, st.chunks.length)) syncRevealedChunks(st);
    }
    // road usage: busy corridors upgrade (repo worked alongside neighbors)
    if (lot.roadId && activeCount >= 2) {
      const road = st.iroads.find((r) => r.id === lot.roadId);
      if (road) {
        road.usage++;
        const rt = roadTier(road.usage);
        if (rt > road.tier) {
          road.tier = rt;
          emit(st, "road.upgrade", { id: road.id, tier: rt });
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

function stepDay(st: State, dayEvents: PixelEvent[]): void {
  const acts = aggregate(st, dayEvents);
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
      };
    });
  const roads = st.iroads.map((r) => ({ id: r.id, path: r.path, tier: r.tier }));
  const chunks = st.chunks.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const landmarks = st.landmarks.slice();
  const water = revealedWater(st.geo);

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
  const water = revealedWater(st.geo);
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

// ============================ (de)serialization for checkpoints ============================

function serializeState(st: State): Checkpoint["state"] {
  return {
    ilots: st.ilots,
    iroads: st.iroads,
    rails: st.rails,
    railPairs: [...st.railPairs],
    chunks: st.chunks,
    landmarks: st.landmarks,
    baseline: st.baseline,
    occupied: [...st.geo.occupied],
    roadSet: [...st.geo.roadSet],
    revealed: [...st.geo.revealed],
    carvedWater: st.carvedWater,
    warehouse: [...st.warehouse.entries()],
    globalWU: st.globalWU,
    nextShipWU: st.nextShipWU,
    shipCount: st.shipCount,
    cumTurns: st.cumTurns,
    cumForks: st.cumForks,
    repoCount: st.repoCount,
    perDayWU: st.perDayWU,
    perDayForks: st.perDayForks,
    milestones: st.milestones,
    allNighterUntilDay: st.allNighterUntilDay,
    sessionRepos: [...st.sessionRepos.entries()],
    seq: st.seq,
    day: st.day,
    foundedTs: st.foundedTs,
    lotOrder: st.lotOrder,
    population: st.population,
    pets: st.pets,
    streak: st.streak,
    allNighter: st.allNighter,
  };
}

function deserializeState(cp: Checkpoint, config: CityConfig): State {
  const seed = cp.seed;
  // deep clone so an incremental fold never mutates the caller's checkpoint
  // (arrays/objects here become the live fold state).
  const s = structuredClone(cp.state);
  const biome = biomeOf(seed);
  const growth = growthDirOf(seed);
  const geo: Geo = {
    seed,
    biome,
    growthVec: growth.vec,
    growthDir: growth.name,
    origin: { x: cp.model.biome.origin[0], y: cp.model.biome.origin[1] },
    ground: [],
    occupied: new Set(s.occupied),
    roadSet: new Set(s.roadSet),
    revealed: new Set(s.revealed),
    lotsGeo: s.ilots.map((l) => ({ x: l.x, y: l.y, cat: l.category as Category })),
  };
  rebuildTerrain(geo, s.carvedWater);
  // re-sync road tiles into the regenerated ground grid: setRoad in the live
  // fold sets BOTH roadSet AND ground[y][x].t="road"; rebuildTerrain only
  // restores water/elev/sand, so without this, tileFree (which reads ground.t)
  // would treat restored road tiles as buildable and placement would diverge.
  for (const k of geo.roadSet) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    const row = geo.ground[y];
    if (row && row[x] && row[x]!.t !== "water") row[x]!.t = "road";
  }
  const st: State = {
    seed,
    config,
    geo,
    ilots: s.ilots,
    lotByRepo: new Map(s.ilots.map((l) => [l.repo, l])),
    iroads: s.iroads,
    rails: s.rails,
    railPairs: new Set(s.railPairs),
    chunks: s.chunks,
    landmarks: s.landmarks,
    baseline: s.baseline,
    carvedWater: s.carvedWater,
    warehouse: new Map(s.warehouse),
    globalWU: s.globalWU,
    nextShipWU: s.nextShipWU,
    shipCount: s.shipCount,
    cumTurns: s.cumTurns,
    cumForks: s.cumForks,
    repoCount: s.repoCount,
    perDayWU: s.perDayWU,
    perDayForks: s.perDayForks,
    milestones: s.milestones,
    allNighterUntilDay: s.allNighterUntilDay,
    sessionRepos: new Map(s.sessionRepos),
    lotOrder: s.lotOrder,
    population: s.population,
    pets: s.pets,
    streak: s.streak,
    allNighter: s.allNighter,
    seq: s.seq,
    day: s.day,
    foundedTs: s.foundedTs,
    deltas: [],
  };
  return st;
}

// carvedWater = water tiles present now but not in the seed's base terrain
// (i.e. inlets carved for harbor lots). Recomputed at finalize so the checkpoint
// can rebuild the exact ground grid on resume.
function recordCarvedWater(st: State): void {
  // regenerate base terrain to compare
  const base: Geo = {
    ...st.geo,
    ground: [],
    occupied: new Set(),
    roadSet: new Set(),
    revealed: new Set(),
    lotsGeo: [],
  };
  genTerrain(base);
  const carved: Coord[] = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (st.geo.ground[y]![x]!.t === "water" && base.ground[y]![x]!.t !== "water") {
        carved.push([x, y]);
      }
    }
  }
  carved.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  st.carvedWater = carved;
}

// ============================ public API ============================

function runDays(st: State, events: PixelEvent[], fromDay: number): void {
  if (!events.length) return;
  const founded = st.foundedTs || dateKey(events[0]!.ts);
  if (!st.foundedTs) st.foundedTs = founded;
  const maxDay = Math.max(fromDay, ...events.map((e) => dayIndex(e.ts, founded)));
  const byDay = new Map<number, PixelEvent[]>();
  for (const ev of events) {
    const d = dayIndex(ev.ts, founded);
    const arr = byDay.get(d) ?? [];
    arr.push(ev);
    byDay.set(d, arr);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (let d = fromDay; d <= maxDay; d++) {
    st.day = d;
    stepDay(st, byDay.get(d) ?? []);
  }
}

function finalize(st: State, events: PixelEvent[]): FoldResult {
  recordCarvedWater(st);
  // full fold: back-patch the day-0 baseline.init delta with final biome so the
  // renderer's delta-replay reconstructs model.biome. (Absent in incremental
  // folds, whose baseline.init lives in the earlier checkpoint's delta log.)
  patchBaselineDelta(st);
  // final delta of every fold (full and incremental): overwrite exact per-lot
  // wu/progress/lastActiveDay/decay so delta replay == model (byte-exact).
  emitSyncLots(st);
  const model = assembleModel(st);
  const upToTs = events.length ? events[events.length - 1]!.ts : new Date(0).toISOString();
  const checkpoint: Checkpoint = {
    version: 1,
    seed: st.seed,
    upToTs,
    model,
    state: serializeState(st),
  };
  return { model, deltas: st.deltas, checkpoint };
}

/** Full fold: events (any order) + seed + config -> model, deltas, checkpoint. */
export function fold(
  events: PixelEvent[],
  seed: string,
  config: Partial<CityConfig> = {}
): FoldResult {
  const cfg: CityConfig = { ...DEFAULT_CONFIG, ...config, aliases: config.aliases ?? {} };
  const sorted = events.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const st = initState(seed, cfg);
  runDays(st, sorted, 0);
  return finalize(st, sorted);
}

/**
 * Incremental fold: continue from a checkpoint with events that occur strictly
 * after the checkpoint's last processed day. Byte-identical to a full fold over
 * (originalEvents + newEvents).
 */
export function foldIncremental(
  cp: Checkpoint,
  newEvents: PixelEvent[],
  config: Partial<CityConfig> = {}
): FoldResult {
  const cfg: CityConfig = { ...DEFAULT_CONFIG, ...config, aliases: config.aliases ?? {} };
  const st = deserializeState(cp, cfg);
  const sorted = newEvents.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const fromDay = st.day + 1;
  runDays(st, sorted, fromDay);
  return finalize(st, sorted.length ? sorted : []);
}

// re-export handy bits for CLI/tests
export { chunkOf, tileFree, CHUNK, GRID, CENTER, classifyEvent };
