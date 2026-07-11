import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseClaudeHistory } from "../src/ingest/claude-history.js";
import { parsePixelagentsLog } from "../src/ingest/pixelagents-log.js";
import { renderCity } from "../src/compiler.js";
import { gamify, type IdentityResolver } from "../src/gamified/gamify.js";
import { stableStringify } from "../src/types.js";
import type { PixelEvent } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, "fixtures");

// The PRODUCTION pipeline is gamify -> renderCity(solo); golden guards THAT.
// A fixed resolver (git remotes for every fixture repo) keeps the model
// machine-independent — never touches the host's real git.
const goldenResolver: IdentityResolver = (repo) => ({ proj: { kind: "git", remote: `github.com/fixtures/${repo}` }, name: repo });

function goldenEvents(): PixelEvent[] {
  return [
    ...parseClaudeHistory(join(fx, "claude-history")),
    ...parsePixelagentsLog(join(fx, "pixelagents")),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

function goldenModel() {
  return renderCity(gamify(goldenEvents(), goldenResolver, "golden"), "golden-seed", {
    scene: "solo",
    config: { historyInfluence: "full" },
  }).model;
}

describe("golden model", () => {
  it("fixtures + seed 'golden-seed' render byte-identically to the committed model", () => {
    const actual = stableStringify(goldenModel());
    const expected = readFileSync(join(fx, "golden-model.json"), "utf8");
    expect(actual).toBe(expected);
  });

  it("re-rendering is byte-identical (determinism invariant)", () => {
    expect(stableStringify(goldenModel())).toBe(stableStringify(goldenModel()));
  });
});
