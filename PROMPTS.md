# AI Usage Log

This project was built conversationally with **Claude** (Anthropic), using
its code-execution/computer-use tools to unzip inputs, write files, run the
Node server, and curl-test the API before every hand-off. Below is the
prompt history in order, with what was produced at each step.

---

### Prompt 1 — initial brief + two source zips

> "there is two file of project 1 st one ui design and second one is for
> backend create proper full project file frontend and backend file in one
> file wire the all the frontend and backend and do all working of all
> feature"

Attached: `ui-designs.zip` (four static HTML mockups — `A-dispatch.html`,
`B-ledger.html`, `C-signal-room.html`, `D-integrity-report(-v2).html`) and
`autonomous-ai-creator_1.zip` (an Express + SQLite backend implementing a
Scout → Curator → Writer → Critic → Auditor content pipeline for an
autonomous persona agent).

**What Claude did:** unzipped and read every backend source file
(`server.js`, `db.js`, `scheduler.js`, `pipeline/*.js`) to learn the real
API surface and data model, then read all four HTML mockups to learn their
visual language. Built a single-page vanilla JS frontend (`public/`)
implementing all four mockups as live tabs — Dispatch, Signal Room, Ledger,
Integrity — wired to the actual `/api/agent/*` endpoints (init, feed,
rejected, track-record, logs, status, debug/tick, debug/audit), with
polling, an init/resume flow, and "force tick"/"force audit" buttons for
demoing without waiting on the real jittered schedule. Modified
`server.js` to serve the frontend as static files. Installed dependencies,
booted the server, and curl-tested every endpoint end-to-end before
delivering a zip.

---

### Prompt 2 — visual polish + repo layout

> "in this project ui use css and windtail css to make ui better and make
> zip file in which frontend and backend file like"

**What Claude did:** rebuilt the frontend UI on Tailwind CSS (CDN build,
no bundler) with a consistent dark design system across all four tabs
(distinct accent colors — amber/cyan/emerald/violet — per view instead of
four unrelated typographic themes), and restructured the deliverable into
top-level `backend/` and `frontend/` folders instead of a `src/` +
`public/` split, so each half is independently deployable. Added a
settings modal so the standalone static frontend can point at any backend
URL. Re-verified the full flow (static serving, init, status/feed/
rejected/track-record/logs) after the restructure.

---

### Prompt 3 — align with hackathon submission rules

> [pasted the ABTalks hackathon API spec, evaluation stages, and
> submission rules] "these are the some of rules of hackthon make
> according to it"

**What Claude did:** checked the existing `POST /api/agent/init` and
`GET /api/agent/feed` handlers against the spec's exact required request/
response shapes, unique-id requirement, reverse-chronological ordering,
ISO 8601 UTC timestamps, and the empty-feed fallback — all already
satisfied by the existing implementation (the extra fields it also returns,
like `postType`/`claims`, are additive and don't conflict with the spec).
Added what was missing for a submittable entry: this `PROMPTS.md`, a
`.gitignore` for the backend, and a `render.yaml` blueprint plus a
`DATA_DIR` env override in `db.js` so the SQLite file can live on a
persistent disk on a host that keeps the process (and its cron scheduler)
running continuously, which this project needs and a stateless serverless
platform can't provide.

---

### Prompt 4 — change API provider to OpenAI (chatgpt 5.6 luna)

> "can u please use chatgpt 5.6 luna model for the api"

**What the AI did:** added a new `callOpenAI` function to `backend/src/llm.js` that posts to the `api.openai.com/v1/chat/completions` endpoint, defaulting to the requested model. Placed OpenAI at the top of the fallback provider list so it takes priority over Gemini/Anthropic when an `OPENAI_API_KEY` is present. Updated `backend/.env.example` to document the new configuration variables.

---

## Tooling summary

- **Model:** Claude (Anthropic), Gemini 3.1 Pro (High) used via chat with file/code-execution
  tools enabled.
- **How it was used:** end-to-end — reading and reconciling the two source
  zips, writing all backend wiring and every frontend file, running and
  curl-testing the server after each change, and preparing the repo layout
  and deployment config for submission.
- **What was NOT AI-generated:** the original `ui-designs.zip` mockups and
  the original `autonomous-ai-creator_1.zip` backend skeleton were supplied
  by the team as starting inputs; Claude read, wired, restyled, and
  extended them rather than generating them from a blank slate.
