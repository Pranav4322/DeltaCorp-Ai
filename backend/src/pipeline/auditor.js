const { v4: uuid } = require("uuid");
const db = require("../db");
const { completeJSON } = require("../llm");
const { discoverCandidates } = require("./scout");
const { log } = require("../logger");

/**
 * The Auditor is what turns "editorial judgment" into "accountability".
 * The Writer already extracts falsifiable claims/predictions from each
 * post (src/pipeline/writer.js). This stage, run on its own jittered
 * schedule (see scheduler.js), picks the oldest claim that has become
 * due, re-scouts FRESH live evidence (same code-only sources Scout uses
 * — no invented "I checked the news" hand-waving), and asks the model to
 * judge, strictly from that fresh evidence, whether the claim held up.
 *
 * Three outcomes:
 *  - "confirmed"  -> claim closed, a short public follow-up post is published
 *  - "corrected"  -> claim closed, a public correction post is published —
 *                    the persona explicitly says it was wrong and why
 *  - "unresolved" -> not enough new evidence yet; claim stays open and is
 *                    re-queued further out. This is the common case for a
 *                    claim that's only a few hours old — it is NOT treated
 *                    as a failure, exactly like "no candidate cleared the
 *                    bar" is a normal outcome for a publish cycle.
 *
 * This is what makes the agent's track record queryable
 * (`GET /api/agent/track-record`) instead of a persona that only ever
 * makes claims and never has to answer for them.
 */

function findDueClaim(agentId) {
  return db
    .prepare(
      `SELECT c.id, c.claim_text as claimText, c.post_id as postId, c.check_after as checkAfter,
              p.text as postText, p.created_at as postCreatedAt
       FROM claims c JOIN posts p ON p.id = c.post_id
       WHERE c.agent_id = ? AND c.status = 'open' AND c.check_after <= ?
       ORDER BY c.check_after ASC LIMIT 1`
    )
    .get(agentId, new Date().toISOString());
}

function requeueClaim(claimId, hoursFromNow) {
  const nextCheck = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
  db.prepare(`UPDATE claims SET check_after = ? WHERE id = ?`).run(nextCheck, claimId);
}

function resolveClaim(claimId, { status, resolutionNote, resolutionPostId }) {
  db.prepare(
    `UPDATE claims SET status = ?, resolution_note = ?, resolution_post_id = ?, resolved_at = ?
     WHERE id = ?`
  ).run(status, resolutionNote, resolutionPostId || null, new Date().toISOString(), claimId);
}

/**
 * Judges one due claim against freshly scouted candidates. Deliberately
 * reuses discoverCandidates() rather than asking the model to "recall"
 * whether the claim came true — the model only ever gets to judge from
 * concrete titles/summaries/URLs gathered this exact call, same
 * grounding discipline the Curator/Writer already follow.
 */
async function judgeClaim(persona, claim) {
  const fresh = await discoverCandidates(persona);
  const evidenceList = fresh
    .slice(0, 20)
    .map((c, i) => `[${i}] ${c.title} — ${c.summary} (${c.source}, ${c.publishedAt})`)
    .join("\n");

  const system = persona.systemPrompt();
  const prompt = `You made this claim/prediction in a post published on ${claim.postCreatedAt}:
"${claim.claimText}"

Original post text for context:
"""
${claim.postText}
"""

FRESH EVIDENCE gathered just now from live sources (this is ALL the new information you have —
do not use outside knowledge, do not assume anything not stated here):
${evidenceList || "(no fresh candidates were discoverable this check)"}

Judge, strictly from the fresh evidence above, whether the claim has been:
- "confirmed": the evidence clearly supports the claim came true / held up
- "corrected": the evidence clearly contradicts the claim — it did not hold up
- "unresolved": the fresh evidence is silent or inconclusive — genuinely not enough to judge yet

Be conservative: only pick "confirmed" or "corrected" if the evidence actually speaks to this specific
claim. Default to "unresolved" rather than guessing.

Return ONLY JSON: {"verdict": "confirmed"|"corrected"|"unresolved", "note": "<one sentence, specific, citing what the evidence showed or the lack of it>", "supportingIndices": [<int>, ...evidence array indices above that this verdict is actually based on, empty array if none or if unresolved]}`;

  const result = await completeJSON({ system, prompt, maxTokens: 400 });
  const supportingUrls = Array.isArray(result.supportingIndices)
    ? result.supportingIndices.map((i) => fresh[i]?.url).filter(Boolean)
    : [];
  return { ...result, supportingUrls };
}

/** Drafts and publishes the short public follow-up/correction post for a resolved claim. */
async function writeResolutionPost(persona, claim, verdict, note) {
  const system = persona.systemPrompt();
  const label = verdict === "confirmed" ? "a confirmed prediction" : "a correction — you were wrong";

  const prompt = `Write a SHORT follow-up post (2-4 sentences, your normal style fingerprint) about ${label}.

The original claim: "${claim.claimText}"
What the fresh evidence showed: ${note}

${
  verdict === "corrected"
    ? "Be direct and specific about what you got wrong and why — no hedging, no vague apology filler. State plainly what actually happened instead."
    : "State plainly that this held up and briefly note what confirmed it. Do not be smug about it."
}
Never use: ${persona.styleFingerprint.avoid.join(", ")}.

Return ONLY JSON: {"text": "..."}`;

  const draft = await completeJSON({ system, prompt, maxTokens: 300 });
  if (!draft.text) throw new Error("Auditor resolution post came back empty");
  return draft.text.trim();
}

/**
 * Runs one audit check for an agent, if a claim is due. Returns a
 * published resolution post (or null if nothing was due / claim stayed
 * unresolved) — mirrors runCycle()'s "null is a valid outcome" contract.
 */
async function runAudit(agent) {
  const persona = agent.persona;
  persona.agentId = agent.id;

  const claim = findDueClaim(agent.id);
  if (!claim) {
    log(agent.id, "auditor", "No claims due for re-check this cycle.");
    return null;
  }

  log(agent.id, "auditor", `Re-checking claim: "${claim.claimText}"`);
  const { verdict, note, supportingUrls } = await judgeClaim(persona, claim);

  if (verdict !== "confirmed" && verdict !== "corrected") {
    requeueClaim(claim.id, 24);
    log(agent.id, "auditor", `Claim unresolved, re-queued for another check in ~24h: ${note}`);
    return null;
  }

  const text = await writeResolutionPost(persona, claim, verdict, note);

  const postId = uuid();
  const createdAt = new Date().toISOString();
  const rationale =
    verdict === "confirmed"
      ? `Follow-up: re-checked a prior prediction against fresh evidence and it held up. ${note}`
      : `Correction: re-checked a prior prediction against fresh evidence and it did not hold up. ${note}`;

  // Fall back to the original post's source(s) if the model didn't point to
  // specific fresh evidence — every published post must carry at least one
  // source per the spec, and the original claim's source is still relevant
  // context for a confirmation/correction of it either way.
  const sources = supportingUrls && supportingUrls.length ? supportingUrls : JSON.parse(
    db.prepare(`SELECT sources_json FROM posts WHERE id = ?`).get(claim.postId)?.sources_json || "[]"
  );

  db.prepare(
    `INSERT INTO posts (id, agent_id, text, rationale, sources_json, topic_key, post_type, refers_to_post_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    postId,
    agent.id,
    text,
    rationale,
    JSON.stringify(sources),
    `audit-${claim.id}`,
    verdict === "confirmed" ? "confirmation" : "correction",
    claim.postId,
    createdAt
  );

  resolveClaim(claim.id, { status: verdict, resolutionNote: note, resolutionPostId: postId });
  log(agent.id, "auditor", `Published ${verdict} post ${postId} for claim ${claim.id}.`);

  return { id: postId, text, rationale, sources, createdAt };
}

module.exports = { runAudit, findDueClaim, judgeClaim };
