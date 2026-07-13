// agentcity — `npm run compile` CLI.
//   npm run compile -- --history <dir> --pixelagents <dir> --seed s --out file [--demo] [--influence full|capped]
// Folds ingested (or demo) events into a CityModel, writes it (stable key order
// -> byte-identical re-runs), and prints a summary: days, lots, tiers, deltas.

import { writeFileSync } from "node:fs";
import type { PixelEvent, CityModel, HistoryInfluence } from "./types.js";
import { stableStringify } from "./types.js";
import { renderCity } from "./compiler.js";
import { gamify } from "./gamified/gamify.js";
import { createIdentityResolver, pathIndex } from "./gamified/identity.js";
import { parseClaudeHistory } from "./ingest/claude-history.js";
import { parsePixelagentsLog } from "./ingest/pixelagents-log.js";
import { generateDemoEvents, demoResolver } from "./demo-events.js";

interface Args {
  history?: string;
  pixelagents?: string;
  seed: string;
  out?: string;
  demo: boolean;
  influence: HistoryInfluence;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { seed: "default", demo: false, influence: "full" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--history":
        a.history = next();
        break;
      case "--pixelagents":
        a.pixelagents = next();
        break;
      case "--seed":
        a.seed = next() ?? "default";
        break;
      case "--out":
        a.out = next();
        break;
      case "--demo":
        a.demo = true;
        break;
      case "--influence": {
        const v = next();
        if (v === "full" || v === "capped") a.influence = v;
        break;
      }
      default:
        break;
    }
  }
  return a;
}

function tierHistogram(model: CityModel): string {
  const counts = new Array(6).fill(0);
  for (const l of model.lots) counts[l.tier]++;
  return counts.map((c, t) => `T${t}:${c}`).join(" ");
}

function summarize(model: CityModel, deltaCount: number): string {
  return [
    `seed=${model.seed}`,
    `biome=${model.biome.kind}`,
    `origin=[${model.biome.origin.join(",")}]`,
    `growth=${model.biome.growthDir}`,
    `days=${model.day}`,
    `founded=${model.foundedTs}`,
    `lots=${model.lots.length}`,
    `tiers={${tierHistogram(model)}}`,
    `roads=${model.roads.length}`,
    `rails=${model.rails.length}`,
    `chunks=${model.chunks.length}`,
    `revealed=${model.chunks.filter((c) => c.revealed).length}/${model.chunks.length}`,
    `landmarks=${model.landmarks.length}`,
    `pop=${model.stats.population}`,
    `ships=${model.stats.ships}`,
    `totalWu=${model.stats.totalWu}`,
    `deltas=${deltaCount}`,
  ].join(" · ");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let events: PixelEvent[] = [];
  if (args.demo) {
    events = generateDemoEvents(args.seed);
  } else {
    if (args.history) events.push(...parseClaudeHistory(args.history));
    if (args.pixelagents) events.push(...parsePixelagentsLog(args.pixelagents));
    events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  // The one pipeline: raw events -> gamified stream (economy + git identity) ->
  // renderCity (solo founder city). --demo uses the synthetic resolver.
  const resolve = args.demo ? demoResolver : createIdentityResolver(pathIndex(events));
  const stream = gamify(events, resolve, "local");
  const { model, deltas } = renderCity(stream, args.seed, { scene: "solo", config: { historyInfluence: args.influence } });
  // Bundle shape matches the renderer's bootstrap (window.__CITY__): the
  // model for live view plus the delta log for the founding timelapse.
  const json = stableStringify({ model, deltas });
  if (args.out) {
    writeFileSync(args.out, json);
  }
  process.stdout.write(summarize(model, deltas.length) + "\n");
}

main();
