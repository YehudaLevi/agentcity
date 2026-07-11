// agentcity — the shared gamified event stream (THE dataset).
//
// One privacy-safe contract rendered identically by the local city and the
// federation hub. `gamify()` produces it from raw PixelEvents (local ingest);
// `renderCity()` consumes it (shared pipeline). It carries ONLY aggregate,
// gamified facts — never a file path, cwd, command, or environment value.

import type { Category } from "../types.js";

/**
 * Project identity + tile-sharing policy. Two orthogonal axes — how tiles merge,
 * and how they render:
 *   git   → SHARED tile keyed by the remote; the same repo worked by different
 *           users merges into one BUILDING.
 *   repo  → a git repo with NO remote: a per-user tile (can't be matched across
 *           machines) that still renders as a BUILDING.
 *   local → not a git repo at all: a per-user tile rendered as a TREEHOUSE.
 * None carries a full path: `remote` is a public git URL, `token` is a hash.
 */
export type ProjectId =
  | { kind: "git"; remote: string }
  | { kind: "repo"; token: string }
  | { kind: "local"; token: string };

/** A per-(project, day) gamified fact. Aggregate counts + a display basename + a
 * remote/hash + a handle + opaque hashed session ids. No paths/commands/env. */
export interface GamifiedEvent {
  v: 1;
  proj: ProjectId;
  name: string; // workspace basename, for display (never a path)
  by: string; // contributor handle
  day: number; // days since the stream epoch
  ts: string; // ISO timestamp
  wu: number; // work units (already economy-capped upstream)
  forks: number;
  turns: number;
  allnighter: boolean;
  category: Category;
  sessions: string[]; // opaque hashed session ids (for coupling/rails)
  founding: boolean; // first day this project appears
}

/** Stable tile id — tiles with the same id merge. git tiles are SHARED across
 * users; repo/local tiles are namespaced per contributor (never merge). */
export function tileId(proj: ProjectId, by: string): string {
  switch (proj.kind) {
    case "git":
      return `g:${proj.remote}`;
    case "repo":
      return `r:${by}:${proj.token}`;
    case "local":
      return `u:${by}:${proj.token}`;
  }
}

/** Only non-repo workspaces render as treehouses; git & no-remote repos are
 * civic buildings. */
export function isTreehouse(proj: ProjectId): boolean {
  return proj.kind === "local";
}

/** Stable identity of a project (ignores the reporter) — for store dedup keys. */
export function projKey(proj: ProjectId): string {
  return proj.kind === "git" ? `git:${proj.remote}` : `${proj.kind}:${proj.token}`;
}

/** The (project, contributor, day) upsert key: a re-sent day replaces the prior
 * fact for that contributor (gamify re-aggregates a growing day; last wins). */
export function factKey(e: { proj: ProjectId; by: string; day: number }): string {
  return `${projKey(e.proj)}|${e.by}|${e.day}`;
}

const CATEGORIES: ReadonlySet<Category> = new Set<Category>([
  "code",
  "tests",
  "infra",
  "api",
  "research",
  "web",
  "planning",
]);

function coerceProj(input: unknown): ProjectId | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (o.kind === "git" && typeof o.remote === "string" && o.remote) return { kind: "git", remote: o.remote };
  if (o.kind === "repo" && typeof o.token === "string" && o.token) return { kind: "repo", token: o.token };
  if (o.kind === "local" && typeof o.token === "string" && o.token) return { kind: "local", token: o.token };
  return null;
}

/** Validate a wire object into a GamifiedEvent, or null (never throws). */
export function coerce(input: unknown): GamifiedEvent | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (o.v !== 1) return null;
  const proj = coerceProj(o.proj);
  if (!proj) return null;
  if (typeof o.by !== "string" || !o.by) return null;
  if (typeof o.name !== "string") return null;
  if (typeof o.day !== "number" || !Number.isFinite(o.day)) return null;
  // ts must be a PARSEABLE timestamp — a blank/garbage ts would poison the shared
  // epoch (min ts) and collapse the whole city to NaN days. Fail early here.
  if (typeof o.ts !== "string" || !Number.isFinite(Date.parse(o.ts))) return null;
  if (typeof o.wu !== "number" || !Number.isFinite(o.wu)) return null;
  if (typeof o.forks !== "number" || typeof o.turns !== "number") return null;
  if (typeof o.category !== "string" || !CATEGORIES.has(o.category as Category)) return null;
  const sessions = Array.isArray(o.sessions) ? o.sessions.filter((s): s is string => typeof s === "string") : [];
  return {
    v: 1,
    proj,
    name: o.name,
    by: o.by,
    day: o.day,
    ts: o.ts,
    wu: o.wu,
    forks: o.forks,
    turns: o.turns,
    allnighter: o.allnighter === true,
    category: o.category as Category,
    sessions,
    founding: o.founding === true,
  };
}

/** POST /ingest body: a contributor's slice of the shared stream. */
export interface GamifiedBatch {
  v: 1;
  handle: string;
  events: GamifiedEvent[];
}

export function coerceBatch(input: unknown): GamifiedBatch | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.handle !== "string" || !o.handle) return null;
  if (!Array.isArray(o.events)) return null;
  const events: GamifiedEvent[] = [];
  for (const raw of o.events) {
    const ev = coerce(raw);
    if (ev) events.push(ev);
  }
  return { v: 1, handle: o.handle, events };
}
