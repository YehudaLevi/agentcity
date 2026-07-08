# AGENTS.md — agentcity

Persistent pixel city compiled from AI-coding-agent activity. Concept, rules
and evidence: `docs/plan.md`, `docs/game-rules.md` (THE rules contract),
`docs/architecture.md` (module layout + data contracts), `docs/sweep-*.md`.
Approved visuals: `mockups/agentcity-rules.html` (engine), `-iso-v3` (art),
`-cards` (share flow).

## Delegation policy (IMPORTANT)

Main session = tech lead, not implementer. Building is delegated (Opus for
engine/visual work, Sonnet for mechanical tasks); the supervisor personally
does: contracts/specs, diff review, running tests, integration, docs, git.
Trivial edits (<~20 lines) done directly. Parallel agents own disjoint
paths; `package.json` has ONE owner per wave.

## Hard rules (learned the expensive way — do not relax)

1. **Validation before code**: any NEW concept/pivot gets a "who is closest"
   sweep (GitHub/npm/marketplaces by CONCEPT) before building. Gates and
   evidence live in README + docs/.
2. **Determinism invariant**: `city(t) = f(events ≤ t, seed)`. No
   `Date.now()`/`Math.random()` inside the compiler — time comes from
   events, randomness derives from seed + content hashes. Golden tests
   enforce byte-identical CityModels.
3. **Local-first, nothing outbound.** Ever. Content catalog (later) is
   inbound-only. Exports are explicit user actions.
4. **Archive, never prune** agentcity data (`~/.agentcity/`); city must be
   re-derivable from archives forever.
5. Tests: vitest, fixtures, injectable paths/clock/seed — never touch real
   `~/.claude`, `~/.pixelagents`, `~/.agentcity`, never the network.
6. Zero runtime dependencies (node built-ins only); dist-first bin launcher
   (copy the proven pixelagents pattern INCLUDING its fixes: tsc prepack,
   dist-first shim, 127.0.0.1 bind, settings-file safety, --port
   validation, plain-JS hot paths).
7. Dry-run/test data physically separated from real data dirs.
8. **STALE dist/**: the launcher prefers compiled code — ALWAYS `npm run
   build` before refound/serve after engine changes (a stale dist/ silently
   ran old rules for a full day once).
9. Agents editing web/city.html work on a COPY and swap at the end — the
   local server serves from disk, so the user watches mid-surgery WIP live.
10. Timebox background agents: silent >20-30 min => nudge, then verify
    their on-disk state yourself, then kill. Never let one ride for an hour.
11. The user's live data dirs (~/.agentcity, ~/.pixelagents, ~/.claude) are
    read-only for agents; refounds happen only after supervisor review.

## Commands

```bash
npm test               # vitest, no network/home dirs
npm run typecheck
npm run compile -- --history <fixture-dir> --seed test1 --out /tmp/city.json
npm run dev            # server on :4243 against fixture data
npx . --demo           # simulated city (uses demo event generator)
```

## Conventions

TypeScript strict ESM Node 20+. Frontend = ONE self-contained web/city.html
(programmatic pixel art, no build step). Event schema is shared with
pixelagents (`PixelEvent`) — never fork it silently.
