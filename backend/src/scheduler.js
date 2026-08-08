const cron = require("node-cron");
const db = require("./db");
const { runCycle } = require("./pipeline");
const { runAudit } = require("./pipeline/auditor");
const { buildPersona } = require("./persona");
const { log } = require("./logger");

const CRON = process.env.SCHEDULE_CRON || "*/20 * * * *";
const MIN_GAP_MIN = parseInt(process.env.MIN_GAP_MINUTES || "90", 10);
const MAX_GAP_MIN = parseInt(process.env.MAX_GAP_MINUTES || "240", 10);

// Independent jittered cadence for re-checking claims (see pipeline/auditor.js).
// Deliberately a different rhythm than publishing so audits don't look like
// a fixed side-effect of the publish cycle.
const MIN_AUDIT_GAP_MIN = parseInt(process.env.MIN_AUDIT_GAP_MINUTES || "60", 10);
const MAX_AUDIT_GAP_MIN = parseInt(process.env.MAX_AUDIT_GAP_MINUTES || "150", 10);

const runningAgents = new Set();
const runningAudits = new Set();

function loadAgent(agentId) {
  const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(agentId);
  if (!row) return null;
  const personaData = JSON.parse(row.persona_json);
  const persona = buildPersona({ name: row.name, domain: row.domain });
  Object.assign(persona, personaData.overrides || {});
  persona.agentId = row.id;
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    persona,
    nextPublishAfter: row.next_publish_after,
    nextAuditAfter: row.next_audit_after,
  };
}

function scheduleNextPublish(agentId) {
  const gapMinutes = MIN_GAP_MIN + Math.random() * (MAX_GAP_MIN - MIN_GAP_MIN);
  const nextAt = new Date(Date.now() + gapMinutes * 60 * 1000).toISOString();
  db.prepare(`UPDATE agents SET next_publish_after = ? WHERE id = ?`).run(nextAt, agentId);
  log(agentId, "scheduler", `Next publish attempt eligible after ${nextAt} (jittered +${gapMinutes.toFixed(0)}m).`);
}

/**
 * A "tick" fires on the cron schedule but does NOT publish every time —
 * it only attempts a publish cycle once the agent's randomized
 * next_publish_after timestamp has passed. This decouples "the process
 * is alive" from "a post appears", giving genuinely autonomous, jittered
 * cadence rather than a fixed interval or (worse) publishing only when
 * the feed endpoint happens to be polled by an evaluator.
 */
async function tick(agentId) {
  if (runningAgents.has(agentId)) return; // avoid overlapping cycles
  const agent = loadAgent(agentId);
  if (!agent) return;

  const now = new Date();
  const eligibleAt = agent.nextPublishAfter ? new Date(agent.nextPublishAfter) : now;

  if (now < eligibleAt) return; // not time yet — jittered autonomy, not fixed cron == publish

  runningAgents.add(agentId);
  try {
    log(agentId, "scheduler", "Tick eligible — starting publish cycle.");
    await runCycle(agent);
  } catch (err) {
    log(agentId, "error", `Cycle failed: ${err.message}`);
    console.error(err);
  } finally {
    scheduleNextPublish(agentId);
    runningAgents.delete(agentId);
  }
}

function scheduleNextAudit(agentId) {
  const gapMinutes = MIN_AUDIT_GAP_MIN + Math.random() * (MAX_AUDIT_GAP_MIN - MIN_AUDIT_GAP_MIN);
  const nextAt = new Date(Date.now() + gapMinutes * 60 * 1000).toISOString();
  db.prepare(`UPDATE agents SET next_audit_after = ? WHERE id = ?`).run(nextAt, agentId);
  log(agentId, "scheduler", `Next audit attempt eligible after ${nextAt} (jittered +${gapMinutes.toFixed(0)}m).`);
}

/**
 * Independent tick for the Auditor. Same "eligibility timestamp" pattern
 * as tick()/publishing, but on its own jittered cadence, so re-checking
 * claims isn't just a side effect glued onto the publish cycle.
 */
async function auditTick(agentId) {
  if (runningAudits.has(agentId)) return;
  const agent = loadAgent(agentId);
  if (!agent) return;

  const now = new Date();
  const eligibleAt = agent.nextAuditAfter ? new Date(agent.nextAuditAfter) : now;
  if (now < eligibleAt) return;

  runningAudits.add(agentId);
  try {
    await runAudit(agent);
  } catch (err) {
    log(agentId, "error", `Audit cycle failed: ${err.message}`);
    console.error(err);
  } finally {
    scheduleNextAudit(agentId);
    runningAudits.delete(agentId);
  }
}

/** Registers the recurring cron job for one agent. Call once per agent, at init time. */
function startAgentScheduler(agentId) {
  // Kick an initial jittered target so it doesn't publish instantly on init,
  // but also doesn't wait a full MAX_GAP before the first post.
  const firstGapMinutes = Math.min(15, MIN_GAP_MIN) + Math.random() * 10;
  const firstAt = new Date(Date.now() + firstGapMinutes * 60 * 1000).toISOString();
  db.prepare(`UPDATE agents SET next_publish_after = ? WHERE id = ?`).run(firstAt, agentId);
  log(agentId, "scheduler", `Agent initialized. First publish attempt eligible after ${firstAt}.`);

  const firstAuditGapMinutes = Math.min(30, MIN_AUDIT_GAP_MIN) + Math.random() * 15;
  const firstAuditAt = new Date(Date.now() + firstAuditGapMinutes * 60 * 1000).toISOString();
  db.prepare(`UPDATE agents SET next_audit_after = ? WHERE id = ?`).run(firstAuditAt, agentId);
  log(agentId, "scheduler", `First audit attempt eligible after ${firstAuditAt}.`);

  cron.schedule(CRON, () => tick(agentId));
  cron.schedule(CRON, () => auditTick(agentId));
  log(agentId, "scheduler", `Cron registered with schedule "${CRON}" (publish + audit).`);
}

/** Re-registers schedulers for all existing agents — call on process boot so a restart doesn't lose autonomy. */
function resumeAllAgents() {
  const rows = db.prepare(`SELECT id FROM agents`).all();
  for (const row of rows) {
    cron.schedule(CRON, () => tick(row.id));
    cron.schedule(CRON, () => auditTick(row.id));
    log(row.id, "scheduler", "Resumed scheduler after process restart.");
  }
}

module.exports = { startAgentScheduler, resumeAllAgents, tick, auditTick, loadAgent };
