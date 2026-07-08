# Game Rules — agentcity v1 (draft for the rules-playground demo)

> The contract both the demo and the real compiler implement. Deterministic:
> same events + same seed → same city. Different seed → structurally
> different city (Rule 6).

## 1. Currency: Work Units (WU)

Events convert to WU (the only way anything gets built):

| Event | WU |
|---|---|
| tool.pre+post pair (real tool call) | 1 |
| turn.end (completed turn) | 5 |
| fork.start (subagent) | 3 |
| session.start (new session) | 2 |
| first-ever event in a repo | 25 (founding bonus — the ship arrives) |

**Pacing caps (anti-spam + good speed):**
- Per-repo daily cap: 120 WU/day counts toward building (excess spills into
  a small "warehouse" buffer, max 60, spent on the next quiet day — smooths
  weekends).
- Global daily cap: 400 WU/day.
- Result: a heavy day ≈ one visible upgrade + street life; a normal week ≈
  clear, satisfying growth. Nothing crawls, nothing explodes.

## 2. History import (first launch)

- Reads existing local history (Claude transcripts / pixelagents events).
- Same WU rules apply BUT compressed through the caps at replay speed —
  rendered as the **Founding Timelapse**: the user watches ~60-90 seconds of
  their city building itself from the first hut. This is the wow moment.
- History cap: import may build a city to at most **Tier 4** structures
  (mature town). Tier 5 landmarks are live-only — there must be room to
  grow after day one.

## 3. Structure progression (per repo = one building lot)

| Tier | Form | Cumulative WU |
|---|---|---|
| 0 | survey stake → tent | first event |
| 1 | hut | 25 |
| 2 | house | 90 |
| 3 | workshop / 3-story | 250 |
| 4 | tower / district-styled mid-rise | 700 |
| 5 | landmark (spire/dome/HQ — live-only) | 1,800 |

- Upgrades show scaffolding + crane for a visible construction period
  (min 30s live / 2s in timelapse) — growth must be *witnessed*.
- District style (which sprite family the tiers use) = repo's dominant work
  category: code→residential, tests→glass, infra→industrial, api→harbor,
  research→library, web→observatory, planning→civic.
- Mixed repos: primary category styles the building; secondary adds an
  ornament (e.g., code+tests → residential with glass atrium).

## 4. Population & street life

- Citizens: 1 per 150 WU in the rolling 7 days (cap 24 visible). Quiet week
  → streets empty out (the city breathes with you).
- Pets: 1 dog/cat per 8 forks in rolling 7 days (cap 6), each attached to a
  citizen.
- All-nighter (session activity 00:00–05:00 local): one lone citizen under
  a streetlamp for the next day.
- Ships: arrive on repo founding + one scheduled cargo ship per 500 global
  WU (harbor bustle scales with output).

## 5. Placement & map growth ("where to build what")

- Map = chunked iso grid (24x24 tile chunks). Start: 2x2 chunks, rest fog.
- **Origin** = seed-determined (Rule 6), NOT center — cities grow
  asymmetrically like real ones.
- District affinity: new lots prefer adjacency to same-category lots
  (clusters emerge), with jitter so clusters are organic, never grids.
- Harbor rule: api-category lots must touch water; if the biome has no
  water edge nearby, a river inlet is carved when the first api repo lands.
- Roads: auto-pathed from new lot to nearest road (A* on tiles), giving
  organic street patterns.
- Rails: laid between two lots when their repos co-occur in sessions
  (coupling made visible).
- **Expansion (amended 2026-07-09, user decision)**: the FULL terrain is
  generated and visible from day 0 — geography before buildings (fog-of-war
  removed; it hid the biome and rendered as void). Terrain = f(seed) only,
  permanent per user (seed pinned at founding). "Wild vs settled": unbuilt
  land renders desaturated with wild details; approaching city tames tiles.
  Former chunk-reveals become "district surveyed" log moments; survey stakes
  still foreshadow growth direction.

### 5b. Spacing & streets (amended 2026-07-08, dogfood feedback)

- No two lots on orthogonally-adjacent tiles: every building keeps a 1-tile
  clear ring (road or ground, never another lot).
- Streets first: a new lot must front a road tile; the network extends to
  reach it before the building rises.
- Blocks stay small: max ~2x2 lot clusters before a street cuts through.
- Road hierarchy: lane (dirt, 1 tile) -> street (cobble) -> paved -> AVENUE
  (top usage tier, 2 tiles wide). Busy corridors literally widen.

### 5c. Construction staging (renderer)

Never roof-first: dirt+stakes -> foundation -> scaffold + walls rising floor
by floor -> roof LAST -> scaffold off. Upgrades: scaffold wraps, new floor
rises, roof lifts back. Timelapse compresses stages; live plays them.

## 6. Uniqueness (no two cities alike)

Seed = hash(machine-id + user) determines:
- **Biome**: coastal / river / lakes / hills (affects water, elevation)
- Origin quadrant + growth direction bias
- Palette accent family + roof/material variants
- Road style (cobble/asphalt/dirt-first)
Plus per-building variation: width/roof/window pattern hashed from repo
name. Two users with identical work histories still get visibly different
cities. (Agent-authored blueprints, v2, multiply this further.)

## 7. Atmosphere

- **Day/night**: follows the user's real local clock (dawn/dusk tints).
- **Weather**: procedural, seeded by date + biome — clear/rain/fog/snow
  cycles with seasonal weighting (northern-hemisphere default; real
  geolocation optional opt-in later, never required).
- Decay: 30 days repo silence → dark windows, vines; 90 days → cracks;
  any new WU → renovation scaffolding, restored next tier-check.
- Milestones: fireworks (1,000th turn), statue (100th fork), fountain
  (10th repo), plaque on Old Town (city founding date).

## 8. Determinism invariant

city(t) = f(events ≤ t, seed). No hidden state, no RNG at render time
(all randomness derives from seed + event content). Replayable, auditable,
cheat-resistant.
