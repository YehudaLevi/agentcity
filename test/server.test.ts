import { describe, it, expect, afterEach } from "vitest";
import { get, request } from "node:http";
import { createAgentcityServer, type AgentcityServer, type CityBundle } from "../src/server.js";
import { parseArgs } from "../src/cli-args.js";
import { render } from "./support.js";
import { generateDemoEvents } from "../src/demo-events.js";
import type { CityDelta } from "../src/types.js";

function bundle() {
  const { model, deltas } = render(generateDemoEvents("srv-seed"), "srv-seed");
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

interface PostResult {
  status: number;
  json: { ok?: boolean; seed?: string; error?: string };
}

/** POST a (possibly raw) body to `path`; resolve with status + parsed JSON. */
function postBody(port: number, path: string, raw: string, method = "POST"): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let json: PostResult["json"] = {};
        try {
          json = JSON.parse(body);
        } catch {
          /* leave {} */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end(raw);
  });
}

const postJson = (port: number, path: string, obj: unknown): Promise<PostResult> =>
  postBody(port, path, JSON.stringify(obj));

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

  it("SSE: resyncs a (re)connecting client with the current full timeline", async () => {
    const b = bundle();
    srv = createAgentcityServer({ bundle: { model: b.model, deltas: b.deltas }, heartbeatMs: 400 });
    const port = await srv.listen(0);

    const sse = await openSSE(port);
    await sleep(50);
    // first thing a connecting client receives is a replace(fromDay:0) carrying
    // the whole timeline — so a reconnect after a dropped pipe is never stale.
    expect(sse.buf.text).toContain('"kind":"replace"');
    expect(sse.buf.text).toContain('"fromDay":0');
    const frame = JSON.parse(sse.buf.text.split("data: ")[1]!.split("\n\n")[0]!);
    expect(frame.deltas.length).toBe(b.deltas.length); // the full current bundle
    sse.req.destroy();
  });
});

describe("POST /refound", () => {
  let srv: AgentcityServer | undefined;
  afterEach(async () => {
    if (srv) await srv.close();
    srv = undefined;
  });

  // A recognizably-different bundle the fake hook swaps in.
  function nextBundle(): CityBundle {
    const { model, deltas } = render(generateDemoEvents("swapped-seed"), "swapped-seed");
    return { model, deltas };
  }

  function bundleFromFixture(body: string): CityBundle {
    const json = body.replace(/^window\.__CITY__ = /, "").replace(/;\s*$/, "");
    return JSON.parse(json) as CityBundle;
  }

  it("happy path: calls onRefound, swaps the bundle, /fixture-city.js reflects it", async () => {
    const swapped = nextBundle();
    let sawSeed = "";
    srv = createAgentcityServer({
      bundle: bundle(),
      onRefound: async (seed) => {
        sawSeed = seed;
        return swapped;
      },
    });
    const port = await srv.listen(0);

    const r = await postJson(port, "/refound", { seed: "harbor-town" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, seed: "harbor-town" });
    expect(sawSeed).toBe("harbor-town");

    // served bundle swapped wholesale (not appended)
    expect(srv.getBundle().model.seed).toBe(swapped.model.seed);
    expect(srv.getBundle().deltas.length).toBe(swapped.deltas.length);

    // and /fixture-city.js now serves the new city
    const fx = await fetchText(port, "/fixture-city.js");
    expect(bundleFromFixture(fx.body).model.seed).toBe(swapped.model.seed);
  });

  it("empty/missing seed → server picks a readable seed and passes it to onRefound", async () => {
    let sawSeed = "";
    srv = createAgentcityServer({
      bundle: bundle(),
      onRefound: async (seed) => {
        sawSeed = seed;
        return nextBundle();
      },
    });
    const port = await srv.listen(0);

    const r = await postJson(port, "/refound", {});
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.seed).toBeTruthy();
    expect(r.json.seed).toMatch(/^[a-zA-Z0-9 _-]+$/);
    expect(sawSeed).toBe(r.json.seed);

    // a blank string is treated the same (→ generated, not rejected)
    const r2 = await postJson(port, "/refound", { seed: "   " });
    expect(r2.json.ok).toBe(true);
    expect(r2.json.seed).toBeTruthy();
  });

  it("rejects invalid seeds (bad chars / too long) with 400", async () => {
    srv = createAgentcityServer({ bundle: bundle(), onRefound: async () => nextBundle() });
    const port = await srv.listen(0);

    const bad = await postJson(port, "/refound", { seed: "rm -rf / ; drop$" });
    expect(bad.status).toBe(400);
    expect(bad.json.ok).toBe(false);
    expect(bad.json.error).toMatch(/invalid/i);

    const tooLong = await postJson(port, "/refound", { seed: "a".repeat(65) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.json.error).toMatch(/too long/i);

    const notString = await postJson(port, "/refound", { seed: 42 });
    expect(notString.status).toBe(400);
  });

  it("method guard: non-POST /refound → 405", async () => {
    srv = createAgentcityServer({ bundle: bundle(), onRefound: async () => nextBundle() });
    const port = await srv.listen(0);
    const r = await fetchText(port, "/refound"); // GET
    expect(r.status).toBe(405);
    expect(JSON.parse(r.body).ok).toBe(false);
  });

  it("malformed JSON body → 400", async () => {
    srv = createAgentcityServer({ bundle: bundle(), onRefound: async () => nextBundle() });
    const port = await srv.listen(0);
    const r = await postBody(port, "/refound", "{not json");
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/malformed/i);
  });

  it("rejects a second refound while one is in flight (409 busy)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const swapped = nextBundle();
    srv = createAgentcityServer({
      bundle: bundle(),
      onRefound: async () => {
        calls++;
        await gate; // hold the first request open
        return swapped;
      },
    });
    const port = await srv.listen(0);

    const first = postJson(port, "/refound", { seed: "one" });
    await sleep(40); // let the first claim the single-flight slot
    const second = await postJson(port, "/refound", { seed: "two" });
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/in progress/i);

    release();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    expect(firstRes.json.seed).toBe("one");
    expect(calls).toBe(1); // the busy one never reached the hook

    // slot freed — a later refound succeeds again
    const third = await postJson(port, "/refound", { seed: "three" });
    expect(third.json.ok).toBe(true);
  });

  it("no onRefound wired → 200 {ok:false, unsupported}", async () => {
    srv = createAgentcityServer({ bundle: bundle() });
    const port = await srv.listen(0);
    const r = await postJson(port, "/refound", { seed: "x" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: false, error: "unsupported" });
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
