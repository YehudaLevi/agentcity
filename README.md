# agentcity (working name)

> **Your work builds a city. Your agent is the architect.**
>
> A persistent pixel-art city that grows from your AI-coding-agent activity.
> Buildings are repos. Floors are shipped work. Districts reveal *how* you
> work. Your agent designs the architecture. Neglect shows as decay.
> Solo: your city. Team: the org's skyline on the office TV.

## ⛔ Status: VALIDATION PHASE — no product code yet

This project is gated behind the validation discipline learned the hard way
(see `docs/plan.md` §1). Code starts only when all gates pass:

- [x] **Gate 1 — incumbent sweep**: PASSED 2026-07-07 with conditions.
      Verdict: PARTIALLY OCCUPIED, our combo OPEN. Named neighbors: Git City
      (5.7k*, GitHub-activity pixel city, monetized), pixel-agents (73k
      installs, ephemeral), AgentPet, AI Town (one-off). Agent-authored
      architecture: nobody. Conditions: positioning must name Git City;
      re-verify neighbor changelogs before build. Full report: docs/sweep-2026-07-07.md
- [x] **Gate 2 — the mock feels right**: PASSED 2026-07-07 ("go green" —
      user, after mock v3, the living isometric city). Game rules drafted:
      docs/game-rules.md.
- [ ] **Gate 3 — metaphor check**: city vs garden decided on evidence
      (scale + taxonomy legibility currently favor city; see plan §4).
- [x] **Gate 4 — team-lane**: PASSED 2026-07-07 with conditions. Lane OPEN;
      "waiting on human" as a team metric exists NOWHERE. Sharks named on
      the serious end (claude-view, Devin Desktop, Anthropic native — real
      platform risk); fun-first team surface untouched. Re-verify before M3.
      Full report: docs/sweep-gate4-team-lane.md

## The one-paragraph pitch

Dashboards show numbers; pixel-agents shows *now*; git shows commits. Nothing
shows the accumulated shape of your work with your agents — something you can
read at a glance, feel proud of, and put on a TV. agentcity compiles your
agent event history (already captured by pixelagents' emitter) into a living
city: legible like a chart, felt like a place, unique like a fingerprint —
because your agent authors the architecture, your city can't be anyone
else's.

## Relationship to prior work

- **pixelagents** (`~/github/pixelagents`): the event pipeline (hooks →
  events.jsonl) and pixel canvas engine are reused here. pixelagents remains
  a parked live-floor tool.
- **pixel-agents (pablodelucca, 8.5k★)**: live single-machine floor — no
  persistence, no history, no analytics. agentcity is a different altitude:
  the *save file*, not the window. We stay interoperable, never adversarial.

## Docs

- `docs/plan.md` — concept, mechanics, taxonomy→city mapping, gates, milestones
- `mockups/` — pitch mocks (the artifact that decides Gate 2)
