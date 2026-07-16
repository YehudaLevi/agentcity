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

// --- wire sanitization (server-side firewall) -------------------------------
// coerce() is the trust boundary: the client-side cleanHandle (src/founding.ts)
// is bypassable by a raw POST to /ingest, so every contributor-controlled string
// that can reach the shared renderer's DOM is sanitized HERE, not just at the
// renderer. `by` is the primary stored-XSS vector (it lands in tooltip credit).

/** A handle token — the SAME charset/length as founding.ts cleanHandle. `by`
 * namespaces per-user tiles and is shown in the shared scene; a raw handle would
 * be a stored-XSS vector. "" when nothing usable survives (caller rejects). */
function cleanHandle(raw: string): string {
  return raw.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
}

/** Strip HTML-meta and control characters from a wire display/identifier string
 * and cap its length. Defense-in-depth for strings (name, remote, token) that
 * can reach the DOM; keeps normal path/URL characters (/ : . @ -) intact. */
function cleanText(raw: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f<>&"'`]/g, "").slice(0, max);
}

function coerceProj(input: unknown): ProjectId | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (o.kind === "git" && typeof o.remote === "string") {
    const remote = cleanText(o.remote, 200);
    if (remote) return { kind: "git", remote };
  }
  if (o.kind === "repo" && typeof o.token === "string") {
    const token = cleanText(o.token, 128);
    if (token) return { kind: "repo", token };
  }
  if (o.kind === "local" && typeof o.token === "string") {
    const token = cleanText(o.token, 128);
    if (token) return { kind: "local", token };
  }
  return null;
}

/** Validate a wire object into a GamifiedEvent, or null (never throws). */
export function coerce(input: unknown): GamifiedEvent | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (o.v !== 1) return null;
  const proj = coerceProj(o.proj);
  if (!proj) return null;
  // `by` is the primary stored-XSS vector — it becomes tooltip credit in the
  // shared renderer. Sanitize to the cleanHandle charset; reject if nothing
  // usable survives (a purely-hostile handle is not a valid contributor).
  if (typeof o.by !== "string") return null;
  const by = cleanHandle(o.by);
  if (!by) return null;
  if (typeof o.name !== "string") return null;
  const name = cleanText(o.name, 64); // display basename; strip HTML-meta, cap length
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
    name,
    by,
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
  if (typeof o.handle !== "string") return null;
  const handle = cleanHandle(o.handle); // same sanitization as the per-event `by`
  if (!handle) return null;
  if (!Array.isArray(o.events)) return null;
  const events: GamifiedEvent[] = [];
  for (const raw of o.events) {
    const ev = coerce(raw);
    if (ev) events.push(ev);
  }
  return { v: 1, handle, events };
}
