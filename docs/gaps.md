# Gaps & Known Issues — agentcity (handoff, 2026-07-08)

> The honest punch list. A fresh agent session should read README → AGENTS.md
> → this file, in that order. State of the world: M0 shipped and dogfooded
> for two days by the founder on real data; every item below came from that
> dogfooding or from killed/incomplete work.

## 0. Where things stand

- `main` = last verified-good state (all committed work tested; 68 engine
  tests green as of the 2026-07-09 full-reveal contract fix, see §2). The user's live city: seed `riviera`, river biome, day ~7,
  16 lots, 0 phantoms, all 36 chunks revealed. Server: `node
  bin/agentcity.js` on :4243; user runs it locally.
- Branch **`wip/rotation-fix`** = 182-line UNVERIFIED renderer surgery from
  a killed 68-minute agent run (see §1). Do not merge blind.
- CRITICAL OPERATIONAL LESSON: **rebuild `dist/` (`npm run build`) before
  any refound/serve after engine changes** — the launcher prefers stale
  compiled code and silently runs old rules (cost us a full day of "the fix
  didn't work"). Consider auto-rebuild-if-stale in the launcher (see §8).

## 1. Rotation is broken at rot≠0 (P0, WIP branch exists)

Rotating renders hollow buildings (missing faces, detached roofs), ground
holes, floating props. `wip/rotation-fix` claims a view-space refactor with
selftests green (fixture/t1/hills incl. 50-random-tile no-black sampling)
but was killed before screenshot review; a BLACK-GRASS regression was
observed live mid-flight and never re-checked. ALSO ON THAT BRANCH: rail art
(pipe→railway with ties/level crossings) and tent hover fix (min pick area =
full tile). NEXT AGENT: verify the branch against a REAL river bundle
(compile with --history ~/.claude/projects --pixelagents ~/.pixelagents
--seed riviera, read-only), day AND night, all 4 rotations, grass fully
painted, then merge or salvage. Riviera bundle also exposed
`foldEqualsModel:false` on real data — an ENGINE replay-equality seam on
real histories (synthetic bundles pass); investigate separately (§2).

## 2. Engine: replay-equality seam on REAL data — FIXED 2026-07-09

Root cause was a full-reveal contract divergence: the engine repurposed
chunk.reveal deltas to "district surveyed" moments (only ~8 chunks ever get
one) while the renderer's fold() still treated them as map existence — so
delta-replay rebuilt 8/36 chunks vs the model's 36 (foldEqualsModel:false),
and live view painted 28 chunks as black fog (the "not fully revealed"
dogfood report). A second bug compounded it: finalize snapshots the
checkpoint BEFORE folding the open day, so the open day's survey re-emitted
its chunk.reveal on EVERY server poll (52 dupes in one day on the live log).
Fixed in the same wave: renderer fold() treats all chunks as revealed from
day 0 (fog paint removed, stakes re-keyed to unsurveyed-adjacent, minimap
paints full terrain, selftest gained full-reveal checks); engine defers
open-day chunk.reveal emission until the day commits (foldingOpenDay flag,
emit-at-most-once guaranteed, 4 regression tests). Verified: 68 tests green
+ headless ?selftest PASS (incl. foldEqualsModel:true) on a fresh read-only
riviera compile from real history. NOTE: the user's live deltas.jsonl still
contains the ~51 historical duplicate reveals (harmless: dedup'd by
renderer; shows dup "district surveyed" log lines) — a refound cleans it.

ALSO FIXED (same day): **black grass on MAIN** — grass tiles painted
rgb(0,0,0) because drawTile used shade(mix(...)) while shade() parsed only
"#hex" and mix() returns "rgb()" (NaN>>16 → 0). The sky gradient's nested
mix(mix()) had the same bug (near-black sky bottom even at noon). The
"BLACK-GRASS regression" §1 pins on the WIP branch was actually this,
on main, since the fidelity wave. Fixed via a cnum() parser accepting both
formats; selftest gained a grassColorLive guard. Verified by headless
screenshot on the real riviera bundle (grass green, full geography, day).
WARNING for the §1 WIP verification: wip/rotation-fix's city.html surgery
predates today's fold/reveal/shade changes — expect merge conflicts;
rebase/salvage rather than merge blind.

## 3. Renderer polish queue (P1, single wave, work on a COPY of
web/city.html — see §8 process note)

- **City Guide modal** (user request): 📖 button in drawer → full-page modal
  explaining rules/elements, illustrated by live sprite canvases. Sections
  spec'd in plan §(conversation 2026-07-08): how it grows / building ladder
  / districts / signs of life / roads+rails / decay / sky / controls.
- **Night terrain readability**: wild ground at night renders near-black
  (user: "not all terrain exposed" — it was darkness, then a real grass
  regression on the WIP). Moonlit ambient for terrain; city stays the
  bright heart.
- **World-edge treatment**: map is a finite diamond; edges currently fade
  to void and read as "hidden". Make the world END visibly (cliff/ocean rim).
- **Wild-vs-settled tint**: full-reveal landed in engine; renderer should
  desaturate far/unbuilt land and "tame" tiles near the city (plan §5 amend).
- Minor: skylight cube loud at high zoom; WU-bar denominator stale after
  live growth (fidelity agent note).

## 4. Engine queue (P2)

- **Secondary-category regression** (from the federation review): the gamified
  pipeline carries a SINGLE `category` per (project, day) — `GamifiedEvent` has
  no secondary field, and `renderCity` sets `secondary: null` for every activity
  (`src/compiler.ts`). The old raw-event pipeline surfaced a secondary category
  ("code+tests" atriums in the renderer); that signal is currently LOST end to
  end. The renderer/tooltip still reads `o.secondary` but never receives one.
  Restoring it means threading a secondary category through gamify → the wire →
  renderCity. Future work — NOT fixed in the review wave.
- **Repo ignore-list**: config.json `ignore:[...]` + default junk list
  (bash-*, docker, k8s, home-dir names). User has junk-dir tents on the map.
- **Every biome gets water**: hills got a dry map (user wanted water; solved
  via seed change for now). Rule: hills → mountain lake, etc.
- **Transport layer** (plan §4g): cars on session.start, bikes for short
  sessions, delivery trucks on installs, trams on rails — designed, not built.

## 5. pixelagents repo (SEPARATE repo, P1 data-loss)

`~/github/pixelagents` rotation PRUNES events >7 days. If the agentcity
server doesn't run for a week, un-archived history is lost forever. Fix:
archive instead of delete (or agentcity-compatible handoff). pixelagents is
public (github.com/YehudaLevi/pixelagents) — keep its zero-dep promises.

## 6. Product roadmap (parked, in order)

M1 agent-as-architect (blueprint DSL, opt-in sidecar) · M2 shareable cards/
Album (mock approved: mockups/agentcity-cards.html) · M3 team/Arena (fresh
validation gate first — see docs/sweep-gate4-team-lane.md sharks). Before
ANYTHING public: full naming sweep for "agentcity" (npm SIMILARITY incl.
hyphens — pixelagents lesson — plus domain, marketplace, GitHub concept).

## 7. Open UX threads from dogfooding (small, unprioritized)

- Seed browsing UX ("try other geographies"): refound --seed works (override
  now beats config); maybe a preview command listing biomes for N seeds.
- Population 0 on quiet weeks reads as "broken" to the user — consider a
  minimum-liveliness floor or an explainer in the Guide.
- Font sizes were bumped 20% once; revisit after Guide ships.

## 8. Process notes for the next supervisor session

- Agents editing web/city.html MUST work on a copy and swap at the end —
  the local server serves from disk, so users watch mid-surgery WIP live.
- Timebox renderer agents (~30 min heartbeat rule): the rotation agent ran
  68 min silent and was killed at the finish line. Nudge → verify-yourself
  → kill, in that order, earlier.
- dist/ staleness (see §0). Candidate fix: launcher compares mtimes
  (src vs dist) and warns/rebuilds.
- The user's live data dirs are sacred: ~/.agentcity, ~/.pixelagents,
  ~/.claude — agents get read-only access, refounds only by supervisor
  after review.
