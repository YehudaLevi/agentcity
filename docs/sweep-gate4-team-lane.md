# Gate 4 Sweep — Team Agent-Observability Lane (2026-07-07)

Verdict: **PARTIALLY OCCUPIED — lane OPEN.** Nobody combines: live +
cross-machine multi-user + coding-agent-specific + waiting-on-human TEAM
analytics + self-hosted/LAN-first — let alone fun-first.
"Waiting on human" as a first-class team metric appears NOWHERE (clearest
open differentiator).

## Closest occupants (each holds one edge)
1. **claude-view** (claudeview.ai) — "Mission Control for AI coding agents",
   Team tier $30/user/mo, cloud SaaS, shipping weekly. Owns the serious
   team-dashboard positioning. No waiting metric found.
2. **disler/claude-code-hooks-multi-agent-observability** (1.5k★) — our
   exact architecture (hooks→HTTP→SQLite→WS dashboard), framed single-dev.
   The fork base anyone building this would start from.
3. **Devin Desktop "Agent Command Center"** (Cognition, $26B valuation) —
   per-developer fleet Kanban; "team fleet" framing means they could ship
   the team view any quarter. Biggest funded threat.
4. **Anthropic native** — batch team analytics dashboard (daily, no idle
   metric), OTel export incl. permission-wait spans (the substrate,
   dashboards left to third parties), Agent View preview (single-user).
   Platform risk is REAL (Terragon shut down Feb 2026 citing provider
   UX cannibalization).
5. Factory.ai analytics ($1.5B) — historical/aggregate, not live.
6. matt454/agent-fleet-console (14★) — exact multi-machine LAN idea, tiny.
7. Pixel-Process-UG/agent-office (25★) — "pixel office for agent teams";
   UNVERIFIED whether multi-human; code-level check required before build.
8. mission-control (5.6k★), Claude-Code-Agent-Monitor (773★ — best
   "waiting" Kanban UX, single-machine), agent-of-empires (2.8k★),
   Conductor (no team features yet, collaboration planned).

## Strategic read
The SERIOUS end is where the funded sharks swim (claude-view, Devin,
Factory, Anthropic native). The FUN-first team surface (org city on a TV,
waiting-time as a game mechanic) is untouched — our defensible angle is the
one we already chose. Do not build a claude-view competitor.

## Conditions / unknowns
- Re-verify before M3 (team milestone): claude-view team internals,
  Pixel-Process agent-office, Devin Desktop team features.
- Social demand-signal sweep incomplete — no data either way on organic
  "team visibility" demand. Gather during org pilot instead.
