import { describe, it, expect } from "vitest";
import { coerce, coerceBatch } from "../src/gamified/types.js";

const good = {
  v: 1,
  proj: { kind: "git", remote: "github.com/a/b" },
  name: "b",
  by: "alice",
  day: 0,
  ts: "2026-03-01T12:00:00.000Z",
  wu: 40,
  forks: 0,
  turns: 8,
  allnighter: false,
  category: "code",
  sessions: [],
  founding: true,
};

describe("gamified wire coercion (fail-early validation)", () => {
  it("accepts a well-formed event", () => {
    expect(coerce(good)).not.toBeNull();
  });

  it("REJECTS a non-parseable ts (would poison the shared epoch -> NaN city)", () => {
    expect(coerce({ ...good, ts: "" })).toBeNull();
    expect(coerce({ ...good, ts: "not-a-date" })).toBeNull();
    expect(coerce({ ...good, ts: 123 })).toBeNull();
  });

  it("rejects unknown project kinds and bad categories", () => {
    expect(coerce({ ...good, proj: { kind: "ftp", remote: "x" } })).toBeNull();
    expect(coerce({ ...good, category: "poetry" })).toBeNull();
    expect(coerce({ ...good, v: 2 })).toBeNull();
  });

  it("accepts all three project kinds", () => {
    expect(coerce({ ...good, proj: { kind: "git", remote: "r" } })!.proj.kind).toBe("git");
    expect(coerce({ ...good, proj: { kind: "repo", token: "t" } })!.proj.kind).toBe("repo");
    expect(coerce({ ...good, proj: { kind: "local", token: "t" } })!.proj.kind).toBe("local");
  });

  it("coerceBatch drops malformed events but keeps the good ones", () => {
    const batch = coerceBatch({ v: 1, handle: "alice", events: [good, { ...good, ts: "" }, { ...good, day: 1 }] });
    expect(batch).not.toBeNull();
    expect(batch!.events.length).toBe(2); // the ts:"" event is dropped
  });
});
