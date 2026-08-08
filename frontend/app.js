/* =======================================================================
   Autonomous AI Creator — frontend controller
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
  activeTab: "dispatch",
  polling: null,
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

function shortId(id) { return id ? id.slice(0, 8) : "—"; }

function toast(msg, isErr) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "fixed bottom-5 right-5 z-[200] font-mono text-xs px-4 py-2.5 rounded-lg transition-all bg-zinc-900 border " +
    (isErr ? "border-rose-500" : "border-emerald-500") + " opacity-100 translate-y-0";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.className = "fixed bottom-5 right-5 z-[200] font-mono text-xs px-4 py-2.5 rounded-lg transition-all bg-zinc-900 border border-zinc-800 opacity-0 translate-y-2 pointer-events-none";
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

/* ---------------------------- settings modal ---------------------------- */

$("#btn-settings").addEventListener("click", () => {
  $("#settings-api-base").value = state.apiBase;
  $("#settings-modal").classList.remove("hidden");
  $("#settings-modal").classList.add("flex");
});
$("#settings-cancel").addEventListener("click", closeSettings);
function closeSettings() {
  $("#settings-modal").classList.add("hidden");
  $("#settings-modal").classList.remove("flex");
}
$("#settings-save").addEventListener("click", () => {
  const val = $("#settings-api-base").value.trim().replace(/\/$/, "");
  state.apiBase = val;
  localStorage.setItem(LS_KEY_API_BASE, val);
  closeSettings();
  toast("Backend URL updated — reconnecting…");
  if (state.agentId) startPolling(); else boot();
});

/* ---------------------------- init / agent switching ---------------------------- */

function setAgent(id) {
  state.agentId = id;
  if (id) localStorage.setItem(LS_KEY_AGENT, id);
  else localStorage.removeItem(LS_KEY_AGENT);
  updateAgentPill();
}

function updateAgentPill() {
  const dot = $("#agent-dot");
  const text = $("#agent-pill-text");
  if (state.agentId) {
    dot.className = "w-1.5 h-1.5 rounded-full bg-emerald-400";
    text.textContent = shortId(state.agentId);
    $("#agent-pill").title = state.agentId;
  } else {
    dot.className = "w-1.5 h-1.5 rounded-full bg-zinc-600";
    text.textContent = "no agent";
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

/* ---------------------------- tabs ---------------------------- */

const TAB_ACTIVE_CLASSES = {
  dispatch: "bg-amber-400/10 text-amber-300",
  signal: "bg-cyan-400/10 text-cyan-300",
  ledger: "bg-emerald-400/10 text-emerald-300",
  integrity: "bg-violet-400/10 text-violet-300",
  community: "bg-sky-400/10 text-sky-300",
};

$all(".tab-btn").forEach((btn) => btn.addEventListener("click", () => showTab(btn.dataset.tab)));

function showTab(tab) {
  state.activeTab = tab;
  $all(".tab-btn").forEach((b) => {
    const isActive = b.dataset.tab === tab;
    b.className = "tab-btn px-3 py-1.5 rounded-lg text-xs font-mono tracking-wide transition " +
      (isActive ? TAB_ACTIVE_CLASSES[tab] + " font-semibold" : "text-zinc-400 hover:text-zinc-100");
  });
  $all(".tab-panel").forEach((v) => v.classList.toggle("active", v.id === "tab-" + tab));
}

/* ---------------------------- data fetch + render orchestration ---------------------------- */

let cache = { status: null, feed: [], rejected: [], track: null, logs: [], community: [] };

async function refreshAll() {
  if (!state.agentId) return;
  try {
    const [status, feed, rejected, track, logs, community] = await Promise.all([
      api(`/api/agent/status?agentId=${state.agentId}`),
      api(`/api/agent/feed?agentId=${state.agentId}`),
      api(`/api/agent/rejected?agentId=${state.agentId}`),
      api(`/api/agent/track-record?agentId=${state.agentId}`),
      api(`/api/agent/logs?agentId=${state.agentId}`),
      api(`/api/agent/community?agentId=${state.agentId}`),
    ]);
    cache = { status, feed: feed.posts || [], rejected: rejected.rejected || [], track, logs: logs.logs || [], community: community.posts || [] };
    renderDispatch();
    renderSignal();
    renderLedger();
    renderIntegrity();
    renderCommunity();
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

function renderDispatch() {
  const { status, feed } = cache;
  if (!status) return;
  $("#d-title").textContent = `${status.name} — the Wire`;
  $("#d-sub").textContent = `${status.domain} · Autonomous Dispatch`;
  $("#d-live").innerHTML = `Live since ${fmtDate(status.createdAt)}<br>Next transmission ${relTime(status.nextPublishAfter)}`;

  const stages = [
    ["Scout", cache.logs.filter((l) => l.stage === "scout").length],
    ["Curator", status.postCount + status.rejectedCount],
    ["Writer", status.postCount],
    ["Critic", status.postCount],
    ["Auditor", (cache.track && cache.track.totalClaims) || 0],
  ];
  $("#d-transmission").innerHTML = stages.map(([name, n], i) => `
    <div class="flex-1 min-w-[80px] pt-2.5 px-2 border-t-2 ${i < 4 ? "border-amber-400 text-amber-400" : "border-zinc-800"}">
      ${esc(name)}<span class="block font-headline text-base ${i < 4 ? "text-amber-300" : "text-zinc-200"} mt-1">${n}</span>
    </div>`).join("");

  const feedEl = $("#d-feed");
  if (!feed.length) {
    feedEl.innerHTML = emptyNote("No dispatches yet. The Scout → Curator → Writer → Critic pipeline runs on its own jittered schedule — use \"force tick\" above to see one immediately.");
    return;
  }
  feedEl.innerHTML = feed.map((p) => {
    const num = p.id ? p.id.slice(0, 4).toUpperCase() : "----";
    if (p.postType && p.postType !== "post") {
      const isCorrection = p.postType === "correction";
      return `
      <article class="py-8" id="post-${esc(p.id)}">
        <div class="flex justify-between font-mono text-[11px] tracking-wide mb-2.5 ${isCorrection ? "text-rose-400" : "text-amber-400"}"><span class="text-zinc-500">FOLLOW-UP · ${num}</span><span>${fmtDate(p.createdAt)}</span></div>
        <div class="inline-flex items-center gap-1.5 font-mono text-[10.5px] tracking-wide uppercase px-2.5 py-1 border rounded mb-3 ${isCorrection ? "border-rose-500 text-rose-400" : "border-amber-500 text-amber-400"}">${isCorrection ? "Correction" : "Confirmed"}</div>
        ${p.refersToPostId ? `<div class="font-mono text-[10.5px] text-zinc-500 -mt-1 mb-4">Re: dispatch <a class="text-emerald-400 cursor-pointer hover:underline" onclick="document.getElementById('post-${esc(p.refersToPostId)}')?.scrollIntoView({behavior:'smooth'})">${shortId(p.refersToPostId)}</a></div>` : ""}
        <p class="text-[15px] leading-relaxed text-zinc-300 mb-4 whitespace-pre-wrap">${esc(p.text)}</p>
        <div class="font-mono text-[10.5px] text-zinc-600">SRC: ${(p.sources || []).slice(0, 1).map(esc).join(", ") || "internal re-check"}</div>
      </article>`;
    }
    return `
    <article class="py-8" id="post-${esc(p.id)}">
      <div class="flex justify-between font-mono text-[11px] text-amber-400 tracking-wide mb-2.5"><span class="text-zinc-500">DISPATCH · ${num}</span><span>${fmtDate(p.createdAt)}</span></div>
      <h2 class="font-headline text-xl font-semibold text-zinc-50 mb-3 leading-snug">${esc(headlineOf(p.text))}</h2>
      <p class="text-[15px] leading-relaxed text-zinc-300 mb-4 whitespace-pre-wrap">${esc(p.text)}</p>
      ${p.rationale ? `<p class="text-[13px] italic text-zinc-500 border-l-2 border-zinc-800 pl-3.5 mb-4 leading-relaxed">${esc(p.rationale)}</p>` : ""}
      <div class="flex gap-4 flex-wrap font-mono text-[10.5px] text-zinc-600 mb-1">
        <span>SRC: ${(p.sources || []).slice(0, 1).map(esc).join(", ") || "—"}</span>
        ${(p.sources || [])[0] ? `<a href="${esc(p.sources[0])}" target="_blank" rel="noopener" class="text-zinc-500 hover:text-amber-400 underline decoration-dotted">Full transmission →</a>` : ""}
      </div>
      ${(p.claims || []).map((c) => `
        <div class="flex gap-2.5 items-baseline font-mono text-[11px] text-zinc-500 py-1.5 border-t border-dashed border-zinc-800 mt-2">
          <span class="shrink-0 px-1.5 py-0.5 text-[9.5px] tracking-wide uppercase border rounded ${claimTagClasses(c.status)}">${claimTagLabel(c.status)}</span>${esc(c.text)}
        </div>`).join("")}
    </article>`;
  }).join("");
}

function emptyNote(msg) {
  return `<div class="text-center py-8 font-mono text-xs text-zinc-600">${esc(msg)}</div>`;
}

/* ---------------------------- render: Signal Room ---------------------------- */

function renderSignal() {
  const { status, feed, rejected, track, logs } = cache;
  if (!status) return;
  $("#s-meta").textContent = `agent_${shortId(status.agentId)} · ${status.name} / ${status.domain}`;

  const lastLog = logs[0];
  $("#s-status").textContent = lastLog ? `cycle activity — ${lastLog.stage} stage` : "idle — waiting for first cycle";

  const order = ["scout", "curator", "writer", "critic", "auditor"];
  const idx = order.indexOf(lastLog ? lastLog.stage : null);
  const stationDefs = [
    ["Scout", `found <b class="text-cyan-300">${logs.filter(l => l.stage === "scout").length}</b>`],
    ["Curator", `accept <b class="text-cyan-300">${status.postCount}</b> · reject ${status.rejectedCount}`],
    ["Writer", `drafted <b class="text-cyan-300">${status.postCount}</b>`],
    ["Critic", `approved <b class="text-cyan-300">${status.postCount}</b>`],
    ["Auditor", `${track ? track.open : 0} claims open`],
  ];
  $("#s-rail").innerHTML = stationDefs.map(([name, countHtml], i) => {
    const active = i <= idx;
    return `
    <div class="flex-1 min-w-[110px] text-center px-1.5">
      <div class="w-3.5 h-3.5 rounded-full mx-auto mb-2.5 border-2 ${active ? "bg-cyan-400 border-cyan-400 shadow-[0_0_0_5px_rgba(79,184,196,0.15)]" : "bg-zinc-900 border-zinc-600"}"></div>
      <div class="text-xs font-medium text-zinc-200">${name}</div>
      <div class="font-mono text-[11px] text-zinc-500 mt-0.5">${countHtml}</div>
    </div>`;
  }).join("");

  const recent = feed.slice(0, 5);
  $("#s-feed").innerHTML = recent.length ? recent.map((p) => {
    const typeClasses = p.postType === "correction" ? "bg-rose-500/15 text-rose-400" : p.postType === "confirmation" ? "bg-emerald-500/15 text-emerald-400" : "bg-cyan-500/15 text-cyan-400";
    return `
    <div class="py-3 first:pt-0">
      <div class="flex justify-between items-baseline mb-1.5 gap-2">
        <span class="font-mono text-[9.5px] uppercase tracking-wide px-1.5 py-0.5 rounded ${typeClasses}">${esc(p.postType || "post")}</span>
        <span class="font-mono text-[10.5px] text-zinc-500 whitespace-nowrap">${fmtDate(p.createdAt)}</span>
      </div>
      <div class="text-[13.5px] leading-relaxed text-zinc-200">${esc(headlineOf(p.text))}</div>
    </div>`;
  }).join("") : emptyNote("Nothing published yet.");

  const decl = rejected.slice(0, 5);
  $("#s-declined").innerHTML = decl.length ? decl.map((r) => {
    const s = r.scores || {};
    const w = (0.3 * (s.novelty||0) + 0.3 * (s.relevance||0) + 0.25 * (s.verifiability||0) + 0.15 * (s.timeliness||0)).toFixed(1);
    return `<div class="flex justify-between gap-2 py-2 first:pt-0 font-mono text-[11.5px] text-zinc-500"><span>${esc(r.topic)}</span><span class="text-rose-400 shrink-0">${w}</span></div>`;
  }).join("") : emptyNote("No rejections logged yet.");

  const accuracy = track && track.accuracyRate !== null ? Math.round(track.accuracyRate * 100) : null;
  $("#s-accuracy").textContent = accuracy === null ? "—" : accuracy + "%";
  const circumference = 2 * Math.PI * 30;
  const filled = accuracy === null ? 0 : (accuracy / 100) * circumference;
  $("#s-gauge-arc").setAttribute("stroke-dasharray", `${filled.toFixed(1)} ${circumference.toFixed(1)}`);

  $("#s-breakdown").innerHTML = track ? `
    <span class="text-zinc-500">confirmed <b class="text-emerald-400 font-medium">${track.confirmed}</b></span>
    <span class="text-zinc-500">corrected <b class="text-rose-400 font-medium">${track.corrected}</b></span>
    <span class="text-zinc-500">open <b class="text-zinc-200 font-medium">${track.open}</b></span>` : "";

  const stageColor = { scout: "text-cyan-400", curator: "text-cyan-400", writer: "text-cyan-400", critic: "text-amber-400", auditor: "text-emerald-400", scheduler: "text-violet-400" };
  $("#s-log").innerHTML = logs.slice(0, 25).map((l) => {
    const t = new Date(l.createdAt);
    const time = isNaN(t) ? l.createdAt : t.toLocaleTimeString();
    return `<div><span class="text-zinc-700">${esc(time)}</span> <span class="${stageColor[l.stage] || "text-zinc-400"}">${esc(l.stage)}</span> ${esc(l.message)}</div>`;
  }).join("") || emptyNote("No pipeline activity logged yet.");
}

/* ---------------------------- render: Ledger ---------------------------- */

function renderLedger() {
  const { status, feed, rejected, track } = cache;
  if (!status) return;
  $("#l-sub").textContent = `${status.name} · ${status.domain} desk · maintained since ${fmtDate(status.createdAt)}`;
  $("#l-book").innerHTML = `${status.postCount} entries published<br>Balance carried forward`;

  const posts = feed.filter((p) => p.postType === "post");
  $("#l-posts").innerHTML = posts.length ? posts.map((p) => `
    <tr>
      <td class="py-3 pr-2 align-top font-mono text-xs text-zinc-500 whitespace-nowrap">${fmtDate(p.createdAt)}</td>
      <td class="py-3 pr-2 align-top font-mono text-xs text-zinc-500">${esc(p.postType || "post")}</td>
      <td class="py-3 align-top">
        <div class="font-semibold text-zinc-100">${esc(headlineOf(p.text))}</div>
        ${p.rationale ? `<div class="italic text-zinc-500 text-xs mt-1">${esc(p.rationale)}</div>` : ""}
      </td>
    </tr>`).join("") : `<tr><td colspan="3">${emptyNote("No entries yet.")}</td></tr>`;

  const claims = (track && track.claims) || [];
  $("#l-claims").innerHTML = claims.length ? claims.map((c) => {
    const cls = c.status === "confirmed" ? "border-amber-500 text-amber-400" : c.status === "corrected" ? "border-rose-500 text-rose-400" : "border-zinc-600 text-zinc-500";
    const label = c.status === "confirmed" ? "Confirmed" : c.status === "corrected" ? "Corrected" : "Open";
    return `<tr>
      <td class="py-3 pr-2 align-top font-mono text-xs text-zinc-500 whitespace-nowrap">${fmtDate(c.createdAt)}</td>
      <td class="py-3 pr-2 align-top italic text-zinc-300 text-sm">"${esc(c.claimText)}"</td>
      <td class="py-3 pr-2 align-top"><span class="inline-block font-mono text-[10px] uppercase tracking-wide px-2 py-0.5 border rounded ${cls}">${label}</span></td>
      <td class="py-3 align-top font-mono text-xs text-zinc-500 whitespace-nowrap">${c.resolvedAt ? fmtDate(c.resolvedAt) : "—"}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="4">${emptyNote("No claims made yet.")}</td></tr>`;

  $("#l-balance").innerHTML = track ? `
    <div class="text-right"><div class="text-[10px] text-zinc-500 uppercase tracking-wide">Confirmed</div><div class="text-xl font-semibold mt-0.5">${track.confirmed}</div></div>
    <div class="text-right"><div class="text-[10px] text-zinc-500 uppercase tracking-wide">Corrected</div><div class="text-xl font-semibold mt-0.5 text-rose-400">${track.corrected}</div></div>
    <div class="text-right"><div class="text-[10px] text-zinc-500 uppercase tracking-wide">Open</div><div class="text-xl font-semibold mt-0.5 text-zinc-400">${track.open}</div></div>
    <div class="text-right"><div class="text-[10px] text-zinc-500 uppercase tracking-wide">Accuracy to date</div><div class="text-xl font-semibold mt-0.5 text-amber-400">${track.accuracyRate !== null ? Math.round(track.accuracyRate * 100) + "%" : "—"}</div></div>
  ` : "";

  $("#l-declined").innerHTML = rejected.length ? rejected.slice(0, 8).map((r) => {
    const s = r.scores || {};
    const w = (0.3 * (s.novelty||0) + 0.3 * (s.relevance||0) + 0.25 * (s.verifiability||0) + 0.15 * (s.timeliness||0)).toFixed(1);
    return `<div class="flex justify-between gap-4 py-2.5 first:pt-0 font-mono text-xs"><span class="text-zinc-300">"${esc(r.topic)}"</span><span class="text-zinc-500 italic text-right">${esc(r.reason)} · <span class="text-rose-400 not-italic">${w}/10</span></span></div>`;
  }).join("") : emptyNote("Nothing declined yet.");
}

/* ---------------------------- render: Integrity Report ---------------------------- */

function renderIntegrity() {
  const { status, track } = cache;
  if (!status) return;
  $("#i-id").textContent = `Integrity report · agent_${shortId(status.agentId)}`;
  $all("#tab-integrity h1")[0].textContent = `${status.name} — ${status.domain}`;

  if (!track || !track.totalClaims) {
    $("#i-range").textContent = fmtDate(status.createdAt) + " — now";
    $("#i-score").textContent = "—";
    $("#i-delta").innerHTML = "&nbsp;";
    $("#i-tallies").innerHTML = "";
    $("#i-chart").innerHTML = `<text x="450" y="135" fill="#71717a" font-size="13" text-anchor="middle">No resolved claims yet — the Auditor re-checks each claim once its check window passes.</text>`;
    $("#i-events").innerHTML = emptyNote("Nothing resolved yet.");
    return;
  }

  const resolved = track.claims
    .filter((c) => c.status === "confirmed" || c.status === "corrected")
    .slice()
    .sort((a, b) => new Date(a.resolvedAt || a.createdAt) - new Date(b.resolvedAt || b.createdAt));

  let conf = 0, corr = 0;
  const traj = resolved.map((c) => {
    if (c.status === "confirmed") conf++; else corr++;
    return { ...c, score: Math.round((conf / (conf + corr)) * 100) };
  });

  const finalScore = traj.length ? traj[traj.length - 1].score : null;
  $("#i-score").textContent = finalScore === null ? "—" : finalScore;
  $("#i-range").textContent = `${fmtDate(status.createdAt)} — ${fmtDate(new Date().toISOString())}`;
  $("#i-range").innerHTML += `<br>${track.totalClaims - track.open} claims resolved · ${track.open} open`;

  if (traj.length >= 2) {
    const delta = traj[traj.length - 1].score - traj[traj.length - 2].score;
    $("#i-delta").textContent = `${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta)} pts since last resolution`;
    $("#i-delta").className = "text-sm mt-1.5 font-medium " + (delta >= 0 ? "text-emerald-400" : "text-rose-400");
  } else {
    $("#i-delta").innerHTML = "&nbsp;";
  }

  $("#i-tallies").innerHTML = `
    <div class="text-center bg-zinc-900 border border-zinc-800 rounded-xl px-5 py-3 min-w-[88px]"><div class="font-headline text-2xl font-semibold text-emerald-400">${track.confirmed}</div><div class="text-[9.5px] text-zinc-500 uppercase tracking-wide mt-1">Confirmed</div></div>
    <div class="text-center bg-zinc-900 border border-zinc-800 rounded-xl px-5 py-3 min-w-[88px]"><div class="font-headline text-2xl font-semibold text-rose-400">${track.corrected}</div><div class="text-[9.5px] text-zinc-500 uppercase tracking-wide mt-1">Corrected</div></div>
    <div class="text-center bg-zinc-900 border border-zinc-800 rounded-xl px-5 py-3 min-w-[88px]"><div class="font-headline text-2xl font-semibold text-violet-400">${track.open}</div><div class="text-[9.5px] text-zinc-500 uppercase tracking-wide mt-1">Open</div></div>`;

  const left = 60, right = 870, top = 40, bottom = 220;
  const yFor = (score) => bottom - (score / 100) * (bottom - top);
  const n = traj.length;
  const xFor = (i) => n <= 1 ? (left + right) / 2 : left + (i / (n - 1)) * (right - left);

  let svg = `
    <defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="4.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter></defs>
    <line x1="${left}" y1="40" x2="${right}" y2="40" stroke="#3f3f46" stroke-width="1"/>
    <line x1="${left}" y1="100" x2="${right}" y2="100" stroke="#3f3f46" stroke-width="1"/>
    <line x1="${left}" y1="160" x2="${right}" y2="160" stroke="#3f3f46" stroke-width="1"/>
    <line x1="${left}" y1="220" x2="${right}" y2="220" stroke="#3f3f46" stroke-width="1"/>
    <text x="40" y="44" fill="#71717a" font-size="10" text-anchor="end">100</text>
    <text x="40" y="104" fill="#71717a" font-size="10" text-anchor="end">80</text>
    <text x="40" y="164" fill="#71717a" font-size="10" text-anchor="end">60</text>
    <text x="40" y="224" fill="#71717a" font-size="10" text-anchor="end">40</text>`;

  const points = traj.map((c, i) => `${xFor(i).toFixed(1)},${yFor(c.score).toFixed(1)}`).join(" ");
  svg += `<polyline points="${points}" fill="none" stroke="#A78BFA" stroke-width="2.5" filter="url(#glow)"/>`;
  traj.forEach((c, i) => {
    const isRed = c.status === "corrected";
    svg += `<circle cx="${xFor(i).toFixed(1)}" cy="${yFor(c.score).toFixed(1)}" r="${isRed ? 6.5 : 5.5}" fill="#09090b" stroke="${isRed ? "#FB7185" : "#34D399"}" stroke-width="3" ${isRed ? 'filter="url(#glow)"' : ""}/>`;
    if (isRed) svg += `<text x="${xFor(i).toFixed(1)}" y="${(yFor(c.score) - 17).toFixed(1)}" fill="#FB7185" font-size="9.5" text-anchor="middle" font-weight="500">corrected</text>`;
  });
  svg += traj.length
    ? `<text x="${left}" y="252" fill="#71717a" font-size="9.5">${fmtDate(traj[0].resolvedAt || traj[0].createdAt)}</text>`
    : `<text x="${left}" y="252" fill="#71717a" font-size="9.5">${fmtDate(status.createdAt)}</text>`;
  svg += `<text x="${right}" y="252" fill="#71717a" font-size="9.5" text-anchor="end">now</text>`;
  $("#i-chart").innerHTML = svg;

  const eventsDesc = traj.slice().reverse();
  $("#i-events").innerHTML = eventsDesc.map((c, i) => {
    const prevScore = traj[traj.length - 1 - i - 1] ? traj[traj.length - 1 - i - 1].score : null;
    const isRed = c.status === "corrected";
    return `
    <div class="flex gap-4 py-4 border-b border-zinc-800 items-start">
      <div class="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm mt-0.5 ${isRed ? "bg-rose-500/15 text-rose-400" : "bg-emerald-500/15 text-emerald-400"}">${isRed ? "×" : "✓"}</div>
      <div class="flex-1 min-w-0">
        <div class="flex justify-between items-center gap-2 mb-1.5 flex-wrap">
          <span class="text-[10.5px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${isRed ? "bg-rose-500/15 text-rose-400" : "bg-emerald-500/15 text-emerald-400"}">${isRed ? "Corrected" : "Confirmed"}</span>
          <span class="font-mono text-[11px] text-zinc-500 whitespace-nowrap">${prevScore !== null ? prevScore + " → " : ""}${c.score}</span>
        </div>
        <div class="font-headline italic text-base text-zinc-100 mb-1.5 leading-snug">"${esc(c.claimText)}"</div>
        <div class="text-xs text-zinc-500 leading-relaxed">${esc(c.resolutionNote || "")}</div>
      </div>
    </div>`;
  }).join("") || emptyNote("Nothing resolved yet.");
}

/* ---------------------------- render: Community ---------------------------- */

function renderCommunity() {
  const posts = cache.community || [];
  $("#c-feed").innerHTML = posts.length
    ? posts.map((p) => `
      <div class="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
        <div class="flex justify-between items-center mb-1.5">
          <span class="text-xs font-semibold text-sky-300">${esc(p.author || "Anonymous")}</span>
          <span class="font-mono text-[10.5px] text-zinc-500">${fmtDate(p.createdAt)}</span>
        </div>
        <div class="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap">${esc(p.text)}</div>
      </div>`).join("")
    : emptyNote("No community posts yet — be the first to say something.");
}

$("#c-text").addEventListener("input", () => {
  $("#c-count").textContent = `${$("#c-text").value.length} / 500`;
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
    $("#c-count").textContent = "0 / 500";
    toast("Posted!");
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $("#c-submit").disabled = false;
  }
});

/* ---------------------------- boot ---------------------------- */

function boot() {
  updateAgentPill();
  if (!state.agentId) return showInit();
  api(`/api/agent/status?agentId=${state.agentId}`)
    .then(() => { hideInit(); startPolling(); })
    .catch(() => { setAgent(null); showInit("Your previously saved agent could not be found on this backend."); });
}
boot();
