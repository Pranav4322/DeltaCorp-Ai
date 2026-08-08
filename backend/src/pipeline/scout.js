const axios = require("axios");
const Parser = require("rss-parser");

const rssParser = new Parser({ timeout: 8000 });

/**
 * Scout is deliberately code-only (no LLM call). It just gathers raw
 * candidates from live sources. Editorial judgment happens later, in the
 * Curator — keeping discovery and judgment as separate stages is what
 * makes the "editorial judgment" criterion demonstrable instead of a
 * black box.
 *
 * Each candidate: { title, summary, url, source, publishedAt }
 */

async function fromHackerNews(limit = 15) {
  try {
    const topIds = await axios.get(
      "https://hacker-news.firebaseio.com/v0/topstories.json",
      { timeout: 8000 }
    );
    const ids = topIds.data.slice(0, limit);
    const items = await Promise.all(
      ids.map((id) =>
        axios
          .get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeout: 8000 })
          .then((r) => r.data)
          .catch(() => null)
      )
    );
    return items
      .filter(Boolean)
      .filter((it) => it.title && it.url)
      .map((it) => ({
        title: it.title,
        summary: it.title,
        url: it.url,
        source: "Hacker News",
        publishedAt: it.time ? new Date(it.time * 1000).toISOString() : new Date().toISOString(),
      }));
  } catch (err) {
    console.error("[scout] Hacker News fetch failed:", err.message);
    return [];
  }
}

async function fromArxiv(category = "cs.CR", limit = 10) {
  try {
    const url = `http://export.arxiv.org/api/query?search_query=cat:${category}&sortBy=submittedDate&sortOrder=descending&max_results=${limit}`;
    const feed = await rssParser.parseURL(url);
    return feed.items.map((it) => ({
      title: it.title?.replace(/\s+/g, " ").trim(),
      summary: (it.contentSnippet || it.content || "").replace(/\s+/g, " ").trim().slice(0, 500),
      url: it.link,
      source: `arXiv (${category})`,
      publishedAt: it.isoDate || new Date().toISOString(),
    }));
  } catch (err) {
    console.error(`[scout] arXiv fetch failed for ${category}:`, err.message);
    return [];
  }
}

async function fromGithubTrending(query = "AI agent security", limit = 10) {
  try {
    // GitHub search API as a stand-in for "trending" — real live data,
    // no scraping, works with an unauthenticated request (rate-limited).
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const resp = await axios.get("https://api.github.com/search/repositories", {
      params: {
        q: `${query} created:>${since}`,
        sort: "stars",
        order: "desc",
        per_page: limit,
      },
      headers: { Accept: "application/vnd.github+json", "User-Agent": "autonomous-ai-creator" },
      timeout: 8000,
    });
    return (resp.data.items || []).map((repo) => ({
      title: `${repo.full_name}: ${repo.description || "no description"}`,
      summary: repo.description || "",
      url: repo.html_url,
      source: "GitHub (trending/new)",
      publishedAt: repo.created_at,
    }));
  } catch (err) {
    console.error("[scout] GitHub fetch failed:", err.message);
    return [];
  }
}

async function fromSecurityRss() {
  const feeds = [
    "https://feeds.feedburner.com/TheHackersNews",
    "https://krebsonsecurity.com/feed/",
  ];
  const results = await Promise.all(
    feeds.map((f) =>
      rssParser
        .parseURL(f)
        .then((feed) =>
          feed.items.slice(0, 8).map((it) => ({
            title: it.title,
            summary: (it.contentSnippet || "").slice(0, 400),
            url: it.link,
            source: feed.title || f,
            publishedAt: it.isoDate || new Date().toISOString(),
          }))
        )
        .catch((err) => {
          console.error(`[scout] RSS fetch failed for ${f}:`, err.message);
          return [];
        })
    )
  );
  return results.flat();
}

/**
 * Runs all sources relevant to the persona's domain in parallel and
 * returns a deduplicated candidate list. Domain -> source mapping is
 * intentionally simple; swap/add sources per persona as needed.
 */
async function discoverCandidates(persona) {
  const domain = persona.domain;

  const tasks = [fromHackerNews(20)];

  if (domain === "AI Security") {
    tasks.push(fromArxiv("cs.CR", 10), fromSecurityRss(), fromGithubTrending("AI security agent", 8));
  } else if (domain === "Machine Learning Engineering") {
    tasks.push(fromArxiv("cs.LG", 10), fromGithubTrending("LLM inference training", 8));
  } else {
    tasks.push(fromArxiv("cs.AI", 10), fromGithubTrending("AI product tool", 8));
  }

  const results = (await Promise.all(tasks)).flat();

  // Dedup by URL
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    deduped.push(r);
  }
  return deduped;
}

module.exports = { discoverCandidates, fromHackerNews, fromArxiv, fromGithubTrending, fromSecurityRss };
