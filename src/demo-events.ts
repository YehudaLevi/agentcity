// agentcity — seeded synthetic event stream for --demo and tests. Deterministic:
// derived purely from a demo seed + a fixed start date (never Date.now/random),
// so `npm run compile --demo --seed X` is reproducible byte-for-byte.
//
// Covers ~90 days, 14 repos across all 7 categories, forks, waiting events, an
// all-nighter, an api repo that needs harbor water, and two repos that go
// silent (decay), plus coupled repos that share sessions (rails).

import type { PixelEvent, Category, EventKind } from "./types.js";
import { rand } from "./seed.js";

interface RepoPlan {
  name: string;
  cat: Category;
  found: number;
  silent?: number;
  oldtown?: boolean;
}

const REPOS: RepoPlan[] = [
  { name: "core-app", cat: "code", found: 0, oldtown: true },
  { name: "api-gateway", cat: "api", found: 0 },
  { name: "unit-runner", cat: "tests", found: 3 },
  { name: "ci-foundry", cat: "infra", found: 7 },
  { name: "docs-archive", cat: "research", found: 11 },
  { name: "dashboard-ui", cat: "web", found: 15, silent: 40 }, // decays
  { name: "roadmap-hall", cat: "planning", found: 19 },
  { name: "monorepo", cat: "code", found: 24 },
  { name: "billing-svc", cat: "api", found: 30 },
  { name: "e2e-suite", cat: "tests", found: 37 },
  { name: "build-cache", cat: "infra", found: 45 },
  { name: "ml-notebook", cat: "research", found: 54 },
  { name: "legacy-cli", cat: "code", found: 5, silent: 30 }, // abandoned early -> cracks
  { name: "webhook-pier", cat: "api", found: 63 },
];

const COUPLES: [string, string][] = [
  ["core-app", "api-gateway"],
  ["unit-runner", "monorepo"],
  ["ci-foundry", "build-cache"],
  ["api-gateway", "billing-svc"],
];

const SIM_DAYS = 90;

/** A couple of representative tool calls for a category. */
function toolCalls(cat: Category): { tool: string; detail: string }[] {
  switch (cat) {
    case "code":
      return [
        { tool: "Edit", detail: "src/module.ts" },
        { tool: "Write", detail: "src/util.ts" },
      ];
    case "tests":
      return [
        { tool: "Bash", detail: "vitest run" },
        { tool: "Edit", detail: "src/module.test.ts" },
      ];
    case "infra":
      return [
        { tool: "Bash", detail: "docker build -t app ." },
        { tool: "Bash", detail: "kubectl apply -f k8s.yaml" },
      ];
    case "api":
      return [
        { tool: "Bash", detail: "curl https://api.svc/v1/users" },
        { tool: "Edit", detail: "src/api/client.ts" },
      ];
    case "research":
      return [
        { tool: "Read", detail: "docs/spec.md" },
        { tool: "Grep", detail: "handler" },
      ];
    case "web":
      return [
        { tool: "WebSearch", detail: "iso rendering technique" },
        { tool: "WebFetch", detail: "reference doc" },
      ];
    case "planning":
      return [{ tool: "TodoWrite", detail: "plan next milestone" }];
  }
}

function iso(startMs: number, day: number, secOffset: number): string {
  return new Date(startMs + day * 86400000 + secOffset * 1000).toISOString();
}

export interface DemoOptions {
  start?: string; // YYYY-MM-DD
  days?: number;
}

/** Generate the demo PixelEvent stream (ts-sorted). */
export function generateDemoEvents(seed: string, opts: DemoOptions = {}): PixelEvent[] {
  const start = opts.start ?? "2026-04-01";
  const days = opts.days ?? SIM_DAYS;
  const startMs = Date.parse(`${start}T09:00:00Z`);
  const startMidnightMs = Date.parse(`${start}T00:00:00Z`);
  const events: PixelEvent[] = [];
  let sessionCounter = 0;

  for (let d = 0; d <= days; d++) {
    const dow = (2 + d) % 7; // arbitrary start weekday
    const weekend = dow === 0 || dow === 6;
    // shared session ids for coupled repos active today
    const coupleSession = new Map<string, string>();

    for (const rp of REPOS) {
      if (d < rp.found) continue;
      if (rp.silent != null && d >= rp.silent) continue;
      const age = d - rp.found;
      const ramp = age < 3 ? 1.15 : age < 20 ? 1.0 : 0.85;
      const pActive = (weekend ? 0.3 : 0.82) * ramp;
      if (rand(seed, `active:${rp.name}:${d}`) > pActive) continue;

      const vigor = 0.6 + rand(seed, `vigor:${rp.name}`) * 0.8;
      const intensity = vigor * ramp * (weekend ? 0.5 : 1) * (0.6 + rand(seed, `int:${rp.name}:${d}`) * 0.9);
      const nTools = Math.max(1, Math.round((3 + rand(seed, `tools:${rp.name}:${d}`) * 9) * intensity));
      const nTurns = Math.max(1, Math.round((1 + rand(seed, `turns:${rp.name}:${d}`) * 3) * intensity));
      const nForks = rand(seed, `forkq:${rp.name}:${d}`) < 0.3 ? 1 + Math.floor(rand(seed, `forkn:${rp.name}:${d}`) * 2) : 0;
      const allnighter = rand(seed, `night:${rp.name}:${d}`) < 0.04;
      const baseSec = allnighter ? -(9 * 3600) + 2 * 3600 : 0; // ~02:00 for all-nighters

      // session id — coupled repos may share one for rail coupling
      let session = `s-${rp.name}-${d}-${sessionCounter++}`;
      for (const [a, b] of COUPLES) {
        const other = a === rp.name ? b : b === rp.name ? a : null;
        if (!other) continue;
        // both active today AND coupling roll -> shared session
        const bothKey = `couple:${a}:${b}:${d}`;
        if (rand(seed, bothKey) < 0.5) {
          const existing = coupleSession.get(`${a}|${b}`);
          if (existing) session = existing;
          else coupleSession.set(`${a}|${b}`, session);
        }
      }

      const cwd = `/work/${rp.name}`;
      let sec = baseSec + Math.floor(rand(seed, `off:${rp.name}:${d}`) * 600);
      const push = (kind: EventKind, tool?: string, detail?: string) => {
        sec += 3 + Math.floor(rand(seed, `sec:${rp.name}:${d}:${sec}:${kind}`) * 40);
        const ev: PixelEvent = {
          ts: iso(allnighter ? startMidnightMs : startMs, d, sec),
          session,
          agent: "user",
          source: "pixelagents",
          cwd,
          repo: rp.name,
          kind,
        };
        if (tool) ev.tool = tool;
        if (detail) ev.detail = detail;
        events.push(ev);
      };

      push("session.start");
      const calls = toolCalls(rp.cat);
      for (let i = 0; i < nTools; i++) {
        const c = calls[i % calls.length]!;
        push("tool.pre", c.tool, c.detail);
        push("tool.post", c.tool, c.detail);
      }
      for (let i = 0; i < nForks; i++) {
        push("fork.start", "Task", "delegate subtask");
        push("fork.end", "Task");
      }
      // occasional waiting events
      if (rand(seed, `waith:${rp.name}:${d}`) < 0.12) push("waiting.human");
      if (rand(seed, `waitp:${rp.name}:${d}`) < 0.08) push("waiting.permission");
      for (let i = 0; i < nTurns; i++) push("turn.end");
      push("session.end");
    }
  }

  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return events;
}
