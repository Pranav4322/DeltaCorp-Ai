const { v4: uuid } = require("uuid");
const db = require("./db");

/**
 * Memory is a structured log the agent actually reads before writing,
 * not just a dedup filter. Writer/Critic get a compact digest of:
 *  - recent published topics + one-line summaries (continuity + avoid repeats)
 *  - recent rejected topics (so it doesn't re-litigate the same rejection)
 * This lets new posts reference past ones ("last week I flagged X...")
 * which is what makes the feed read as a continuous editorial thread
 * across the 48-hour window instead of disconnected one-offs.
 */

function recordPublished(agentId, { topicKey, entities, summary }) {
  db.prepare(
    `INSERT INTO memory_topics (id, agent_id, topic_key, entities_json, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuid(), agentId, topicKey, JSON.stringify(entities || []), summary, new Date().toISOString());
}

function recentMemory(agentId, limit = 12) {
  return db
    .prepare(
      `SELECT topic_key as topicKey, entities_json as entitiesJson, summary, created_at as createdAt
       FROM memory_topics WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(agentId, limit)
    .map((r) => ({ ...r, entities: JSON.parse(r.entitiesJson) }));
}

function recentRejections(agentId, limit = 10) {
  return db
    .prepare(
      `SELECT topic, reason, created_at as createdAt
       FROM rejected_topics WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(agentId, limit);
}

/**
 * Track-record helpers. Claims are falsifiable predictions/assertions the
 * Writer makes inside a post (see pipeline/writer.js + pipeline/auditor.js).
 * Surfacing resolved claims back into the digest means the persona is
 * accountable to itself: it won't casually repeat a stance it already
 * publicly retracted, and it can build on things it got right.
 */
function recentResolutions(agentId, limit = 6) {
  return db
    .prepare(
      `SELECT claim_text as claimText, status, resolution_note as resolutionNote, resolved_at as resolvedAt
       FROM claims WHERE agent_id = ? AND status IN ('confirmed','corrected') ORDER BY resolved_at DESC LIMIT ?`
    )
    .all(agentId, limit);
}

function openClaimCount(agentId) {
  return db.prepare(`SELECT COUNT(*) as c FROM claims WHERE agent_id = ? AND status = 'open'`).get(agentId).c;
}

/** Compact text digest fed into Curator/Writer/Critic prompts. */
function memoryDigest(agentId) {
  const published = recentMemory(agentId, 12);
  const rejected = recentRejections(agentId, 8);
  const resolutions = recentResolutions(agentId, 6);

  const publishedLines = published.length
    ? published.map((p) => `- [${p.createdAt}] ${p.summary} (entities: ${p.entities.join(", ") || "none"})`).join("\n")
    : "(nothing published yet)";

  const rejectedLines = rejected.length
    ? rejected.map((r) => `- ${r.topic} — rejected: ${r.reason}`).join("\n")
    : "(nothing rejected yet)";

  const resolutionLines = resolutions.length
    ? resolutions
        .map((r) => `- [${r.status === "confirmed" ? "CONFIRMED" : "CORRECTED"}] "${r.claimText}" — ${r.resolutionNote}`)
        .join("\n")
    : "(no claims resolved yet)";

  return `PREVIOUSLY PUBLISHED (most recent first):\n${publishedLines}\n\nPREVIOUSLY REJECTED (most recent first):\n${rejectedLines}\n\nYOUR TRACK RECORD — past predictions/claims you made and how they resolved (stay consistent with corrections, don't repeat a claim you already retracted):\n${resolutionLines}`;
}

module.exports = {
  recordPublished,
  recentMemory,
  recentRejections,
  recentResolutions,
  openClaimCount,
  memoryDigest,
};
