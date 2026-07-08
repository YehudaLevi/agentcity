#!/usr/bin/env node
// Launcher shim: this is the file `package.json#bin` points at. The actual CLI
// is TypeScript (agentcity.ts), but agentcity ships ZERO runtime dependencies
// (AGENTS.md rule 6), so a real npm/npx install must never need tsx (a
// devDependency) to run.
//
// `npm run build` / prepack compiles agentcity.ts (+ src/*.ts) to plain ESM
// under dist/ (tsconfig.build.json) — that's what a published package runs. In
// a dev checkout with no dist/ (e.g. `npx .` straight from the repo), fall back
// to registering tsx's ESM loader and running agentcity.ts directly, so local
// dev needs no build step.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, "..", "dist", "bin", "agentcity.js");

let mod;
if (existsSync(compiled)) {
  mod = await import(pathToFileURL(compiled).href);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  mod = await import(pathToFileURL(join(here, "agentcity.ts")).href);
}

await mod.main().catch((err) => {
  // CLI users get the message, not a stack (set AGENTCITY_DEBUG=1 for the stack).
  console.error(process.env.AGENTCITY_DEBUG ? err : `agentcity: ${err?.message ?? err}`);
  process.exit(1);
});
