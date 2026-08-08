require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { v4: uuid } = require("uuid");

const db = require("./db");
const { buildPersona } = require("./persona");
const { startAgentScheduler, resumeAllAgents, tick, auditTick, loadAgent } = require("./scheduler");
const { recentLogs } = require("./logger");

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
              refers_to_post_id as refersToPostId, created_at as createdAt
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
