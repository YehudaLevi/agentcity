// agentcity — local ingest: raw PixelEvents -> the shared gamified stream.
//
// This is the ONLY place raw events are read. It runs the economy (WU + per-repo
// daily cap + warehouse + global cap), classifies work, aggregates fork/turn/
// all-nighter/session signals, and resolves project identity (git remote vs a
// per-user hash). Output is privacy-safe GamifiedEvents — the same dataset the
// city renders from and (optionally) forwards to the hub.

import type { PixelEvent } from "../types.js";
import { rawWu, applyRepoCap, GLOBAL_DAILY_CAP, dominantCategory } from "../rules/economy.js";
import { sha256hex } from "../seed.js";
import type { GamifiedEvent, ProjectId } from "./types.js";

/** Resolve a repo (by name) to its identity: a git remote (shared) or a per-user
 * hash (treehouse). Injected so gamify stays pure/testable — the local server
 * builds it from ingested cwds + git. */
export interface IdentityResolver {
  (repo: string): { proj: ProjectId; name: string };
}

const PHANTOM_REPO = /^agent-[0-9a-f]{16,}$/i;

function dateKey(ts: string): string {
  return ts.slice(0, 10); // YYYY-MM-DD
}
function dayIndex(ts: string, founded: string): number {
  const a = Date.parse(`${dateKey(ts)}T00:00:00Z`);
  const b = Date.parse(`${founded}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((a - b) / 86_400_000)) : 0;
}
function hourOf(ts: string): number {
  const m = /T(\d{2})/.exec(ts);
  return m ? parseInt(m[1]!, 10) : 12;
}

interface DayRepo {
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

/**
 * Produce the gamified stream for one contributor. `by` is the handle stamped on
 * every event. Deterministic given (events, resolve, by).
 */
export function gamify(events: PixelEvent[], resolve: IdentityResolver, by: string): GamifiedEvent[] {
  const usable = events.filter((e) => !PHANTOM_REPO.test(e.repo));
  if (!usable.length) return [];
  const sorted = usable.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const founded = dateKey(sorted[0]!.ts);

  // group by day
  const byDay = new Map<number, PixelEvent[]>();
  for (const ev of sorted) {
    const d = dayIndex(ev.ts, founded);
    const arr = byDay.get(d) ?? [];
    arr.push(ev);
    byDay.set(d, arr);
  }

  const out: GamifiedEvent[] = [];
  const warehouse = new Map<string, number>();
  const seen = new Set<string>();

  const days = [...byDay.keys()].sort((a, b) => a - b);
  for (const d of days) {
    const dayEvents = byDay.get(d)!;
    // aggregate per repo
    const repos = new Map<string, DayRepo>();
    for (const ev of dayEvents) {
      let a = repos.get(ev.repo);
      if (!a) {
        a = {
          firstTs: ev.ts,
          tools: 0,
          turns: 0,
          forks: 0,
          sessions: 0,
          founding: !seen.has(ev.repo),
          allnighter: false,
          sessionIds: new Set(),
          events: [],
        };
        repos.set(ev.repo, a);
      }
      if (ev.ts < a.firstTs) a.firstTs = ev.ts;
      a.events.push(ev);
      a.sessionIds.add(ev.session);
      const h = hourOf(ev.ts);
      if (h >= 0 && h < 5) a.allnighter = true;
      if (ev.kind === "tool.post") a.tools++;
      else if (ev.kind === "turn.end") a.turns++;
      else if (ev.kind === "fork.start") a.forks++;
      else if (ev.kind === "session.start") a.sessions++;
    }

    // economy: per-repo cap + warehouse, then global cap (deterministic repo order)
    const spendables = [...repos.entries()]
      .map(([repo, a]) => {
        const { spendable, warehouse: wh } = applyRepoCap(rawWu(a), warehouse.get(repo) ?? 0);
        warehouse.set(repo, wh);
        return { repo, spendable, a };
      })
      .sort((p, q) => (p.repo < q.repo ? -1 : p.repo > q.repo ? 1 : 0));

    let globalToday = 0;
    for (const { repo, spendable, a } of spendables) {
      let wu = spendable;
      if (globalToday + wu > GLOBAL_DAILY_CAP) wu = Math.max(0, GLOBAL_DAILY_CAP - globalToday);
      globalToday += wu;

      const founding = !seen.has(repo);
      seen.add(repo);
      const { proj, name } = resolve(repo);
      const { category } = dominantCategory(a.events);
      out.push({
        v: 1,
        proj,
        name,
        by,
        day: d,
        ts: a.firstTs,
        wu,
        forks: a.forks,
        turns: a.turns,
        allnighter: a.allnighter,
        category,
        sessions: [...a.sessionIds].sort().map((s) => sha256hex(s).slice(0, 12)),
        founding,
      });
    }
  }
  return out;
}
