# Plan — agentcity

> Status: validation phase (2026-07-07). No product code until the gates in
> README pass. This doc captures the concept as designed in conversation so
> nothing is lost while validation runs.

## 1. Why the gates exist (the lesson)

pixelagents was built in 2 days on an unvalidated "whitespace" claim; the
incumbent (pixel-agents, 8.5k★, Feb 2026) was findable in 10 seconds of
concept search. Rule (permanent): every idea/pivot gets a dedicated
"who is closest" sweep — GitHub/npm/marketplaces/web by CONCEPT — and the
mock must earn the build. Excitement raises the bar, not lowers it.

## 2. Core thesis

A persistent, legible, unique visualization of accumulated agent work:

- **Persistent** — the axis the incumbent structurally lacks (pixel-agents is
  ephemeral/live-only). Progression = retention: cute tools churn, save
  files don't.
- **Legible** — the work taxonomy IS the visual vocabulary (districts).
  You read a skyline and know how someone works.
- **Unique** — the agent authors each building's architecture (constrained
  blueprint DSL, post-session sidecar). "The city is the byproduct of your
  agent": same metrics, different city. Provenance, not decoration.

## 3. Mechanics

### The invariant
`city = f(events.jsonl)` — deterministic compile of the event log (same
idempotent philosophy as the pixelagents/Observatory pipelines). No save
state to corrupt; replayable; cheat-resistant (daily caps + diminishing
returns in the compiler — spam builds nothing).

### Event → city mapping
| Signal (already captured by pixelagents emitter) | City element |
|---|---|
| repo (first_seen order) | building + plot; first repo = Old Town center, city radiates chronologically |
| turn.end count per repo | floors (diminishing curve: floor 1 = 5 turns, floor 10 = 200) |
| tool mix per repo (taxonomy below) | district + architecture material |
| fork.start/end | cranes while live; annexes accumulate; 100th fork = plaza statue |
| waiting.human/permission time | live: rooftop distress beacon; historic: clocktower grows |
| 30 days silence | decay: dark windows, vines, cracks; revival = scaffolding |
| session activity now | lit windows + tiny workers (live layer rides on top) |
| milestones (1000th event, first all-nighter…) | landmarks (fountain, streetlamp district…) |
| real clock | day/night cycle |

### Work taxonomy (derived from tool + detail patterns)
| Category | Derivation | Visual |
|---|---|---|
| code | Edit/Write on source | residential towers |
| tests | test runners, *.test.* edits | glass & steel |
| infra | bash: docker/deploy/scripts | industrial: smokestacks, pipes |
| api/integration | curl, http clients, api paths | harbor, bridges, lighthouse |
| research | Read/Grep/Glob sprees | libraries, museums |
| web | WebSearch/WebFetch | observatory domes |
| planning | plan-mode/long turn.start gaps | city hall, blueprint office |
| delegation | fork density | scaffolding, worker cranes |

### Agent-as-architect (the byproduct layer)
- Opt-in `SessionEnd` sidecar: tiny budget-capped call (Haiku-class,
  ~$0.005) AFTER the session, never inside it (post-Kickbacks discipline —
  a ritual, not a tax).
- Agent reads a session summary (categories touched, vibe) and authors a
  **blueprint in a constrained DSL** (shapes/materials/ornaments/palette —
  validated; Minecraft blocks, not raw code). Engine renders blueprints;
  failed/absent generation falls back to procedural.
- Result: skeleton honest (metrics), skin unique (authored).

## 4. Metaphor decision (Gate 3)

City vs garden vs colony/hive/reef scored on: progression, taxonomy
legibility, decay, live layer, solo→org scale, agent-authored variety,
across-the-room readability. City wins primarily on (a) humans pre-read
urban categories (industrial vs residential vs civic), (b) org scale
(skyline→metropolis; garden collapses into "a field"), (c) a city IS
accumulated collective work — isomorphic, needs no explanation. Garden is
runner-up for solo-cozy; revisit only if the city mock fails Gate 2.

## 4b. Art direction (decided 2026-07-07, user: "Red Alert map")

**Isometric ever-growing world map**, not a side-view skyline. RTS visual
grammar (C&C/SimCity 2000): 2:1 diamond tiles, iso buildings (lit top +
two shaded faces), camera pan/zoom travel (tech transplanted from
pixelagents' viewport), minimap with click-to-jump, hover tooltips per
building, fog-of-war at edges = unexplored future work. Why it beats the
skyline: "ever-growing" needs a sprawling map (skylines have fixed frames);
"travel there" = the explorer/ownership feel; districts annex outward
forever. Mock v1 (side-view) kept in mockups/ for the record; v2 (iso) is
the Gate 2 artifact.

## 4c. Living-city layer (user direction, 2026-07-07)

- **Population = activity pulse**: every N completed sessions (rolling week)
  → +1 walking citizen; fork density → dogs/cats accompanying owners;
  all-nighter → lone citizen under streetlamps. Streets read as the pulse.
- **Harbor narrative**: new repo founded = ship arrives with a horn +
  cargo → construction begins at the map edge. Lighthouse blinks for
  past-midnight sessions.
- **Rails/bridges** between districts whose repos co-occur in sessions —
  cross-repo coupling as geography.
- **Soundscape** (opt-in, off by default): turn.end chime, ship horn,
  hourly town-clock chimes, gentle waiting-bell. Milestone fireworks.
- **"The Daily Build"**: daily pixel-newspaper front page (shareable PNG).

## 4d. Content catalog architecture (decided 2026-07-07)

Split: engine + events = LOCAL (nothing outbound, ever — the trust story).
Content catalog = REMOTE: versioned JSON+sprite packs (building types,
citizen/pet skins, ornaments, seasonal events) fetched inbound-only with a
bundled base-pack offline fallback. New types/seasons ship without npm
releases → live-ops/retention for a local-first tool. Integrity: pin
catalog versions + checksum (never executable content — data only).

## 4e. Game decision + community layer (2026-07-07)

**Decided: the game is exposure + joy + the org story** (not income/daily-
tool). Two conditions carved in: (1) instant-history compile — first launch
builds a mature city from existing ~/.claude transcript history (ccusage
precedent); day-1 empty-plot is a rejected design; (2) retention beyond the
novelty window is community-fed, not solo live-ops:

- **Community content packs** (privacy-free): catalog accepts community PRs
  (data-only packs: buildings/citizens/pets/seasons, validated, no code).
  Converts the live-ops burden into community participation.
- **Gallery** (opt-in, hosted): explicit "exhibit my city" export — geometry
  + types + counts only, repo names aliased by default, preview before
  publish. Kudos/browse. The gallery IS the marketing site. Moderation
  burden acknowledged.
- **Seasonal world events** (catalog-pushed): synchronized changes across
  all cities → synchronized share waves (the Wrapped mechanic).
- **Sister cities** (serverless social): exchange a token → embassy building
  in each other's city.

Trust line, verbatim for all materials: "ambient data stays home; you
choose what to exhibit."

## 5. Solo → team dial

Same compiler over merged multi-user streams: solo city (zero infra,
npx-able, the on-ramp) → team districts → org metropolis on the office TV.
Team lane facts (from the pixel-agents sweep, 2026-07-07): incumbent has
NO-signal on multi-user/remote/analytics; their architecture is
single-machine (local pid-file discovery, flat JSON, no time-series); the
durable moat = identity + multi-tenant + analytics + TV product layer, not
the event wire. Naming landmine: they own the term "Agent Teams"
(same-machine subagent viz) — never use it.

- Interop play: contribute a narrow RemoteTransport PR upstream to stay
  compatible/visible in their ecosystem while owning the team product.
- Analytics on the team dial: "agents waited 3.2h on humans today" — the
  measurable, buyable layer (roadmap after fun proves itself).
- Internal pilot candidate: the office TV (pending lead's blessing —
  employer name stays OUT of public docs; lesson applied).

## 6. Milestones (locked until gates pass)

- G0: gates 1-4 (sweeps + mock + metaphor)
- M0: city compiler (events → CityModel) + renderer reusing pixelagents
  canvas engine; solo city from existing local history — "day 94" out of
  the box for existing pixelagents users
- M1: agent-as-architect sidecar (opt-in) + blueprint DSL
- M2: snapshot sharing (PNG export, no accounts)
- M3: team hub (identity, merge, TV mode) — separate go/no-go with
  fresh validation
- Naming: "agentcity" is a WORKING name — full name/npm/domain check
  (similarity included, not just exact-404) before anything public.

## 7. Open questions

- [ ] Compile cost at scale: replaying months of events on open — needs
      snapshot/checkpoint format? (measure first)
- [ ] Multi-machine solo (work laptop + home) before "team"?
- [ ] Does the live layer matter enough in v1, or is pure progression
      stronger (avoid re-competing with pixel-agents on "live")?
- [ ] Blueprint DSL scope: how constrained is constrained enough?
