-- Site content (one JSON document under key 'site') and small settings.
CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE subscribers (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  token         TEXT NOT NULL UNIQUE,          -- used in confirm / unsubscribe / reader links
  status        TEXT NOT NULL CHECK (status IN ('pending','confirmed','unsubscribed')),
  created_at    INTEGER NOT NULL,
  confirmed_at  INTEGER,
  confirm_sent_at INTEGER
);
CREATE INDEX subscribers_status ON subscribers(status);

CREATE TABLE likes (
  post_id    TEXT NOT NULL,
  voter      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, voter)
);

CREATE TABLE votes (
  poll_id    TEXT NOT NULL,
  voter      TEXT NOT NULL,
  choice     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, voter)
);

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  voter      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_post ON comments(post_id, status, created_at);
CREATE INDEX comments_status ON comments(status, created_at);

-- Owner's unpublished drafts.
CREATE TABLE drafts (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per post that has been (or is being) emailed to subscribers.
CREATE TABLE notified (
  post_id    TEXT PRIMARY KEY,
  state      TEXT NOT NULL CHECK (state IN ('sending','done','skipped')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  title      TEXT,
  sent       INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- One row per (post, subscriber) so a post is never emailed twice to the same person.
CREATE TABLE deliveries (
  post_id       TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('claimed','sent')),
  at            INTEGER NOT NULL,
  PRIMARY KEY (post_id, subscriber_id)
);

-- Local-testing outbox (only used when EMAIL_MODE=log).
CREATE TABLE outbox (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body    TEXT NOT NULL
);

-- Rate limiting buckets (login attempts, subscribe, comments).
CREATE TABLE rate (
  key TEXT NOT NULL,
  at  INTEGER NOT NULL
);
CREATE INDEX rate_key_at ON rate(key, at);
