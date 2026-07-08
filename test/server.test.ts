import { describe, it, expect, afterEach } from "vitest";
import { get, request } from "node:http";
import { createAgentcityServer, type AgentcityServer } from "../src/server.js";
import { parseArgs } from "../src/cli-args.js";
import { fold } from "../src/compiler.js";
import { generateDemoEvents } from "../src/demo-events.js";
import type { CityDelta } from "../src/types.js";

function bundle() {
  const { model, deltas } = fold(generateDemoEvents("srv-seed"), "srv-seed");
  return { model, deltas };
}

function fetchText(port: number, path: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body, type: String(res.headers["content-type"] ?? "") })
      );
    }).on("error", reject);
  });
}

interface SSEHandle {
  buf: { text: string };
  req: ReturnType<typeof request>;
}

/** Open an SSE stream; accumulate raw text into buf.text as it streams. */
function openSSE(port: number): Promise<SSEHandle> {
  return new Promise((resolve, reject) => {
    const buf = { text: "" };
    const req = request({ host: "127.0.0.1", port, path: "/events" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => (buf.text += c));
      resolve({ buf, req }); // established once headers arrive
    });
    req.on("error", reject);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("agentcity server", () => {
  let srv: AgentcityServer | undefined;
  afterEach(async () => {
    if (srv) await srv.close();
    srv = undefined;
  });

  it("binds 127.0.0.1 only (never LAN-visible)", async () => {
    srv = createAgentcityServer({ bundle: bundle() });
    await srv.listen(0);
    const addr = srv.server.address();
    expect(typeof addr === "object" && addr).toBeTruthy();
    if (typeof addr === "object" && addr) expect(addr.address).toBe("127.0.0.1");
  });

  it("serves the renderer at / with a canvas", async () => {
    srv = createAgentcityServer({ bundle: bundle() });
    const port = await srv.listen(0);
    const r = await fetchText(port, "/");
    expect(r.status).toBe(200);
    expect(r.type).toContain("text/html");
    expect(r.body).toContain("<canvas");
  });

  it("impersonates the dev fixture at /fixture-city.js (window.__CITY__ = bundle)", async () => {
    const b = bundle();
    srv = createAgentcityServer({ bundle: b });
    const port = await srv.listen(0);
    const r = await fetchText(port, "/fixture-city.js");
    expect(r.status).toBe(200);
    expect(r.type).toContain("javascript");
    expect(r.body.startsWith("window.__CITY__ = ")).toBe(true);
    const json = r.body.replace(/^window\.__CITY__ = /, "").replace(/;\s*$/, "");
    const parsed = JSON.parse(json);
    expect(parsed.model.lots.length).toBe(b.model.lots.length);
    expect(parsed.deltas.length).toBe(b.deltas.length);
  });

  it("answers /healthz and 404s unknown paths", async () => {
    srv = createAgentcityServer({ bundle: bundle() });
    const port = await srv.listen(0);
    expect((await fetchText(port, "/healthz")).body).toBe("ok");
    expect((await fetchText(port, "/nope")).status).toBe(404);
  });

  it("SSE: pushes newly-folded deltas to open clients and appends to the bundle", async () => {
    const b = bundle();
    srv = createAgentcityServer({ bundle: { model: b.model, deltas: [] }, heartbeatMs: 40 });
    const port = await srv.listen(0);

    const sse = await openSSE(port);
    await sleep(50); // let the client register
    expect(srv.clientCount()).toBe(1);

    const newDeltas: CityDelta[] = [
      { day: 99, seq: 9001, kind: "ship.arrive", shipKind: "cargo" },
      { day: 99, seq: 9002, kind: "population.set", population: 7, pets: 1 },
    ];
    srv.update(b.model, newDeltas);
    await sleep(60);

    expect(sse.buf.text).toContain('"seq":9001');
    expect(sse.buf.text).toContain('"seq":9002');
    expect(sse.buf.text).toContain(": heartbeat"); // heartbeat kept the pipe warm
    // bundle now carries the pushed deltas for a fresh page load / timelapse
    expect(srv.getBundle().deltas.length).toBe(2);
    sse.req.destroy();
  });
});

describe("CLI --port validation", () => {
  it("accepts an in-range integer port", () => {
    expect(parseArgs(["--port", "4243"]).port).toBe(4243);
  });
  it("rejects non-numeric and out-of-range ports", () => {
    expect(() => parseArgs(["--port", "abc"])).toThrow(/--port/);
    expect(() => parseArgs(["--port", "0"])).toThrow(/--port/);
    expect(() => parseArgs(["--port", "70000"])).toThrow(/--port/);
  });
  it("rejects a flag value that is another flag", () => {
    expect(() => parseArgs(["--root", "--demo"])).toThrow(/requires a value/);
  });
});
