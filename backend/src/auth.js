// Real authentication: hashed passwords (bcrypt) + signed sessions (JWT).

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool } from './db.js';

const TOKEN_TTL = '30d';

// Session-signing secret. JWT_SECRET env wins; without it we DO NOT fall back to a public
// default (audit CRITICAL #1: anyone could forge an admin token from the string in the repo).
// Instead a random secret is generated ONCE and persisted in Postgres, so it survives
// restarts/deploys and needs no manual setup. Existing sessions signed with the old public
// default become invalid — users just sign in again, forged tokens die with it.
let SECRET = process.env.JWT_SECRET || null;
export const JWT_IS_DEFAULT = !process.env.JWT_SECRET;
export async function ensureJwtSecret() {
  if (SECRET) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`INSERT INTO app_secrets(name, value) VALUES('jwt', $1) ON CONFLICT (name) DO NOTHING`, [crypto.randomBytes(48).toString('hex')]);
    const r = await pool.query(`SELECT value FROM app_secrets WHERE name = 'jwt'`);
    if (r.rows[0]) SECRET = r.rows[0].value;
  } catch (e) { console.warn('ensureJwtSecret:', e.message); }
  // Absolute last resort (no DB at all): a per-boot random secret — sessions die on restart,
  // but tokens are never forgeable.
  if (!SECRET) SECRET = crypto.randomBytes(48).toString('hex');
}

function sign(user) {
  return jwt.sign({ uid: user.id, email: user.email }, SECRET, { expiresIn: TOKEN_TTL });
}

export async function signup(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!email.includes('@') || email.length < 5) {
    const e = new Error('Please enter a valid email.'); e.status = 400; throw e;
  }
  if (password.length < 8) {
    const e = new Error('Password must be at least 8 characters.'); e.status = 400; throw e;
  }

  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query(
      'INSERT INTO users(email, password_hash) VALUES($1, $2) RETURNING id, email',
      [email, hash],
    );
    const user = r.rows[0];
    // Private beta: accounts are created PENDING and activated personally by the
    // founder (manual billing) — no session until approved.
    return { pending: true, email: user.email };
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      const e = new Error('An account with that email already exists.'); e.status = 409; throw e;
    }
    throw err;
  }
}

// Admin-created account: the founder creates a client login directly (email + password),
// pre-approved so they can sign in immediately — no self-serve pending step.
export async function createUser(email, password, { approved = false, admin = false } = {}) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!email.includes('@') || email.length < 5) { const e = new Error('Please enter a valid email.'); e.status = 400; throw e; }
  if (password.length < 8) { const e = new Error('Password must be at least 8 characters.'); e.status = 400; throw e; }
  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query(
      'INSERT INTO users(email, password_hash, approved, admin) VALUES($1, $2, $3, $4) RETURNING id, email',
      [email, hash, !!approved, !!admin],
    );
    return r.rows[0];
  } catch (err) {
    if (err.code === '23505') { const e = new Error('An account with that email already exists.'); e.status = 409; throw e; }
    throw err;
  }
}

// Self-service password change. The CURRENT password is required — otherwise anyone who
// borrowed a signed-in browser could lock the real owner out of their own account.
export async function changePassword(uid, current, next) {
  next = String(next || '');
  if (next.length < 8) { const e = new Error('Your new password must be at least 8 characters.'); e.status = 400; throw e; }
  const r = await pool.query('SELECT password_hash FROM users WHERE id = $1', [uid]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(String(current || ''), u.password_hash))) {
    const e = new Error('That current password is wrong.'); e.status = 401; throw e;
  }
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [uid, await bcrypt.hash(next, 10)]);
}

// Reset an account's password (admin action — e.g. re-issuing a client's login).
export async function setPassword(uid, password) {
  password = String(password || '');
  if (password.length < 8) { const e = new Error('Password must be at least 8 characters.'); e.status = 400; throw e; }
  const hash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [uid, hash]);
}

export async function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  const r = await pool.query(
    'SELECT id, email, password_hash, approved, admin, max_competitors FROM users WHERE email = $1',
    [email],
  );
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    const e = new Error('Wrong email or password.'); e.status = 401; throw e;
  }
  if (!u.approved) {
    const e = new Error('Your account is awaiting activation — founding accounts are approved personally during the private beta. You’ll hear from us shortly.'); e.status = 403; throw e;
  }
  const dflt = Number(process.env.DEFAULT_MAX_COMPETITORS) || 2;
  return { token: sign(u), user: { id: u.id, email: u.email, admin: !!u.admin, maxCompetitors: u.max_competitors == null ? dflt : u.max_competitors } };
}

// Express middleware — require a valid Bearer token, attach req.user.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Please sign in.' });
  }
}

// Best-effort: if a valid Bearer token is present, return its uid — otherwise null.
// Used by OPEN routes (insights/angle/chat/my-brand-read) that work for anonymous
// demo visitors too, but personalize for a logged-in customer when possible.
export function optionalUid(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  try { return jwt.verify(token, SECRET).uid || null; } catch { return null; }
}
