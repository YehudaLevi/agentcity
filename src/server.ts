// agentcity — local HTTP server (node:http only, zero deps). Serves the
// self-contained renderer and impersonates its dev fixture so the renderer
// needs ZERO changes to consume the real compiled city:
//
//   GET /                → web/city.html verbatim
//   GET /fixture-city.js → `window.__CITY__ = {model,deltas};` (the live bundle;
//                          city.html loads it via <script src="fixture-city.js">)
//   GET /events          → SSE; pushes NEW CityDeltas as live folds arrive,
//                          plus a 15s heartbeat comment to keep the pipe warm
//   POST /refound        → recompile the whole city with a new seed (the renderer
//                          drawer's "generate new map layout" button). Delegates
//                          the real recompile to the injected onRefound hook, then
//                          swaps the served bundle in place. See handleRefound.
//   GET /healthz         → "ok"
//
// Binds 127.0.0.1 only (rule 3: nothing outbound / never LAN-visible). The
// served bundle is mutable: the founding poll loop calls update() with the
// latest model + the newly-produced deltas, which broadcasts to SSE clients.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CityModel, CityDelta } from "./types.js";

const HEARTBEAT_MS = 15_000;

export interface CityBundle {
  model: CityModel;
  deltas: CityDelta[];
}

export interface AgentcityServerOptions {
  /** Initial bundle to serve (the founding / incremental boot result). */
  bundle: CityBundle;
  /** Directory containing city.html. Defaults to the package's web/ dir. */
  webRoot?: string;
  /** Heartbeat interval override (tests). */
  heartbeatMs?: number;
  /**
   * Recompile the city from its archived history with a NEW seed and persist it
   * exactly as the CLI `refound` does (config seed pinned, checkpoint + delta log
   * rewritten, archives untouched). Wired in bin/agentcity.ts where founding
   * lives; kept injectable so server unit tests never touch disk. When omitted,
   * POST /refound answers `{ok:false,error:"unsupported"}`. The returned bundle
   * fully REPLACES the served one (this is a re-found, not an incremental fold).
   */
  onRefound?: (seed: string) => Promise<CityBundle>;
}

/** Max accepted seed length; longer inputs are rejected (400). */
const MAX_SEED_LEN = 64;
/** Cap the POST /refound body so a bad client can't stream unbounded bytes. */
const MAX_BODY_BYTES = 4096;
/** Allowed seed characters — a readable, filesystem/JSON-safe subset. */
const SEED_RE = /^[a-zA-Z0-9 _-]+$/;

// Word pool for server-picked readable seeds (config, not compile — Math.random
// is fine here: the SEED STRING is an input, determinism starts from it).
const SEED_WORDS = [
  "harbor", "cedar", "amber", "delta", "quartz", "marsh", "cobalt", "willow",
  "ember", "basalt", "meadow", "onyx", "pier", "linden", "slate", "bramble",
  "cove", "ridge", "birch", "coral", "fenn", "hollow", "moor", "vale",
];

/** A short, human-readable seed: "word-word" or "word-<0..999>". */
function randomReadableSeed(): string {
  const word = (): string => SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)]!;
  if (Math.random() < 0.5) return `${word()}-${word()}`;
  return `${word()}-${Math.floor(Math.random() * 1000)}`;
}

/**
 * Resolve the seed for a POST /refound body. Missing/empty/whitespace → a
 * server-picked readable seed. A provided seed is trimmed then validated against
 * SEED_RE / MAX_SEED_LEN. Returns the usable seed or an { error } to reject with.
 */
export function resolveRefoundSeed(raw: unknown): { seed: string } | { error: string } {
  if (raw === undefined || raw === null) return { seed: randomReadableSeed() };
  if (typeof raw !== "string") return { error: "seed must be a string" };
  const seed = raw.trim();
  if (seed === "") return { seed: randomReadableSeed() };
  if (seed.length > MAX_SEED_LEN) return { error: `seed too long (max ${MAX_SEED_LEN})` };
  if (!SEED_RE.test(seed)) return { error: "seed has invalid characters (allowed: letters, digits, space, - _)" };
  return { seed };
}

export interface AgentcityServer {
  server: Server;
  /** Binds 127.0.0.1 by default. */
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
  /**
   * Replace the live model and broadcast newly-folded deltas to SSE clients.
   * `newDeltas` are appended to the served bundle (so a fresh page load / the
   * founding timelapse sees them) and pushed to every open /events stream.
   */
  update(model: CityModel, newDeltas: CityDelta[]): void;
  /** Broadcast atmosphere-only activity messages over the same SSE stream. */
  pushActivity(msgs: Array<{ type: "activity"; repo: string; kind: string; tool?: string }>): void;
  /** Current served bundle (test hook). */
  getBundle(): CityBundle;
  /** Open SSE client count (test hook). */
  clientCount(): number;
}

// This module runs from source (dev / tsx: .../src/server.ts) or compiled
// (npm install: .../dist/src/server.js). web/ is never compiled and always
// sits at <package root>/web, so the "up" count from here differs. Probe both.
function defaultWebRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const devPath = join(here, "..", "web"); // src/ -> root/web
  if (existsSync(join(devPath, "city.html"))) return devPath;
  const distPath = join(here, "..", "..", "web"); // dist/src/ -> root/web
  if (existsSync(join(distPath, "city.html"))) return distPath;
  return devPath;
}

export function createAgentcityServer(opts: AgentcityServerOptions): AgentcityServer {
  const webRoot = opts.webRoot ?? defaultWebRoot();
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const onRefound = opts.onRefound;
  let bundle: CityBundle = { model: opts.bundle.model, deltas: opts.bundle.deltas.slice() };
  const clients = new Set<ServerResponse>();
  // Single-flight guard: a recompile mutates on-disk state, so never run two at
  // once — a second POST /refound while one is in flight is rejected (409).
  let refoundInFlight = false;

  function fixtureBody(): string {
    // Exactly the shape city.html's dev fixture uses: a global assignment the
    // <script src="fixture-city.js"> tag pulls in before the bootstrap runs.
    return `window.__CITY__ = ${JSON.stringify(bundle)};\n`;
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  // POST /refound — recompile the city with a new seed. Validates + parses here,
  // delegates the actual recompile/persist to onRefound, then swaps the served
  // bundle so /fixture-city.js reflects the new city before we reply. The client
  // reloads the page after 200, so no SSE choreography is required.
  //
  // Error style: 4xx/5xx status + JSON {ok:false,error} — except the "no hook
  // wired" case, which the contract fixes at 200 {ok:false,error:"unsupported"}.
  //   405 non-POST · 400 malformed JSON / invalid seed · 409 busy · 500 recompile threw
  function handleRefound(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (!onRefound) {
      sendJson(res, 200, { ok: false, error: "unsupported" });
      return;
    }
    if (refoundInFlight) {
      sendJson(res, 409, { ok: false, error: "refound already in progress" });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        sendJson(res, 400, { ok: false, error: "request body too large" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      let body: unknown = {};
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          sendJson(res, 400, { ok: false, error: "malformed JSON body" });
          return;
        }
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        sendJson(res, 400, { ok: false, error: "body must be a JSON object" });
        return;
      }
      const resolved = resolveRefoundSeed((body as Record<string, unknown>).seed);
      if ("error" in resolved) {
        sendJson(res, 400, { ok: false, error: resolved.error });
        return;
      }
      const seed = resolved.seed;

      // Re-check + claim the single-flight slot atomically (JS is single-threaded,
      // so this is race-free between the earlier guard and here).
      if (refoundInFlight) {
        sendJson(res, 409, { ok: false, error: "refound already in progress" });
        return;
      }
      refoundInFlight = true;
      onRefound(seed)
        .then((next) => {
          // Full swap: a re-found replaces the served bundle wholesale (new model
          // + new full delta log), unlike update()'s incremental append.
          bundle = { model: next.model, deltas: next.deltas.slice() };
          sendJson(res, 200, { ok: true, seed });
        })
        .catch((err: unknown) => {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          refoundInFlight = false;
        });
    });
    req.on("error", () => {
      if (!aborted) sendJson(res, 400, { ok: false, error: "request error" });
    });
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?")[0];

    if (path === "/refound") {
      handleRefound(req, res);
      return;
    }

    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (req.method === "GET" && (path === "/" || path === "/index.html" || path === "/city.html")) {
      try {
        const html = readFileSync(join(webRoot, "city.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("city.html not found");
      }
      return;
    }

    if (req.method === "GET" && path === "/fixture-city.js") {
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-cache, no-transform",
      });
      res.end(fixtureBody());
      return;
    }

    if (req.method === "GET" && path === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }

  const server = createServer(handleRequest);

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        clients.delete(res);
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    server,
    listen(port = 4243, host = "127.0.0.1") {
      return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
    pushActivity(msgs: Array<{ type: "activity"; repo: string; kind: string; tool?: string }>) {
      // Presence channel: lightweight, atmosphere-only messages (birds,
      // window flicker). Same SSE stream as deltas; renderers that don't
      // understand {type:"activity"} ignore it.
      if (!msgs.length) return;
      for (const res of clients) {
        try {
          for (const m of msgs) res.write(`data: ${JSON.stringify(m)}\n\n`);
        } catch {
          clients.delete(res);
        }
      }
    },
    update(model: CityModel, newDeltas: CityDelta[]) {
      bundle = { model, deltas: bundle.deltas.concat(newDeltas) };
      if (!newDeltas.length) return;
      for (const res of clients) {
        try {
          for (const d of newDeltas) res.write(`data: ${JSON.stringify(d)}\n\n`);
        } catch {
          clients.delete(res);
        }
      }
    },
    getBundle() {
      return bundle;
    },
    clientCount() {
      return clients.size;
    },
  };
}
