const { v4: uuid } = require("uuid");
const db = require("./db");

function log(agentId, stage, message) {
  console.log(`[${new Date().toISOString()}] [${agentId}] [${stage}] ${message}`);
  try {
    db.prepare(
      `INSERT INTO agent_log (id, agent_id, stage, message, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(uuid(), agentId, stage, message, new Date().toISOString());
  } catch (err) {
    console.error("Failed to persist log:", err.message);
  }
}

function recentLogs(agentId, limit = 50) {
  return db
    .prepare(
      `SELECT stage, message, created_at as createdAt FROM agent_log
       WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(agentId, limit);
}

module.exports = { log, recentLogs };
