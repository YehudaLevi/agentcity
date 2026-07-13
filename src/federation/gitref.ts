// agentcity — git remote discovery (used by gamified/identity.ts to resolve a
// workspace to its ProjectId).
//
// Discovery is delegated to git itself (`git config --get remote.origin.url`,
// `git rev-parse --show-toplevel`) rather than parsing .git/config by hand, so
// it is permissive by construction: subdirectories, worktrees (where .git is a
// file), and submodules all resolve, because git walks up and reads the real
// (possibly linked) config. No stupid fallbacks: no origin remote => the project
// is genuinely personal. The remote is the ONLY identifier that may leave the
// machine — never the local path.

import { execFileSync } from "node:child_process";

/** Run a read-only git query in `dir`, returning trimmed stdout or null. */
function git(dir: string, ...args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Normalize any git remote URL to `host/owner/repo` (no protocol, creds, .git). */
export function normalizeRemote(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  // scp-like: git@github.com:acme/foo.git
  const scp = /^[^/@]+@([^:]+):(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    // strip scheme + optional credentials: https://user:tok@host/path
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^/@]+@/, "");
  }
  s = s.replace(/\.git$/, "").replace(/\/+$/, "");
  return s.includes("/") ? s : null;
}

/**
 * Canonical `origin` remote for `dir`, via git. Returns null when `dir` is not a
 * git repo, has no `origin` remote, or git is unavailable — the caller then
 * treats the project as personal. Never throws.
 */
export function readOriginRemote(dir: string): string | null {
  const url = git(dir, "config", "--get", "remote.origin.url");
  return url ? normalizeRemote(url) : null;
}

/** Canonical repo root for `dir` (git's own boundary — resolves subdirs and
 * worktrees), or null when `dir` is not in a git repo. */
export function gitToplevel(dir: string): string | null {
  return git(dir, "rev-parse", "--show-toplevel");
}
