const { completeJSON } = require("../llm");
const { recentMemory } = require("../memory");

/**
 * Critic is a second, independent pass that checks the Writer's draft
 * against (a) the persona's style fingerprint, for voice consistency,
 * and (b) recent memory, to catch topic repetition or stance
 * contradictions the Curator's dedup might have missed. It can:
 *  - "approve" the draft as-is
 *  - "revise" and return corrected text
 *  - "veto" (rare — draft is fundamentally off-persona or repeats memory)
 * This is memory doing real work (consistency enforcement), not just a
 * "have I posted this URL before" check.
 */
async function critiquePost(persona, draft) {
  const system = persona.systemPrompt();
  const recent = recentMemory(persona.agentId, 8);

  const recentSummaries = recent.length
    ? recent.map((r) => `- ${r.summary}`).join("\n")
    : "(nothing published yet — no repetition risk)";

  const prompt = `Review this DRAFT post before it gets published. You are acting as an editor checking
for voice consistency and repetition, not re-doing the topic selection.

DRAFT TEXT:
"""
${draft.text}
"""

DRAFT RATIONALE: ${draft.rationale}

RECENTLY PUBLISHED SUMMARIES (check for repetition/contradiction):
${recentSummaries}

Style fingerprint you must match: length ${persona.styleFingerprint.typicalLength}; ${persona.styleFingerprint.tone}
${persona.styleFingerprint.structure} Never use: ${persona.styleFingerprint.avoid.join(", ")}.

Decide:
- "approve" if the draft matches voice/style and does not repeat/contradict recent posts.
- "revise" if it's fixable — return corrected "text" that fixes style or trims repetition overlap.
- "veto" if it substantially repeats a recent post's core topic or fundamentally contradicts a stance
  you've taken before, and cannot be reasonably fixed by a revision.

Return ONLY JSON: {"decision": "approve"|"revise"|"veto", "text": "<final or revised text, omit/empty if veto>", "notes": "<one sentence explaining the decision>"}`;

  const result = await completeJSON({ system, prompt, maxTokens: 1500 });

  if (!result.decision) throw new Error("Critic returned no decision");

  return {
    decision: result.decision,
    text: result.text ? result.text.trim() : draft.text,
    notes: result.notes || "",
  };
}

module.exports = { critiquePost };