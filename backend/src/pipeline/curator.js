const { completeJSON } = require("../llm");
const { memoryDigest } = require("../memory");

const THRESHOLD = parseFloat(process.env.PUBLISH_SCORE_THRESHOLD || "6.5");

/**
 * Curator is the "editorial judgment" stage. It scores every candidate
 * against an explicit, visible rubric and returns a decision + reasoning
 * for EACH candidate — including the ones it rejects. The caller logs
 * every rejection to the rejected_topics table, which is what makes
 * editorial judgment falsifiable/auditable instead of an unverifiable
 * claim buried in a single mega-prompt.
 *
 * Rubric (0-10 each):
 *  - novelty: is this actually new information, not a rehash?
 *  - relevance: does it fit the persona's in-scope topics and stances?
 *  - verifiability: is it grounded in a real, citable source (not speculation)?
 *  - timeliness: does it matter *now* (recent, active, unresolved)?
 *
 * weighted score = 0.3*novelty + 0.3*relevance + 0.25*verifiability + 0.15*timeliness
 */
function weightedScore(s) {
  return 0.3 * s.novelty + 0.3 * s.relevance + 0.25 * s.verifiability + 0.15 * s.timeliness;
}

async function scoreCandidates(persona, candidates) {
  if (!candidates.length) return [];

  // Cap batch size to keep prompts small/cheap; scheduler calls this per tick.
  const batch = candidates.slice(0, 15);

  const system = persona.systemPrompt();
  const digest = memoryDigest(persona.agentId);

  const candidateList = batch
    .map(
      (c, i) =>
        `[${i}] TITLE: ${c.title}\nSUMMARY: ${c.summary}\nSOURCE: ${c.source}\nURL: ${c.url}\nPUBLISHED: ${c.publishedAt}`
    )
    .join("\n\n");

  const prompt = `You are acting as the EDITOR for your own persona, deciding what is worth publishing.

${digest}

Score EACH candidate below on this rubric, 0-10 integers only:
- novelty: is this genuinely new, or a rehash of something you already covered / something old news?
- relevance: does it fit your in-scope topics and stances? Score 0-2 if it is explicitly out-of-scope for you.
- verifiability: is it grounded in a real, checkable source, not speculation or a rumor?
- timeliness: does it matter right now (recent, active, unresolved) vs stale?

Be a harsh editor. Most candidates should NOT clear a high bar. Reject anything that is out-of-scope,
already covered (check PREVIOUSLY PUBLISHED), a rehash of something already rejected for the same reason,
or low-substance (pure announcement with no technical content).

CANDIDATES:
${candidateList}

Return a JSON array, one object per candidate, in the same order, each with EXACTLY these fields:
{"index": <int>, "novelty": <0-10>, "relevance": <0-10>, "verifiability": <0-10>, "timeliness": <0-10>, "reason": "<one sentence, specific to this candidate>"}`;

  const scored = await completeJSON({ system, prompt, maxTokens: 2000 });

  if (!Array.isArray(scored)) {
    throw new Error("Curator did not return an array");
  }

  return scored
    .map((s) => {
      const candidate = batch[s.index];
      if (!candidate) return null;
      const scores = {
        novelty: s.novelty,
        relevance: s.relevance,
        verifiability: s.verifiability,
        timeliness: s.timeliness,
      };
      const weighted = weightedScore(scores);
      return {
        candidate,
        scores,
        weighted,
        reason: s.reason,
        decision: weighted >= THRESHOLD ? "accept" : "reject",
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.weighted - a.weighted);
}

module.exports = { scoreCandidates, weightedScore, THRESHOLD };
