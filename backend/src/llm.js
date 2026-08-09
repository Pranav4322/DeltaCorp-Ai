const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

/**
 * Multi-provider LLM wrapper with automatic fallback.
 *
 * Every pipeline stage (Curator, Writer, Critic, Auditor) calls only
 * `complete`/`completeJSON` below — they don't know or care which
 * provider actually answered. On each call, providers are tried in order
 * (Anthropic -> Gemini -> OpenRouter); if one throws (bad key, rate
 * limit, outage, timeout), the next configured provider is tried
 * automatically. A provider is only attempted if its API key env var is
 * set, so this works fine with just one key configured too.
 *
 * Keys are read from environment variables ONLY — see .env.example.
 * Never hardcode real keys here; this file is committed to a public repo.
 */

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-latest";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "chatgpt-5.6-luna";

const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

async function callAnthropic({ system, prompt, maxTokens }) {
  const resp = await anthropicClient.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function callGemini({ system, prompt, maxTokens }) {
  const key = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const resp = await axios.post(
    url,
    {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    },
    { timeout: 30000 }
  );
  const text = resp.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n");
  if (!text) throw new Error("Gemini returned no text (possibly blocked or empty candidates)");
  return text.trim();
}

async function callOpenRouter({ system, prompt, maxTokens }) {
  const key = process.env.OPENROUTER_API_KEY;
  const resp = await axios.post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: OPENROUTER_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // OpenRouter asks for these for attribution; harmless if ignored.
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "https://github.com",
        "X-Title": "Autonomous AI Creator",
      },
      timeout: 30000,
    }
  );
  const text = resp.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenRouter returned no text");
  return text.trim();
}

async function callOpenAI({ system, prompt, maxTokens }) {
  const key = process.env.OPENAI_API_KEY;
  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: OPENAI_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  const text = resp.data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI returned no text");
  return text.trim();
}

// Order = fallback priority. Each entry only runs if its key is set.
// OpenAI first, followed by Gemini — Anthropic/OpenRouter remain as fallback
const PROVIDERS = [
  { name: "openai", enabled: !!process.env.OPENAI_API_KEY, fn: callOpenAI },
  { name: "gemini", enabled: !!process.env.GEMINI_API_KEY, fn: callGemini },
  { name: "anthropic", enabled: !!process.env.ANTHROPIC_API_KEY, fn: callAnthropic },
  { name: "openrouter", enabled: !!process.env.OPENROUTER_API_KEY, fn: callOpenRouter },
];

/**
 * Calls the model and returns raw text, trying each configured provider
 * in order until one succeeds.
 */
async function complete({ system, prompt, maxTokens = 1000 }) {
  const active = PROVIDERS.filter((p) => p.enabled);
  if (!active.length) {
    throw new Error(
      "No LLM provider configured — set OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, and/or OPENROUTER_API_KEY in .env"
    );
  }

  let lastErr;
  for (const provider of active) {
    try {
      return await provider.fn({ system, prompt, maxTokens });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error(`[llm] ${provider.name} failed (${msg}) — trying next provider`);
      lastErr = err;
    }
  }
  throw new Error(`All LLM providers failed. Last error: ${lastErr.message}`);
}

/**
 * Models frequently emit literal newline/tab characters inside JSON string
 * values (e.g. paragraph breaks in a "text" field) instead of the escaped
 * \n / \t sequences strict JSON requires. A raw newline inside a string
 * makes JSON.parse throw "Unterminated string" the moment it hits that
 * line break. This walks the text char-by-char, tracking whether we're
 * inside a quoted string (respecting escape sequences), and escapes any
 * raw newline/tab/carriage-return it finds ONLY while inside a string —
 * whitespace outside strings (formatting between fields) is left alone.
 */
function sanitizeJsonWhitespace(text) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        result += char;
        escaped = false;
      } else if (char === "\\") {
        result += char;
        escaped = true;
      } else if (char === '"') {
        result += char;
        inString = false;
      } else if (char === "\n") {
        result += "\\n";
      } else if (char === "\r") {
        result += "\\r";
      } else if (char === "\t") {
        result += "\\t";
      } else {
        result += char;
      }
    } else {
      if (char === '"') inString = true;
      result += char;
    }
  }
  return result;
}

/**
 * Calls the model and expects strict JSON back. Strips markdown fences,
 * extracts just the {...} (or [...]) object/array out of the response so
 * any reasoning preamble/trailing commentary the model adds ("Wait, the
 * article says...") doesn't break parsing, sanitizes stray raw newlines
 * inside string values, and throws with the raw text attached if parsing
 * still fails, so callers can log/retry instead of silently crashing.
 */
function extractJsonSpan(text) {
  // Find the outermost {...} or [...] — whichever starts first — and
  // slice to its matching close. Handles models that prepend reasoning
  // text or append trailing commentary around the actual JSON payload.
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  let start = -1;
  let openChar, closeChar;
  if (firstBrace === -1 && firstBracket === -1) return text;
  if (firstBracket === -1 || (firstBrace !== -1 && firstBrace < firstBracket)) {
    start = firstBrace; openChar = "{"; closeChar = "}";
  } else {
    start = firstBracket; openChar = "["; closeChar = "]";
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start); // unbalanced — let JSON.parse report the real error
}

async function completeJSON({ system, prompt, maxTokens = 1000 }) {
  const raw = await complete({
    system: `${system}\n\nRespond with ONLY valid JSON. No markdown fences, no preamble, no explanation outside the JSON object. Any line breaks within a string value MUST be written as the two characters \\n, never as an actual newline.`,
    prompt,
    maxTokens,
  });

  const cleaned = raw.replace(/```json|```/g, "").trim();
  const extracted = extractJsonSpan(cleaned);
  const sanitized = sanitizeJsonWhitespace(extracted);
  try {
    return JSON.parse(sanitized);
  } catch (err) {
    const e = new Error(`Failed to parse JSON from model: ${err.message}`);
    e.raw = raw;
    throw e;
  }
}

module.exports = { complete, completeJSON, ANTHROPIC_MODEL, GEMINI_MODEL, OPENROUTER_MODEL, OPENAI_MODEL };
