// CLI argument parsing for bin/agentcity.ts — lives in src/ so tests can import
// it without resolving to the launcher shim (bin/agentcity.js) or executing the
// CLI. Mirrors the pixelagents src/args.ts split for the same reason.

export interface Args {
  cmd?: string;
  port?: number;
  root?: string;
  history?: string;
  pixelagents?: string;
  seed?: string;
  demo: boolean;
  yes: boolean;
}

/** A flag's value must exist and not be another flag ("--root --demo" is a
 * mistake, not a dir named "--demo"). */
function flagValue(flag: string, argv: string[], i: number): string {
  const v = argv[i];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} requires a value`);
  return v;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { demo: false, yes: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--demo") args.demo = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--port") {
      const raw = flagValue("--port", argv, ++i);
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`--port must be an integer between 1 and 65535, got: ${raw}`);
      }
      args.port = port;
    } else if (a === "--root") args.root = flagValue("--root", argv, ++i);
    else if (a === "--history") args.history = flagValue("--history", argv, ++i);
    else if (a === "--pixelagents") args.pixelagents = flagValue("--pixelagents", argv, ++i);
    else if (a === "--seed") args.seed = flagValue("--seed", argv, ++i);
    else positional.push(a);
  }
  args.cmd = positional[0];
  return args;
}
