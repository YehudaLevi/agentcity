/* ============================================================================
 * agentcity — fixture-city.js  (Agent B / renderer fixture)
 * ----------------------------------------------------------------------------
 * A hand-authored, CONTRACT-EXACT ~90-day city. This is the M0 dev bootstrap
 * for web/city.html (`window.__CITY__ = {model, deltas}`) AND the reference
 * artifact for the compiler team (Agent A).
 *
 * It codes strictly to docs/architecture.md:
 *   Contract 2  — CityModel v1   (compiler output = renderer input)
 *   Contract 3  — CityDelta      (ordered; replays to exactly `model`)
 *
 * GUARANTEE: `model` is produced by folding `deltas` day 0..90 with the same
 * pure reducer the renderer uses, so the founding timelapse (replay of deltas)
 * arrives at byte-for-byte the same state as live view. The timeline below is
 * the single source of truth; both `deltas` and `model` derive from it.
 *
 * WU tier thresholds (game-rules.md §3, cumulative): [0,25,90,250,700,1800].
 * Field semantics chosen for the wuIntoTier/wuNextTier pair (arch Contract 2):
 *   wuIntoTier = wu - TIERS[tier]                (WU accrued inside current tier)
 *   wuNextTier = TIERS[min(tier+1,5)]            (cumulative WU threshold of next tier)
 *   progress   = wuIntoTier / (wuNextTier - TIERS[tier])   (clamped for tier 5)
 * ==========================================================================*/
(function () {
  "use strict";

  var TIERS = [0, 25, 90, 250, 700, 1800];

  // fnv-1a → stable per-repo variant (arch: variant = hash(repo))
  function vhash(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function tierMeta(tier, wu) {
    return { wuIntoTier: wu - TIERS[tier], wuNextTier: TIERS[Math.min(5, tier + 1)] };
  }

  // ------------------------------------------------------------------ timeline
  var SEED = "fixture-coastal-01";
  var FOUNDED_TS = "2026-04-09";
  var MAX_DAY = 90;

  var BIOME = {
    kind: "coastal",
    origin: [25, 25],
    growthDir: "NE",
    water: (function () {           // a rectangular sea on the E/harbor edge
      var w = [];
      for (var x = 36; x <= 39; x++) for (var y = 20; y <= 29; y++) w.push([x, y]);
      return w;
    })()
  };

  // baseline hamlet (the founding hut + starter road + props). §7 plaque lands here.
  var BASELINE = {
    housePos: [24, 25],
    roadPath: [[24, 25], [25, 25], [26, 25]],
    props: [
      { kind: "well", pos: [25, 24] },
      { kind: "tree", pos: [23, 24] },
      { kind: "boat", pos: [37, 25] }   // on the water
    ]
  };

  // 3 revealed chunks (10x10 tiles each) + fog everywhere else
  var CHUNKS = [
    { x: 2, y: 2, day: 0 },   // Old Town
    { x: 3, y: 2, day: 25 },  // harbor annexed
    { x: 2, y: 3, day: 50 }   // industry annexed
  ];

  // 12 lots, all 7 categories, tiers 1..5.  steps = [day, tier, cumulativeWu]
  // (first step = founding; the rest are lot.upgrade snapshots).
  var LOTS = [
    { repo: "core-app",     category: "code",     secondary: "tests", pos: [25, 25], oldtown: true,
      steps: [[0,1,25],[3,2,90],[15,3,250],[40,4,700],[86,4,1120]], decays: [] },
    { repo: "utils-lib",    category: "code",     secondary: null,    pos: [26, 26],
      steps: [[20,1,25],[28,2,90],[80,2,150]], decays: [] },
    { repo: "legacy-cli",   category: "code",     secondary: null,    pos: [23, 28],
      steps: [[0,1,25],[0,2,130]], decays: [[30,1],[90,2]] },      // decay-2 ruin (silent since day 0)
    { repo: "unit-runner",  category: "tests",    secondary: null,    pos: [22, 22],
      steps: [[4,1,25],[7,2,90],[18,3,250],[45,4,700],[78,5,1800],[89,5,2050]], decays: [] },
    { repo: "e2e-suite",    category: "tests",    secondary: null,    pos: [23, 24],
      steps: [[44,1,25],[50,2,90],[72,3,250],[84,3,480]], decays: [] },
    { repo: "ci-foundry",   category: "infra",    secondary: null,    pos: [24, 32],
      steps: [[52,1,25],[55,2,90],[66,3,250],[82,4,700],[88,4,900]], decays: [] },
    { repo: "build-cache",  category: "infra",    secondary: null,    pos: [25, 33],
      steps: [[58,1,25],[64,2,90],[85,2,200]], decays: [] },
    { repo: "api-gateway",  category: "api",      secondary: null,    pos: [35, 24],
      steps: [[26,1,25],[30,2,90],[48,3,250],[74,4,700],[87,4,820]], decays: [] },
    { repo: "webhook-pier", category: "api",      secondary: null,    pos: [35, 27],
      steps: [[70,1,25],[76,2,90],[88,2,110]], decays: [] },
    { repo: "docs-archive", category: "research", secondary: null,    pos: [21, 26],
      steps: [[12,1,25],[20,2,90],[55,3,250],[83,3,340]], decays: [] },
    { repo: "dashboard-ui", category: "web",      secondary: null,    pos: [28, 22],
      steps: [[16,1,25],[40,1,55]], decays: [[71,1]] },            // went quiet -> vines (decay 1)
    { repo: "roadmap-hall", category: "planning", secondary: null,    pos: [27, 24],
      steps: [[8,1,25],[14,2,90],[38,3,250],[80,3,300]], decays: [] }
  ];

  var ROADS = [
    { id: "r-avenue",  path: [[25,25],[26,25],[27,25],[28,25],[29,25],[30,25],[31,25],[32,25],[33,25],[34,25]],
      adds: [[0,1],[30,2],[60,3]] },                              // dirt -> street -> avenue (tier 3)
    { id: "r-tests",   path: [[25,25],[25,24],[25,23],[24,23],[23,23],[22,23],[22,22]],
      adds: [[4,1],[45,2]] },
    { id: "r-research",path: [[24,25],[23,25],[22,25],[21,25],[21,26]],
      adds: [[12,1]] },
    { id: "r-civic",   path: [[27,25],[27,24],[28,24],[28,23],[28,22]],
      adds: [[8,1],[50,2]] },
    { id: "r-industry",path: [[25,26],[25,27],[25,28],[25,29],[25,30],[24,30],[24,31],[24,32]],
      adds: [[50,1]] }
  ];

  var RAILS = [
    { between: ["L-core-app", "L-api-gateway"], path: [[25,25],[30,25],[34,24],[35,24]], day: 32 }
  ];

  var LANDMARKS = [
    { kind: "plaque",        pos: [25, 25], day: 1 },   // city founding plaque on Old Town
    { kind: "fountain",      pos: [26, 24], day: 55 },  // §7: 10th repo
    { kind: "statue",        pos: [24, 24], day: 62 },  // §7: 100th fork
    { kind: "fireworks-spot",pos: [25, 25], day: 70 }   // §7: 1000th turn
  ];

  // population.set snapshots (rolling-window derived, §4). Final carries the
  // remaining stats fragment (streak + all-nighter).
  var POP = [
    { day: 0,  population: 0,  pets: 0 },
    { day: 10, population: 3,  pets: 0 },
    { day: 25, population: 6,  pets: 1 },
    { day: 45, population: 9,  pets: 2 },
    { day: 74, population: 12, pets: 3 },
    { day: 90, population: 12, pets: 3, streakDays: 14, allNighterYesterday: true }
  ];

  var DOCK = [36, 24];                                  // water tile ships dock at
  var CARGO_DAYS = [20, 35, 55, 70, 88];                // scheduled cargo (§4: 1 / 500 WU)

  // ------------------------------------------------------------- emit deltas
  var raw = [];
  function push(day, ord, d) { d.day = day; d._ord = ord; raw.push(d); }

  // id per lot + alias (repo names OFF => alias)
  LOTS.forEach(function (l, i) { l.id = "L-" + l.repo; l.alias = "building-" + (i + 1); l.variant = vhash(l.repo) % 16; });

  push(0, 0, { kind: "baseline.init", seed: SEED, foundedTs: FOUNDED_TS,
    biome: { kind: BIOME.kind, water: BIOME.water, origin: BIOME.origin, growthDir: BIOME.growthDir },
    baseline: BASELINE });

  CHUNKS.forEach(function (c) { push(c.day, 1, { kind: "chunk.reveal", x: c.x, y: c.y, revealedDay: c.day }); });

  LOTS.forEach(function (l) {
    l.steps.forEach(function (s, idx) {
      var day = s[0], tier = s[1], wu = s[2], m = tierMeta(tier, wu);
      if (idx === 0) {
        push(day, 2, { kind: "lot.found", id: l.id, repo: l.repo, alias: l.alias,
          category: l.category, secondary: l.secondary, pos: l.pos, variant: l.variant,
          tier: tier, wu: wu, wuIntoTier: m.wuIntoTier, wuNextTier: m.wuNextTier,
          foundedDay: day, lastActiveDay: day });
        // a ship arrives on founding (§4)
        push(day, 8, { kind: "ship.arrive", dock: DOCK, repo: l.repo, cargo: "founding" });
      } else {
        push(day, 5, { kind: "lot.upgrade", id: l.id, tier: tier, wu: wu,
          wuIntoTier: m.wuIntoTier, wuNextTier: m.wuNextTier, lastActiveDay: day });
      }
    });
    l.decays.forEach(function (d) { push(d[0], 9, { kind: "lot.decay", id: l.id, level: d[1] }); });
  });

  ROADS.forEach(function (r) {
    r.adds.forEach(function (a, idx) {
      if (idx === 0) push(a[0], 3, { kind: "road.add", id: r.id, path: r.path, tier: a[1] });
      else           push(a[0], 6, { kind: "road.upgrade", id: r.id, tier: a[1] });
    });
  });

  RAILS.forEach(function (r) { push(r.day, 4, { kind: "rail.add", between: r.between, path: r.path }); });
  // landmark type travels in `landmarkKind` so it can't clobber the delta's own `kind`
  LANDMARKS.forEach(function (l) { push(l.day, 7, { kind: "landmark.add", landmarkKind: l.kind, pos: l.pos }); });

  CARGO_DAYS.forEach(function (day) { push(day, 8, { kind: "ship.arrive", dock: DOCK, cargo: "cargo" }); });
  POP.forEach(function (p) {
    var d = { kind: "population.set", population: p.population, pets: p.pets };
    if (p.streakDays != null) d.streakDays = p.streakDays;
    if (p.allNighterYesterday != null) d.allNighterYesterday = p.allNighterYesterday;
    push(p.day, 10, d);
  });

  // stable order: (day, ord, insertion) then assign strictly-increasing seq
  raw.forEach(function (d, i) { d._i = i; });
  raw.sort(function (a, b) { return (a.day - b.day) || (a._ord - b._ord) || (a._i - b._i); });
  var deltas = raw.map(function (d, i) {
    var out = { day: d.day, seq: 1000 + i, kind: d.kind };
    for (var k in d) if (k !== "day" && k !== "kind" && k !== "_ord" && k !== "_i") out[k] = d[k];
    return out;
  });

  // ----------------------------------------------- pure reducer (fold)  ⇐ SHARED
  // The renderer carries an identical fold(); keep them in sync. Determinism:
  // fold(deltas, 90) === model.
  function fold(list, upto) {
    var m = {
      version: 1, seed: SEED, day: upto, foundedTs: FOUNDED_TS,
      biome: { kind: "coastal", water: [], origin: [0, 0], growthDir: "NE" },
      chunks: [], roads: [], rails: [], lots: [], landmarks: [],
      stats: { totalWu: 0, population: 0, pets: 0, ships: 0, streakDays: 0, allNighterYesterday: false },
      baseline: null
    };
    var lotById = {}, roadById = {};
    for (var i = 0; i < list.length; i++) {
      var d = list[i]; if (d.day > upto) continue;
      switch (d.kind) {
        case "baseline.init":
          m.seed = d.seed; m.foundedTs = d.foundedTs;
          m.biome = { kind: d.biome.kind, water: d.biome.water, origin: d.biome.origin, growthDir: d.biome.growthDir };
          m.baseline = d.baseline; break;
        case "chunk.reveal":
          m.chunks.push({ x: d.x, y: d.y, revealed: true, revealedDay: d.revealedDay }); break;
        case "lot.found": {
          var lot = { id: d.id, repo: d.repo, alias: d.alias, category: d.category, secondary: d.secondary,
            pos: d.pos, tier: d.tier, wu: d.wu, wuIntoTier: d.wuIntoTier, wuNextTier: d.wuNextTier,
            foundedDay: d.foundedDay, lastActiveDay: d.lastActiveDay, decay: 0, underConstruction: false,
            variant: d.variant };
          m.lots.push(lot); lotById[lot.id] = lot; break;
        }
        case "lot.upgrade": {
          var lu = lotById[d.id];
          if (lu) { lu.tier = d.tier; lu.wu = d.wu; lu.wuIntoTier = d.wuIntoTier; lu.wuNextTier = d.wuNextTier; lu.lastActiveDay = d.lastActiveDay; }
          break;
        }
        case "lot.decay":   { var ld = lotById[d.id]; if (ld) ld.decay = d.level; break; }
        case "lot.renovate":{ var lr = lotById[d.id]; if (lr) { lr.decay = 0; lr.lastActiveDay = d.lastActiveDay; } break; }
        case "road.add":    { var r = { id: d.id, path: d.path, tier: d.tier }; m.roads.push(r); roadById[d.id] = r; break; }
        case "road.upgrade":{ var ru = roadById[d.id]; if (ru) ru.tier = d.tier; break; }
        case "rail.add":     m.rails.push({ between: d.between, path: d.path }); break;
        case "landmark.add": m.landmarks.push({ kind: d.landmarkKind, pos: d.pos, day: d.day }); break;
        case "ship.arrive":  m.stats.ships++; break;
        case "population.set":
          m.stats.population = d.population; m.stats.pets = d.pets;
          if (d.streakDays != null) m.stats.streakDays = d.streakDays;
          if (d.allNighterYesterday != null) m.stats.allNighterYesterday = d.allNighterYesterday;
          break;
        case "sync.lots":
          for (var si = 0; si < d.lots.length; si++) { var s = d.lots[si], sl = lotById[s.id];
            if (sl) { sl.wu = s.wu; sl.wuIntoTier = s.wuIntoTier; sl.wuNextTier = s.wuNextTier; sl.lastActiveDay = s.lastActiveDay; sl.decay = s.decay; } }
          break;
      }
    }
    var tot = 0; for (var j = 0; j < m.lots.length; j++) tot += m.lots[j].wu;
    m.stats.totalWu = tot;
    return m;
  }

  // contract: the FINAL delta of every fold is a sync.lots carrying exact
  // per-lot wu/progress/lastActiveDay/decay (matches the compiler). Derived from
  // a pre-fold so it re-asserts the already-consistent values -> fold == model.
  var _pre = fold(deltas, MAX_DAY);
  var _syncLots = _pre.lots
    .slice()
    .sort(function (a, b) { return a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0; })
    .map(function (l) { return { id: l.id, wu: l.wu, wuIntoTier: l.wuIntoTier, wuNextTier: l.wuNextTier, lastActiveDay: l.lastActiveDay, decay: l.decay }; });
  deltas.push({ day: MAX_DAY, seq: 1000 + deltas.length, kind: "sync.lots", lots: _syncLots });

  var model = fold(deltas, MAX_DAY);

  var payload = { model: model, deltas: deltas, _fold: fold, _MAX_DAY: MAX_DAY };
  var root = (typeof window !== "undefined") ? window : globalThis;
  root.__CITY__ = payload;
  if (typeof module !== "undefined" && module.exports) module.exports = payload;
})();
