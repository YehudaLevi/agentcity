// agentcity — Contract types (Contracts 1-4 from docs/architecture.md) plus a
// stable-key-order JSON serializer. Determinism depends on the serializer:
// identical (events, seed) MUST yield byte-identical JSON.

// ============================ Contract 1: PixelEvent ============================
// Shared shape with pixelagents — never fork it silently.

export type EventKind =
  | "session.start"
  | "session.end"
  | "turn.start"
  | "turn.end"
  | "tool.pre"
  | "tool.post"
  | "fork.start"
  | "fork.end"
  | "waiting.human"
  | "waiting.permission"
  | "other";

export interface PixelEvent {
  ts: string; // ISO timestamp
  session: string;
  agent: string; // e.g. "user"
  source: string; // e.g. "claude-code" | "pixelagents"
  cwd?: string;
  repo: string; // basename of cwd (or explicit)
  kind: EventKind;
  tool?: string; // tool name for tool.pre/post
  detail?: string; // file_path / command first-line, 120-char truncated, NEVER content
}

// ============================ Contract 2: CityModel v1 ============================

export type BiomeKind = "coastal" | "river" | "lakes" | "hills";
export type GrowthDir = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

export type Category =
  | "code"
  | "tests"
  | "infra"
  | "api"
  | "research"
  | "web"
  | "planning";

export type Coord = [number, number];

export interface Biome {
  kind: BiomeKind;
  water: Coord[]; // water tile coords (sorted for determinism)
  origin: Coord;
  growthDir: GrowthDir;
}

export interface Chunk {
  x: number; // chunk coord (tiles = x*CHUNK)
  y: number;
  revealed: boolean;
  revealedDay: number;
}

export interface Road {
  id: string;
  path: Coord[];
  tier: number; // 0 dirt -> 3 avenue
}

export interface Rail {
  between: [string, string]; // lot ids
  path: Coord[];
}

export interface Lot {
  id: string; // "h(repo)"
  repo: string;
  alias: string; // "building-N"
  category: Category;
  secondary: Category | null;
  pos: Coord;
  tier: number; // 0-5
  wu: number;
  wuIntoTier: number;
  wuNextTier: number;
  foundedDay: number;
  lastActiveDay: number;
  decay: 0 | 1 | 2; // 0 none, 1 vines(30d), 2 cracks(90d)
  underConstruction: boolean;
  variant: number; // hash(repo) -> width/roof/windows
  // Federation only: contributing handles (sorted). Absent for a solo city.
  contributors?: string[];
  // Federation only: a per-user (no-remote) project — rendered as a shack, not a
  // shared civic building, and never merged across users.
  personal?: boolean;
}

export type LandmarkKind = "fountain" | "statue" | "plaque" | "fireworks-spot";

export interface Landmark {
  kind: LandmarkKind;
  pos: Coord;
  day: number;
}

export interface CityStats {
  totalWu: number;
  population: number;
  pets: number;
  ships: number;
  streakDays: number;
  allNighterYesterday: boolean;
}

export interface Baseline {
  housePos: Coord;
  roadPath: Coord[];
  props: { kind: "well" | "tree" | "boat"; pos: Coord }[];
  // false suppresses the founder cottage + hamlet props (the federation hub has
  // no single founder). Absent/true keeps the local city's founding hamlet.
  hamlet?: boolean;
}

export interface CityModel {
  version: 1;
  seed: string;
  day: number;
  foundedTs: string;
  biome: Biome;
  chunks: Chunk[];
  roads: Road[];
  rails: Rail[];
  lots: Lot[];
  landmarks: Landmark[];
  stats: CityStats;
  baseline: Baseline;
}

// ============================ Contract 3: CityDelta ============================

export type DeltaKind =
  | "baseline.init"
  | "lot.found"
  | "lot.upgrade"
  | "lot.decay"
  | "lot.renovate"
  | "road.add"
  | "road.upgrade"
  | "rail.add"
  | "chunk.reveal"
  | "landmark.add"
  | "ship.arrive"
  | "population.set"
  | "sync.lots"
  // Live reconciliation (local + hub): after a re-fold, drop deltas dated
  // >= `fromDay` and splice in this delta's `deltas`. Subsumes append (fromDay
  // past the frontier), same-day refresh, and late-join/reset (fromDay 0).
  | "replace";

export interface CityDelta {
  day: number;
  seq: number;
  kind: DeltaKind;
  // kind-specific fields mirroring CityModel fragments:
  [k: string]: unknown;
}

// ============================ Contract 4: persistence / config ============================

export type HistoryInfluence = "full" | "capped";

/** Opt-in federation settings (see docs/federation.md). Absent = disabled. */
export interface FederationConfig {
  role?: "client" | "central";
  /** hub base URL when role=client */
  centralUrl?: string;
  /** contributor display name on the shared scene */
  handle?: string;
}

export interface CityConfig {
  seed?: string;
  historyInfluence: HistoryInfluence;
  aliases: Record<string, string>;
  federation?: FederationConfig;
}

// Internal richer lot/road records (carry fields the model doesn't need but the
// fold must keep to resume exactly).
export interface ILot {
  id: string;
  repo: string;
  alias: string;
  category: Category;
  secondary: Category | null;
  x: number;
  y: number;
  wu: number;
  tier: number;
  prevTier: number;
  foundedDay: number;
  lastActiveDay: number;
  decay: 0 | 1 | 2;
  variant: number;
  roadId: string | null;
  lastUpgradeDay: number;
  lastRenovateDay: number;
  // Federation only (absent for a solo city).
  contributors?: string[];
  personal?: boolean;
}

export interface IRoad {
  id: string;
  path: Coord[];
  tier: number;
  usage: number;
  lotRepo: string | null;
}

// ============================ stable-key-order JSON serializer ============================

/**
 * Deterministic JSON: object keys emitted in sorted order at every level so
 * that structurally-equal models serialize byte-identically. Arrays keep their
 * order (order is meaningful). Numbers use JSON's default formatting.
 */
export function stableStringify(value: unknown, indent = 2): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) throw new Error("stableStringify: circular reference");
    seen.add(v as object);
    if (Array.isArray(v)) {
      const arr = v.map(walk);
      seen.delete(v as object);
      return arr;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[key];
      if (val === undefined) continue; // drop undefined for stability
      out[key] = walk(val);
    }
    seen.delete(v as object);
    return out;
  };
  return JSON.stringify(walk(value), null, indent);
}
