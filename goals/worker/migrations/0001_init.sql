-- Project Goals review store (Cloudflare D1 / SQLite). Table names follow
-- common CRM tables so rows can sync to any CRM that uses them.

-- Proposed corrections and claim reviews. A review's decision updates the
-- claim's review_state; nothing is overwritten.
CREATE TABLE IF NOT EXISTS activities (
  id             TEXT PRIMARY KEY,
  activity_type  TEXT NOT NULL CHECK (activity_type IN ('correction', 'review', 'note')),
  status         TEXT NOT NULL DEFAULT 'candidate'
                 CHECK (status IN ('candidate', 'in_review', 'verified', 'disputed', 'rejected', 'retired')),
  parent_id      TEXT NOT NULL,          -- record id, e.g. svc:upstream-directory:28397
  property       TEXT,
  proposed_value TEXT,                   -- JSON
  evidence_url   TEXT,
  note           TEXT,
  origin         TEXT NOT NULL,          -- human_submitted | agent_submitted | pipeline
  assigned_to    TEXT,                   -- reviewer role, never a veteran's identity
  decision_note  TEXT,
  created_at     TEXT NOT NULL,
  decided_at     TEXT
);
CREATE INDEX IF NOT EXISTS activities_parent ON activities (parent_id);
CREATE INDEX IF NOT EXISTS activities_status ON activities (status, created_at);

-- Claims stored individually once records move out of static files.
CREATE TABLE IF NOT EXISTS claims (
  claim_id      TEXT PRIMARY KEY,
  record_id     TEXT NOT NULL,
  property      TEXT NOT NULL,
  value         TEXT NOT NULL,           -- JSON
  source_id     TEXT NOT NULL,
  source_url    TEXT,
  retrieved_at  TEXT NOT NULL,
  valid_from    TEXT,
  valid_to      TEXT,
  origin        TEXT NOT NULL,
  review_state  TEXT NOT NULL DEFAULT 'candidate',
  confidence    REAL,
  supersedes    TEXT,
  contradicts   TEXT                     -- JSON array of claim_ids
);
CREATE INDEX IF NOT EXISTS claims_record ON claims (record_id, property);

-- Quality flags on records and counties, as tags.
CREATE TABLE IF NOT EXISTS taggables (
  tag        TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  level      TEXT NOT NULL,              -- record | county | source
  detail     TEXT,
  raised_at  TEXT NOT NULL,
  PRIMARY KEY (tag, target_id)
);
