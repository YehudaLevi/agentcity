import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { boot, poll, foundFromEvents, refound, type Sources } from "../src/founding.js";
import { readCheckpoint, readArchive, paths } from "../src/persist.js";
import { fold } from "../src/compiler.js";
import { generateDemoEvents } from "../src/demo-events.js";
import { stableStringify } from "../src/types.js";
import type { PixelEvent } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const SEED = "found-seed";
// A full 90-day demo stream, split into two batches on a clean day boundary so
// the second boot must fold ONLY the newer events off the checkpoint.
const ALL = generateDemoEvents(SEED);
const CUT = "2026-05-16T00:00:00.000Z";
const BATCH1 = ALL.filter((e) => e.ts < CUT);
const BATCH2 = ALL.filter((e) => e.ts >= CUT);

let root: string;
let paDir: string; // pixelagents source dir
let histDir: string; // claude-history source dir (kept empty here)

function writeEvents(events: PixelEvent[]): void {
  writeFileSync(join(paDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
function sources(): Sources {
  return { historyDir: histDir, pixelagentsDir: paDir };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentcity-root-"));
  paDir = mkdtempSync(join(tmpdir(), "agentcity-pa-"));
  histDir = mkdtempSync(join(tmpdir(), "agentcity-hist-"));
  mkdirSync(histDir, { recursive: true });
});
afterEach(() => {
  for (const d of [root, paDir, histDir]) rmSync(d, { recursive: true, force: true });
});

describe("founding flow", () => {
  it("founds a fresh city end-to-end: checkpoint + archive + deltas written, valid bundle", () => {
    writeEvents(BATCH1);
    const res = boot(root, sources(), { seed: SEED });

    expect(res.founded).toBe(true);
    const p = paths(root);
    expect(existsSync(p.checkpoint)).toBe(true);
    expect(existsSync(p.deltas)).toBe(true);
    expect(readdirSync(p.archiveDir).some((f) => f.endsWith(".jsonl.gz"))).toBe(true);

    // archive holds the raw ingested events (rule 4)
    expect(readArchive(root).length).toBe(BATCH1.length);
    // served bundle is a valid CityModel + delta log
    expect(res.model.version).toBe(1);
    expect(res.model.lots.length).toBeGreaterThan(0);
    expect(res.deltas.length).toBeGreaterThan(0);
    expect(res.deltas[0]!.kind).toBe("baseline.init");
  });

  it("incremental restart: second boot resumes the checkpoint and folds ONLY new events", () => {
    writeEvents(BATCH1);
    const first = boot(root, sources(), { seed: SEED });
    const cpAfterFirst = readCheckpoint(root)!;
    expect(cpAfterFirst.upToTs).toBe(BATCH1[BATCH1.length - 1]!.ts);

    // more activity arrives; a fresh boot must use the checkpoint, not re-found
    writeEvents(ALL);
    const second = boot(root, sources(), { seed: SEED });
    expect(second.founded).toBe(false);
    expect(second.model.day).toBeGreaterThan(first.model.day);

    // incremental result is byte-identical to a full fold of everything
    const full = fold(ALL, SEED).model;
    expect(stableStringify(second.model)).toBe(stableStringify(full));
  });

  it("poll returns only the newly-produced deltas after the checkpoint", () => {
    writeEvents(BATCH1);
    boot(root, sources(), { seed: SEED });
    // committed frontier after founding = last COMPLETE day (state.day). The
    // final day of batch1 is still "open" (re-derived from pending), so poll
    // finalizes it and everything after — all strictly past this frontier.
    const frontier = readCheckpoint(root)!.state.day;

    // no new events yet
    expect(poll(root, sources())).toBeNull();

    writeEvents(ALL);
    const p = poll(root, sources())!;
    expect(p).not.toBeNull();
    expect(p.newDeltas.length).toBeGreaterThan(0);
    // every pushed delta is dated on a day past the committed frontier
    expect(Math.min(...p.newDeltas.map((d) => d.day as number))).toBeGreaterThan(frontier);
    // and a subsequent poll with nothing new is a no-op
    expect(poll(root, sources())).toBeNull();
  });

  it("refound rebuilds byte-identically from archives + sources", () => {
    writeEvents(ALL);
    const first = boot(root, sources(), { seed: SEED });
    // wipe derived state, keep archives, rebuild
    const p = paths(root);
    rmSync(p.checkpoint, { force: true });
    rmSync(p.deltas, { force: true });
    const re = refound(root, sources(), { seed: SEED });
    expect(stableStringify(re.model)).toBe(stableStringify(first.model));
  });
});

describe("--demo isolation", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("serves the demo city from a temp root without touching the real home dir", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "agentcity-home-"));
    const port = 4300 + Math.floor(Math.random() * 200);
    const child = spawn(process.execPath, [join(repoRoot, "bin", "agentcity.js"), "--demo", "--port", String(port)], {
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, AGENTCITY_DEBUG: "1" },
      stdio: "ignore",
    });
    try {
      // wait for the server to come up
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        await sleep(150);
        up = await new Promise<boolean>((resolve) => {
          get({ host: "127.0.0.1", port, path: "/healthz" }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          }).on("error", () => resolve(false));
        });
      }
      expect(up).toBe(true);
      // the real data dir under the sandboxed HOME must NOT have been created
      expect(existsSync(join(fakeHome, ".agentcity"))).toBe(false);
    } finally {
      child.kill("SIGKILL");
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("foundFromEvents writes only under the given root", () => {
    const demoRoot = mkdtempSync(join(tmpdir(), "agentcity-demoroot-"));
    try {
      const res = foundFromEvents(demoRoot, generateDemoEvents("demo"), "demo");
      expect(res.founded).toBe(true);
      expect(existsSync(paths(demoRoot).checkpoint)).toBe(true);
      expect(res.model.lots.length).toBeGreaterThan(0);
    } finally {
      rmSync(demoRoot, { recursive: true, force: true });
    }
  });
});
