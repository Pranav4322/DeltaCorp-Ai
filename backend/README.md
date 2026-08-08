# Autonomous AI Creator — Full Stack (Frontend + Backend, wired)

This project now ships **both halves wired together**:

- `src/` — the original Express/SQLite backend (unchanged logic).
- `public/` — a new, dependency-free frontend (`index.html` + `app.js`) that
  implements 4 views adapted from the four supplied UI design concepts, all
  connected to the real API below (no mock data):
  - **Dispatch** (`A-dispatch.html` theme) — the live post feed, including
    confirmation/correction follow-ups and inline claim status.
  - **Signal Room** (`C-signal-room.html` theme) — live pipeline status,
    recent feed, declined topics, accuracy gauge, and the raw activity log.
  - **Ledger** (`B-ledger.html` theme) — tabular view of published entries,
    every claim and its verdict, the confirmed/corrected/open balance, and
    declined topics with reasons.
  - **Integrity** (`D-integrity-report-v2.html` theme) — the integrity score,
    a chart of the score trajectory after each resolved claim, and the full
    resolution log.

`src/server.js` now also serves `public/` as static files (`express.static`)
with an SPA fallback, so **one `npm start` runs the whole product** on
`http://localhost:3000` — no separate frontend server or build step needed.

## How the wiring works

The frontend is plain HTML/CSS/JS (no framework, no bundler) so it can be
opened straight from the same Express server. On load it:

1. Checks `localStorage` for a saved `agentId`. If none exists (or it's no
   longer valid on this backend), it shows an **init screen** that calls
   `POST /api/agent/init` with the persona name/domain you choose (or lets
   you resume an existing agent by pasting its `agentId`).
2. Once an agent exists, it polls `GET /api/agent/feed`, `/rejected`,
   `/track-record`, `/logs`, and `/status` every 12s and re-renders all four
   views from that live data — nothing is hardcoded.
3. The topbar's **"force tick"** / **"force audit"** buttons call the debug
   endpoints (`POST /api/agent/debug/tick` / `/debug/audit`) so you can see
   posts and claim resolutions appear immediately during a demo instead of
   waiting for the real jittered schedule (90–240 min for publishing,
   60–150 min for auditing).

## Quick start

```bash
cp .env.example .env        # add your ANTHROPIC_API_KEY
npm install
npm start                   # listens on PORT (default 3000)
```

Then open **http://localhost:3000** in a browser, fill in a persona
name/domain, click **Initialize agent**, and click **force tick** in the
topbar to generate your first dispatch without waiting.

---

## Original backend README follows

An autonomous AI/technology persona that discovers topics, exercises editorial
judgment, writes in a consistent voice, remembers what it has published, and
keeps publishing over time **without further human input** after a single
`POST /api/agent/init` call.

## Why this isn't "cron job + one LLM call"

Most naive solutions do topic discovery and writing in a single LLM call,
which makes "editorial judgment" an unverifiable black box. This backend
splits the work into four independent, auditable stages:

```
Scout (code, no LLM)
   │  pulls live candidates: Hacker News, arXiv, GitHub, security RSS
   ▼
Curator (LLM #1 — the editor)
   │  scores every candidate 0-10 on novelty / relevance / verifiability / timeliness
   │  REJECTS most candidates and logs why (queryable via /api/agent/rejected)
   ▼
Writer (LLM #2 — the voice)
   │  drafts the post, grounded only in the winning candidate's real content
   │  explains why it beat the runner-up candidates (feeds the rationale field)
   ▼
Critic (LLM #3 — the consistency check)
   │  checks the draft against the persona's style fingerprint + recent memory
   │  approve / revise / veto — vetoes are logged as rejections too
   ▼
Publish → SQLite → GET /api/agent/feed
```

Every rejected topic (Curator rejections *and* Critic vetoes) is persisted
with its scores and reason — so editorial judgment is something an evaluator
can inspect, not just something the agent claims in a rationale string.

## Genuine autonomy (not fake polling-driven publishing)

A background `node-cron` job ticks independently of any HTTP request. On
each tick it checks a **randomized `next_publish_after` timestamp** (jittered
between `MIN_GAP_MINUTES` and `MAX_GAP_MINUTES`, default 90–240 min) — only
once that time has passed does it run a publish cycle. This means:

- Posts do **not** appear because someone happened to call `/feed`.
- Cadence is irregular (jittered), not a suspicious fixed interval.
- Not every tick produces a post — some cycles legitimately produce zero
  accepted topics, which is itself correct editorial behavior.
- `resumeAllAgents()` re-registers schedulers for all existing agents on
  process boot, so a server restart during the 48-hour window doesn't kill
  autonomy.

## Memory that does more than deduplication

`src/memory.js` keeps a structured log of published topics (with entities
and a one-line summary) and rejected topics. This digest is fed into the
Curator (avoid re-covering old ground), the Writer (can reference past
coverage — "last week I flagged X, today's advisory confirms it"), and the
Critic (catch repetition/contradiction the Curator's dedup might miss).

## Self-auditing track record (the agent is accountable to itself)

Every other autonomous-poster design only looks *forward*: discover, judge,
write, remember-to-avoid-repeats. None of that checks whether anything the
agent said actually held up. `src/pipeline/auditor.js` closes that loop:

1. **Writer flags claims.** While drafting, the Writer pulls out 0-2 short,
   falsifiable predictions/assertions the post makes (e.g. "this CVE will
   get a patch within a week"), each stamped with a `checkAfterHours`
   (`claims` table).
2. **Auditor re-checks them independently.** On its own jittered cron
   (`MIN/MAX_AUDIT_GAP_MINUTES`, decoupled from the publish cadence), once a
   claim's `check_after` has passed, the Auditor re-runs the *same* Scout
   sources used for discovery to gather fresh evidence, and asks the model
   to judge — strictly from that fresh evidence, never from memory —
   whether the claim was **confirmed**, **corrected**, or still
   **unresolved** (in which case it's silently re-queued; not every claim
   resolves on the first check, same as not every cycle produces a post).
3. **Confirmed/corrected claims get a public follow-up post.** A short
   post is published (`post_type` = `confirmation` or `correction`,
   `refers_to_post_id` pointing back at the original) — including an
   honest "I was wrong, here's what actually happened" when the evidence
   contradicts the original claim. No silent editing, no disappearing
   predictions.
4. **The track record feeds back into every future cycle.** Resolved
   claims are surfaced inside `memoryDigest()`, so the Curator/Writer/Critic
   won't casually re-assert something the persona already publicly
   retracted.

Queryable via `GET /api/agent/track-record` — total claims made, how many
resolved which way, and a running accuracy rate. This turns "editorial
judgment" from a one-time filtering decision into something with a
verifiable history, which is a much stronger trust signal than voice
consistency alone.

## Persona as structured data, not a vibe

`src/persona.js` encodes the persona as fixed stances, in/out-of-scope
topic lists, and a style fingerprint (length, tone, structure, banned
words) — reused verbatim across every pipeline stage via
`persona.systemPrompt()`. This is what keeps voice and opinions stable
across a 48-hour, many-post evaluation window instead of drifting.

## API

### `POST /api/agent/init` (required, called once)
```json
{ "persona": { "name": "Ada", "domain": "AI Security" } }
```
→ `{ "agentId": "..." }`

Supported `domain` presets: `"AI Security"`, `"Machine Learning Engineering"`,
`"AI Product"` (any other string falls back to a generic AI/tech persona pack
— see `defaultDomainPack()` in `src/persona.js` to add more).

### `GET /api/agent/feed?agentId=...` (required, polled repeatedly)
```json
{ "posts": [ { "id": "...", "createdAt": "ISO8601", "text": "...", "rationale": "...", "sources": ["https://..."] } ] }
```
Newest first. Never triggers publishing — purely a read.

### Bonus transparency endpoints (not required, included for auditability)
- `GET /api/agent/rejected?agentId=...` — every rejected/vetoed topic + reason + scores
- `GET /api/agent/track-record?agentId=...` — every falsifiable claim the agent has made, whether it
  was later confirmed or corrected against fresh evidence, and a running accuracy rate (see below)
- `GET /api/agent/logs?agentId=...` — pipeline activity log (scout/curator/writer/critic/auditor/scheduler)
- `GET /api/agent/status?agentId=...` — persona spec, next scheduled attempt, post/rejection counts
- `POST /api/agent/debug/tick { agentId }` — **local demo only**, forces an immediate cycle so you
  don't have to wait 90+ minutes to see a post while developing. Not part of the evaluated flow.
- `POST /api/agent/debug/audit { agentId }` — **local demo only**, forces an immediate claim re-check
  (see "Self-auditing track record" below) instead of waiting for one to come due naturally.

`GET /api/agent/feed` posts also include `postType` (`"post"` | `"confirmation"` | `"correction"`),
`refersToPostId` (set on confirmations/corrections, pointing back at the original post), and `claims`
(any falsifiable claims that post made, with their current resolution status).

## Setup

```bash
cp .env.example .env        # add your ANTHROPIC_API_KEY
npm install
npm start                   # listens on PORT (default 3000)
```

For a hackathon demo, temporarily lower `MIN_GAP_MINUTES` / `MAX_GAP_MINUTES`
in `.env` (or just use `POST /api/agent/debug/tick`) so you can show posts
appearing without waiting the full jittered gap.

## Data model (SQLite, `data/agent.db`)
- `agents` — one row per initialized persona, plus its randomized `next_publish_after` / `next_audit_after`
- `posts` — published feed content (what `/feed` reads); `post_type` + `refers_to_post_id` distinguish
  ordinary posts from Auditor-published confirmations/corrections
- `rejected_topics` — every rejected/vetoed candidate with scores + reason
- `memory_topics` — structured continuity log the pipeline reads before writing
- `claims` — falsifiable claims/predictions extracted from posts, and how they resolved (see auditor.js)
- `agent_log` — stage-by-stage activity trace

## Extending sources
`src/pipeline/scout.js` currently pulls Hacker News, arXiv, GitHub search
(as a trending proxy), and a couple of security RSS feeds, chosen per
persona domain in `discoverCandidates()`. Add a new source by writing a
`fromX()` function returning `{ title, summary, url, source, publishedAt }[]`
and wiring it into the domain branch you want it to feed.

## What's intentionally out of scope (per problem statement)
No real social platform posting, no multi-platform publishing, no images/
video, no engagement analytics, no multi-agent architecture, no human
intervention after init. Publishing is simulated into SQLite and served via
the feed API, which the spec explicitly allows.
