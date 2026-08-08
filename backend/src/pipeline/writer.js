const { completeJSON } = require("../llm");
const { memoryDigest } = require("../memory");

/**
 * Writer drafts the actual post text + rationale, grounded strictly in
 * the winning candidate's title/summary/source (never invents facts).
 * It also receives the runner-up candidates that were NOT chosen this
 * cycle, so the rationale can honestly explain what it beat — this is
 * what satisfies "why this topic over other candidates" in the spec's
 * rationale requirement, using data the Curator already produced.
 */
async function writePost(persona, winner, runnersUp) {
  const system = persona.systemPrompt();
  const digest = memoryDigest(persona.agentId);

  const runnersUpText = runnersUp.length
    ? runnersUp
        .slice(0, 3)
        .map((r) => `- "${r.candidate.title}" (weighted score ${r.weighted.toFixed(1)}: ${r.reason})`)
        .join("\n")
    : "(no other candidates cleared initial scoring this cycle)";

  const prompt = `${digest}

You are writing your next post. Ground every factual claim ONLY in the material below — never invent
details, numbers, or quotes that are not supported by it.

CHOSEN TOPIC:
Title: ${winner.candidate.title}
Summary: ${winner.candidate.summary}
Source: ${winner.candidate.source}
URL: ${winner.candidate.url}
Why it was selected (editorial reasoning): ${winner.reason}
Scores: novelty=${winner.scores.novelty} relevance=${winner.scores.relevance} verifiability=${winner.scores.verifiability} timeliness=${winner.scores.timeliness}

CANDIDATES CONSIDERED AND NOT CHOSEN THIS CYCLE:
${runnersUpText}

Write:
1. "text": the post itself, in your voice, following your style fingerprint exactly. Do not include
   hashtags, emoji, or a link inline (the source is attached separately) — write it as it would appear
   on a professional feed.
2. "rationale": 2-4 sentences covering (a) why this topic was selected, (b) why it's relevant right now,
   (c) briefly why it was chosen over the other candidates considered this cycle. Written in third person,
   as an editorial note, not in the post's own voice.
3. "topicKey": a short kebab-case key identifying this topic for future dedup, e.g. "claude-computer-use-cve".
4. "entities": array of 2-5 short strings — the key tools/orgs/CVEs/papers this post is about, for memory.
5. "claims": array of 0-2 short, FALSIFIABLE predictions or assertions this specific post makes that could be
   proven right or wrong later (e.g. "this CVE will get a patch within a week", "this benchmark result won't
   reproduce outside the vendor's own harness"). Skip purely descriptive posts with nothing to verify — an
   empty array is a normal, expected answer. Each entry: {"text": "<the falsifiable claim, self-contained
   sentence, no pronouns referring back to the post>", "checkAfterHours": <int, 12-72, how long until there's
   plausibly enough new evidence to check it>}.

Return ONLY a JSON object: {"text": "...", "rationale": "...", "topicKey": "...", "entities": ["...", "..."], "claims": [{"text": "...", "checkAfterHours": 24}]}`;

  const draft = await completeJSON({ system, prompt, maxTokens: 2000 });

  if (!draft.text || !draft.rationale) {
    throw new Error("Writer returned incomplete draft");
  }

  const claims = Array.isArray(draft.claims)
    ? draft.claims
        .filter((c) => c && c.text)
        .slice(0, 2)
        .map((c) => ({
          text: String(c.text).trim(),
          checkAfterHours: Math.min(72, Math.max(12, parseInt(c.checkAfterHours, 10) || 24)),
        }))
    : [];

  return {
    text: draft.text.trim(),
    rationale: draft.rationale.trim(),
    topicKey: draft.topicKey || winner.candidate.url,
    entities: Array.isArray(draft.entities) ? draft.entities : [],
    sources: [winner.candidate.url],
    claims,
  };
}

module.exports = { writePost };
