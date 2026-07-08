# Architecture — agentcity M0

> Source of truth for modules and DATA CONTRACTS. game-rules.md defines
> behavior; this file defines shape. Both bind the compiler AND renderer.

## Stack

TS strict / Node 20+ / ESM / zero runtime deps / vitest. Frontend: single
self-contained `web/city.html` (canvas, programmatic pixel art — engine
adapted from `mockups/agentcity-rules.html`). Bin: dist-first launcher
(pixelagents pattern, all its fixes).

## Layout & ownership (wave 1)

```
agentcity/
├── AGENTS.md, docs/, mockups/          # supervisor-owned
├── package.json, tsconfig*, vitest.config.ts   # supervisor scaffold
├── src/                                 # ENGINE (Agent A)
│   ├── types.ts          PixelEvent (shared w/ pixelagents), CityModel,
│   │                     Lot, CityDelta, Checkpoint, Seed types
│   ├── seed.ts           machine+user → stable seed; hash helpers (fnv/sha)
│   ├── ingest/
│   │   ├── claude-history.ts     ~/.claude transcripts → PixelEvent[]
│   │   │                         (dir injectable; tool_use/tool_result +
│   │   │                         timestamps + cwd/session mapping)
│   │   └── pixelagents-log.ts    events.jsonl + archives → PixelEvent[]
│   ├── rules/
│   │   ├── economy.ts    event→WU, daily caps, warehouse (game-rules §1-2)
│   │   ├── tiers.ts      thresholds, upgrade/decay checks (§3, §7 decay)
│   │   ├── placement.ts  biome, origin, district affinity, water carving,
│   │   │                 road A*, rails, chunk expansion (§5-6)
│   │   ├── population.ts citizens/pets/ships rolling windows (§4)
│   │   └── milestones.ts landmarks (§7)
│   ├── compiler.ts       fold(events, seed) → {model, deltas} day by day.
│   │                     PURE. Also incremental: fold(checkpoint, newEvents)
│   ├── persist.ts        ~/.agentcity layout (injectable root): checkpoint
│   │                     write/read (atomic), monthly archive gz, album dir
│   └── demo-events.ts    seeded synthetic event stream (for --demo & tests)
├── web/city.html                        # RENDERER (Agent B)
├── src/server.ts + bin/*                # wave 2 (after A+B land)
└── test/                                # each agent owns its own tests
```

## Contract 1: PixelEvent (unchanged from pixelagents)

```json
{"ts":"ISO","session":"id","agent":"user","source":"claude-code",
 "cwd":"/path","repo":"name","kind":"session.start|session.end|turn.start|
 turn.end|tool.pre|tool.post|fork.start|fork.end|waiting.human|
 waiting.permission|other","tool":"Edit?","detail":"src/a.ts?"}
```

## Contract 2: CityModel v1 (compiler output = renderer input)

```json
{
  "version": 1,
  "seed": "a1b2c3",
  "day": 94,                       // days since founding (event-derived)
  "foundedTs": "2026-04-05",
  "biome": {"kind":"coastal|river|lakes|hills",
             "water":[[x,y],...],  // water tile coords
             "origin":[x,y], "growthDir":"NE"},
  "chunks": [{"x":0,"y":0,"revealed":true,"revealedDay":0}],   // 10x10 tiles each (M0; see note)
  "roads": [{"id":"r1","path":[[x,y],...],"tier":1}],          // tier 0..3 dirt→avenue
  "rails": [{"between":["lotA","lotB"],"path":[[x,y],...]}],
  "lots": [{
    "id":"h(repo)","repo":"webshop","alias":"building-3",
    "category":"code|tests|infra|api|research|web|planning",
    "secondary":"tests|null",
    "pos":[x,y],"tier":0-5,"wu":712,"wuIntoTier":12,"wuNextTier":700,
    "foundedDay":3,"lastActiveDay":92,
    "decay":0-2,                    // 0 none, 1 vines(30d), 2 cracks(90d)
    "underConstruction":false,
    "variant":7                     // hash(repo) — width/roof/windows
  }],
  "landmarks":[{"kind":"fountain|statue|plaque|fireworks-spot",
                "pos":[x,y],"day":40}],
  "stats":{"totalWu":9412,"population":12,"pets":3,"ships":61,
           "streakDays":14,"allNighterYesterday":false},
  "baseline":{"housePos":[x,y],"roadPath":[[x,y],...] ,"props":[{"kind":"well|tree|boat","pos":[x,y]}]}
}
```

Coordinates: integer tile coords, x→SE, y→SW (iso 2:1 render mapping is the
renderer's business). Chunk size 10 in M0 (playground-proven; the rules doc
says 24 — amended for visible fog recession at solo scale).

## Contract 3: CityDelta (timelapse + live updates)

Ordered list; renderer replays for the Founding Timelapse and applies live.

```json
{"day":47,"seq":1203,
 "kind":"lot.found|lot.upgrade|lot.decay|lot.renovate|road.add|road.upgrade|
 rail.add|chunk.reveal|landmark.add|ship.arrive|population.set|baseline.init",
 ...kind-specific fields mirroring CityModel fragments}
```

`compiler.fold()` returns `{model, deltas}`; incremental folds return only
new deltas (seq strictly increasing). Determinism: identical (events, seed)
⇒ byte-identical JSON (stable key order via serializer in types.ts).

## Contract 4: persistence (~/.agentcity/, root injectable)

```
checkpoint.json        {version, seed, upToTs, model}   atomic tmp+rename
deltas.jsonl           full delta log (append; source for timelapse)
archive/events-YYYY-MM.jsonl.gz    ingested raw events (never pruned)
album/*.png
config.json            {seed?, historyInfluence:"full|capped", aliases:{}}
```

## Renderer (web/city.html) responsibilities

- Load `window.__CITY__` bootstrap (M0 dev: a <script> fixture; wave 2:
  fetched from local server /model + /deltas SSE).
- Modes: **timelapse** (replay deltas with play/pause/speed — founding
  experience) and **live** (current model + incoming deltas).
- Everything approved in mocks: iso engine, pan/zoom/minimap, fog, day/night
  by real clock, seeded weather, citizens/pets/ships from stats, sound
  toggle (off), reduced-motion static, card hooks stubbed (Album is M2).
- Renderer may use real clock/random ONLY for atmosphere (light, weather
  particle jitter, walk cycles) — never for map state.

## Testing policy

Golden-model: fixture events + seed → committed expected CityModel hash.
Property: WU caps never exceeded; tier monotonic (except never-decreasing);
deltas replay ⇒ same model as direct fold; incremental fold ≡ full fold.
Renderer: headless-chrome smoke (no console errors, N buildings painted)
against a fixture model.

## Milestones

- **M0 (this wave)**: A=engine (ingest/rules/compiler/persist/demo) ·
  B=renderer vs fixture · wave 2: server+CLI+founding flow wiring
- M1: agent-as-architect (blueprint DSL) · M2: cards/Album · M3: team hub
  (fresh validation first)
