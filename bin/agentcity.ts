// agentcity CLI (invoked via bin/agentcity.js — the published `agentcity` bin;
// see that shim for why it exists: zero runtime deps, dist-first, tsx fallback
// in a dev checkout). No auto-run on import: the shim calls main(), so tests can
// import parseArgs / main without side effects.
//
// Subcommands:
//   (default) serve [--port 4243] [--root DIR] [--history DIR] [--pixelagents DIR] [--seed S]
//   --demo                     serve the seeded demo city from a throwaway temp
//                              root — never touches real ~/.claude/~/.agentcity
//   refound [--seed S] --yes   re-found from archives+sources (e.g. a new seed)
//   compile ...                delegate to the existing `npm run compile` CLI

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRoot, readConfig, readFederationState, writeFederationState } from "../src/persist.js";
import { boot, refound, foundFromEvents, localHandle, defaultSources, type Sources, type BootResult } from "../src/founding.js";
import { demoResolver } from "../src/demo-events.js";
import { replaceDelta } from "../src/gamified/city.js";
import { createAgentcityServer, type AgentcityServer, type CityBundle } from "../src/server.js";
import { generateDemoEvents } from "../src/demo-events.js";
import { parseArgs, type Args } from "../src/cli-args.js";
import { createFederator, ZERO_CURSOR, type Federator } from "../src/federate.js";
import { createHub } from "../src/gamified/hub.js";
import { FileGamifiedStore } from "../src/gamified/store.js";
import { compileRules, parseRules } from "../src/federation/mapping.js";

export { parseArgs, type Args };

const DEFAULT_PORT = 4243;
const DEFAULT_POLL_MS = 10_000;

function sourcesFrom(args: Args): Sources {
  const d = defaultSources();
  return {
    historyDir: args.history ?? d.historyDir,
    pixelagentsDir: args.pixelagents ?? d.pixelagentsDir,
  };
}

async function listenOrExit(server: AgentcityServer, port: number, host?: string): Promise<number> {
  try {
    return await server.listen(port, host);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`port ${port} is already in use — try --port <n>`);
      process.exit(1);
    }
    throw err;
  }
}

function announce(port: number, founded: boolean): void {
  console.log(`agentcity listening on http://localhost:${port}`);
  // The renderer autostarts the Founding Timelapse from this deep link.
  const tl = `http://localhost:${port}/?mode=timelapse`;
  if (founded) console.log(`founded a new city — watch it rise: ${tl}`);
  else console.log(`open ${tl} to replay the founding, or / for the live city`);
}

function installShutdown(cleanup: () => void): void {
  const shutdown = (): void => {
    try {
      cleanup();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Wire opt-in federation (client mode). Returns null when disabled. The client
 * forwards its already-gamified stream (identity resolved at ingest), so there
 * is no ref resolver here — nothing but privacy-safe facts leaves the machine.
 */
function setupFederation(root: string, args: Args): Federator | null {
  const cfg = readConfig(root).federation;
  const url = args.federate ?? (cfg?.role !== "central" ? cfg?.centralUrl : undefined);
  if (!url) return null;
  // --refederate: forget how far we've pushed so the next push resends the whole
  // history (re-seed a hub that lost its store, or re-brand under a new handle).
  if (args.refederate) {
    writeFederationState(root, { cursor: { ...ZERO_CURSOR } });
    console.log("federation: --refederate — resending full history");
  }
  // ONE handle: the same localHandle stamped on the local stream's `by`, so the
  // batch handle and the events' contributor match on the hub.
  const handle = localHandle(root, args.handle);
  console.log(`federation: client mode -> ${url} as "${handle}"`);
  return createFederator({
    url,
    handle,
    loadCursor: () => readFederationState(root).cursor,
    saveCursor: (c) => writeFederationState(root, { cursor: c }),
    log: (m) => console.log(m),
  });
}

async function serve(args: Args): Promise<void> {
  const root = args.root ?? defaultRoot();
  const sources = sourcesFrom(args);
  const city = boot(root, sources, { seed: args.seed, handle: args.handle });

  const server = createAgentcityServer({
    bundle: { model: city.model(), deltas: city.deltas() },
    // Renderer "generate new map layout" button → recompile from archives with a
    // new seed via the SAME code path as `refound --yes`, then serve the result.
    onRefound: async (seed): Promise<CityBundle> => {
      const re = refoundCity(root, sources, seed);
      return { model: re.model, deltas: re.deltas };
    },
  });
  const port = await listenOrExit(server, args.port ?? DEFAULT_PORT);
  announce(port, city.founded);

  const federator = setupFederation(root, args);
  if (federator) void federator.push(city.stream());

  let liveSeq = 0;
  const PRESENCE = new Set(["tool.pre", "turn.end", "fork.start", "waiting.human", "waiting.permission", "session.start"]);
  // Background live loop: re-gamify newly-arrived events and reconcile.
  const timer = setInterval(() => {
    try {
      const p = city.poll();
      if (p) {
        // Broadcast a map update only when the reconciliation produced deltas.
        // Day-granular reconciliation: one `replace(fromDay)` the renderer applies
        // by dropping days >= fromDay and splicing the new tail.
        if (p.deltas.length) server.replace({ model: p.model, deltas: city.deltas() }, [replaceDelta(p, liveSeq++)]);
        // Presence: freshly-ingested raw events -> activity messages (birds/
        // flicker). Atmosphere only — never map state.
        server.pushActivity(
          p.newEvents
            .filter((e) => PRESENCE.has(e.kind))
            .slice(-60) // cap per poll: enough for ambience, never a flood
            .map((e) => ({ type: "activity" as const, repo: e.repo, kind: e.kind, tool: e.tool })),
        );
      }
      // ALWAYS attempt a push, even on an idle poll: the federator sends new facts
      // when there are any, and periodically re-asserts the full backlog (anti-
      // entropy) — that heartbeat is what detects a recovered/emptied hub and
      // heals it without local activity.
      if (federator) void federator.push(city.stream());
    } catch {
      /* a bad poll must never crash the server */
    }
  }, DEFAULT_POLL_MS);
  timer.unref?.();

  installShutdown(() => {
    clearInterval(timer);
    void server.close();
  });
}

/** Load hub mapping rules from --rules PATH, else <root>/federation-rules.json. */
function loadRules(args: Args, root: string): ReturnType<typeof compileRules> {
  const file = args.rules ?? join(root, "federation-rules.json");
  if (!existsSync(file)) return [];
  try {
    const rules = parseRules(JSON.parse(readFileSync(file, "utf8")));
    console.log(`federation: loaded ${rules.length} mapping rule(s) from ${file}`);
    return compileRules(rules);
  } catch (err) {
    console.error(`federation: could not read rules ${file} — ${(err as Error).message}`);
    return [];
  }
}

/** Central federation hub: aggregate contributors' gamified events into one
 * shared scene and serve it. Binds 127.0.0.1 unless --host is given. */
async function serveCentral(args: Args): Promise<void> {
  const root = args.root ?? defaultRoot();
  const seed = args.seed ?? "agentcity-hub";
  // Persistent append-only log so the hub resumes all history on restart and a
  // late joiner's backlog re-folds into chronological position (time-travel).
  const store = new FileGamifiedStore(join(root, "hub-events.jsonl"));
  const hub = createHub({ seed, rules: loadRules(args, root), store });
  console.log(`federation: hub store ${join(root, "hub-events.jsonl")} (${store.all().length} facts)`);
  let hubSeq = 0;

  const server = createAgentcityServer({
    bundle: { model: hub.model(), deltas: hub.deltas() },
    onIngest: (batch) => {
      const res = hub.ingest(batch);
      if (!res) return;
      // Day-granular reconciliation: one `replace(fromDay)` covers append,
      // same-day refresh, and a late joiner's historic backlog alike.
      server.replace({ model: hub.model(), deltas: hub.deltas() }, [replaceDelta(res, hubSeq++)]);
      if (hub.dropped() > 0) console.warn(`federation: ${hub.dropped()} project(s) unplaced — the 60x60 world is full`);
    },
    onCityAt: (day) => (day === null ? hub.model() : hub.cityAt(day)),
  });

  const host = args.host ?? "127.0.0.1";
  const port = await listenOrExit(server, args.port ?? DEFAULT_PORT, host);

  console.log(`agentcity hub listening on http://${host}:${port}`);
  console.log(`contributors POST gamified events to http://${host}:${port}/ingest`);
  installShutdown(() => void server.close());
}

async function serveDemo(args: Args): Promise<void> {
  // A throwaway root so --demo never reads or writes real data (rule 7).
  const root = mkdtempSync(join(tmpdir(), "agentcity-demo-"));
  const seed = args.seed ?? "demo";
  const result = foundFromEvents(root, generateDemoEvents(seed), seed, { resolve: demoResolver });

  const server = createAgentcityServer({
    bundle: { model: result.model, deltas: result.deltas },
    // Demo refound: regenerate the seeded synthetic city with the new seed into
    // the same throwaway root (never touches real data — rule 7).
    onRefound: async (newSeed): Promise<CityBundle> => {
      const re = foundFromEvents(root, generateDemoEvents(newSeed), newSeed, { resolve: demoResolver });
      return { model: re.model, deltas: re.deltas };
    },
  });
  const port = await listenOrExit(server, args.port ?? DEFAULT_PORT);
  console.log("(demo mode — seeded synthetic city, real data untouched)");
  announce(port, true);

  installShutdown(() => {
    void server.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });
}

/**
 * The one refound code path — shared by the CLI `refound --yes` command and the
 * server's POST /refound hook. Re-founds from the archives + sources (rule 4:
 * archives untouched) with the new seed. refound() persists the resolved seed
 * back to config, so a server-triggered refound leaves disk consistent with a CLI
 * one — the city is a pure function of the archive, so there's no derived state
 * to wipe first.
 */
function refoundCity(root: string, sources: Sources, seed?: string): BootResult {
  return refound(root, sources, { seed });
}

function doRefound(args: Args): void {
  if (!args.yes) {
    console.error("refound rewrites the city from its archives — re-run with --yes to confirm");
    process.exit(1);
  }
  const root = args.root ?? defaultRoot();
  const result = refoundCity(root, sourcesFrom(args), args.seed);
  console.log(
    `re-founded: seed=${result.model.seed} day=${result.model.day} lots=${result.model.lots.length} deltas=${result.deltas.length}`
  );
}

async function delegateCompile(): Promise<void> {
  // Strip the "compile" subcommand so cli-compile sees its own flags in argv,
  // then import it (it runs main() at module load).
  const idx = process.argv.indexOf("compile");
  if (idx >= 0) process.argv.splice(idx, 1);
  await import("../src/cli-compile.js");
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.cmd === "compile") {
    await delegateCompile();
    return;
  }
  if (args.cmd === "refound") {
    doRefound(args);
    return;
  }
  if (args.cmd === undefined || args.cmd === "serve") {
    if (args.central) await serveCentral(args);
    else if (args.demo) await serveDemo(args);
    else await serve(args);
    return;
  }
  console.error(`agentcity: unknown command "${args.cmd}"`);
  console.error(
    "usage: agentcity [serve] [--demo] [--federate URL [--handle NAME] [--refederate]] [--central [--rules F] [--host H]] [--port N] [--root DIR] [--seed S] | refound --yes | compile ..."
  );
  process.exit(1);
}
