// agentcity — economy (game-rules §1-2): events -> Work Units, daily caps,
// warehouse buffer. Also the work-category taxonomy (§3) since it is derived
// from the same event stream.

import type { PixelEvent, Category } from "../types.js";

export const WU = {
  toolPair: 1, // one completed tool.pre+post pair
  turnEnd: 5,
  forkStart: 3,
  sessionStart: 2,
  founding: 25, // first-ever event in a repo
} as const;

export const PER_REPO_DAILY_CAP = 120;
export const GLOBAL_DAILY_CAP = 400;
export const WAREHOUSE_MAX = 60;

/** Raw WU before caps. */
export function rawWu(a: {
  tools: number;
  turns: number;
  forks: number;
  sessions: number;
  founding: boolean;
}): number {
  return (
    a.tools * WU.toolPair +
    a.turns * WU.turnEnd +
    a.forks * WU.forkStart +
    a.sessions * WU.sessionStart +
    (a.founding ? WU.founding : 0)
  );
}

/**
 * Apply the per-repo daily cap + warehouse. Returns the WU that counts toward
 * building today and the new warehouse level. (Global cap is applied by the
 * caller across repos.)
 */
export function applyRepoCap(
  raw: number,
  warehouse: number
): { spendable: number; warehouse: number } {
  const toBuild = raw + warehouse;
  const spendable = Math.min(PER_REPO_DAILY_CAP, toBuild);
  const leftover = toBuild - spendable;
  return { spendable, warehouse: Math.min(WAREHOUSE_MAX, leftover) };
}

// ============================ category taxonomy ============================

const TEST_RE = /(\.(test|spec)\.)|(^|\/)(tests?|__tests__|spec)(\/|$)/i;
const TEST_TOOL_RE = /\b(vitest|jest|pytest|mocha|go test|cargo test|npm test|npm run test)\b/i;
const INFRA_RE = /\b(docker|kubectl|terraform|helm|deploy|ansible|systemctl|make|\.sh\b)|dockerfile/i;
const API_RE = /\b(curl|http:\/\/|https:\/\/|wget|fetch|axios|grpc)\b|\/api\//i;

/** Classify a single event into a work category (best-effort, deterministic). */
export function classifyEvent(ev: PixelEvent): Category | null {
  const tool = ev.tool ?? "";
  const detail = ev.detail ?? "";
  // web work
  if (tool === "WebSearch" || tool === "WebFetch") return "web";
  // research sprees
  if (tool === "Read" || tool === "Grep" || tool === "Glob") return "research";
  // planning
  if (tool === "TodoWrite" || tool === "ExitPlanMode") return "planning";
  if (tool === "Bash") {
    if (TEST_TOOL_RE.test(detail)) return "tests";
    if (INFRA_RE.test(detail)) return "infra";
    if (API_RE.test(detail)) return "api";
    return "infra"; // generic shell -> industrial
  }
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit" || tool === "MultiEdit") {
    if (TEST_RE.test(detail)) return "tests";
    if (API_RE.test(detail)) return "api";
    return "code"; // editing source -> residential
  }
  return null;
}

/**
 * Dominant + secondary category for a set of events (per repo). Ties broken by
 * a fixed category order for determinism.
 */
const CATEGORY_ORDER: Category[] = [
  "code",
  "tests",
  "infra",
  "api",
  "research",
  "web",
  "planning",
];

export function dominantCategory(events: PixelEvent[]): {
  category: Category;
  secondary: Category | null;
} {
  const counts = new Map<Category, number>();
  for (const ev of events) {
    const c = classifyEvent(ev);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  if (counts.size === 0) return { category: "code", secondary: null };
  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]);
  });
  const category = ranked[0]![0];
  // secondary only if it has meaningful mass (>= 30% of dominant) and differs
  let secondary: Category | null = null;
  if (ranked.length > 1) {
    const s = ranked[1]!;
    if (s[1] >= ranked[0]![1] * 0.3) secondary = s[0];
  }
  return { category, secondary };
}
