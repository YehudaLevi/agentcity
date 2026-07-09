# agentcity

> **Your work builds a city. Your agent is the architect.**

A persistent pixel-art city that grows out of your AI-coding-agent activity — entirely on your machine. Every repo you work on becomes a building. Shipped work adds floors. The *kind* of work you do shapes the districts. Neglect a project and vines creep up its walls. Come back and the scaffolding goes up again.

It's not a dashboard. It's a place.

![90 days of work growing into a city — demo data](https://raw.githubusercontent.com/YehudaLevi/agentcity/main/media/city-growth.gif)

*90 days of (demo) work, replayed as the Founding Timelapse: first huts, streets, districts, towers — and a hover card for any building.*

![agentcity — a river city at day](https://raw.githubusercontent.com/YehudaLevi/agentcity/main/media/city-day.png)

## What you're looking at

| On the map | In your work |
|---|---|
| A building | A repository |
| Floors & tiers (tent → hut → house → workshop → tower → landmark) | Accumulated shipped work |
| District style — residential, glass, industrial, harbor, library, observatory, civic | Your work mix: code, tests, infra, APIs, research, web, planning |
| Roads widening from dirt lane to avenue | How often you travel between projects |
| Rails between buildings | Repos that ship together |
| A ship arriving with a horn | You founded a new repo |
| Citizens in the streets, pets trailing them | Your recent activity pulse |
| Vines, then cracks | 30, then 90 days of silence |
| Sheep in the meadows | Sheep in the meadows 🐑 |

And when your agent is working **right now**, a beam of light rises from that building into the sky — gold for editing, orange for shell work, cyan for reading, violet for the web, green for subagents. A completed task pops a small firework at the beam's top. When the agent is blocked waiting on *you*, the beam turns black-and-white and blinks slowly. You can read your whole fleet's status from across the room.

![agentcity at night — sky beams over the city](https://raw.githubusercontent.com/YehudaLevi/agentcity/main/media/city-night.png)

## The invariant

```
city = f(your event history, seed)
```

The city is a **pure, deterministic compile** of your local agent event log. No save state to corrupt, nothing to cheat (daily caps and diminishing returns are built into the economy — spam builds nothing). Delete the app, reinstall, recompile: same city. Your history *is* the save file.

Your seed decides the geography — river, coast, lakes, or hills — plus where the first stone is laid, the palette, and the road style. Same work, different seed, visibly different city. No two are alike.

## First launch is not an empty field

agentcity reads your **existing** local agent history at founding and replays it as a 60–90 second **Founding Timelapse**: you watch your city build itself from the first hut to today. If you've been working with coding agents for months, you start with a mature town, not a survey stake.

## Local-first, nothing outbound

- Everything is compiled and rendered **locally**. No accounts, no telemetry, no network calls.
- Your event data lives in your home directory and is **archived, never pruned** — the city stays re-derivable forever.
- Anything that ever leaves your machine (like exporting a snapshot PNG) is an explicit action you take.

## Quick start

```bash
npx agentcity            # founds your city from local history → http://127.0.0.1:4243
```

No agent history yet? Take it for a spin with simulated activity:

```bash
npx agentcity --demo
```

Recompile the city from your archives (e.g. to try a different geography):

```bash
npx agentcity refound --yes --seed <any-string>
```

Or from source:

```bash
git clone https://github.com/YehudaLevi/agentcity.git
cd agentcity && npm install && npm run build
node bin/agentcity.js
```

## Around the map

- **Pan / zoom / rotate** — full isometric camera, minimap with click-to-jump
- **Live ↔ Timelapse** — scrub through your city's entire history, day by day
- **Day/night** follows your real clock (override with brightness modes: always day, dusk, bright night)
- **Weather** — seeded rain, fog, and snow with the seasons
- **Hover any building** for its repo, tier, work mix, and last-active day

## Under the hood

- TypeScript, Node 20+, **zero runtime dependencies**
- The entire renderer is one self-contained `web/city.html` — canvas and programmatic pixel art, no build step, no frameworks
- Deterministic compiler with golden-model and property tests (`npm test`)
- Rules of the world: [`docs/game-rules.md`](docs/game-rules.md) · module layout & data contracts: [`docs/architecture.md`](docs/architecture.md)

## Status

Early and moving fast. The solo city is live and dogfooded daily; agent-authored building blueprints, shareable city cards, and a team mode (your whole org's skyline on the office TV) are on the roadmap.

---

*Your work builds the map · your agent is the architect · local-first*
