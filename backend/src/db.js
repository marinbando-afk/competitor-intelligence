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
  `);
}
