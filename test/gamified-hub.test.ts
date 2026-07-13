import { describe, it, expect } from "vitest";
import { createHub } from "../src/gamified/hub.js";
import { renderCity } from "../src/compiler.js";
import { compileRules } from "../src/federation/mapping.js";
import { stableStringify } from "../src/types.js";
import type { GamifiedEvent, GamifiedBatch, ProjectId } from "../src/gamified/types.js";

function ev(p: Partial<GamifiedEvent> & { proj: ProjectId; by: string; day: number }): GamifiedEvent {
  return {
    v: 1, proj: p.proj, name: p.name ?? (p.proj.kind === "git" ? p.proj.remote.split("/").pop()! : "ws"),
    by: p.by, day: p.day, ts: p.ts ?? `2026-03-0${p.day + 1}T12:00:00.000Z`,
    wu: p.wu ?? 40, forks: 0, turns: 8, allnighter: false, category: p.category ?? "code",
    sessions: p.sessions ?? [], founding: p.founding ?? p.day === 0,
  };
}
const git = (r: string): ProjectId => ({ kind: "git", remote: `github.com/a/${r}` });
const batch = (handle: string, events: GamifiedEvent[]): GamifiedBatch => ({ v: 1, handle, events });

describe("central hub (shared GamifiedCity)", () => {
  it("merges two contributors on a shared git repo into one building", () => {
    const hub = createHub({ seed: "hub" });
    hub.ingest(batch("alice", [ev({ proj: git("app"), by: "alice", day: 0 })]));
    const r = hub.ingest(batch("bob", [ev({ proj: git("app"), by: "bob", day: 0, founding: false })]));
    expect(r).not.toBeNull();
    expect(hub.model().lots.length).toBe(1);
    expect(hub.model().lots[0]!.contributors).toEqual(["alice", "bob"]);
    expect(hub.contributors()).toBe(2);
  });

  it("appends at the new day; a late joiner's historic backlog reconciles from day 0", () => {
    const hub = createHub({ seed: "hub" });
    hub.ingest(batch("alice", [0, 1, 2].map((day) => ev({ proj: git("app"), by: "alice", day, founding: day === 0 }))));
    const append = hub.ingest(batch("alice", [ev({ proj: git("app"), by: "alice", day: 3, founding: false })]));
    expect(append!.fromDay).toBe(3); // only the new day changed
    const late = hub.ingest(batch("bob", [0, 1].map((day) => ev({ proj: git("app"), by: "bob", day, founding: false }))));
    expect(late!.fromDay).toBe(0); // bob joined day 0 -> reconcile from the earliest touched day
  });

  it("late-join reconciliation equals a from-the-start fold (determinism)", () => {
    const alice = [0, 1, 2].map((day) => ev({ proj: git("app"), by: "alice", day, founding: day === 0 }));
    const bob = [0, 1].map((day) => ev({ proj: git("app"), by: "bob", day, founding: false }));
    const hub = createHub({ seed: "hub" });
    hub.ingest(batch("alice", alice));
    hub.ingest(batch("bob", bob));
    // batch arrival order must not matter: hub == a single render of the union.
    const oracle = renderCity([...alice, ...bob], "hub", { scene: "shared" }).model;
    expect(stableStringify(hub.model())).toBe(stableStringify(oracle));
  });

  it("cityAt(day) time-travels; ingest of nothing new is a null no-op", () => {
    const hub = createHub({ seed: "hub" });
    hub.ingest(batch("alice", [0, 1, 2].map((day) => ev({ proj: git("app"), by: "alice", day, founding: day === 0 }))));
    expect(hub.cityAt(0).day).toBe(0);
    expect(hub.cityAt(2).day).toBe(2);
    // exact-duplicate batch -> store unchanged -> null
    expect(hub.ingest(batch("alice", [ev({ proj: git("app"), by: "alice", day: 0, founding: true })]))).toBeNull();
  });

  it("mapping rules alias different remotes into one shared building", () => {
    const rules = compileRules([{ pattern: "acme/(foo|foo-fork)", project: "foo" }]);
    const hub = createHub({ seed: "hub", rules });
    hub.ingest(batch("alice", [ev({ proj: { kind: "git", remote: "github.com/acme/foo" }, by: "alice", day: 0 })]));
    hub.ingest(batch("bob", [ev({ proj: { kind: "git", remote: "gitlab.com/acme/foo-fork" }, by: "bob", day: 0, founding: false })]));
    expect(hub.model().lots.length).toBe(1); // both remotes -> canonical/foo
  });
});
