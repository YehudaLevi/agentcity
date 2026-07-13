import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentityResolver, pathIndex } from "../src/gamified/identity.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });

describe("createIdentityResolver (repo -> ProjectId)", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it.skipIf(!hasGit)("a repo WITH a remote -> git (shared building)", () => {
    dir = mkdtempSync(join(tmpdir(), "agentcity-id-git-"));
    const repo = join(dir, "withremote");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", "https://github.com/acme/withremote.git");
    const resolve = createIdentityResolver((r) => (r === "withremote" ? repo : undefined));
    expect(resolve("withremote").proj).toEqual({ kind: "git", remote: "github.com/acme/withremote" });
    expect(resolve("withremote").name).toBe("withremote");
  });

  it.skipIf(!hasGit)("a no-remote repo -> repo (per-user BUILDING); subdirs collapse to the root", () => {
    dir = mkdtempSync(join(tmpdir(), "agentcity-id-repo-"));
    const repo = join(dir, "myproj");
    mkdirSync(join(repo, "ui", "web"), { recursive: true });
    mkdirSync(join(repo, "crates", "core"), { recursive: true });
    git(repo, "init", "-q"); // NO remote
    const resolve = createIdentityResolver((r) =>
      r === "web" ? join(repo, "ui", "web") : r === "core" ? join(repo, "crates", "core") : undefined
    );
    const web = resolve("web");
    const core = resolve("core");
    expect(web.proj.kind).toBe("repo");
    expect(web.proj).toEqual(core.proj); // both subdirs -> one building
    expect(web.name).toBe("myproj");
  });

  it("a non-repo workspace -> local (treehouse)", () => {
    dir = mkdtempSync(join(tmpdir(), "agentcity-id-local-"));
    const resolve = createIdentityResolver((r) => (r === "plain" ? dir : undefined));
    expect(resolve("plain").proj.kind).toBe("local");
  });

  it("no known path -> local (treehouse named by the workspace), and caches", () => {
    const resolve = createIdentityResolver(() => undefined);
    const a = resolve("ghost");
    const b = resolve("ghost");
    expect(a.proj.kind).toBe("local");
    expect(a.name).toBe("ghost");
    expect(a).toBe(b); // cached
  });

  it("pathIndex maps repo -> last cwd seen", () => {
    const idx = pathIndex([
      { repo: "a", cwd: "/one" },
      { repo: "a", cwd: "/two" },
      { repo: "b" },
    ]);
    expect(idx("a")).toBe("/two");
    expect(idx("b")).toBeUndefined();
  });
});
