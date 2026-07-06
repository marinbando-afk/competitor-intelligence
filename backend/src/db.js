// Postgres connection + schema. Railway provides DATABASE_URL automatically
// once you attach a PostgreSQL service to this backend.

import pg from 'pg';
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn('⚠  DATABASE_URL is not set. Attach a PostgreSQL service in Railway.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's managed Postgres needs SSL but with a self-signed chain.
  ssl: process.env.DATABASE_URL && /railway|rlwy|proxy\.rlwy/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
});

// Create tables on boot — no separate migration step to run.
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS competitors (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      host       TEXT NOT NULL,
      url        TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_competitors_user ON competitors(user_id);
    ALTER TABLE competitors ADD COLUMN IF NOT EXISTS country TEXT;
    ALTER TABLE competitors ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'setup';
    ALTER TABLE competitors ADD COLUMN IF NOT EXISTS handles JSONB;
    ALTER TABLE competitors ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS idx_competitors_user_host ON competitors(user_id, host);
    CREATE TABLE IF NOT EXISTS emails (
      id            SERIAL PRIMARY KEY,
      message_id    TEXT,
      sender_email  TEXT,
      sender_domain TEXT,
      from_name     TEXT,
      subject       TEXT,
      preview       TEXT,
      html          TEXT,
      offer         TEXT,
      received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_emails_domain ON emails(sender_domain, received_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_msgid ON emails(message_id);
    CREATE TABLE IF NOT EXISTS snapshots (
      id         SERIAL PRIMARY KEY,
      host       TEXT NOT NULL,
      channel    TEXT NOT NULL,
      day        DATE NOT NULL DEFAULT CURRENT_DATE,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_snap_unique ON snapshots(host, channel, day);
    CREATE INDEX IF NOT EXISTS idx_snap_host ON snapshots(host, channel, day DESC);
    CREATE TABLE IF NOT EXISTS feedback (
      id         SERIAL PRIMARY KEY,
      name       TEXT,
      email      TEXT,
      message    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE feedback ADD COLUMN IF NOT EXISTS image TEXT;
    -- Private beta: new accounts need the founder's approval before first sign-in
    -- (customers are onboarded + charged manually). The founder account is always approved.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT FALSE;
    -- The founder account is the standing admin: normal login unlocks approvals,
    -- unlimited competitors and the submissions inbox.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS admin BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE users SET approved = TRUE, admin = TRUE WHERE email = 'marin.bando@gmail.com';
  `);
}
