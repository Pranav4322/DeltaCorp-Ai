/* =======================================================================
   DeltaCorp Ai Agent — frontend controller
   Standalone static app (Tailwind CDN, no build step). Talks to the
   backend's /api/* routes over fetch, using a configurable API base URL
   so this frontend/ folder can be hosted separately from backend/.
   ===================================================================== */

const LS_KEY_AGENT = "aac_agent_id";
const LS_KEY_API_BASE = "aac_api_base";
const POLL_MS = 12000;

let state = {
  agentId: localStorage.getItem(LS_KEY_AGENT) || null,
  apiBase: localStorage.getItem(LS_KEY_API_BASE) || "https://deltacorp-ai.onrender.com",
  activeTab: "overview",
  dispatchFilter: "all",
  polling: null,
  tickerInterval: null,
};

/* ---------------------------- helpers ---------------------------- */

function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString(undefined, {
    month: "short", day: "2-digit",
    year: sameYear ? undefined : "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function relTime(iso) {
  if (!iso) return "—";
  const diffMs = new Date(iso) - new Date();
  const mins = Math.round(diffMs / 60000);
  if (Math.abs(mins) < 1) return "any moment now";
  if (mins > 0) return mins < 60 ? `in ~${mins}m` : `in ~${Math.round(mins / 60)}h`;
  const am = Math.abs(mins);
  return am < 60 ? `${am}m overdue` : `${Math.round(am / 60)}h overdue`;
}

function fmtCountdown(iso) {
  if (!iso) return "—:—";
  const diffMs = new Date(iso) - new Date();
  if (diffMs <= 0) return "due now";
  const totalSec = Math.floor(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtAge(iso) {
  if (!iso) return "—";
  const diffMs = new Date() - new Date(iso);
  if (diffMs < 0) return "—";
  const mins = Math.floor(diffMs / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

function shortId(id) { return id ? id.slice(0, 8) : "—"; }

function estTokens(text) { return text ? Math.max(1, Math.round(text.length / 4)) : 0; }

function weightedScore(scores) {
  const s = scores || {};
  return 0.3 * (s.novelty || 0) + 0.3 * (s.relevance || 0) + 0.25 * (s.verifiability || 0) + 0.15 * (s.timeliness || 0);
}

function toast(msg, isErr) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "fixed bottom-5 right-5 z-[200] font-mono text-xs px-4 py-2.5 rounded-lg transition-all bg-slate-900 border " +
    (isErr ? "border-rose-500" : "border-emerald-500") + " opacity-100 translate-y-0";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.className = "fixed bottom-5 right-5 z-[200] font-mono text-xs px-4 py-2.5 rounded-lg transition-all bg-slate-900 border border-slate-800 opacity-0 translate-y-2 pointer-events-none";
  }, 3200);
}

async function api(path, opts) {
  const res = await fetch(state.apiBase + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const msg = (body && body.error) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

function emptyNote(msg) {
  return `<div class="text-center py-8 font-mono text-xs text-slate-600">${esc(msg)}</div>`;
}

/* ---------------------------- settings (now a page, not a modal) ---------------------------- */

$("#settings-cancel").addEventListener("click", () => showTab("overview"));
$("#settings-save").addEventListener("click", () => {
  const val = $("#settings-api-base").value.trim().replace(/\/$/, "");
  state.apiBase = val;
  localStorage.setItem(LS_KEY_API_BASE, val);
  toast("Backend URL updated — reconnecting…");
  if (state.agentId) startPolling(); else boot();
});
$("#settings-danger-reset").addEventListener("click", () => {
  toast("Not available in this build — no reset endpoint on the backend.", true);
});
$("#settings-danger-revoke").addEventListener("click", () => {
  setAgent(null);
  stopPolling();
  toast("Disconnected this browser from the agent.");
  showInit();
});

/* ---------------------------- init / agent switching ---------------------------- */

function setAgent(id) {
  state.agentId = id;
  if (id) localStorage.setItem(LS_KEY_AGENT, id);
  else localStorage.removeItem(LS_KEY_AGENT);
  updateAgentCard();
}

function updateAgentCard() {
  const dot = $("#agent-dot");
  const dotWrap = $("#agent-dot-wrap");
  const name = $("#agent-name");
  if (state.agentId) {
    dot.className = "w-1.5 h-1.5 rounded-full bg-emerald-400";
    dotWrap.className = "flex items-center gap-1.5 font-mono text-[10px] text-emerald-400";
    dotWrap.innerHTML = `<span id="agent-dot" class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>ON`;
    name.textContent = shortId(state.agentId);
    $("#agent-card").title = state.agentId;
  } else {
    dotWrap.className = "flex items-center gap-1.5 font-mono text-[10px] text-slate-600";
    dotWrap.innerHTML = `<span id="agent-dot" class="w-1.5 h-1.5 rounded-full bg-slate-700"></span>OFF`;
    name.textContent = "No agent";
    $("#agent-meta").textContent = "—";
    $("#agent-countdown").textContent = "—:—";
  }
}

function showInit(errMsg) {
  $("#init-screen").classList.remove("hidden");
  $all(".tab-panel").forEach((v) => v.classList.remove("active"));
  const errEl = $("#init-err");
  if (errMsg) { errEl.textContent = errMsg; errEl.classList.remove("hidden"); }
  else errEl.classList.add("hidden");
}

function hideInit() {
  $("#init-screen").classList.add("hidden");
  showTab(state.activeTab);
}

$("#init-domain").addEventListener("change", (e) => {
  $("#init-domain-custom").classList.toggle("hidden", e.target.value !== "custom");
});

$("#init-submit").addEventListener("click", async () => {
  const name = $("#init-name").value.trim();
  const domainSel = $("#init-domain").value;
  const domain = domainSel === "custom" ? $("#init-domain-custom").value.trim() : domainSel;
  if (!name || !domain) return showInit("Persona name and domain are both required.");
  $("#init-submit").disabled = true;
  try {
    const data = await api("/api/agent/init", {
      method: "POST",
      body: JSON.stringify({ persona: { name, domain } }),
    });
    setAgent(data.agentId);
    toast(`Agent initialized: ${name} / ${domain}`);
    hideInit();
    startPolling();
    startTicker();
  } catch (err) {
    if (err.message.includes("already initialized")) {
      toast("That persona already exists — resume it with its agentId instead.", true);
    } else {
      showInit(err.message);
    }
  } finally {
    $("#init-submit").disabled = false;
  }
});

$("#resume-submit").addEventListener("click", async () => {
  const id = $("#resume-id").value.trim();
  if (!id) return;
  try {
    await api(`/api/agent/status?agentId=${encodeURIComponent(id)}`);
    setAgent(id);
    toast("Resumed agent " + shortId(id));
    hideInit();
    startPolling();
    startTicker();
  } catch (err) {
    showInit("Couldn't find that agent: " + err.message);
  }
});

$("#btn-generate").addEventListener("click", async () => {
  if (!state.agentId) return toast("No agent yet", true);
  try {
    await api("/api/agent/generate", { method: "POST", body: JSON.stringify({ agentId: state.agentId }) });
    toast("Generating a new post — refreshing…");
    await refreshAll();
  } catch (err) { toast(err.message, true); }
});

$("#btn-tick").addEventListener("click", async () => {
  if (!state.agentId) return toast("No agent yet", true);
  try {
    await api("/api/agent/debug/tick", { method: "POST", body: JSON.stringify({ agentId: state.agentId }) });
    toast("Forced a publish cycle — refreshing…");
    await refreshAll();
  } catch (err) { toast(err.message, true); }
});

$("#btn-audit").addEventListener("click", async () => {
  if (!state.agentId) return toast("No agent yet", true);
  try {
    await api("/api/agent/debug/audit", { method: "POST", body: JSON.stringify({ agentId: state.agentId }) });
    toast("Forced a claim audit — refreshing…");
    await refreshAll();
  } catch (err) { toast(err.message, true); }
});

/* ---------------------------- sidebar nav (tabs) ---------------------------- */

const BREADCRUMB_LABEL = {
  overview: "Overview", dispatch: "Dispatch", signal: "Signal Room", ledger: "Ledger",
  integrity: "Integrity", community: "Community", factcheck: "Fact Check", settings: "Settings",
};

$all("#sidebar-nav .nav-item").forEach((btn) => btn.addEventListener("click", () => showTab(btn.dataset.tab)));

function showTab(tab) {
  state.activeTab = tab;
  $all("#sidebar-nav .nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $all(".tab-panel").forEach((v) => v.classList.toggle("active", v.id === "tab-" + tab));
  $("#breadcrumb-page").textContent = BREADCRUMB_LABEL[tab] || tab;
  if (tab === "settings") $("#settings-api-base").value = state.apiBase;
}

/* ---------------------------- data fetch + render orchestration ---------------------------- */

let cache = { status: null, feed: [], rejected: [], track: null, logs: [], community: [], urlChecks: [] };

async function refreshAll() {
  if (!state.agentId) return;
  try {
    const [status, feed, rejected, track, logs, community, urlChecks] = await Promise.all([
      api(`/api/agent/status?agentId=${state.agentId}`),
      api(`/api/agent/feed?agentId=${state.agentId}`),
      api(`/api/agent/rejected?agentId=${state.agentId}`),
      api(`/api/agent/track-record?agentId=${state.agentId}`),
      api(`/api/agent/logs?agentId=${state.agentId}`),
      api(`/api/agent/community?agentId=${state.agentId}`),
      api(`/api/agent/url-checks?agentId=${state.agentId}`),
    ]);
    cache = {
      status, feed: feed.posts || [], rejected: rejected.rejected || [], track, logs: logs.logs || [],
      community: community.posts || [], urlChecks: urlChecks.checks || [],
    };
    renderSidebarAgent();
    renderOverview();
    renderDispatch();
    renderSignal();
    renderLedger();
    renderIntegrity();
    renderCommunity();
    renderFactCheck();
  } catch (err) {
    console.error(err);
    toast("Failed to refresh: " + err.message, true);
  }
}

function startPolling() {
  stopPolling();
  refreshAll();
  state.polling = setInterval(refreshAll, POLL_MS);
}
function stopPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = null;
}

function startTicker() {
  stopTicker();
  tickClock();
  state.tickerInterval = setInterval(tickClock, 1000);
}
function stopTicker() {
  if (state.tickerInterval) clearInterval(state.tickerInterval);
  state.tickerInterval = null;
}
function tickClock() {
  $("#sys-time").textContent = new Date().toLocaleTimeString();
  if (cache.status) {
    $("#sys-age").textContent = fmtAge(cache.status.createdAt);
    $("#agent-countdown").textContent = fmtCountdown(cache.status.nextPublishAfter);
    $("#ov-next-tick").textContent = fmtCountdown(cache.status.nextPublishAfter);
  }
}

/* ---------------------------- render: sidebar agent card ---------------------------- */

function renderSidebarAgent() {
  const { status } = cache;
  if (!status) return;
  $("#agent-name").textContent = status.name;
  $("#agent-meta").textContent = `${status.domain}`;
}

/* ---------------------------- render: Overview ---------------------------- */

function candidatesScannedFromLogs(logs) {
  const scoutLog = logs.find((l) => l.stage === "scout" && /Found \d+/.test(l.message));
  if (!scoutLog) return null;
  const m = scoutLog.message.match(/Found (\d+)/);
  return m ? Number(m[1]) : null;
}

function renderOverview() {
  const { status, track, feed, community, logs } = cache;
  if (!status) return;

  $("#ov-name").textContent = status.name;
  $("#ov-meta").textContent = `${status.domain} · Autonomous pipeline`;
  $("#ov-next-tick").textContent = fmtCountdown(status.nextPublishAfter);

  const todayStr = new Date().toDateString();
  const todayPosts = feed.filter((p) => new Date(p.createdAt).toDateString() === todayStr).length;
  $("#ov-today-posts").textContent = todayPosts;

  const scanned = candidatesScannedFromLogs(logs);
  $("#ov-sources").textContent = scanned === null ? "—" : scanned;

  $("#ov-stat-posts").textContent = status.postCount;
  const accuracy = track && track.accuracyRate !== null ? Math.round(track.accuracyRate * 100) + "%" : "—";
  $("#ov-stat-integrity").textContent = accuracy;
  $("#ov-stat-claims").textContent = track ? track.totalClaims - track.open : 0;
  $("#ov-stat-community").textContent = community.length;

  $("#ov-cfg-name").textContent = status.name;
  $("#ov-cfg-domain").textContent = status.domain;
  $("#ov-cfg-id").textContent = status.agentId;

  const stageColor = { scout: "text-cyan-400", curator: "text-cyan-400", writer: "text-cyan-400", critic: "text-amber-400", auditor: "text-emerald-400", scheduler: "text-slate-400", publish: "text-emerald-400" };
  $("#ov-log").innerHTML = logs.slice(0, 20).map((l) => {
    const t = new Date(l.createdAt);
    const time = isNaN(t) ? l.createdAt : t.toLocaleTimeString();
    return `<div><span class="text-slate-700">${esc(time)}</span> <span class="${stageColor[l.stage] || "text-slate-400"}">${esc(l.stage.toUpperCase())}</span> ${esc(l.message)}</div>`;
  }).join("") || emptyNote("No pipeline activity logged yet.");
}

/* ---------------------------- render: Dispatch ---------------------------- */

function headlineOf(text) {
  if (!text) return "";
  const m = text.match(/^(.{20,140}?[.!?])\s/);
  return m ? m[1] : (text.length > 140 ? text.slice(0, 137) + "…" : text);
}

function claimTagLabel(status) {
  return status === "confirmed" ? "Confirmed" : status === "corrected" ? "Corrected" : "Watching";
}
function claimTagClasses(status) {
  if (status === "confirmed") return "text-emerald-400 border-emerald-700/60";
  if (status === "corrected") return "text-rose-400 border-rose-700/60";
  return "text-amber-500/80 border-amber-800/60";
}

$all(".d-filter-btn").forEach((btn) => btn.addEventListener("click", () => {
  state.dispatchFilter = btn.dataset.filter;
  renderDispatch();
}));

function scoreBar(score, colorClass) {
  const pct = score === null || score === undefined ? 0 : Math.max(0, Math.min(100, score));
  return `<div class="h-1 bg-slate-800 rounded-full overflow-hidden mt-2"><div class="h-full ${colorClass}" style="width:${pct}%"></div></div>`;
}

function renderDispatch() {
  const { status, feed, rejected } = cache;
  if (!status) return;

  $all(".d-filter-btn").forEach((b) => {
    const active = b.dataset.filter === state.dispatchFilter;
    b.className = "d-filter-btn px-3 py-1 rounded-md text-[11px] font-mono transition " +
      (active ? "bg-cyan-500 text-slate-950 font-semibold" : "text-slate-400 hover:text-slate-100");
  });

  const acceptedItems = feed.map((p) => ({ kind: "accepted", createdAt: p.createdAt, data: p }));
  const declinedItems = rejected.map((r) => ({ kind: "declined", createdAt: r.createdAt, data: r }));
  let items = [...acceptedItems, ...declinedItems].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (state.dispatchFilter === "accepted") items = items.filter((i) => i.kind === "accepted");
  if (state.dispatchFilter === "declined") items = items.filter((i) => i.kind === "declined");

  const feedEl = $("#d-feed");
  if (!items.length) {
    feedEl.innerHTML = emptyNote("No dispatches yet. The Scout → Curator → Writer → Critic pipeline runs on its own jittered schedule — use \"Force tick\" above to see one immediately.");
    return;
  }

  feedEl.innerHTML = items.map((item) => {
    if (item.kind === "declined") {
      const r = item.data;
      const w = Math.round(weightedScore(r.scores) * 10);
      return `
      <div class="bg-slate-900/60 border-l-4 border-l-rose-500 border-y border-r border-slate-800 rounded-xl p-4">
        <div class="flex justify-between items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 mb-1.5 flex-wrap">
              <span class="stamp text-rose-400">Declined</span>
              <span class="text-[10.5px] font-mono text-slate-500 border border-slate-800 rounded px-1.5 py-0.5">${esc(status.domain)}</span>
              <span class="text-[10.5px] font-mono text-slate-600">${fmtDate(r.createdAt)}</span>
            </div>
            <div class="text-sm font-semibold text-slate-200 leading-snug">${esc(r.topic)}</div>
            <div class="text-[11px] text-amber-500/90 mt-1 flex items-center gap-1">⚠ ${esc(r.reason)}</div>
            ${scoreBar(w, "bg-rose-500")}
          </div>
          <div class="text-right shrink-0">
            <div class="text-2xl font-mono font-bold text-rose-400">${w}</div>
            <div class="text-[10px] font-mono text-slate-600">/100</div>
          </div>
        </div>
      </div>`;
    }

    const p = item.data;
    const isFollowUp = p.postType && p.postType !== "post";
    const isCorrection = p.postType === "correction";
    const scoreVal = p.score ?? null;
    const scoreColor = isCorrection ? "text-rose-400" : "text-emerald-400";
    const barColor = isCorrection ? "bg-rose-500" : "bg-emerald-500";
    const typeLabel = isFollowUp ? (isCorrection ? "Correction" : "Confirmation") : "Published";
    const badgeColor = isCorrection ? "text-rose-400" : "text-emerald-400";

    return `
    <div class="bg-slate-900/60 border-l-4 ${isCorrection ? "border-l-rose-500" : "border-l-emerald-500"} border-y border-r border-slate-800 rounded-xl p-4" id="post-${esc(p.id)}">
      <div class="flex justify-between items-start gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 mb-1.5 flex-wrap">
            <span class="stamp ${badgeColor}">${esc(typeLabel)}</span>
            <span class="text-[10.5px] font-mono text-slate-500 border border-slate-800 rounded px-1.5 py-0.5">${esc(status.domain)}</span>
            <span class="text-[10.5px] font-mono text-slate-600">${fmtDate(p.createdAt)}</span>
            <span class="text-[10.5px] font-mono text-slate-600">~${estTokens(p.text)} tokens</span>
          </div>
          <div class="text-sm font-semibold text-slate-100 leading-snug">${esc(headlineOf(p.text))}</div>
          ${p.rationale ? `<div class="text-[12px] italic text-slate-500 mt-1.5 leading-relaxed">${esc(p.rationale)}</div>` : ""}
          ${(p.claims || []).map((c) => `
            <div class="flex gap-2 items-baseline font-mono text-[10.5px] text-slate-500 py-1 border-t border-dashed border-slate-800 mt-2">
              <span class="shrink-0 px-1.5 py-0.5 text-[9px] tracking-wide uppercase border rounded ${claimTagClasses(c.status)}">${claimTagLabel(c.status)}</span>${esc(c.text)}
            </div>`).join("")}
          ${scoreVal !== null ? scoreBar(scoreVal, barColor) : ""}
        </div>
        <div class="text-right shrink-0">
          <div class="text-2xl font-mono font-bold ${scoreColor}">${scoreVal !== null ? scoreVal : "—"}</div>
          ${scoreVal !== null ? `<div class="text-[10px] font-mono text-slate-600">/100</div>` : ""}
        </div>
      </div>
    </div>`;
  }).join("");
}

/* ---------------------------- render: Signal Room ---------------------------- */

function strengthTier(weighted10) {
  if (weighted10 >= 7) return { label: "HIGH", cls: "text-rose-400 border-rose-500" };
  if (weighted10 >= 4.5) return { label: "MED", cls: "text-amber-400 border-amber-500" };
  return { label: "LOW", cls: "text-slate-500 border-slate-600" };
}

function renderSignal() {
  const { status, feed, rejected, track, logs } = cache;
  if (!status) return;

  const scanned = candidatesScannedFromLogs(logs);
  $("#s-source-count").textContent = scanned === null ? "—" : `${scanned} candidates`;

  const recent = [...feed].slice(0, 6);
  $("#s-feed").innerHTML = recent.length ? recent.map((p) => {
    const tier = strengthTier(p.score !== null && p.score !== undefined ? p.score / 10 : 5);
    return `
    <div class="py-3 first:pt-0 flex gap-3">
      <span class="shrink-0 font-mono text-[9.5px] font-bold border rounded px-1.5 py-0.5 h-fit ${tier.cls}">${tier.label}</span>
      <div class="min-w-0">
        <div class="text-[13px] text-cyan-300 font-medium truncate">${esc(status.domain)}</div>
        <div class="text-[12.5px] text-slate-400 leading-snug">${esc(headlineOf(p.text))}</div>
      </div>
    </div>`;
  }).join("") : emptyNote("Nothing published yet.");

  const stageColor = { scout: "text-amber-400", curator: "text-cyan-400", writer: "text-violet-400", critic: "text-cyan-400", auditor: "text-emerald-400", scheduler: "text-slate-500", publish: "text-emerald-400" };
  $("#s-log").innerHTML = logs.slice(0, 30).map((l) => {
    const t = new Date(l.createdAt);
    const time = isNaN(t) ? l.createdAt : t.toLocaleTimeString();
    return `<div><span class="text-slate-700">${esc(time)}</span> <span class="${stageColor[l.stage] || "text-slate-400"} font-semibold">${esc(l.stage.toUpperCase())}</span> ${esc(l.message)}</div>`;
  }).join("") || emptyNote("No pipeline activity logged yet.");

  const accuracy = track && track.accuracyRate !== null ? Math.round(track.accuracyRate * 100) : null;
  $("#s-accuracy").textContent = accuracy === null ? "—" : accuracy + "%";
  const circumference = 2 * Math.PI * 30;
  const filled = accuracy === null ? 0 : (accuracy / 100) * circumference;
  $("#s-gauge-arc").setAttribute("stroke-dasharray", `${filled.toFixed(1)} ${circumference.toFixed(1)}`);

  $("#s-breakdown").innerHTML = track ? `
    <span class="text-slate-500">confirmed <b class="text-emerald-400 font-medium">${track.confirmed}</b></span>
    <span class="text-slate-500">corrected <b class="text-rose-400 font-medium">${track.corrected}</b></span>
    <span class="text-slate-500">open <b class="text-slate-200 font-medium">${track.open}</b></span>` : "";

  const decl = rejected.slice(0, 4);
  $("#s-declined-count").textContent = rejected.length;
  $("#s-declined").innerHTML = decl.length ? decl.map((r) => {
    const w = Math.round(weightedScore(r.scores) * 10);
    return `
    <div class="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5">
      <div class="text-[13px] text-slate-200 font-medium leading-snug mb-1.5">${esc(r.topic)}</div>
      <div class="text-[11px] text-amber-500/90 mb-2">⚠ ${esc(r.reason)}</div>
      ${scoreBar(w, "bg-rose-500")}
      <div class="text-[10.5px] font-mono text-slate-500 mt-1.5">Score: ${w}/100</div>
    </div>`;
  }).join("") : emptyNote("No rejections logged yet.");
}

/* ---------------------------- render: Ledger (unified timeline) ---------------------------- */

const LEDGER_TYPE_STYLE = {
  Post: "text-cyan-400 border-cyan-700/50",
  Correction: "text-rose-400 border-rose-700/50",
  Confirmation: "text-emerald-400 border-emerald-700/50",
  Claim: "text-violet-400 border-violet-700/50",
};

function renderLedger() {
  const { status, feed, track } = cache;
  if (!status) return;

  const entries = [];
  feed.forEach((p) => {
    const type = p.postType === "correction" ? "Correction" : p.postType === "confirmation" ? "Confirmation" : "Post";
    entries.push({ date: p.createdAt, type, text: headlineOf(p.text) });
  });
  (track && track.claims ? track.claims : []).forEach((c) => {
    entries.push({ date: c.createdAt, type: "Claim", text: `"${c.claimText}"` });
  });
  entries.sort((a, b) => new Date(b.date) - new Date(a.date));

  $("#l-entries").innerHTML = entries.length ? entries.map((e) => `
    <tr>
      <td class="py-3 px-4 align-top font-mono text-xs text-slate-500 whitespace-nowrap">${fmtDate(e.date)}</td>
      <td class="py-3 px-2 align-top"><span class="stamp ${LEDGER_TYPE_STYLE[e.type] || "text-slate-400 border-slate-700"}">${esc(e.type)}</span></td>
      <td class="py-3 px-2 align-top text-slate-200 text-sm">${esc(e.text)}</td>
    </tr>`).join("") : `<tr><td colspan="3">${emptyNote("No entries yet.")}</td></tr>`;

  $("#l-balance").innerHTML = track ? `
    <div class="text-right"><div class="text-[10px] text-slate-500 uppercase tracking-wide">Confirmed</div><div class="text-xl font-semibold mt-0.5 text-emerald-400">${track.confirmed}</div></div>
    <div class="text-right"><div class="text-[10px] text-slate-500 uppercase tracking-wide">Corrected</div><div class="text-xl font-semibold mt-0.5 text-rose-400">${track.corrected}</div></div>
    <div class="text-right"><div class="text-[10px] text-slate-500 uppercase tracking-wide">Open</div><div class="text-xl font-semibold mt-0.5 text-slate-400">${track.open}</div></div>
    <div class="text-right"><div class="text-[10px] text-slate-500 uppercase tracking-wide">Accuracy to date</div><div class="text-xl font-semibold mt-0.5 text-cyan-400">${track.accuracyRate !== null ? Math.round(track.accuracyRate * 100) + "%" : "—"}</div></div>
  ` : "";
}

/* ---------------------------- render: Integrity Report ---------------------------- */

const CIRCUMFERENCE_150 = 2 * Math.PI * 62;

function renderIntegrity() {
  const { track } = cache;
  if (!track) return;

  const pct = track.confirmed + track.corrected > 0
    ? Math.round((track.confirmed / (track.confirmed + track.corrected)) * 100)
    : null;

  $("#i-donut-pct").textContent = pct === null ? "—" : pct + "%";
  const filled = pct === null ? 0 : (pct / 100) * CIRCUMFERENCE_150;
  $("#i-donut").setAttribute("stroke-dasharray", `${filled.toFixed(1)} ${CIRCUMFERENCE_150.toFixed(1)}`);
  $("#i-donut-sub").textContent = `${track.confirmed} confirmed · ${track.corrected} corrected · ${track.open} pending`;

  $("#i-total").textContent = track.totalClaims;
  $("#i-confirmed").textContent = track.confirmed;
  $("#i-corrected").textContent = track.corrected;
  $("#i-pending").textContent = track.open;

  const claims = (track.claims || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  $("#i-table").innerHTML = claims.length ? claims.map((c) => {
    let verdictHtml;
    if (c.status === "confirmed") verdictHtml = `<span class="stamp text-emerald-400">✓ Confirmed</span>`;
    else if (c.status === "corrected") verdictHtml = `<span class="stamp text-amber-400">⚠ Corrected</span>`;
    else verdictHtml = `<span class="stamp text-cyan-400">○ Pending</span>`;
    return `<tr>
      <td class="py-3 px-4 align-top font-mono text-xs text-slate-500 whitespace-nowrap">${fmtDate(c.createdAt)}</td>
      <td class="py-3 px-2 align-top text-slate-200 text-sm">${esc(c.claimText)}</td>
      <td class="py-3 px-2 align-top">${verdictHtml}</td>
      <td class="py-3 px-4 align-top font-mono text-xs text-slate-500 whitespace-nowrap">${c.resolvedAt ? fmtDate(c.resolvedAt) : "–"}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="4">${emptyNote("No claims made yet.")}</td></tr>`;
}

/* ---------------------------- render: Community ---------------------------- */

function renderCommunity() {
  const posts = cache.community || [];
  $("#c-feed").innerHTML = posts.length
    ? posts.map((p) => `
      <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
        <div class="flex items-center gap-2 mb-1.5">
          <span class="w-6 h-6 rounded-full bg-cyan-500/15 text-cyan-400 text-[11px] font-bold flex items-center justify-center shrink-0">${esc((p.author || "A")[0].toUpperCase())}</span>
          <span class="text-xs font-semibold text-slate-200">${esc(p.author || "Anonymous")}</span>
          <span class="font-mono text-[10.5px] text-slate-500">${fmtDate(p.createdAt)}</span>
        </div>
        <div class="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap pl-8">${esc(p.text)}</div>
      </div>`).join("")
    : emptyNote("No community posts yet — be the first to say something.");
}

$("#c-text").addEventListener("input", () => {
  $("#c-count").textContent = `${$("#c-text").value.length}/500`;
});

$("#c-submit").addEventListener("click", async () => {
  if (!state.agentId) return toast("No agent yet", true);
  const text = $("#c-text").value.trim();
  const author = $("#c-author").value.trim();
  if (!text) return toast("Write something first", true);

  $("#c-submit").disabled = true;
  try {
    await api("/api/agent/community", {
      method: "POST",
      body: JSON.stringify({ agentId: state.agentId, text, author }),
    });
    $("#c-text").value = "";
    $("#c-count").textContent = "0/500";
    toast("Posted!");
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $("#c-submit").disabled = false;
  }
});

/* ---------------------------- render: Fact Check ---------------------------- */

const VERDICT_STYLE = {
  "worth-covering": "text-emerald-400",
  "not-relevant": "text-slate-400",
  "needs-caution": "text-amber-400",
};

function renderFactCheck() {
  const checks = cache.urlChecks || [];
  $("#f-feed").innerHTML = checks.length
    ? checks.map((c) => {
        if (c.status === "failed") {
          return `
          <div class="bg-slate-900/60 border border-rose-900/50 rounded-2xl p-4">
            <div class="flex justify-between items-center mb-1.5 gap-2 flex-wrap">
              <a href="${esc(c.url)}" target="_blank" rel="noopener" class="text-xs text-slate-400 hover:text-slate-200 underline truncate max-w-[70%]">${esc(c.url)}</a>
              <span class="font-mono text-[10.5px] text-slate-500">${fmtDate(c.createdAt)}</span>
            </div>
            <div class="text-xs text-rose-400">${esc(c.error || "Check failed.")}</div>
          </div>`;
        }
        const r = c.result || {};
        const badge = VERDICT_STYLE[r.verdict] || "text-slate-400";
        return `
        <div class="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
          <div class="flex justify-between items-start gap-2 mb-2 flex-wrap">
            <div class="min-w-0">
              <div class="text-sm font-semibold text-slate-100 truncate">${esc(c.title || c.url)}</div>
              <a href="${esc(c.url)}" target="_blank" rel="noopener" class="text-[11px] text-slate-500 hover:text-slate-300 underline truncate block">${esc(c.url)}</a>
            </div>
            <span class="stamp whitespace-nowrap ${badge}">${esc(r.verdict || "—")}</span>
          </div>
          <div class="text-sm text-slate-300 leading-relaxed mb-2">${esc(r.summary || "")}</div>
          ${r.keyClaims && r.keyClaims.length ? `
          <div class="mb-2">
            <div class="text-[10.5px] uppercase tracking-wide text-slate-500 mb-1">Key claims</div>
            <ul class="list-disc list-inside text-xs text-slate-400 space-y-0.5">${r.keyClaims.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>
          </div>` : ""}
          ${r.credibilitySignals && r.credibilitySignals.length ? `
          <div class="mb-2">
            <div class="text-[10.5px] uppercase tracking-wide text-slate-500 mb-1">Credibility signals</div>
            <ul class="list-disc list-inside text-xs text-slate-400 space-y-0.5">${r.credibilitySignals.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>
          </div>` : ""}
          <div class="flex justify-between items-center mt-3 pt-2 border-t border-slate-800">
            <span class="text-[11px] text-slate-500 italic">${esc(r.notes || "")}</span>
            <span class="font-mono text-[10.5px] text-slate-500 whitespace-nowrap">relevance ${r.relevanceToDomain ?? "—"}/10 · ${esc(c.submittedBy || "Anonymous")} · ${fmtDate(c.createdAt)}</span>
          </div>
        </div>`;
      }).join("")
    : emptyNote("No URLs checked yet — paste one above.");
}

$("#f-submit").addEventListener("click", async () => {
  if (!state.agentId) return toast("No agent yet", true);
  const url = $("#f-url").value.trim();
  const submittedBy = $("#f-author").value.trim();
  if (!url) return toast("Paste a URL first", true);

  $("#f-submit").disabled = true;
  $("#f-loading").classList.remove("hidden");
  try {
    await api("/api/agent/check-url", {
      method: "POST",
      body: JSON.stringify({ agentId: state.agentId, url, submittedBy }),
    });
    $("#f-url").value = "";
    toast("Checked!");
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $("#f-submit").disabled = false;
    $("#f-loading").classList.add("hidden");
  }
});

/* ---------------------------- boot ---------------------------- */

function boot() {
  updateAgentCard();
  if (!state.agentId) return showInit();
  api(`/api/agent/status?agentId=${state.agentId}`)
    .then(() => { hideInit(); startPolling(); startTicker(); })
    .catch(() => { setAgent(null); showInit("Your previously saved agent could not be found on this backend."); });
}
boot();