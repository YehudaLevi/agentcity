import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveEvents, readArchive, writeConfig, readConfig, paths } from "../src/persist.js";
import { generateDemoEvents } from "../src/demo-events.js";

// NEVER touch the real ~/.agentcity — use an isolated temp root.
const roots: string[] = [];
function tmpRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "agentcity-test-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("persistence (archive + config)", () => {
  const events = generateDemoEvents("persist-seed").slice(0, 400);

  it("events archive to monthly gz and read back (never pruned)", () => {
    const root = tmpRoot();
    archiveEvents(root, events);
    const files = readdirSync(paths(root).archiveDir).filter((f) => f.endsWith(".jsonl.gz"));
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => /^events-\d{4}-\d{2}\.jsonl\.gz$/.test(f))).toBe(true);
    const back = readArchive(root);
    expect(back.length).toBe(events.length);
    // appending more preserves prior content (archive, never prune)
    const more = generateDemoEvents("persist-seed").slice(400, 450);
    archiveEvents(root, more);
    expect(readArchive(root).length).toBe(events.length + more.length);
  });

  it("config round-trips with defaults", () => {
    const root = tmpRoot();
    expect(readConfig(root).historyInfluence).toBe("full"); // default when absent
    writeConfig(root, { seed: "s1", historyInfluence: "capped", aliases: { repo: "town-1" } });
    const c = readConfig(root);
    expect(c.seed).toBe("s1");
    expect(c.historyInfluence).toBe("capped");
    expect(c.aliases.repo).toBe("town-1");
  });

  it("reading an absent archive is safe", () => {
    const root = tmpRoot();
    expect(readArchive(root)).toEqual([]);
  });
});
