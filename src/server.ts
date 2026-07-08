// agentcity — local HTTP server (node:http only, zero deps). Serves the
// self-contained renderer and impersonates its dev fixture so the renderer
// needs ZERO changes to consume the real compiled city:
//
//   GET /                → web/city.html verbatim
//   GET /fixture-city.js → `window.__CITY__ = {model,deltas};` (the live bundle;
//                          city.html loads it via <script src="fixture-city.js">)
//   GET /events          → SSE; pushes NEW CityDeltas as live folds arrive,
//                          plus a 15s heartbeat comment to keep the pipe warm
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
  let bundle: CityBundle = { model: opts.bundle.model, deltas: opts.bundle.deltas.slice() };
  const clients = new Set<ServerResponse>();

  function fixtureBody(): string {
    // Exactly the shape city.html's dev fixture uses: a global assignment the
    // <script src="fixture-city.js"> tag pulls in before the bootstrap runs.
    return `window.__CITY__ = ${JSON.stringify(bundle)};\n`;
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?")[0];

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
