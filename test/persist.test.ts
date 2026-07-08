import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeCheckpoint,
  readCheckpoint,
  appendDeltas,
  readDeltas,
  archiveEvents,
  readArchive,
  writeConfig,
  readConfig,
  paths,
} from "../src/persist.js";
import { fold } from "../src/compiler.js";
import { generateDemoEvents } from "../src/demo-events.js";
import { stableStringify } from "../src/types.js";

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

describe("persistence (Contract 4)", () => {
  const events = generateDemoEvents("persist-seed").slice(0, 400);
  const { checkpoint, deltas } = fold(events, "persist-seed");

  it("checkpoint round-trips byte-identically (atomic write)", () => {
    const root = tmpRoot();
    writeCheckpoint(root, checkpoint);
    const back = readCheckpoint(root);
    expect(back).not.toBeNull();
    expect(stableStringify(back)).toBe(stableStringify(checkpoint));
  });

  it("deltas append and read back in order", () => {
    const root = tmpRoot();
    appendDeltas(root, deltas.slice(0, 5));
    appendDeltas(root, deltas.slice(5, 10));
    const back = readDeltas(root);
    expect(back.length).toBe(10);
    expect(stableStringify(back)).toBe(stableStringify(deltas.slice(0, 10)));
  });

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

  it("reading absent checkpoint/deltas is safe", () => {
    const root = tmpRoot();
    expect(readCheckpoint(root)).toBeNull();
    expect(readDeltas(root)).toEqual([]);
    expect(existsSync(join(root, "checkpoint.json"))).toBe(false);
  });
});
