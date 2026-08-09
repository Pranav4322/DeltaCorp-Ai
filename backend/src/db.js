const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// DATA_DIR lets Render (or any host) point the SQLite file at a mounted
// persistent disk (see render.yaml) so it survives restarts/redeploys.
// Falls back to ./data/agent.db for local dev.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "agent.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    domain              TEXT NOT NULL,
    persona_json        TEXT NOT NULL,
    next_publish_after  TEXT,
    next_audit_after    TEXT,
    created_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id                  TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL REFERENCES agents(id),
    text                TEXT NOT NULL,
    rationale           TEXT,
    sources_json        TEXT,
    topic_key           TEXT,
    post_type           TEXT NOT NULL DEFAULT 'post',
    refers_to_post_id   TEXT,
    score               INTEGER,
    created_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rejected_topics (
    id                  TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL REFERENCES agents(id),
    topic               TEXT,
    reason              TEXT,
    scores_json         TEXT,
    created_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_topics (
    id                  TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL REFERENCES agents(id),
    topic_key           TEXT,
    entities_json       TEXT,
    summary             TEXT,
    created_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS claims (
    id                  TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL REFERENCES agents(id),
    post_id             TEXT NOT NULL REFERENCES posts(id),
    claim_text          TEXT NOT NULL,
    check_after         TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'open',
    resolution_note     TEXT,
    resolution_post_id  TEXT,
    resolved_at         TEXT,
    created_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_log (
    id                  TEXT PRIMARY KEY,
    agent_id            TEXT NOT NULL,
    stage               TEXT,
    message             TEXT,
    created_at          TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_posts_agent        ON posts(agent_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_rejected_agent      ON rejected_topics(agent_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memory_agent        ON memory_topics(agent_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_claims_agent_status  ON claims(agent_id, status, check_after);
  CREATE INDEX IF NOT EXISTS idx_log_agent           ON agent_log(agent_id, created_at);
`);

module.exports = db;
