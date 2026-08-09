const { v4: uuid } = require("uuid");
const db = require("../db");
const { discoverCandidates } = require("./scout");
const { scoreCandidates } = require("./curator");
const { writePost } = require("./writer");
const { critiquePost } = require("./critic");
const { recordPublished } = require("../memory");
const { log } = require("../logger");

/**
 * Runs one full editorial cycle for an agent:
 *   Scout -> Curator -> (log all rejections) -> Writer -> Critic -> publish
 * Returns the published post, or null if nothing cleared the bar this
 * cycle (which is itself a valid, expected editorial outcome — not
 * every tick should produce a post).
 */
async function runCycle(agent) {
  const persona = agent.persona;
  persona.agentId = agent.id;

  log(agent.id, "scout", "Discovering candidates from live sources...");
  const candidates = await discoverCandidates(persona);
  log(agent.id, "scout", `Found ${candidates.length} deduplicated candidates.`);

  if (!candidates.length) {
    log(agent.id, "curator", "No candidates discovered this cycle; skipping.");
    return null;
  }

  const scored = await scoreCandidates(persona, candidates);

  const accepted = scored.filter((s) => s.decision === "accept");
  const rejected = scored.filter((s) => s.decision === "reject");

  const insertRejected = db.prepare(
    `INSERT INTO rejected_topics (id, agent_id, topic, reason, scores_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const r of rejected) {
    insertRejected.run(
      uuid(),
      agent.id,
      r.candidate.title,
      r.reason,
      JSON.stringify({ ...r.scores, weighted: Number(r.weighted.toFixed(2)) }),
      new Date().toISOString()
    );
  }
  log(agent.id, "curator", `Accepted ${accepted.length}, rejected ${rejected.length} candidates.`);

  if (!accepted.length) {
    log(agent.id, "curator", "Nothing cleared the publishing threshold this cycle.");
    return null;
  }

  const winner = accepted[0];
  const runnersUp = accepted.slice(1);

  const draft = await writePost(persona, winner, runnersUp);
  log(agent.id, "writer", `Drafted post on topic: ${draft.topicKey}`);

  const critique = await critiquePost(persona, draft);
  log(agent.id, "critic", `Decision: ${critique.decision} — ${critique.notes}`);

  if (critique.decision === "veto") {
    // Log the veto as a rejection too, for full transparency.
    insertRejected.run(
      uuid(),
      agent.id,
      winner.candidate.title,
      `Vetoed post-draft by Critic: ${critique.notes}`,
      JSON.stringify({ ...winner.scores, weighted: Number(winner.weighted.toFixed(2)) }),
      new Date().toISOString()
    );
    return null;
  }

  const finalText = critique.decision === "revise" ? critique.text : draft.text;

  const postId = uuid();
  const createdAt = new Date().toISOString();
  const finalRationale =
    critique.decision === "revise"
      ? `${draft.rationale} (Style/consistency revision applied before publishing: ${critique.notes})`
      : draft.rationale;

  db.prepare(
    `INSERT INTO posts (id, agent_id, text, rationale, sources_json, topic_key, post_type, score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'post', ?, ?)`
  ).run(postId, agent.id, finalText, finalRationale, JSON.stringify(draft.sources), draft.topicKey, Math.round(winner.weighted * 10), createdAt);

  recordPublished(agent.id, {
    topicKey: draft.topicKey,
    entities: draft.entities,
    summary: `${draft.topicKey}: ${finalText.slice(0, 140)}`,
  });

  // Persist any falsifiable claims/predictions the Writer flagged so the
  // Auditor can re-check them later and publish a public confirmation or
  // correction (see src/pipeline/auditor.js) — this is what gives the
  // agent an accountable, queryable track record instead of only ever
  // making forward-looking claims nobody follows up on.
  if (draft.claims && draft.claims.length) {
    const insertClaim = db.prepare(
      `INSERT INTO claims (id, agent_id, post_id, claim_text, check_after, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`
    );
    for (const c of draft.claims) {
      const checkAfter = new Date(Date.now() + c.checkAfterHours * 60 * 60 * 1000).toISOString();
      insertClaim.run(uuid(), agent.id, postId, c.text, checkAfter, createdAt);
    }
    log(agent.id, "writer", `Flagged ${draft.claims.length} falsifiable claim(s) for future audit.`);
  }

  log(agent.id, "publish", `Published post ${postId}.`);

  return { id: postId, text: finalText, rationale: finalRationale, sources: draft.sources, createdAt };
}

module.exports = { runCycle };
