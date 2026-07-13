// Shared test support: render raw PixelEvents through the PRODUCTION pipeline
// (gamify -> renderCity, solo scene) so tests exercise what actually ships.
// A fixed all-git resolver keeps results machine-independent (never touches the
// host's real git) while still producing buildings/tiers/rails/etc.

import { renderCity, type RenderResult } from "../src/compiler.js";
import { gamify, type IdentityResolver } from "../src/gamified/gamify.js";
import type { PixelEvent, CityConfig } from "../src/types.js";

export const testResolver: IdentityResolver = (repo) => ({
  proj: { kind: "git", remote: `github.com/t/${repo}` },
  name: repo,
});

/** A no-remote resolver — every repo becomes a per-user treehouse. */
export const treehouseResolver: IdentityResolver = (repo) => ({
  proj: { kind: "local", token: `tok-${repo}` },
  name: repo,
});

export function render(
  events: PixelEvent[],
  seed: string,
  config?: Partial<CityConfig>,
  resolve: IdentityResolver = testResolver
): RenderResult {
  return renderCity(gamify(events, resolve, "me"), seed, { scene: "solo", config });
}
