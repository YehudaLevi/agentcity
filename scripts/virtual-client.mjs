#!/usr/bin/env node
// agentcity — a temp VIRTUAL federation client for demos.
//
// Posts a fake contributor's gamified backlog to a running hub, then drives a
// time-travel sweep so you can watch the shared city grow. Demonstrates:
//   • a NEW client joining with historic backlog (the hub reconciles it into
//     chronological position — buildings appear at their real days, not "now");
//   • GET /city?day=N time-travel across the merged timeline;
//   • an incremental "live" push afterwards (append reconciliation).
//
// Zero deps (global fetch, Node 20+). NOT the deterministic compiler, so a plain
// LCG for variety is fine here.
//
//   node scripts/virtual-client.mjs [hubUrl] [handle]
//   e.g. node scripts/virtual-client.mjs http://127.0.0.1:4300 vince

const HUB = (process.argv[2] || "http://127.0.0.1:4300").replace(/\/+$/, "");
const BY = process.argv[3] || "vince";

// --- tiny seeded RNG (reproducible demo) ---
let _s = 0x2545f4914f6cdd1d ^ [...BY].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 7);
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const ri = (n) => Math.floor(rnd() * n);

const CATS = ["code", "tests", "infra", "api", "research", "web", "planning"];

// The fake contributor's projects. 3 git repos (shared BUILDINGS) + 1 no-repo
// workspace (a per-user TREEHOUSE). `at` = shared-day offset the project is founded.
const PROJECTS = [
  { proj: { kind: "git", remote: `github.com/${BY}/rocket` }, name: "rocket", cat: "code", at: 5 },
  { proj: { kind: "git", remote: `github.com/${BY}/atlas` }, name: "atlas", cat: "infra", at: 8 },
  { proj: { kind: "git", remote: `github.com/${BY}/pixel-lab` }, name: "pixel-lab", cat: "web", at: 12 },
  { proj: { kind: "local", token: `${BY}-scratch` }, name: "scratch", cat: "research", at: 7 }, // treehouse
];

async function getModel(day) {
  const url = day == null ? `${HUB}/city` : `${HUB}/city?day=${day}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return (await r.json()).model;
}
async function post(events) {
  const r = await fetch(`${HUB}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: 1, handle: BY, events }),
  });
  return r.status;
}

// vince's lots — matched by TILE IDENTITY (lot.id = `h(<tileId>)`), not display
// name, so a name collision with another contributor's workspace isn't counted.
function tileId(proj) {
  if (proj.kind === "git") return `g:${proj.remote}`;
  return `${proj.kind === "repo" ? "r" : "u"}:${BY}:${proj.token}`;
}
const MY_IDS = new Set(PROJECTS.map((p) => `h(${tileId(p.proj)})`));
const mine = (model) => model.lots.filter((l) => MY_IDS.has(l.id));

const dayMs = 86400000;
function iso(base, dayOff, hour) {
  return new Date(base + dayOff * dayMs + hour * 3600000).toISOString();
}

/** Build vince's gamified stream over [start .. start+span) shared days. Two
 * projects share a session on overlap days so they RAIL on the hub. */
function buildStream(foundedBase, span) {
  const evs = [];
  for (const p of PROJECTS) {
    let founded = false;
    for (let d = p.at; d < span; d++) {
      if (founded && rnd() > 0.72) continue; // some idle days
      const first = !founded;
      founded = true;
      const shareSession = (p.name === "rocket" || p.name === "atlas") && d % 4 === 0;
      evs.push({
        v: 1,
        proj: p.proj,
        name: p.name,
        by: BY,
        day: d,
        ts: iso(foundedBase, d, 9 + ri(6)),
        wu: 18 + ri(46),
        forks: rnd() > 0.82 ? 1 + ri(2) : 0,
        turns: 3 + ri(9),
        allnighter: rnd() > 0.9,
        category: rnd() > 0.75 ? CATS[ri(CATS.length)] : p.cat,
        sessions: [shareSession ? `${BY}-collab-${d}` : `${BY}-${p.name}-${d}`],
        founding: first,
      });
    }
  }
  return evs;
}

function bar(n, max, w = 28) {
  const k = max ? Math.round((n / max) * w) : 0;
  return "█".repeat(k) + "·".repeat(w - k);
}

async function main() {
  console.log(`\n▶ virtual client "${BY}" → ${HUB}\n`);

  const before = await getModel();
  console.log(`hub before: ${before.lots.length} lots (${mine(before).length} are ${BY}'s), founded ${before.foundedTs}, day ${before.day}`);

  // Interleave vince's history INTO the existing timeline: start a few days after
  // the hub's founding so his backlog lands in the past, not appended at the end.
  const foundedBase = Date.parse(`${before.foundedTs}T00:00:00Z`);
  const span = Math.max(20, before.day - 2);
  const backlog = buildStream(foundedBase, span);
  console.log(`\n① NEW CLIENT JOINS — posting ${backlog.length} historic facts (days ${PROJECTS.reduce((m, p) => Math.min(m, p.at), 99)}..${span - 1}) as one backlog…`);
  console.log(`   POST /ingest → ${await post(backlog)}`);

  const after = await getModel();
  const mineAfter = mine(after);
  console.log(`   hub after: ${after.lots.length} lots (+${after.lots.length - before.lots.length}); ${BY} now has ${mineAfter.length} lots: ${mineAfter.map((l) => `${l.repo}${l.personal ? "🌳" : "🏢"} T${l.tier}`).join(", ")}`);
  const rails = after.rails.length - before.rails.length;
  if (rails > 0) console.log(`   +${rails} rail(s) — coupled projects that shared a session`);

  console.log(`\n② TIME-TRAVEL — the merged city at past days (GET /city?day=N):`);
  const maxDay = after.day;
  const stops = [...new Set([0, Math.floor(maxDay * 0.25), Math.floor(maxDay * 0.5), Math.floor(maxDay * 0.75), maxDay])];
  const totalMax = after.lots.length;
  for (const d of stops) {
    const m = await getModel(d);
    console.log(`   day ${String(d).padStart(3)} │ ${bar(m.lots.length, totalMax)} │ ${String(m.lots.length).padStart(2)} lots · ${String(mine(m).length).padStart(2)} ${BY} · ${m.stats.ships} ships · pop ${m.stats.population}`);
  }

  console.log(`\n③ LIVE PUSH — ${BY} works today (append reconciliation, beyond the frontier):`);
  const today = maxDay + 1;
  const live = PROJECTS.slice(0, 2).map((p, i) => ({
    v: 1, proj: p.proj, name: p.name, by: BY, day: today,
    ts: iso(foundedBase, today, 11 + i), wu: 30 + ri(30), forks: 0, turns: 6 + ri(6),
    allnighter: false, category: p.cat, sessions: [`${BY}-live-${today}`], founding: false,
  }));
  console.log(`   POST /ingest (${live.length} facts on day ${today}) → ${await post(live)}`);
  const fin = await getModel();
  console.log(`   hub now: ${fin.lots.length} lots, day ${fin.day}, ${fin.stats.ships} ships\n`);
  console.log(`✔ open ${HUB.replace("127.0.0.1", "localhost")}/?mode=timelapse to watch it rise, or drag the scrubber to time-travel.`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}\n  (is the hub running?  agentcity --central --port 4300)`);
  process.exit(1);
});
