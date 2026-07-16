// agentcity — federation client. The only outbound network module. Opt-in.
//
// The local server already produces the privacy-safe gamified stream (gamify:
// aggregate facts only, never paths/cwd/commands). Federating just FORWARDS that
// stream to the hub as a GamifiedBatch — no separate projection, no delta wire.
//
// The cursor is an absolute TIMESTAMP watermark (not a day index, which would
// renumber if a newly-ingested older event shifts the stream epoch). Each push
// resends every event on or after the watermark's calendar day, then advances the
// watermark to the newest ts sent. Resending the open day is safe: the hub upserts
// by (project, contributor, day), so it is idempotent — never double-counted, and
// tolerant of the hub being down (the watermark only advances on a successful POST).

import type { GamifiedEvent, GamifiedBatch } from "./gamified/types.js";

/** Persisted watermark: the newest ts fully pushed. `""` = nothing sent yet
 * (first join forwards the whole historic backlog). */
export interface Cursor {
  ts: string;
}

export const ZERO_CURSOR: Cursor = { ts: "" };

const dayKey = (ts: string): string => ts.slice(0, 10); // YYYY-MM-DD

/** Anti-entropy cadence: periodically re-assert the FULL backlog to the hub even
 * with no local activity, so an emptied/recovered hub self-heals (idempotent). */
const FULL_RESYNC_MS = 5 * 60_000;

export interface FederatorOpts {
  /** Central hub base URL, e.g. http://hub.example:4243 */
  url: string;
  handle: string;
  loadCursor: () => Cursor;
  saveCursor: (c: Cursor) => void;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms) for the anti-entropy interval; defaults to Date.now. */
  now?: () => number;
  log?: (msg: string) => void;
}

export interface Federator {
  /** Forward the gamified stream's new/open-day facts to the hub. Never throws. */
  push(stream: GamifiedEvent[]): Promise<void>;
}

function ingestUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/ingest`;
}

/** Parse the hub's `202 {accepted:N}` — how many facts it actually stored. An
 * older hub / non-JSON body means "all of them" (assume success). */
async function acceptedCount(res: Response, sent: number): Promise<number> {
  try {
    const body = (await res.json()) as { accepted?: unknown };
    return typeof body.accepted === "number" ? body.accepted : sent;
  } catch {
    return sent;
  }
}

export function createFederator(opts: FederatorOpts): Federator {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const url = ingestUrl(opts.url);
  // A FULL resend heals an emptied hub (upsert is idempotent). We send one when:
  //   • recovering — the last push failed, so the hub may have restarted empty;
  //   • the anti-entropy interval elapsed — periodic re-assert even when idle.
  // Otherwise we send only the (possibly grown) open day onward from the watermark.
  let healthy = true;
  let lastFullMs = 0; // 0 = never sent a full resync yet

  return {
    async push(stream: GamifiedEvent[]): Promise<void> {
      if (!stream.length) return;
      const cursor = opts.loadCursor();
      const t = now();
      const fullResync = !healthy || !cursor.ts || t - lastFullMs >= FULL_RESYNC_MS;
      const fromDayKey = fullResync ? "" : dayKey(cursor.ts);
      const events = stream.filter((e) => dayKey(e.ts) >= fromDayKey);
      if (!events.length) return; // nothing to send and not time for a resync
      const maxTs = events.reduce((m, e) => (e.ts > m ? e.ts : m), cursor.ts);

      // Privacy: the hub only needs DAY-level ordering (store sorts by day, ts,
      // factKey; renderCity slots by dateKey(ts)). Truncate the wire ts to the
      // calendar day so second-granularity "when exactly you worked" never leaves
      // the machine. The watermark (maxTs, above) keeps full precision locally so
      // resume stays exact. dayKey(ts) stays a parseable date coerce() accepts.
      const wireEvents = events.map((e) => ({ ...e, ts: dayKey(e.ts) }));
      const batch: GamifiedBatch = { v: 1, handle: opts.handle, events: wireEvents };
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
        });
        if (!res.ok) {
          healthy = false; // hub down/erroring — trigger a full resync on recovery
          log(`federation: hub returned ${res.status} — will retry next poll`);
          return;
        }
        healthy = true; // reachable again
        const accepted = await acceptedCount(res, events.length);
        if (accepted < events.length) {
          // hub rejected some facts (version skew?) — surface it and DON'T advance
          // the watermark past them, so they're retried rather than lost silently.
          log(`federation: hub accepted ${accepted}/${events.length} facts — ${events.length - accepted} rejected, will retry`);
          return;
        }
        if (fullResync) lastFullMs = t;
        opts.saveCursor({ ts: maxTs });
        log(`federation: ${fullResync ? "resynced" : "pushed"} ${events.length} facts to ${url}`);
      } catch (err) {
        healthy = false;
        log(`federation: push failed (${(err as Error).message}) — will retry next poll`);
      }
    },
  };
}
