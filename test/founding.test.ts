import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { boot, foundFromEvents, refound, localHandle, type Sources } from "../src/founding.js";
import { readArchive, paths, writeConfig, readConfig } from "../src/persist.js";
import { renderCity } from "../src/compiler.js";
import { gamify } from "../src/gamified/gamify.js";
import { generateDemoEvents, demoResolver } from "../src/demo-events.js";
import { stableStringify } from "../src/types.js";
import type { PixelEvent } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const SEED = "found-seed";
const HANDLE = "tester";
// A full 90-day demo stream, split on a clean day boundary so a resume/poll must
// APPEND only the newer days.
const ALL = generateDemoEvents(SEED);
const CUT = "2026-05-16T00:00:00.000Z";
const BATCH1 = ALL.filter((e) => e.ts < CUT);

let root: string;
let paDir: string; // pixelagents source dir
let histDir: string; // claude-history source dir (kept empty here)

function writeEvents(events: PixelEvent[]): void {
  writeFileSync(join(paDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
function sources(): Sources {
  return { historyDir: histDir, pixelagentsDir: paDir };
}
const opts = { seed: SEED, handle: HANDLE, resolve: demoResolver };

// Oracle: the deterministic city for a raw event set, straight through the
// shared pipeline (gamify -> renderCity), machine-independent via demoResolver.
function oracle(events: PixelEvent[]): string {
  return stableStringify(renderCity(gamify(events, demoResolver, HANDLE), SEED).model);
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
  it("founds a fresh city end-to-end: archive written, valid bundle, treehouses present", () => {
    writeEvents(BATCH1);
    const city = boot(root, sources(), opts);

    expect(city.founded).toBe(true);
    const p = paths(root);
    expect(readdirSync(p.archiveDir).some((f) => f.endsWith(".jsonl.gz"))).toBe(true);
    // archive holds the raw ingested events (rule 4)
    expect(readArchive(root).length).toBe(BATCH1.length);

    const model = city.model();
    expect(model.version).toBe(1);
    expect(model.lots.length).toBeGreaterThan(0);
    expect(city.deltas().length).toBeGreaterThan(0);
    expect(city.deltas()[0]!.kind).toBe("baseline.init");
    // the demo stream carries no-remote workspaces -> the city has treehouses.
    expect(model.lots.some((l) => l.personal === true)).toBe(true);
    expect(model.lots.some((l) => l.personal !== true)).toBe(true);
    // the served model is exactly the shared-pipeline oracle.
    expect(stableStringify(model)).toBe(oracle(BATCH1));
  });

  it("restart resumes the archive and re-folds ALL history (append)", () => {
    writeEvents(BATCH1);
    const first = boot(root, sources(), opts);

    // more activity arrives; a fresh boot resumes from the archive, not re-founds.
    writeEvents(ALL);
    const second = boot(root, sources(), opts);
    expect(second.founded).toBe(false);
    expect(second.model().day).toBeGreaterThan(first.model().day);
    // resumed city == a from-scratch render of everything (fold purity).
    expect(stableStringify(second.model())).toBe(oracle(ALL));
  });

  it("poll reconciles new activity and is a no-op when nothing changed", () => {
    writeEvents(BATCH1);
    const city = boot(root, sources(), opts);

    // nothing new yet
    expect(city.poll()).toBeNull();

    writeEvents(ALL);
    const p = city.poll()!;
    expect(p).not.toBeNull();
    expect(p.deltas.length).toBeGreaterThan(0);
    // BATCH2 founds new harbor (api) repos that carve inlets, back-patching the
    // day-0 geography — a legitimate refold. Either way the live city is exactly
    // the full-render oracle (clean append is covered in gamified-city.test).
    expect(stableStringify(city.model())).toBe(oracle(ALL));
    // a subsequent poll with nothing new is a no-op
    expect(city.poll()).toBeNull();
  });

  it("refound rebuilds byte-identically from archive + sources", () => {
    writeEvents(ALL);
    const first = boot(root, sources(), opts);
    const re = refound(root, sources(), opts);
    expect(stableStringify(re.model)).toBe(stableStringify(first.model()));
  });

  it("refound PRESERVES federation config + a non-default historyInfluence", () => {
    writeEvents(BATCH1);
    boot(root, sources(), opts);
    // a user configures federation + a capped influence
    writeConfig(root, {
      seed: SEED,
      historyInfluence: "capped",
      aliases: {},
      federation: { role: "client", centralUrl: "http://hub:4243", handle: "alice" },
    });
    refound(root, sources(), { seed: SEED, handle: HANDLE, resolve: demoResolver });
    const cfg = readConfig(root);
    expect(cfg.federation?.centralUrl).toBe("http://hub:4243"); // not wiped
    expect(cfg.federation?.handle).toBe("alice");
    expect(cfg.historyInfluence).toBe("capped"); // preserved, not reset to "full"
  });
});

describe("localHandle precedence + sanitization", () => {
  let r: string;
  beforeEach(() => (r = mkdtempSync(join(tmpdir(), "agentcity-h-"))));
  afterEach(() => rmSync(r, { recursive: true, force: true }));

  it("override (--handle) beats config, which beats $USER", () => {
    const prevUser = process.env.USER;
    try {
      process.env.USER = "alice";
      expect(localHandle(r)).toBe("alice"); // $USER default
      writeConfig(r, { seed: "s", historyInfluence: "full", aliases: {}, federation: { handle: "bob" } });
      expect(localHandle(r)).toBe("bob"); // config wins over $USER
      expect(localHandle(r, "carol")).toBe("carol"); // explicit override wins over all
    } finally {
      if (prevUser === undefined) delete process.env.USER;
      else process.env.USER = prevUser;
    }
  });

  it("sanitizes to a scene-safe token and falls back to 'user'", () => {
    expect(localHandle(r, "Jane Doe!")).toBe("Jane-Doe");
    const prevUser = process.env.USER;
    const prevLog = process.env.LOGNAME;
    try {
      delete process.env.USER;
      delete process.env.LOGNAME;
      expect(localHandle(r)).toBe("user"); // nothing usable -> "user"
    } finally {
      if (prevUser !== undefined) process.env.USER = prevUser;
      if (prevLog !== undefined) process.env.LOGNAME = prevLog;
    }
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
      const res = foundFromEvents(demoRoot, generateDemoEvents("demo"), "demo", { resolve: demoResolver });
      expect(res.founded).toBe(true);
      expect(readdirSync(paths(demoRoot).archiveDir).some((f) => f.endsWith(".jsonl.gz"))).toBe(true);
      expect(res.model.lots.length).toBeGreaterThan(0);
    } finally {
      rmSync(demoRoot, { recursive: true, force: true });
    }
  });
});
