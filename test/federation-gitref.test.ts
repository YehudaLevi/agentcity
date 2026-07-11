import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRemote, readOriginRemote } from "../src/federation/gitref.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

describe("normalizeRemote", () => {
  it("normalizes scp, https, and credentialed URLs to host/owner/repo", () => {
    expect(normalizeRemote("git@github.com:acme/foo.git")).toBe("github.com/acme/foo");
    expect(normalizeRemote("https://github.com/acme/foo.git")).toBe("github.com/acme/foo");
    expect(normalizeRemote("https://user:tok@gitlab.com/acme/foo")).toBe("gitlab.com/acme/foo");
    expect(normalizeRemote("ssh://git@host.xz:22/acme/foo.git")).toBe("host.xz:22/acme/foo");
  });
  it("rejects junk", () => {
    expect(normalizeRemote("")).toBeNull();
    expect(normalizeRemote("not-a-url")).toBeNull();
  });
});

describe("readOriginRemote (canonical git discovery)", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("returns null outside a git repo (no stupid fallback)", () => {
    dir = mkdtempSync(join(tmpdir(), "agentcity-nogit-"));
    expect(readOriginRemote(dir)).toBeNull();
  });

  it.skipIf(!hasGit)("resolves origin from a subdirectory AND a worktree (.git is a file)", () => {
    dir = mkdtempSync(join(tmpdir(), "agentcity-git-"));
    const repo = join(dir, "myrepo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "remote", "add", "origin", "git@github.com:acme/myrepo.git");
    writeFileSync(join(repo, "a.txt"), "x");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");

    // from a nested subdirectory — git walks up
    const sub = join(repo, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(readOriginRemote(sub)).toBe("github.com/acme/myrepo");

    // from a linked worktree, where `.git` is a FILE, not a directory
    const wt = join(dir, "wt");
    git(repo, "worktree", "add", "-q", "--detach", wt, "HEAD");
    expect(readOriginRemote(wt)).toBe("github.com/acme/myrepo");
  });

  it.skipIf(!hasGit)("treats a repo with no origin remote as personal (null)", () => {
    dir = mkdtempSync(join(tmpdir(), "agentcity-noorigin-"));
    git(dir, "init", "-q");
    expect(readOriginRemote(dir)).toBeNull();
  });
});

describe("gitToplevel", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it.skipIf(!hasGit)("returns the repo root from a nested subdir, null outside a repo", async () => {
    const { gitToplevel } = await import("../src/federation/gitref.js");
    dir = mkdtempSync(join(tmpdir(), "agentcity-top-"));
    const repo = join(dir, "proj");
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    git(repo, "init", "-q");
    // git may report a realpath (/private on macOS); compare basenames.
    expect(gitToplevel(join(repo, "a", "b"))?.endsWith("proj")).toBe(true);
    expect(gitToplevel(mkdtempSync(join(tmpdir(), "agentcity-nogit2-")))).toBeNull();
  });
});
