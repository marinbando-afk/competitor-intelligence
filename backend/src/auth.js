// Real authentication: hashed passwords (bcrypt) + signed sessions (JWT).

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-change-me';
const TOKEN_TTL = '30d';

// True when JWT_SECRET hasn't been set — server.js warns loudly at boot so the
// owner knows sessions are signed with a public, guessable key.
export const JWT_IS_DEFAULT = !process.env.JWT_SECRET;

function sign(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_TTL });
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

export async function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  const r = await pool.query(
    'SELECT id, email, password_hash, approved, admin FROM users WHERE email = $1',
    [email],
  );
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    const e = new Error('Wrong email or password.'); e.status = 401; throw e;
  }
  if (!u.approved) {
    const e = new Error('Your account is awaiting activation — founding accounts are approved personally during the private beta. You’ll hear from us shortly.'); e.status = 403; throw e;
  }
  return { token: sign(u), user: { id: u.id, email: u.email, admin: !!u.admin } };
}

// Express middleware — require a valid Bearer token, attach req.user.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    req.user = jwt.verify(token, JWT_SECRET);
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
  try { return jwt.verify(token, JWT_SECRET).uid || null; } catch { return null; }
}
