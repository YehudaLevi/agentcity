import { describe, it, expect } from "vitest";
import { renderCity } from "../src/compiler.js";
import { stableStringify } from "../src/types.js";
import type { GamifiedEvent, ProjectId } from "../src/gamified/types.js";

// A single gamified fact. `wu`/`forks`/`turns` default to something lively so the
// city actually grows; override per test.
function ev(p: Partial<GamifiedEvent> & { proj: ProjectId; by: string; day: number }): GamifiedEvent {
  const iso = `2026-01-${String(p.day + 1).padStart(2, "0")}T12:00:00.000Z`;
  return {
    v: 1,
    proj: p.proj,
    name: p.name ?? (p.proj.kind === "git" ? p.proj.remote.split("/").pop()! : "workspace"),
    by: p.by,
    day: p.day,
    ts: p.ts ?? iso,
    wu: p.wu ?? 40,
    forks: p.forks ?? 0,
    turns: p.turns ?? 8,
    allnighter: p.allnighter ?? false,
    category: p.category ?? "code",
    sessions: p.sessions ?? [],
    founding: p.founding ?? p.day === 0,
  };
}

const git = (repo: string): ProjectId => ({ kind: "git", remote: `github.com/acme/${repo}` });
const local = (token: string): ProjectId => ({ kind: "local", token });

describe("renderCity (the shared pipeline)", () => {
  it("produces a non-empty city from a single-contributor stream", () => {
    const stream = [0, 1, 2, 3, 4].map((day) => ev({ proj: git("app"), by: "alice", day }));
    const { model } = renderCity(stream, "seed-a");
    expect(model.lots.length).toBe(1);
    expect(model.lots[0]!.repo).toBe("app");
    expect(model.lots[0]!.wu).toBe(40 * 5);
    expect(model.stats.totalWu).toBe(40 * 5);
  });

  it("git projects MERGE across contributors into one shared building", () => {
    const stream: GamifiedEvent[] = [
      ev({ proj: git("app"), by: "alice", day: 0 }),
      ev({ proj: git("app"), by: "bob", day: 0, founding: false }),
      ev({ proj: git("app"), by: "bob", day: 1, founding: false }),
    ];
    const { model } = renderCity(stream, "seed-a");
    expect(model.lots.length).toBe(1);
    const lot = model.lots[0]!;
    // WU sums across both contributors; attribution lists both.
    expect(lot.wu).toBe(40 * 3);
    expect(lot.contributors).toEqual(["alice", "bob"]);
    expect(lot.personal).toBe(false);
  });

  it("local projects are per-user treehouses — never merged across contributors", () => {
    const stream: GamifiedEvent[] = [
      ev({ proj: local("t1"), by: "alice", day: 0, name: "sketch" }),
      ev({ proj: local("t1"), by: "bob", day: 0, name: "sketch" }),
    ];
    const { model } = renderCity(stream, "seed-a");
    // same token, different handles -> two distinct per-user tiles.
    expect(model.lots.length).toBe(2);
    expect(model.lots.every((l) => l.personal === true)).toBe(true);
  });

  it("uses a SHARED calendar epoch so independently-gamified streams align in time", () => {
    // alice founds on the global day 0; bob's stream is day-0-relative to HIS own
    // start (Jan 3) but must land on shared day 2, not shared day 0.
    const stream: GamifiedEvent[] = [
      ev({ proj: git("a"), by: "alice", day: 0, ts: "2026-01-01T12:00:00.000Z" }),
      ev({ proj: git("b"), by: "bob", day: 0, ts: "2026-01-03T12:00:00.000Z" }),
    ];
    const { deltas } = renderCity(stream, "seed-a");
    const founds = deltas.filter((d) => d.kind === "lot.found");
    const dayOf = (repo: string) => founds.find((d) => d.repo === repo)!.day;
    expect(dayOf("a")).toBe(0);
    expect(dayOf("b")).toBe(2);
  });

  it("is deterministic given (events, seed)", () => {
    const stream = [0, 1, 2, 3].flatMap((day) => [
      ev({ proj: git("app"), by: "alice", day }),
      ev({ proj: local("t"), by: "alice", day, name: "notes" }),
    ]);
    const a = renderCity(stream, "seed-x");
    const b = renderCity(stream, "seed-x");
    expect(stableStringify(a.model)).toBe(stableStringify(b.model));
    expect(stableStringify(a.deltas)).toBe(stableStringify(b.deltas));
  });

  it("throughDay advances time past the last event (decay/population keep ticking)", () => {
    const stream = [ev({ proj: git("app"), by: "alice", day: 0 })];
    const early = renderCity(stream, "seed-a");
    const late = renderCity(stream, "seed-a", { throughDay: 40 });
    expect(early.model.day).toBe(0);
    expect(late.model.day).toBe(40);
    // idle building decays over the extra days.
    expect(late.model.lots[0]!.decay).toBeGreaterThan(early.model.lots[0]!.decay);
  });
});
