// Compile entry for `bun build --compile` (see Dockerfile). agentcity.ts
// deliberately does NOT self-run so tests can import main/parseArgs without
// side effects; the node shim (agentcity.js) invokes main() for dist/tsx runs,
// and this file does the same for a Bun single-file binary. Bun-only: the
// explicit .ts specifier hits the CLI module, not the sibling .js shim, and
// tsconfig.build.json never compiles this file.
import { main } from "./agentcity.ts";

main().catch((err) => {
  console.error(process.env.AGENTCITY_DEBUG ? err : `agentcity: ${err?.message ?? err}`);
  process.exit(1);
});
