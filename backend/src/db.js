const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// Overridable so a host with a persistent/mounted disk (e.g. Render) can
// point this at that disk instead of the ephemeral local filesystem.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "agent.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  persona_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  next_publish_after TEXT,
  next_audit_after TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  text TEXT NOT NULL,
  rationale TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  topic_key TEXT,
  post_type TEXT NOT NULL DEFAULT 'post',
  refers_to_post_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Falsifiable claims/predictions the agent makes inside its own posts.
-- These get re-checked later against fresh scouted evidence, which is
-- what powers the self-auditing "track record" feature (see auditor.js).
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  claim_text TEXT NOT NULL,
  check_after TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolution_note TEXT,
  resolution_post_id TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

CREATE TABLE IF NOT EXISTS rejected_topics (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  reason TEXT NOT NULL,
  scores_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS memory_topics (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  entities_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS agent_log (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_posts_agent ON posts(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rejected_agent ON rejected_topics(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_topics(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_log_agent ON agent_log(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_claims_agent ON claims(agent_id, status, check_after);
CREATE INDEX IF NOT EXISTS idx_claims_post ON claims(post_id);
`);

// Lightweight migration for DBs created before post_type/refers_to_post_id/
// next_audit_after existed — safe no-ops on a fresh database.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn("posts", "post_type", "post_type TEXT NOT NULL DEFAULT 'post'");
ensureColumn("posts", "refers_to_post_id", "refers_to_post_id TEXT");
ensureColumn("agents", "next_audit_after", "next_audit_after TEXT");

module.exports = db;
