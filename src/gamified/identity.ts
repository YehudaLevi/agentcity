// agentcity — resolve a repo to its gamified ProjectId (git remote vs per-user
// hash). This is where the local machine's filesystem is consulted; the PATH
// itself never leaves the machine — only a public git remote OR an opaque hash.
//
// Discovery is delegated to git (`git config --get remote.origin.url`,
// `git rev-parse --show-toplevel`) so subdirectories, worktrees and submodules
// all resolve. Three outcomes, mirroring ProjectId:
//   • has origin remote → { kind: "git", remote }  (SHARED building)
//   • git repo, no remote → { kind: "repo", token } (per-user building)
//   • not a git repo → { kind: "local", token }     (per-user treehouse)

import { basename } from "node:path";
import { sha256hex } from "../seed.js";
import { readOriginRemote, gitToplevel } from "../federation/gitref.js";
import type { ProjectId } from "./types.js";
import type { IdentityResolver } from "./gamify.js";

function resolve(repo: string, dir: string | undefined): { proj: ProjectId; name: string } {
  if (dir) {
    const remote = readOriginRemote(dir);
    if (remote) return { proj: { kind: "git", remote }, name: basename(remote) };
    // A git repo with no remote: per-user BUILDING keyed by the repo root, so a
    // repo's subdirectories collapse into one building named after the repo.
    const top = gitToplevel(dir);
    if (top) return { proj: { kind: "repo", token: sha256hex(top).slice(0, 16) }, name: basename(top) };
    // not a git repo: a per-user workspace -> treehouse.
    return { proj: { kind: "local", token: sha256hex(dir).slice(0, 16) }, name: repo };
  }
  // no known path: last resort, a treehouse named by the workspace.
  return { proj: { kind: "local", token: sha256hex(repo).slice(0, 16) }, name: repo };
}

/**
 * Build a cached repo -> identity resolver. `pathForRepo` yields a known working
 * directory for a repo (harvested from ingested events' cwd), used only locally
 * to ask git for its remote. Caching keeps gamify's fold pure & fast.
 */
export function createIdentityResolver(pathForRepo: (repo: string) => string | undefined): IdentityResolver {
  const cache = new Map<string, { proj: ProjectId; name: string }>();
  return (repo: string) => {
    const hit = cache.get(repo);
    if (hit) return hit;
    const id = resolve(repo, pathForRepo(repo));
    cache.set(repo, id);
    return id;
  };
}

/** Harvest a repo -> cwd map from ingested events (last cwd wins, deterministic
 * over a ts-sorted stream). Used to feed createIdentityResolver. */
export function pathIndex(events: { repo: string; cwd?: string }[]): (repo: string) => string | undefined {
  const map = new Map<string, string>();
  for (const e of events) if (e.cwd) map.set(e.repo, e.cwd);
  return (repo: string) => map.get(repo);
}
