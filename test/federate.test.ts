import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { gamify, type IdentityResolver } from "../src/gamified/gamify.js";
import { generateDemoEvents, demoResolver } from "../src/demo-events.js";
import { createFederator, ZERO_CURSOR, type Cursor } from "../src/federate.js";
import { coerceBatch, type GamifiedBatch } from "../src/gamified/types.js";

const resolver: IdentityResolver = demoResolver;
const stream = gamify(generateDemoEvents("fed-demo"), resolver, "alice");
const maxTs = stream.reduce((m, e) => (e.ts > m ? e.ts : m), "");
const lastDayKey = maxTs.slice(0, 10);

// A controllable hub: collects valid batches, returns `status`, and reports an
// `accepted` count (default = all events; set `acceptDrop` to reject some).
let received: GamifiedBatch[] = [];
let status = 200;
let acceptDrop = 0; // how many events the hub pretends to reject
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let accepted = 0;
      if (req.method === "POST" && req.url === "/ingest") {
        const batch = coerceBatch(JSON.parse(body));
        if (batch) {
          received.push(batch);
          accepted = Math.max(0, batch.events.length - acceptDrop);
        }
      }
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: status < 400, accepted }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function federator(cur: { v: Cursor }) {
  return createFederator({
    url: base,
    handle: "alice",
    loadCursor: () => cur.v,
    saveCursor: (c) => (cur.v = c),
  });
}

describe("federate client (forwards the gamified stream)", () => {
  beforeEach(() => {
    received = [];
    status = 200;
    acceptDrop = 0;
  });

  it("pushes the whole backlog on first join and advances the watermark", async () => {
    received = [];
    status = 200;
    const cur = { v: { ...ZERO_CURSOR } as Cursor };
    await federator(cur).push(stream);

    expect(received).toHaveLength(1);
    expect(received[0]!.handle).toBe("alice");
    expect(received[0]!.events.length).toBe(stream.length); // full historic backlog
    expect(cur.v.ts).toBe(maxTs);
    // privacy: only gamified facts on the wire — no cwd/detail/command substrings.
    const wire = JSON.stringify(received[0]!.events);
    expect(wire).not.toContain("/work/");
  });

  it("re-sends only the open day on a second push (watermark holds)", async () => {
    received = [];
    status = 200;
    const cur = { v: { ...ZERO_CURSOR } as Cursor };
    const f = federator(cur);
    await f.push(stream);
    received = [];
    await f.push(stream); // watermark at maxTs -> only the last calendar day resent
    expect(received).toHaveLength(1);
    expect(received[0]!.events.every((e) => e.ts.slice(0, 10) >= lastDayKey)).toBe(true);
  });

  it("does NOT advance the watermark when the hub errors (retry next poll)", async () => {
    received = [];
    status = 500;
    const cur = { v: { ...ZERO_CURSOR } as Cursor };
    await federator(cur).push(stream);
    expect(cur.v).toEqual(ZERO_CURSOR); // unchanged, so next poll re-sends
  });

  it("never throws when the hub is unreachable", async () => {
    const cur = { v: { ...ZERO_CURSOR } as Cursor };
    const f = createFederator({
      url: "http://127.0.0.1:1",
      handle: "alice",
      loadCursor: () => cur.v,
      saveCursor: (c) => (cur.v = c),
    });
    await expect(f.push(stream)).resolves.toBeUndefined();
    expect(cur.v).toEqual(ZERO_CURSOR);
  });

  it("SELF-HEALS: after a failed push, the next success resends the WHOLE backlog", async () => {
    const cur = { v: { ...ZERO_CURSOR } as Cursor };
    const f = federator(cur);
    await f.push(stream); // healthy -> advances the watermark
    const advanced = cur.v.ts;
    expect(advanced).toBe(maxTs);

    status = 500; // hub goes down
    await f.push(stream);
    expect(cur.v.ts).toBe(advanced); // watermark holds

    status = 200; // hub recovers (possibly with an empty store)
    received = [];
    await f.push(stream);
    // recovery push ignores the watermark and resends everything (idempotent),
    // so an emptied hub is refilled — not left missing history.
    expect(received).toHaveLength(1);
    expect(received[0]!.events.length).toBe(stream.length);
  });

  it("does NOT advance the watermark when the hub accepts only SOME facts", async () => {
    acceptDrop = 2; // hub rejects 2 events (e.g. version skew)
    const cur = { v: { ...ZERO_CURSOR } as Cursor };
    await federator(cur).push(stream);
    expect(cur.v).toEqual(ZERO_CURSOR); // not advanced -> rejected facts are retried, not lost
  });

  it("ANTI-ENTROPY: periodically re-asserts the FULL backlog even with nothing new", async () => {
    let clock = 1_000_000;
    const cur = { v: { ...ZERO_CURSOR } as Cursor };
    const f = createFederator({ url: base, handle: "alice", loadCursor: () => cur.v, saveCursor: (c) => (cur.v = c), now: () => clock });
    await f.push(stream); // first push = full, advances the watermark
    received = [];
    await f.push(stream); // moments later: incremental -> only the open day
    expect(received[0]!.events.length).toBeLessThan(stream.length);
    received = [];
    clock += 5 * 60_000 + 1; // let the anti-entropy interval elapse
    await f.push(stream); // now a full resync fires even though nothing changed
    expect(received[0]!.events.length).toBe(stream.length);
  });
});
