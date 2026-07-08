# agentcity (working name)

> **Your work builds a city. Your agent is the architect.**
>
> A persistent pixel-art city that grows from your AI-coding-agent activity.
> Buildings are repos. Floors are shipped work. Districts reveal *how* you
> work. Your agent designs the architecture. Neglect shows as decay.
> Solo: your city. Team: the org's skyline on the office TV.

## Status: M0 SHIPPED — dogfood week (updated 2026-07-08)

All four validation gates passed (evidence in docs/sweep-*.md). M0 built,
integrated, and running on the founder's real data: compiler (history +
live events -> deterministic city), renderer (live view + founding
timelapse), server + npx CLI, presence layer (birds/SSE). ~20 commits,
64 engine tests. Two days of real-data dogfooding produced and fixed: day
runaway, worktree phantoms, lot spacing/streets, construction staging,
fidelity wave, UI drawers/log, full-reveal terrain, seed override.

**Read next: [docs/gaps.md](docs/gaps.md)** — honest punch list + the
`wip/rotation-fix` branch warning + operational lessons (STALE dist/!).

Run: `npm run build && node bin/agentcity.js` (server :4243).
Refound (recompiles city from archives): `node bin/agentcity.js refound --yes [--seed s]`.

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
