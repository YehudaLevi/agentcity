import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseClaudeHistory } from "../src/ingest/claude-history.js";
import { parsePixelagentsLog } from "../src/ingest/pixelagents-log.js";
import { fold } from "../src/compiler.js";
import { stableStringify } from "../src/types.js";
import type { PixelEvent } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, "fixtures");

function goldenEvents(): PixelEvent[] {
  return [
    ...parseClaudeHistory(join(fx, "claude-history")),
    ...parsePixelagentsLog(join(fx, "pixelagents")),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

describe("golden model", () => {
  it("fixtures + seed 'golden-seed' fold byte-identically to the committed model", () => {
    const { model } = fold(goldenEvents(), "golden-seed", { historyInfluence: "full" });
    const actual = stableStringify(model);
    const expected = readFileSync(join(fx, "golden-model.json"), "utf8");
    expect(actual).toBe(expected);
  });

  it("re-folding is byte-identical (determinism invariant)", () => {
    const a = stableStringify(fold(goldenEvents(), "golden-seed").model);
    const b = stableStringify(fold(goldenEvents(), "golden-seed").model);
    expect(a).toBe(b);
  });
});
