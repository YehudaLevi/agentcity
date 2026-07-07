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

- [ ] **Gate 1 — incumbent sweep**: who is closest to "agent-activity builds
      a persistent city"? (CodeCity/gource/Skyline family, gamified dev tools,
      agent-world products). *In progress.*
- [ ] **Gate 2 — the mock feels right**: a static "3 months in" city frame
      must produce the "I want mine" reaction in <5 seconds. *In progress —
      see `mockups/`.*
- [ ] **Gate 3 — metaphor check**: city vs garden decided on evidence
      (scale + taxonomy legibility currently favor city; see plan §4).
- [ ] **Gate 4 — team-lane confirmation**: broader team-observability sweep
      (Anthropic native, AgentOps et al.) returns open. *In progress.*

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
