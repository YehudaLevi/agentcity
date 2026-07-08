// agentcity CLI (invoked via bin/agentcity.js — the published `agentcity` bin;
// see that shim for why it exists: zero runtime deps, dist-first, tsx fallback
// in a dev checkout). No auto-run on import: the shim calls main(), so tests can
// import parseArgs / main without side effects.
//
// Subcommands:
//   (default) serve [--port 4243] [--root DIR] [--history DIR] [--pixelagents DIR] [--seed S]
//   --demo                     serve the seeded demo city from a throwaway temp
//                              root — never touches real ~/.claude/~/.agentcity
//   refound [--seed S] --yes   wipe checkpoint+deltas, re-found from archives+sources
//   compile ...                delegate to the existing `npm run compile` CLI

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRoot, paths } from "../src/persist.js";
import { boot, poll, refound, foundFromEvents, defaultSources, type Sources } from "../src/founding.js";
import { createAgentcityServer, type AgentcityServer } from "../src/server.js";
import { generateDemoEvents } from "../src/demo-events.js";
import { parseArgs, type Args } from "../src/cli-args.js";

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

async function listenOrExit(server: AgentcityServer, port: number): Promise<number> {
  try {
    return await server.listen(port);
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

async function serve(args: Args): Promise<void> {
  const root = args.root ?? defaultRoot();
  const sources = sourcesFrom(args);
  const result = boot(root, sources, { seed: args.seed });

  const server = createAgentcityServer({ bundle: { model: result.model, deltas: result.deltas } });
  const port = await listenOrExit(server, args.port ?? DEFAULT_PORT);
  announce(port, result.founded);

  // Background live loop: fold newly-arrived events and push deltas over SSE.
  const timer = setInterval(() => {
    try {
      const p = poll(root, sources);
      if (p) server.update(p.model, p.newDeltas);
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

async function serveDemo(args: Args): Promise<void> {
  // A throwaway root so --demo never reads or writes real data (rule 7).
  const root = mkdtempSync(join(tmpdir(), "agentcity-demo-"));
  const seed = args.seed ?? "demo";
  const result = foundFromEvents(root, generateDemoEvents(seed), seed);

  const server = createAgentcityServer({ bundle: { model: result.model, deltas: result.deltas } });
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

function doRefound(args: Args): void {
  if (!args.yes) {
    console.error("refound rewrites the city from its archives — re-run with --yes to confirm");
    process.exit(1);
  }
  const root = args.root ?? defaultRoot();
  const p = paths(root);
  // wipe the derived state; archives (rule 4) stay untouched and re-derive it.
  rmSync(p.checkpoint, { force: true });
  rmSync(p.deltas, { force: true });
  const result = refound(root, sourcesFrom(args), { seed: args.seed });
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
    if (args.demo) await serveDemo(args);
    else await serve(args);
    return;
  }
  console.error(`agentcity: unknown command "${args.cmd}"`);
  console.error(
    "usage: agentcity [serve] [--demo] [--port N] [--root DIR] [--history DIR] [--pixelagents DIR] [--seed S] | refound --yes | compile ..."
  );
  process.exit(1);
}
