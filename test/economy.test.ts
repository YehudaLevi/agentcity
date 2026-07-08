import { describe, it, expect } from "vitest";
import { fold } from "../src/compiler.js";
import {
  rawWu,
  applyRepoCap,
  PER_REPO_DAILY_CAP,
  GLOBAL_DAILY_CAP,
  WAREHOUSE_MAX,
} from "../src/rules/economy.js";
import type { PixelEvent } from "../src/types.js";

function pairs(repo: string, day: number, n: number, hh = 9): PixelEvent[] {
  const out: PixelEvent[] = [];
  const base = Date.parse(`2026-06-0${day + 1}T${String(hh).padStart(2, "0")}:00:00Z`);
  let sec = 0;
  const ts = () => new Date(base + sec++ * 1000).toISOString();
  out.push({ ts: ts(), session: `s-${repo}-${day}`, agent: "u", source: "t", repo, kind: "session.start" });
  for (let i = 0; i < n; i++) {
    out.push({ ts: ts(), session: `s-${repo}-${day}`, agent: "u", source: "t", repo, kind: "tool.pre", tool: "Edit", detail: "src/a.ts" });
    out.push({ ts: ts(), session: `s-${repo}-${day}`, agent: "u", source: "t", repo, kind: "tool.post", tool: "Edit", detail: "src/a.ts" });
  }
  return out;
}

describe("economy units + caps (unit)", () => {
  it("rawWu applies the WU table", () => {
    expect(rawWu({ tools: 3, turns: 2, forks: 1, sessions: 1, founding: true })).toBe(3 * 1 + 2 * 5 + 1 * 3 + 1 * 2 + 25);
  });
  it("per-repo cap spills into a warehouse bounded at 60", () => {
    const r = applyRepoCap(1000, 0);
    expect(r.spendable).toBe(PER_REPO_DAILY_CAP);
    expect(r.warehouse).toBe(WAREHOUSE_MAX);
    // next quiet day spends the warehouse
    const r2 = applyRepoCap(5, WAREHOUSE_MAX);
    expect(r2.spendable).toBe(65);
    expect(r2.warehouse).toBe(0);
  });
});

describe("economy caps (integration through fold)", () => {
  it("a heavy single day never builds more than the per-repo cap", () => {
    // A trailing event on a later day makes "solo"'s heavy day 0 a COMPLETE day
    // so it lands in checkpoint.state (the checkpoint commits only whole days;
    // the still-open last day is re-derived from checkpoint.pending on resume).
    const { model, checkpoint } = fold([...pairs("solo", 0, 200), ...pairs("other", 2, 1)], "cap1");
    const lot = model.lots.find((l) => l.repo === "solo")!;
    expect(lot.wu).toBe(PER_REPO_DAILY_CAP);
    const wh = new Map(checkpoint.state.warehouse);
    expect(wh.get("solo")).toBe(WAREHOUSE_MAX);
  });

  it("warehouse spends on the next active day", () => {
    const ev = [...pairs("solo", 0, 200), ...pairs("solo", 1, 5)];
    const { model } = fold(ev, "cap2");
    const lot = model.lots.find((l) => l.repo === "solo")!;
    // day0 raw=200 tools + 2 (session) + 25 (founding) -> spend 120, warehouse 60.
    // day1 raw=5 tools + 2 (session)=7, +60 warehouse -> spend 67 -> 187 cumulative.
    expect(lot.wu).toBe(187);
  });

  it("global daily cap never exceeds 400 across repos", () => {
    const ev: PixelEvent[] = [];
    for (const r of ["a-repo", "b-repo", "c-repo", "d-repo", "e-repo"]) ev.push(...pairs(r, 0, 200));
    const { model } = fold(ev, "cap3");
    const dayGain = model.lots.reduce((s, l) => s + l.wu, 0);
    expect(dayGain).toBe(GLOBAL_DAILY_CAP);
    for (const l of model.lots) expect(l.wu).toBeLessThanOrEqual(PER_REPO_DAILY_CAP);
    expect(model.stats.totalWu).toBe(GLOBAL_DAILY_CAP);
  });
});
