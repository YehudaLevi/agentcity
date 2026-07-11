import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryGamifiedStore, FileGamifiedStore } from "../src/gamified/store.js";
import type { GamifiedEvent, ProjectId } from "../src/gamified/types.js";

function ev(p: Partial<GamifiedEvent> & { proj: ProjectId; by: string; day: number; wu: number }): GamifiedEvent {
  return {
    v: 1, proj: p.proj, name: p.name ?? "x", by: p.by, day: p.day,
    ts: p.ts ?? `2026-03-0${p.day + 1}T12:00:00.000Z`, wu: p.wu, forks: 0, turns: 4,
    allnighter: false, category: "code", sessions: [], founding: p.founding ?? false,
  };
}
const git = (r: string): ProjectId => ({ kind: "git", remote: `github.com/a/${r}` });

describe("GamifiedStore (upsert by project|by|day)", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("UPSERTS a growing open day (last WU wins), keeps distinct contributors", () => {
    const s = new MemoryGamifiedStore();
    expect(s.upsert([ev({ proj: git("app"), by: "alice", day: 0, wu: 10 })])).toBe(true);
    // same (proj,by,day) with more WU -> replaces
    expect(s.upsert([ev({ proj: git("app"), by: "alice", day: 0, wu: 25 })])).toBe(true);
    // a different contributor on the same tile/day -> distinct fact
    expect(s.upsert([ev({ proj: git("app"), by: "bob", day: 0, wu: 5 })])).toBe(true);
    const all = s.all();
    expect(all.length).toBe(2);
    expect(all.find((e) => e.by === "alice")!.wu).toBe(25);
    // exact duplicate -> no change
    expect(s.upsert([ev({ proj: git("app"), by: "bob", day: 0, wu: 5 })])).toBe(false);
    // a change to a NON-wu field (category) on a capped day must still re-fold
    expect(s.upsert([{ ...ev({ proj: git("app"), by: "bob", day: 0, wu: 5 }), category: "tests" }])).toBe(true);
    expect(s.all().find((e) => e.by === "bob")!.category).toBe("tests");
  });

  it("persists across restart and replays upserts (last line wins)", () => {
    dir = mkdtempSync(join(tmpdir(), "agentcity-gstore-"));
    const file = join(dir, "hub.jsonl");
    const s1 = new FileGamifiedStore(file);
    s1.upsert([ev({ proj: git("app"), by: "alice", day: 0, wu: 10 })]);
    s1.upsert([ev({ proj: git("app"), by: "alice", day: 0, wu: 40 })]); // append the update
    // fresh instance loads the log; the later value wins
    const s2 = new FileGamifiedStore(file);
    expect(s2.all().length).toBe(1);
    expect(s2.all()[0]!.wu).toBe(40);
  });

  it("orders deterministically by (day, ts, key)", () => {
    const s = new MemoryGamifiedStore();
    s.upsert([
      ev({ proj: git("b"), by: "z", day: 2, wu: 1 }),
      ev({ proj: git("a"), by: "z", day: 0, wu: 1 }),
      ev({ proj: git("a"), by: "z", day: 1, wu: 1 }),
    ]);
    expect(s.all().map((e) => e.day)).toEqual([0, 1, 2]);
  });
});
