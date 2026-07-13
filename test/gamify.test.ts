import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseClaudeHistory } from "../src/ingest/claude-history.js";
import { gamify, type IdentityResolver } from "../src/gamified/gamify.js";
import { PER_REPO_DAILY_CAP } from "../src/rules/economy.js";
import type { ProjectId } from "../src/gamified/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLAUDE = join(here, "fixtures", "claude-history");

// deterministic identity — no git (treehouses); never touches the filesystem
const localResolver: IdentityResolver = (repo) => ({ proj: { kind: "local", token: `t-${repo}` }, name: repo });
const gitResolver: IdentityResolver = (repo) => ({ proj: { kind: "git", remote: `github.com/x/${repo}` }, name: repo });

describe("gamify (local ingest -> shared stream)", () => {
  const raw = parseClaudeHistory(CLAUDE);

  it("produces a gamified stream with WU, categories and founding flags", () => {
    const stream = gamify(raw, localResolver, "alice");
    expect(stream.length).toBeGreaterThan(0);
    expect(stream.every((e) => e.by === "alice" && e.v === 1)).toBe(true);
    expect(stream.some((e) => e.founding)).toBe(true);
    expect(stream.some((e) => e.wu > 0)).toBe(true);
  });

  it("FIREWALL: the stream leaks no file paths, cwd, commands or session UUIDs", () => {
    const stream = gamify(raw, localResolver, "alice");
    const wire = JSON.stringify(stream);
    const secrets = new Set<string>();
    for (const e of raw) {
      if (e.detail) secrets.add(e.detail);
      if (e.cwd) secrets.add(e.cwd);
      if (e.session) secrets.add(e.session); // raw session UUID must be hashed away
    }
    expect(secrets.size).toBeGreaterThan(0);
    for (const s of secrets) expect(wire).not.toContain(s);
  });

  it("respects the per-repo daily WU cap", () => {
    const stream = gamify(raw, localResolver, "alice");
    for (const e of stream) expect(e.wu).toBeLessThanOrEqual(PER_REPO_DAILY_CAP);
  });

  it("carries the git/local identity from the resolver", () => {
    const asGit = gamify(raw, gitResolver, "alice");
    expect(asGit.every((e) => e.proj.kind === "git")).toBe(true);
    const asLocal = gamify(raw, localResolver, "alice");
    expect(asLocal.every((e) => (e.proj as ProjectId).kind === "local")).toBe(true);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(gamify(raw, localResolver, "alice"))).toBe(JSON.stringify(gamify(raw, localResolver, "alice")));
  });
});
