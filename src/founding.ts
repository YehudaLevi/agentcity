// agentcity — the founding flow. Turns raw agent activity into a served,
// persistent city and keeps it live, via the ONE shared pipeline:
//
//   ingest raw PixelEvents  →  gamify (privacy firewall + economy + git identity)
//   →  GamifiedCity (fold + append/refold reconciliation)  →  {model, deltas}
//
// The raw event archive is the source of truth (rule 4: never pruned); the city
// is a pure function of it, re-derivable forever. A boot re-gamifies the whole
// archive (historic fold); each poll re-gamifies and reconciles day-granularly
// (broadcast only the days that changed). Local and central share GamifiedCity,
// so reconciliation is identical on both sides.
//
// Everything is injectable (sources, seed, resolver, handle) so tests never read
// a real home dir or hit the network.

import { homedir } from "node:os";
import { join } from "node:path";
import type { PixelEvent, CityConfig, CityModel, CityDelta } from "./types.js";
import { parseClaudeHistory } from "./ingest/claude-history.js";
import { parsePixelagentsLog } from "./ingest/pixelagents-log.js";
import { archiveEvents, readArchive, readConfig, writeConfig } from "./persist.js";
import { deriveSeed } from "./seed.js";
import { gamify, type IdentityResolver } from "./gamified/gamify.js";
import { createIdentityResolver, pathIndex } from "./gamified/identity.js";
import { GamifiedCity, type IngestResult } from "./gamified/city.js";
import type { GamifiedEvent } from "./gamified/types.js";

export interface Sources {
  /** claude-code transcripts dir (default ~/.claude/projects). */
  historyDir: string;
  /** pixelagents log dir (default ~/.pixelagents). */
  pixelagentsDir: string;
}

export function defaultSources(): Sources {
  return {
    historyDir: join(homedir(), ".claude", "projects"),
    pixelagentsDir: join(homedir(), ".pixelagents"),
  };
}

/** Merge both ingest sources into one ts-sorted stream (tolerant of absent dirs). */
export function ingestSources(sources: Sources): PixelEvent[] {
  const events: PixelEvent[] = [];
  events.push(...parseClaudeHistory(sources.historyDir));
  events.push(...parsePixelagentsLog(sources.pixelagentsDir));
  return sortEvents(events);
}

function sortEvents(events: PixelEvent[]): PixelEvent[] {
  return events.slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Stable identity key for de-duping raw events across archive + live. */
function eventKey(e: PixelEvent): string {
  return `${e.ts}|${e.session}|${e.kind}|${e.repo}|${e.tool ?? ""}|${e.detail ?? ""}`;
}

/** Resolve the persistent seed: explicit override wins, then config, else a
 * machine+user derived stable seed. Persisted on found so resumes never drift. */
function resolveSeed(root: string, override?: string): string {
  const cfg = readConfig(root);
  if (override) return override;
  if (cfg.seed) return cfg.seed;
  // deriveSeed is deterministic given machine+user; keep it out of the compiler
  // (rule 2) — it only picks WHICH deterministic city, never mutates the fold.
  return deriveSeed(process.env.AGENTCITY_MACHINE ?? "agentcity", process.env.USER ?? "user");
}

/** Sanitize a handle to a compact scene-safe token (the shared calendar shows it
 * and it namespaces per-user tiles). Falls back to "user" if nothing usable. */
function cleanHandle(raw: string | undefined): string {
  const h = (raw ?? "").trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "");
  return h.slice(0, 32) || "user";
}

/**
 * The one contributor handle (stamped as the gamified `by` AND the federation
 * batch handle — they must match). Precedence: explicit override (--handle) >
 * config.federation.handle > $USER > "user". No anonymous hash: the handle is a
 * chosen display name; a user who wants anonymity sets one explicitly.
 */
export function localHandle(root: string, override?: string): string {
  if (override) return cleanHandle(override);
  const cfg = readConfig(root);
  if (cfg.federation?.handle) return cleanHandle(cfg.federation.handle);
  return cleanHandle(process.env.USER ?? process.env.LOGNAME);
}

export interface FoundOptions {
  seed?: string; // explicit override (CLI --seed); beats config.seed and is persisted
  config?: Partial<CityConfig>;
  handle?: string; // contributor handle stamped on the stream (default: localHandle)
  /** Identity resolver override (demo/tests inject a synthetic one). Default:
   * the real git-discovery resolver over the events' cwds. */
  resolve?: IdentityResolver;
}

/** Gamify a raw stream into the shared gamified event stream. */
function streamOf(events: PixelEvent[], handle: string, resolve?: IdentityResolver): ReturnType<typeof gamify> {
  const resolver = resolve ?? createIdentityResolver(pathIndex(events));
  return gamify(events, resolver, handle);
}

/** Persist config, PRESERVING existing fields (federation, and any prior
 * influence/aliases) — writeConfig overwrites wholesale, so boot/refound/found
 * must all merge through here or a re-found silently wipes federation setup. */
function persistConfig(root: string, seed: string, config?: Partial<CityConfig>): void {
  const prev = readConfig(root);
  writeConfig(root, {
    seed,
    historyInfluence: config?.historyInfluence ?? prev.historyInfluence ?? "full",
    aliases: config?.aliases ?? prev.aliases ?? {},
    ...(prev.federation ? { federation: prev.federation } : {}),
  });
}

export interface BootResult {
  founded: boolean; // true if this boot founded a fresh city (empty prior archive)
  model: CityModel;
  deltas: CityDelta[]; // FULL delta timeline (the served bundle / timelapse source)
}

/**
 * A live local city: holds the folded GamifiedCity AND the raw events + resolver
 * across the server's poll loop. `poll()` ingests only NEW raw events (never
 * re-decompressing the whole archive) and re-gamifies with a CACHED resolver (so
 * git is queried once per repo, not per poll), then reconciles. Returns the
 * day-granular reconciliation, or null when nothing is new.
 */
export class LocalCity {
  readonly founded: boolean;
  private lastArchivedTs: string;
  constructor(
    private readonly root: string,
    private readonly sources: Sources,
    private readonly handle: string,
    private readonly resolve: IdentityResolver,
    private readonly pathFor: Map<string, string>,
    private readonly events: PixelEvent[], // in-memory raw log (grows on poll)
    private readonly city: GamifiedCity,
    founded: boolean,
    lastArchivedTs: string
  ) {
    this.founded = founded;
    this.lastArchivedTs = lastArchivedTs;
  }

  model(): CityModel {
    return this.city.model();
  }
  deltas(): CityDelta[] {
    return this.city.deltas();
  }
  /** The gamified stream (what the federation client forwards to the hub). */
  stream(): GamifiedEvent[] {
    return this.city.all();
  }

  poll(): (IngestResult & { newEvents: PixelEvent[] }) | null {
    const fresh = ingestSources(this.sources).filter((e) => e.ts > this.lastArchivedTs);
    if (!fresh.length) return null;
    archiveEvents(this.root, fresh);
    this.lastArchivedTs = fresh[fresh.length - 1]!.ts;
    for (const e of fresh) {
      if (e.cwd) this.pathFor.set(e.repo, e.cwd); // feed the cached resolver new repos
      this.events.push(e);
    }
    const res = this.city.reconcile(gamify(this.events, this.resolve, this.handle));
    return { ...res, newEvents: fresh };
  }
}

/** Build the identity resolver over a mutable repo->cwd map (so newly-seen repos
 * resolve as they arrive) — or the injected one (demo/tests). */
function makeResolver(pathFor: Map<string, string>, injected?: IdentityResolver): IdentityResolver {
  return injected ?? createIdentityResolver((repo) => pathFor.get(repo));
}

/** Boot a local city: ingest sources, merge with the archive, gamify, fold.
 * Founds fresh when the archive was empty; otherwise resumes all history. */
export function boot(root: string, sources: Sources, opts: FoundOptions = {}): LocalCity {
  const seed = resolveSeed(root, opts.seed);
  const handle = localHandle(root, opts.handle);
  const prior = readArchive(root);
  const founded = prior.length === 0;

  // merge archive + live, de-dupe, archive only the genuinely new events (rule 4).
  const seen = new Set(prior.map(eventKey));
  const live = ingestSources(sources);
  const fresh = live.filter((e) => !seen.has(eventKey(e)));
  if (fresh.length) archiveEvents(root, fresh);

  const all = sortEvents([...prior, ...fresh]);
  const pathFor = new Map<string, string>();
  for (const e of all) if (e.cwd) pathFor.set(e.repo, e.cwd);
  const resolve = makeResolver(pathFor, opts.resolve);
  const cfg: Partial<CityConfig> = opts.config ?? {};
  const city = new GamifiedCity(seed, { scene: "solo", config: cfg }, gamify(all, resolve, handle));

  persistConfig(root, seed, cfg);

  const lastTs = all.length ? all[all.length - 1]!.ts : "";
  return new LocalCity(root, sources, handle, resolve, pathFor, all, city, founded, lastTs);
}

/**
 * One-shot full fold from an explicit event list (no live loop). Archives the
 * events, gamifies + folds, persists config. Used by --demo and refound.
 */
export function foundFromEvents(
  root: string,
  events: PixelEvent[],
  seed: string,
  opts: FoundOptions = {}
): BootResult {
  const handle = localHandle(root, opts.handle);
  const sorted = sortEvents(events);
  archiveEvents(root, sorted);
  const stream = streamOf(sorted, handle, opts.resolve);
  const city = new GamifiedCity(seed, { scene: "solo", config: opts.config }, stream);
  persistConfig(root, seed, opts.config);
  return { founded: true, model: city.model(), deltas: city.deltas() };
}

/**
 * Re-found from the permanent archive + current sources (rule 4: the city is
 * re-derivable forever). De-dupes across archive and live, then full-folds.
 */
export function refound(root: string, sources: Sources, opts: FoundOptions = {}): BootResult {
  const archived = readArchive(root);
  const seen = new Set(archived.map(eventKey));
  const fresh = ingestSources(sources).filter((e) => !seen.has(eventKey(e)));
  if (fresh.length) archiveEvents(root, fresh); // rule 4: never lose a live event
  const merged = sortEvents([...archived, ...fresh]);
  const seed = resolveSeed(root, opts.seed);
  const handle = localHandle(root, opts.handle);
  const stream = streamOf(merged, handle, opts.resolve);
  const city = new GamifiedCity(seed, { scene: "solo", config: opts.config }, stream);
  persistConfig(root, seed, opts.config);
  return { founded: false, model: city.model(), deltas: city.deltas() };
}
