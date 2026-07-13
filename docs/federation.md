# Federation (optional)

agentcity is local-first by default (`AGENTS.md` rule 3: *"Local-first, nothing outbound.
Ever."*). Federation is an **opt-in** mode where a local server also feeds a central hub
that correlates projects across users and renders everyone's work in one shared 2D scene.
It is **off unless explicitly enabled** and is the project's first sanctioned outbound path.

## One pipeline, one stream

Local and central render through the **same** pipeline. Raw `PixelEvent`s are turned into a
privacy-safe **gamified event stream** by `gamify()`; that stream is folded into a city by
`renderCity()`. The only difference between local and central is the breadth of the stream —
one contributor vs. all of them.

```
PixelEvents ──gamify()──▶ GamifiedEvent[] ──renderCity()──▶ { model, deltas }
                (firewall)     (the wire)      (the one pipeline)
```

- **Local server** folds its own stream and, when federating, forwards it to the hub.
- **Hub** merges every contributor's stream and folds the union — same `renderCity`.

## The firewall

The hub **never receives raw `PixelEvent`s** — those carry file paths, command first-lines,
and `cwd`. `gamify()` is the privacy boundary: its output carries only **aggregate gamified
facts** per (project, day) — work-units, forks, turns, an all-nighter flag, a category, and
opaque hashed session ids. Never a path, command, or environment value.

The only new identifier that can leave the machine is a project's **git remote in clear**
(e.g. `github.com/acme/foo`), resolved locally at ingest. Repos with no remote send an opaque
**hash** instead; local paths never leave the machine.

## Identity & tile policy (`src/gamified/types.ts`)

`gamify()` resolves each workspace (via `src/gamified/identity.ts`, which asks git) to a
`ProjectId` with a tile-sharing policy:

```ts
type ProjectId =
  | { kind: "git";   remote: string }   // SHARED building — merges across users by remote
  | { kind: "repo";  token: string }    // per-user BUILDING — a git repo with no remote
  | { kind: "local"; token: string }    // per-user TREEHOUSE — not a git repo
```

`tileId(proj, by)` decides what merges: git → `g:remote` (shared), repo/local →
`r|u:by:token` (per-user, never merged across contributors). `isTreehouse` is true only for
`local`. So the same repo worked by many users becomes one building; a private repo stays a
per-user building; a scratch workspace is a per-user treehouse.

## Wire contract (`src/gamified/types.ts`)

```ts
interface GamifiedEvent {
  v: 1; proj: ProjectId; name: string; by: string; day: number; ts: string;
  wu: number; forks: number; turns: number; allnighter: boolean;
  category: Category; sessions: string[]; founding: boolean;
}
interface GamifiedBatch { v: 1; handle: string; events: GamifiedEvent[] }  // POST /ingest body
```

`coerce()` / `coerceBatch()` validate the wire at runtime with **zero deps**. Facts are
keyed by `(project, contributor, day)` (`factKey`); a re-sent open day **upserts** (gamify
re-aggregates a growing day to a higher WU — last wins), so at-least-once delivery and
out-of-order arrival are idempotent. No double-counting.

## Reconciliation (`src/gamified/city.ts`)

`GamifiedCity` is shared by local and central. It holds the folded model + delta timeline and
reconciles new facts against the current one:

- **APPEND** (the default — established activity): when the recomputed timeline still has the
  old one as a prefix, only the new tail deltas are broadcast (`server.update`).
- **REFOLD** (a client first joins with a historic backlog, or a shared tile gains a
  contributor on an already-folded day): a past day changed, so the whole timeline is
  broadcast as one `reset` (`server.replace`) the renderer replays.

Because the fold is pure (`city(day D) = f(facts ≤ D, seed)`), a late joiner's backlog lands
in correct chronological position — time-travel by determinism, not mutation. `cityAt(day)`
folds only facts up to that shared-calendar day.

## Client (`--federate <url>`)

The local server already produces the gamified stream, so federating just **forwards** it
(`src/federate.ts`): each poll it POSTs a `GamifiedBatch` of facts on days ≥ a persisted
`maxDay` watermark (so the still-open day is re-sent; the hub upserts). The watermark advances
**only on a successful POST** — a failed/dropped push retries next poll. Tolerant of the hub
being down; never crashes the loop. No projection, no delta wire, no ref resolver — identity
was already resolved in `gamify()`.

Config (`~/.agentcity/config.json`, additive/optional):
```json
{ "federation": { "role": "client", "centralUrl": "http://hub:4243", "handle": "alice" } }
```
`--federate <url>` overrides `centralUrl`. Absent handle → an anonymous `anon-<hash>`. The
watermark persists to `~/.agentcity/federation.json`.

## Hub (`--central`)

`agentcity --central [--rules FILE] [--host H] [--port N] [--seed S]` (`src/gamified/hub.ts`)
merges all contributors' streams into one shared city:
- **Store** (`src/gamified/store.ts`): `FileGamifiedStore` is an append-only JSONL log of
  every accepted fact (rule 4: archive, never prune), upserted by `factKey` and loaded on
  startup so a restart resumes all history.
- **Mapping** (`src/federation/mapping.ts`): optional ordered regex `rules.json` aliases git
  remotes to one canonical project (a fork/mirror/monorepo → one building). Rules load from
  `--rules` or `<root>/federation-rules.json`:
  `[{ "pattern": "github\\.com/acme/", "project": "acme-mono" }]`.
- **Merge:** git tiles sum contributors' (already per-user capped) WU; attribution lists every
  contributor. Rails link projects worked in a shared session. Uniform placement — per-user
  tiles are an identity concept, never a spatial one.
- **Bounded world:** the 60×60 grid; projects that don't fit are **reported**
  (`hub.dropped()` / a `--central` warning), never silently dropped.

### HTTP surface (hub)
- `POST /ingest` — a `GamifiedBatch`; validated, upserted, reconciled. `202 {accepted}`.
- `GET /events` — SSE; each ingest pushes the append tail, or a `reset` on a refold.
- `GET /city[?day=N]` — the shared model now, or time-travelled to day N.
- `GET /` — the renderer.

## Renderer (shared scene)

The renderer is delta-driven: it replays the timeline (initial bundle + live SSE deltas),
folding to the head in live view. A `reset` replaces the timeline and re-folds. git buildings
show their contributors in the tooltip; per-user treehouses render distinctly. Local and
central use the identical renderer — only the breadth of the stream differs.

Before extending, run the `AGENTS.md` rule-1 validation sweep (new-concept gate).
