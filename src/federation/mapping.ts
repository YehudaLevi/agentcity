// agentcity — hub-side project correlation.
//
// Ordered regex rules alias git remotes to a canonical project, so the same
// logical project reported under different remotes (a fork, a mirror, a
// monorepo) merges into ONE building. Rules apply only to git-remote identities;
// per-user (repo/local) tiles are never merged across contributors by design.

import type { ProjectId } from "../gamified/types.js";

export interface MappingRule {
  /** JS regex source tested against the remote (e.g. "github\\.com/acme/"). */
  pattern: string;
  /** canonical project name matched remotes collapse into. */
  project: string;
}

export interface CompiledRule {
  re: RegExp;
  project: string;
}

/** Precompile rules, skipping (never throwing on) invalid regex sources. */
export function compileRules(rules: MappingRule[]): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const r of rules) {
    if (!r || typeof r.pattern !== "string" || typeof r.project !== "string") continue;
    try {
      out.push({ re: new RegExp(r.pattern), project: r.project });
    } catch {
      /* tolerate a bad pattern — the rule is simply ignored */
    }
  }
  return out;
}

/** Parse a rules.json payload (an array, or `{ rules: [...] }`) into rules. */
export function parseRules(json: unknown): MappingRule[] {
  const arr = Array.isArray(json) ? json : Array.isArray((json as { rules?: unknown })?.rules) ? (json as { rules: unknown[] }).rules : [];
  return arr.filter((r): r is MappingRule => !!r && typeof (r as MappingRule).pattern === "string" && typeof (r as MappingRule).project === "string");
}

/**
 * Rewrite a git project's remote to its canonical alias when a rule matches, so
 * all matching remotes share one tile. Non-git (per-user) projects pass through
 * unchanged. Deterministic: first matching rule wins.
 */
export function remapProject(proj: ProjectId, rules: CompiledRule[]): ProjectId {
  if (proj.kind !== "git") return proj;
  for (const rule of rules) {
    if (rule.re.test(proj.remote)) return { kind: "git", remote: `canonical/${rule.project}` };
  }
  return proj;
}
