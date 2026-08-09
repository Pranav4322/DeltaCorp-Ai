require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { v4: uuid } = require("uuid");

const db = require("./db");
const { buildPersona } = require("./persona");
const { startAgentScheduler, resumeAllAgents, tick, auditTick, loadAgent } = require("./scheduler");
const { recentLogs } = require("./logger");
const { completeJSON } = require("./llm");

const app = express();
app.use(cors()); // frontend/ is a separate folder and may be served from a different origin
app.use(express.json());

// Convenience: also serve the sibling frontend/ folder as static files, so
// `npm start` from backend/ can run the whole product on one port. The
// frontend is a standalone static app though — it can equally be hosted
// separately (Vercel/Netlify/S3/nginx/etc) and pointed at this API via the
// "API base URL" setting in its topbar.
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");
app.use(express.static(FRONTEND_DIR));

const PORT = process.env.PORT || 3000;

/**
 * POST /api/agent/init
 * Called exactly once before evaluation. Creates the agent, persists its
 * persona, and starts an autonomous scheduler that runs independently of
 * any further HTTP calls (see src/scheduler.js).
 */
app.post("/api/agent/init", (req, res) => {
  const { persona } = req.body || {};
  if (!persona || !persona.name || !persona.domain) {
    return res.status(400).json({ error: "Request must include persona.name and persona.domain" });
  }

  const existing = db.prepare(`SELECT id FROM agents WHERE name = ? AND domain = ?`).get(persona.name, persona.domain);
  if (existing) {
    return res.status(409).json({ error: "Agent with this name/domain already initialized", agentId: existing.id });
  }

  const agentId = uuid();
  const builtPersona = buildPersona({ name: persona.name, domain: persona.domain });

  db.prepare(
    `INSERT INTO agents (id, name, domain, persona_json, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(
    agentId,
    persona.name,
    persona.domain,
    JSON.stringify({
      tagline: builtPersona.tagline,
      coreStances: builtPersona.coreStances,
      inScope: builtPersona.inScope,
      outOfScope: builtPersona.outOfScope,
      styleFingerprint: builtPersona.styleFingerprint,
    }),
    new Date().toISOString()
  );

  startAgentScheduler(agentId);

  res.json({ agentId });
});

/**
 * GET /api/agent/feed?agentId=...
 * The only endpoint evaluators poll after init. Returns posts newest
 * first. Never triggers publishing itself — publishing is driven solely
 * by the background scheduler.
 */
app.get("/api/agent/feed", (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: "agentId query param is required" });

  const agent = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(agentId);
  if (!agent) return res.status(404).json({ error: "Unknown agentId" });

  const rows = db
    .prepare(
      `SELECT id, text, rationale, sources_json as sourcesJson, post_type as postType,
              refers_to_post_id as refersToPostId, score, created_at as createdAt
       FROM posts WHERE agent_id = ? ORDER BY created_at DESC`
    )
    .all(agentId);

  const claimRows = db
    .prepare(
      `SELECT post_id as postId, claim_text as claimText, status, resolution_note as resolutionNote,
              resolution_post_id as resolutionPostId
       FROM claims WHERE agent_id = ?`
    )
    .all(agentId);
  const claimsByPost = {};
  for (const c of claimRows) {
    (claimsByPost[c.postId] = claimsByPost[c.postId] || []).push({
      text: c.claimText,
      status: c.status,
      resolutionNote: c.resolutionNote,
      resolutionPostId: c.resolutionPostId,
    });
  }

  const posts = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    text: r.text,
    rationale: r.rationale,
    sources: JSON.parse(r.sourcesJson),
    // "post" | "confirmation" | "correction" — the latter two are published
    // by the Auditor re-checking a past claim (see src/pipeline/auditor.js).
    postType: r.postType || "post",
    refersToPostId: r.refersToPostId || null,
    score: r.score ?? null, // 0-100 Curator score at publish time; null for older posts predating this field
    claims: claimsByPost[r.id] || [],
  }));

  res.json({ posts });
});

/* ---------------------------------------------------------------------
 * Bonus transparency endpoints (not required by spec, but make editorial
 * judgment and autonomy auditable rather than a black-box claim).
 * ------------------------------------------------------------------- */

// Every topic considered and rejected, with scores and reasons.
app.get("/api/agent/rejected", (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: "agentId query param is required" });

  const rows = db
    .prepare(
      `SELECT id, topic, reason, scores_json as scoresJson, created_at as createdAt
       FROM rejected_topics WHERE agent_id = ? ORDER BY created_at DESC`
    )
    .all(agentId);

  res.json({
    rejected: rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      reason: r.reason,
      scores: JSON.parse(r.scoresJson),
      createdAt: r.createdAt,
    })),
  });
});

// Self-auditing track record: every falsifiable claim the agent has made,
// whether it was later confirmed or corrected against fresh evidence, and
// a running accuracy rate. This is the feature that makes the persona
// accountable over time instead of only ever making forward-looking claims
// nobody checks — see src/pipeline/auditor.js.
app.get("/api/agent/track-record", (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: "agentId query param is required" });

  const agent = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(agentId);
  if (!agent) return res.status(404).json({ error: "Unknown agentId" });

  const rows = db
    .prepare(
      `SELECT id, post_id as postId, claim_text as claimText, status, resolution_note as resolutionNote,
              resolution_post_id as resolutionPostId, check_after as checkAfter,
              resolved_at as resolvedAt, created_at as createdAt
       FROM claims WHERE agent_id = ? ORDER BY created_at DESC`
    )
    .all(agentId);

  const confirmed = rows.filter((r) => r.status === "confirmed").length;
  const corrected = rows.filter((r) => r.status === "corrected").length;
  const open = rows.filter((r) => r.status === "open").length;
  const resolvedTotal = confirmed + corrected;

  res.json({
    agentId,
    totalClaims: rows.length,
    open,
    confirmed,
    corrected,
    accuracyRate: resolvedTotal ? Number((confirmed / resolvedTotal).toFixed(2)) : null,
    claims: rows,
  });
});

// Live activity log of the pipeline (scout/curator/writer/critic/publish/scheduler stages).
app.get("/api/agent/logs", (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: "agentId query param is required" });
  res.json({ logs: recentLogs(agentId, 100) });
});

// Full agent status: persona spec, next scheduled attempt, counts.
app.get("/api/agent/status", (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: "agentId query param is required" });

  const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId);
  if (!row) return res.status(404).json({ error: "Unknown agentId" });

  const postCount = db.prepare(`SELECT COUNT(*) as c FROM posts WHERE agent_id = ?`).get(agentId).c;
  const rejectedCount = db.prepare(`SELECT COUNT(*) as c FROM rejected_topics WHERE agent_id = ?`).get(agentId).c;

  res.json({
    agentId: row.id,
    name: row.name,
    domain: row.domain,
    createdAt: row.created_at,
    nextPublishAfter: row.next_publish_after,
    persona: JSON.parse(row.persona_json),
    postCount,
    rejectedCount,
  });
});

// Manual trigger for local testing/demo only — NOT called by the evaluator,
// and not required for the agent to function (the scheduler runs on its own).
app.post("/api/agent/debug/tick", async (req, res) => {
  const { agentId } = req.body || {};
  if (!agentId) return res.status(400).json({ error: "agentId is required" });
  const agent = loadAgent(agentId);
  if (!agent) return res.status(404).json({ error: "Unknown agentId" });

  // Force eligibility so the debug tick actually runs a cycle immediately.
  db.prepare(`UPDATE agents SET next_publish_after = ? WHERE id = ?`).run(new Date(0).toISOString(), agentId);
  await tick(agentId);
  res.json({ ok: true });
});

// Manual trigger for the Auditor — local demo only, same rationale as
// debug/tick above. Forces any open claim's check_after into the past so
// you don't have to wait for it to naturally come due while developing.
app.post("/api/agent/debug/audit", async (req, res) => {
  const { agentId } = req.body || {};
  if (!agentId) return res.status(400).json({ error: "agentId is required" });
  const agent = loadAgent(agentId);
  if (!agent) return res.status(404).json({ error: "Unknown agentId" });

  db.prepare(`UPDATE claims SET check_after = ? WHERE agent_id = ? AND status = 'open'`).run(
    new Date(0).toISOString(),
    agentId
  );
  db.prepare(`UPDATE agents SET next_audit_after = ? WHERE id = ?`).run(new Date(0).toISOString(), agentId);
  await auditTick(agentId);
  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ ok: true }));

/* ---------------------------------------------------------------------
 * Public-facing extras for real visitors (not just the local demo
 * buttons above): a rate-limited "generate now" trigger anyone can
 * click, and a separate community board where visitors can post their
 * own text without touching the AI's own official feed.
 * ------------------------------------------------------------------- */

// Simple in-memory per-agent cooldown so a public "Generate Post" button
// can't be spammed into burning through LLM API quota/cost. Resets if the
// process restarts, which is fine for a cooldown (not persisted state).
const lastPublicGenerate = {};
const GENERATE_COOLDOWN_MS = Number(process.env.GENERATE_COOLDOWN_MINUTES || 3) * 60 * 1000;

// POST /api/agent/generate — public, rate-limited version of debug/tick.
// Safe to expose to real visitors: same underlying pipeline cycle, just
// throttled so one person can't trigger it repeatedly back-to-back.
app.post("/api/agent/generate", async (req, res) => {
  const { agentId } = req.body || {};
  if (!agentId) return res.status(400).json({ error: "agentId is required" });
  const agent = loadAgent(agentId);
  if (!agent) return res.status(404).json({ error: "Unknown agentId" });

  const now = Date.now();
  const last = lastPublicGenerate[agentId] || 0;
  const elapsed = now - last;
  if (elapsed < GENERATE_COOLDOWN_MS) {
    const waitSec = Math.ceil((GENERATE_COOLDOWN_MS - elapsed) / 1000);
    return res.status(429).json({ error: `Please wait ${waitSec}s before generating another post.` });
  }
  lastPublicGenerate[agentId] = now;

  db.prepare(`UPDATE agents SET next_publish_after = ? WHERE id = ?`).run(new Date(0).toISOString(), agentId);
  await tick(agentId);
  res.json({ ok: true });
});

// GET /api/agent/community?agentId=... — list visitor-submitted posts,
// newest first. Kept entirely separate from /api/agent/feed (the AI's
// official, evaluated feed).
app.get("/api/agent/community", (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: "agentId query param is required" });

  const agent = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(agentId);
  if (!agent) return res.status(404).json({ error: "Unknown agentId" });

  const rows = db
    .prepare(
      `SELECT id, author, text, created_at as createdAt
       FROM community_posts WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100`
    )
    .all(agentId);

  res.json({ posts: rows });
});

// POST /api/agent/community — a real visitor submits their own text.
// Basic length/empty validation only; this is a hackathon demo feature,
// not hardened for abuse at internet scale.
app.post("/api/agent/community", (req, res) => {
  const { agentId, text, author } = req.body || {};
  if (!agentId || !text) return res.status(400).json({ error: "agentId and text are required" });

  const clean = String(text).trim();
  if (!clean) return res.status(400).json({ error: "Post text cannot be empty." });
  if (clean.length > 500) return res.status(400).json({ error: "Keep it under 500 characters." });

  const agent = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(agentId);
  if (!agent) return res.status(404).json({ error: "Unknown agentId" });

  const id = uuid();
  const createdAt = new Date().toISOString();
  const cleanAuthor = author ? String(author).trim().slice(0, 40) : "Anonymous";

  db.prepare(
    `INSERT INTO community_posts (id, agent_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, agentId, cleanAuthor, clean, createdAt);

  res.json({ ok: true, id });
});

/* ---------------------------------------------------------------------
 * URL fact-check: a visitor submits a link, we fetch it, strip it down
 * to plain text, and ask the LLM to analyze it (summary, key claims,
 * credibility signals, relevance to this persona's domain). Result is
 * stored and returned synchronously.
 * ------------------------------------------------------------------- */

const lastUrlCheck = {};
const URL_CHECK_COOLDOWN_MS = Number(process.env.URL_CHECK_COOLDOWN_SECONDS || 20) * 1000;

function extractTitleAndText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : null;

  const withoutJunk = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = withoutJunk
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

  return { title, text: text.slice(0, 6000) };
}

// GET /api/agent/url-checks?agentId=... — browse past checks, newest first.
app.get("/api/agent/url-checks", (req, res) => {
  const { agentId } = req.query;
  if (!agentId) return res.status(400).json({ error: "agentId query param is required" });

  const agent = db.prepare(`SELECT id FROM agents WHERE id = ?`).get(agentId);
  if (!agent) return res.status(404).json({ error: "Unknown agentId" });

  const rows = db
    .prepare(
      `SELECT id, url, submitted_by as submittedBy, title, result_json as resultJson,
              status, error, created_at as createdAt
       FROM url_checks WHERE agent_id = ? ORDER BY created_at DESC LIMIT 50`
    )
    .all(agentId);

  res.json({
    checks: rows.map((r) => ({
      id: r.id,
      url: r.url,
      submittedBy: r.submittedBy,
      title: r.title,
      status: r.status,
      error: r.error,
      createdAt: r.createdAt,
      result: r.resultJson ? JSON.parse(r.resultJson) : null,
    })),
  });
});

// POST /api/agent/check-url — fetch + analyze a submitted URL, synchronously.
app.post("/api/agent/check-url", async (req, res) => {
  const { agentId, url, submittedBy } = req.body || {};
  if (!agentId || !url) return res.status(400).json({ error: "agentId and url are required" });

  let parsed;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("bad protocol");
  } catch {
    return res.status(400).json({ error: "Please submit a valid http(s) URL." });
  }

  const agent = loadAgent(agentId);
  if (!agent) return res.status(404).json({ error: "Unknown agentId" });

  const now = Date.now();
  const last = lastUrlCheck[agentId] || 0;
  if (now - last < URL_CHECK_COOLDOWN_MS) {
    const waitSec = Math.ceil((URL_CHECK_COOLDOWN_MS - (now - last)) / 1000);
    return res.status(429).json({ error: `Please wait ${waitSec}s before checking another URL.` });
  }
  lastUrlCheck[agentId] = now;

  const id = uuid();
  const createdAt = new Date().toISOString();
  const cleanSubmittedBy = submittedBy ? String(submittedBy).trim().slice(0, 40) : "Anonymous";

  let pageTitle = null;
  let pageText = "";
  try {
    const resp = await axios.get(parsed.toString(), {
      timeout: 12000,
      maxRedirects: 5,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DeltaCorpAI-URLCheck/1.0)" },
      responseType: "text",
    });
    const extracted = extractTitleAndText(String(resp.data));
    pageTitle = extracted.title;
    pageText = extracted.text;
  } catch (err) {
    const errMsg = `Couldn't fetch that URL: ${err.message}`;
    db.prepare(
      `INSERT INTO url_checks (id, agent_id, url, submitted_by, title, result_json, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?)`
    ).run(id, agentId, parsed.toString(), cleanSubmittedBy, null, "{}", errMsg, createdAt);
    return res.status(502).json({ error: errMsg });
  }

  if (!pageText || pageText.length < 100) {
    const errMsg = "Fetched the page but couldn't extract readable article text from it.";
    db.prepare(
      `INSERT INTO url_checks (id, agent_id, url, submitted_by, title, result_json, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?)`
    ).run(id, agentId, parsed.toString(), cleanSubmittedBy, pageTitle, "{}", errMsg, createdAt);
    return res.status(422).json({ error: errMsg });
  }

  const persona = agent.persona;
  const system = persona.systemPrompt();
  const prompt = `A visitor submitted this URL for you to check as the EDITOR persona, using the same rigor you use for your own sourcing.

URL: ${parsed.toString()}
PAGE TITLE: ${pageTitle || "(no title found)"}
PAGE TEXT (truncated): ${pageText}

Analyze it and return ONLY a JSON object with EXACTLY these fields:
{
  "summary": "<2-3 sentence neutral summary of what the article actually says>",
  "keyClaims": ["<claim 1>", "<claim 2>", "..."],
  "credibilitySignals": ["<short note on sourcing, evidence, tone, dates, etc>", "..."],
  "relevanceToDomain": <0-10 int, how relevant this is to your domain>,
  "verdict": "<one of: worth-covering, not-relevant, needs-caution>",
  "notes": "<one sentence explaining the verdict>"
}`;

  let result;
  try {
    result = await completeJSON({ system, prompt, maxTokens: 1200 });
  } catch (err) {
    const errMsg = `Fetched the article, but analysis failed: ${err.message}`;
    db.prepare(
      `INSERT INTO url_checks (id, agent_id, url, submitted_by, title, result_json, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?)`
    ).run(id, agentId, parsed.toString(), cleanSubmittedBy, pageTitle, "{}", errMsg, createdAt);
    return res.status(502).json({ error: errMsg });
  }

  db.prepare(
    `INSERT INTO url_checks (id, agent_id, url, submitted_by, title, result_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'done', ?)`
  ).run(id, agentId, parsed.toString(), cleanSubmittedBy, pageTitle, JSON.stringify(result), createdAt);

  res.json({ ok: true, id, url: parsed.toString(), title: pageTitle, result });
});

// SPA fallback: any non-/api GET request falls through to index.html so the
// frontend's own client-side tab routing works on a hard refresh (only
// relevant when the frontend is being served from here — see FRONTEND_DIR).
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"), (err) => {
    if (err) res.status(404).json({ error: "Not found. (Serving frontend/ as static files failed — is it present next to backend/?)" });
  });
});

resumeAllAgents();

app.listen(PORT, () => {
  console.log(`Autonomous AI Creator backend listening on port ${PORT}`);
});

/**
 * Keep-alive self-ping.
 *
 * Render's free web service tier spins the process down after ~15 minutes
 * with no inbound HTTP traffic. If that happens mid-evaluation, node-cron
 * (and every in-memory scheduler timer in scheduler.js) dies with it —
 * publishing would silently stop until the evaluator's next /feed poll
 * cold-starts the process again, which breaks "continues publishing over
 * time without additional human input."
 *
 * Render automatically sets RENDER_EXTERNAL_URL to the service's public
 * URL, so this needs no extra config on Render itself. It's a no-op
 * locally (the env var won't be set). This is a second, redundant layer —
 * still set up an external pinger (e.g. cron-job.org hitting /health every
 * 10 min) for real belt-and-suspenders, since a platform can in principle
 * ignore self-traffic for idle detection.
 */
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
if (KEEP_ALIVE_URL) {
  const axios = require("axios");
  const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes — comfortably under Render's 15-minute idle window
  setInterval(() => {
    axios.get(`${KEEP_ALIVE_URL}/health`, { timeout: 8000 }).catch((err) => {
      console.error("[keep-alive] self-ping failed:", err.message);
    });
  }, INTERVAL_MS);
  console.log(`[keep-alive] Self-ping enabled every ${INTERVAL_MS / 60000}m against ${KEEP_ALIVE_URL}/health`);
} else {
  console.log("[keep-alive] KEEP_ALIVE_URL/RENDER_EXTERNAL_URL not set — self-ping disabled (fine for local dev).");
}