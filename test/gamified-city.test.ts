import { describe, it, expect } from "vitest";
import { GamifiedCity } from "../src/gamified/city.js";
import { renderCity } from "../src/compiler.js";
import { stableStringify } from "../src/types.js";
import type { CityDelta } from "../src/types.js";
import type { GamifiedEvent, ProjectId } from "../src/gamified/types.js";

function ev(p: Partial<GamifiedEvent> & { proj: ProjectId; by: string; day: number }): GamifiedEvent {
  const iso = `2026-02-${String(p.day + 1).padStart(2, "0")}T12:00:00.000Z`;
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
    allnighter: false,
    category: p.category ?? "code",
    sessions: p.sessions ?? [],
    founding: p.founding ?? p.day === 0,
  };
}

const git = (repo: string): ProjectId => ({ kind: "git", remote: `github.com/acme/${repo}` });

// full timeline == core(prev) ++ tail is the invariant the renderer relies on:
// replaceFrom(fromDay) drops day >= fromDay then splices `deltas`.
function replayEquals(before: CityDelta[], fromDay: number, tail: CityDelta[], after: CityDelta[]): void {
  const kept = before.filter((d) => d.day < fromDay && d.kind !== "sync.lots");
  const rebuilt = [...kept, ...tail].sort((a, b) => a.day - b.day || a.seq - b.seq);
  expect(stableStringify(rebuilt)).toBe(stableStringify(after));
}

describe("GamifiedCity (day-granular reconciliation)", () => {
  it("APPENDS at the new day when an established client works beyond the frontier", () => {
    const before0 = [0, 1, 2, 3].map((day) => ev({ proj: git("app"), by: "alice", day, founding: day === 0 }));
    const city = new GamifiedCity("seed-a", {}, before0);
    const before = city.deltas();
    const r = city.ingest([ev({ proj: git("app"), by: "alice", day: 4, founding: false })]);
    expect(r.fromDay).toBe(4); // only day 4 onward changed
    expect(r.deltas.every((d) => d.day >= 4)).toBe(true);
    replayEquals(before, r.fromDay, r.deltas, city.deltas());
  });

  it("reconciled model + timeline == a full refold of the merged stream", () => {
    const seed = "seed-b";
    const first = [ev({ proj: git("app"), by: "alice", day: 0 }), ev({ proj: git("api"), by: "alice", day: 0 })];
    const second = [1, 2, 3].map((day) => ev({ proj: git("app"), by: "alice", day, founding: false }));
    const city = new GamifiedCity(seed, {}, first);
    city.ingest(second);
    const whole = renderCity([...first, ...second], seed);
    expect(stableStringify(city.model())).toBe(stableStringify(whole.model));
    expect(stableStringify(city.deltas())).toBe(stableStringify(whole.deltas));
  });

  it("a late joiner backfilling a historic day reconciles from that earliest day", () => {
    const seed = "seed-c";
    const base = [0, 1, 2].map((day) => ev({ proj: git("app"), by: "alice", day, founding: day === 0 }));
    const city = new GamifiedCity(seed, {}, base);
    const before = city.deltas();
    const r = city.ingest([
      ev({ proj: git("app"), by: "bob", day: 0, founding: false }),
      ev({ proj: git("app"), by: "bob", day: 1, founding: false }),
    ]);
    expect(r.fromDay).toBe(0); // day 0 changed (bob joined it) -> reconcile from 0
    replayEquals(before, r.fromDay, r.deltas, city.deltas());
    // attribution now credits both contributors on the shared building.
    expect(city.model().lots[0]!.contributors).toEqual(["alice", "bob"]);
  });

  it("late-join reconciliation equals a from-the-start fold (fold purity)", () => {
    const seed = "seed-d";
    const alice = [0, 1, 2].map((day) => ev({ proj: git("app"), by: "alice", day, founding: day === 0 }));
    const bobHistoric = [0, 1].map((day) => ev({ proj: git("app"), by: "bob", day, founding: false }));
    const city = new GamifiedCity(seed, {}, alice);
    city.ingest(bobHistoric);
    const fromStart = renderCity([...alice, ...bobHistoric], seed);
    expect(stableStringify(city.model())).toBe(stableStringify(fromStart.model));
  });

  it("an earlier epoch (an event older than day 0) reconciles from day 0", () => {
    const seed = "seed-e";
    const city = new GamifiedCity(seed, {}, [ev({ proj: git("app"), by: "alice", day: 5, ts: "2026-02-10T12:00:00.000Z" })]);
    const r = city.ingest([ev({ proj: git("api"), by: "alice", day: 0, ts: "2026-02-01T12:00:00.000Z", founding: true })]);
    expect(r.fromDay).toBe(0); // epoch shifted -> whole timeline renumbers
  });
});
