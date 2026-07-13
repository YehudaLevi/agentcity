import { describe, it, expect } from "vitest";
import { render } from "./support.js";
import type { PixelEvent } from "../src/types.js";

function activity(repo: string, day: number): PixelEvent[] {
  const base = Date.parse("2026-04-01T09:00:00Z") + day * 86400000;
  let s = 0;
  const ts = () => new Date(base + s++ * 1000).toISOString();
  const out: PixelEvent[] = [
    { ts: ts(), session: `s-${repo}-${day}`, agent: "u", source: "t", repo, kind: "session.start" },
  ];
  for (let i = 0; i < 3; i++) {
    out.push({ ts: ts(), session: `s-${repo}-${day}`, agent: "u", source: "t", repo, kind: "tool.pre", tool: "Edit", detail: "src/a.ts" });
    out.push({ ts: ts(), session: `s-${repo}-${day}`, agent: "u", source: "t", repo, kind: "tool.post", tool: "Edit", detail: "src/a.ts" });
  }
  out.push({ ts: ts(), session: `s-${repo}-${day}`, agent: "u", source: "t", repo, kind: "turn.end" });
  return out;
}

describe("decay (30/90 day silence) + renovation", () => {
  it("vines at >30 days idle (decay 1)", () => {
    const ev = [...activity("web", 0), ...activity("keepalive", 40)];
    const { model } = render(ev, "decay1");
    expect(model.lots.find((l) => l.repo === "web")!.decay).toBe(1);
  });

  it("cracks at >90 days idle (decay 2)", () => {
    const ev = [...activity("web", 0), ...activity("keepalive", 100)];
    const { model } = render(ev, "decay2");
    expect(model.lots.find((l) => l.repo === "web")!.decay).toBe(2);
  });

  it("new WU renovates a decayed lot (decay resets, renovate delta emitted)", () => {
    const ev = [...activity("web", 0), ...activity("keepalive", 100), ...activity("web", 101)];
    const { model, deltas } = render(ev, "decay3");
    const web = model.lots.find((l) => l.repo === "web")!;
    expect(web.decay).toBe(0);
    const webDecays = deltas.filter((d) => d.kind === "lot.decay" && d.id === web.id).map((d) => d.level);
    expect(webDecays).toContain(1);
    expect(webDecays).toContain(2);
    expect(deltas.some((d) => d.kind === "lot.renovate" && d.id === web.id)).toBe(true);
  });
});
