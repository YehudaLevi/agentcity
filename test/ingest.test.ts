import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseClaudeHistory } from "../src/ingest/claude-history.js";
import { parsePixelagentsLog } from "../src/ingest/pixelagents-log.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLAUDE = join(here, "fixtures", "claude-history");
const PIXEL = join(here, "fixtures", "pixelagents");

describe("claude-history ingest", () => {
  const events = parseClaudeHistory(CLAUDE);

  it("maps cwd basename -> repo and preserves timestamps in order", () => {
    expect(events.length).toBeGreaterThan(0);
    const repos = new Set(events.map((e) => e.repo));
    expect(repos).toContain("webshop");
    expect(repos).toContain("api-svc");
    // ts sorted
    for (let i = 1; i < events.length; i++) expect(events[i - 1]!.ts <= events[i]!.ts).toBe(true);
  });

  it("derives tool.pre/post, turn.end, session brackets", () => {
    const webshop = events.filter((e) => e.repo === "webshop");
    const kinds = webshop.map((e) => e.kind);
    expect(kinds).toContain("session.start");
    expect(kinds).toContain("tool.pre");
    expect(kinds).toContain("tool.post");
    expect(kinds).toContain("turn.end");
    expect(kinds).toContain("session.end");
    // detail is file_path / first command line only
    const edit = webshop.find((e) => e.tool === "Edit");
    expect(edit?.detail).toBe("src/cart.ts");
    const bash = webshop.find((e) => e.tool === "Bash");
    expect(bash?.detail).toBe("npm test -- cart"); // only the FIRST line
  });

  it("maps Task tool to fork.start/fork.end", () => {
    const api = events.filter((e) => e.repo === "api-svc");
    expect(api.some((e) => e.kind === "fork.start" && e.tool === "Task")).toBe(true);
    expect(api.some((e) => e.kind === "fork.end")).toBe(true);
  });

  it("handles a session spanning midnight (events on both calendar days)", () => {
    const days = new Set(events.map((e) => e.ts.slice(0, 10)));
    expect(days).toContain("2026-05-03");
    expect(days).toContain("2026-05-04");
  });

  it("PRIVACY: never leaks content fields into detail", () => {
    const forbidden = [
      "SECRET_TOKEN",
      "abc123",
      "process.env",
      "PRIVATE FILE CONTENT",
      "must never leak",
      "3 passing",
      "race condition",
      "200 OK",
      "Going to sleep",
    ];
    for (const e of events) {
      const d = e.detail ?? "";
      for (const f of forbidden) expect(d.includes(f)).toBe(false);
    }
  });
});

describe("subagent worktrees never become their own repo (BUG-2)", () => {
  const SUB = join(here, "fixtures", "subagent-history");
  const events = parseClaudeHistory(SUB);

  it("attributes subagent worktree transcripts to the PARENT repo, not agent-<id>", () => {
    expect(events.length).toBeGreaterThan(0);
    const repos = new Set(events.map((e) => e.repo));
    // no phantom "agent-*" repos at all
    expect([...repos].some((r) => /^agent-/.test(r))).toBe(false);
    // everything (parent session + worktree subagent) credits the one repo
    expect(repos).toEqual(new Set(["myrepo"]));
  });

  it("credits the subagent's actual work (Edit) to the parent repo", () => {
    const edit = events.find((e) => e.kind === "tool.post");
    expect(edit).toBeTruthy();
    expect(edit!.repo).toBe("myrepo");
    // the fork itself (Task in the parent transcript) also lands on the parent
    expect(events.some((e) => e.kind === "fork.start" && e.repo === "myrepo")).toBe(true);
  });

  it("attributes cwd-less subagent entries to the project repo (fallback)", () => {
    // the agent-a0000… transcript has NO cwd line anywhere; it must inherit myrepo
    const write = events.find((e) => e.tool === "Write");
    expect(write).toBeTruthy();
    expect(write!.repo).toBe("myrepo");
  });
});

describe("pixelagents-log ingest", () => {
  it("parses events.jsonl and tolerates corrupt lines", () => {
    const events = parsePixelagentsLog(PIXEL);
    expect(events.length).toBe(5); // 6 lines, 1 corrupt dropped
    expect(events.every((e) => e.repo === "infra-repo")).toBe(true);
    expect(events.some((e) => e.kind === "tool.pre" && e.detail === "docker build -t app .")).toBe(true);
  });

  it("returns empty for a missing directory (no throw)", () => {
    expect(parsePixelagentsLog(join(PIXEL, "does-not-exist"))).toEqual([]);
  });
});
