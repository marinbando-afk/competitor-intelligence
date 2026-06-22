// Email intelligence — a "seeded inbox" pipeline. One monitored address is
// subscribed to every competitor's newsletter; an inbound-email service (e.g.
// CloudMailin) POSTs each received email to /api/inbound-email. We route it to
// the right competitor by the SENDER's domain, detect offers, and store it.
//
//   POST /api/inbound-email   (from the inbound service)  -> stores one email
//   GET  /api/emails?host=theoodie.com                    -> { emails, summary }

import { pool } from './db.js';

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function extractEmail(s) { const m = String(s || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/); return m ? m[0].toLowerCase() : ''; }
function displayName(s) { const m = String(s || '').match(/^\s*"?([^"<]+?)"?\s*</); return m ? m[1].trim() : ''; }
function domainOf(email) { const i = String(email || '').lastIndexOf('@'); return i < 0 ? '' : email.slice(i + 1).toLowerCase(); }

const SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
// Registrable root, e.g. "news.email.theoodie.com" -> "theoodie.com", "brand.co.uk" -> "brand.co.uk".
export function rootDomain(d) {
  d = String(d || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const p = d.split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  if (SLD.has(p[p.length - 2])) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}

function stripHtml(h) {
  return String(h || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Promo signals worth surfacing, most specific first.
const OFFERS = [
  /\b\d{1,3}\s*%\s*off\b/i, /\$\d+(?:\.\d+)?\s*off\b/i, /£\d+(?:\.\d+)?\s*off\b/i, /€\d+\s*off\b/i,
  /\bup to \d{1,3}\s*%\b/i, /\bfree shipping\b/i, /\bfree gift\b/i, /\bgift with purchase\b/i,
  /\bbuy one[, ]+get one\b/i, /\bbogo\b/i, /\bflash sale\b/i, /\bclearance\b/i,
  /\bends (tonight|today|soon|midnight|tomorrow)\b/i, /\blast chance\b/i, /\bfinal (hours|day)\b/i,
  /\bnew (arrival|arrivals|drop|launch|in)\b/i, /\bback in stock\b/i, /\bbundle\b/i, /\bsale\b/i,
];
export function detectOffer(s) { s = String(s || ''); for (const re of OFFERS) { const m = s.match(re); if (m) return m[0]; } return ''; }

// Flexibly pull fields from CloudMailin / Postmark / Mailgun / SendGrid payloads.
function parseInbound(b) {
  b = b || {};
  const h = b.headers || {};
  const fromRaw = b.From || b.from || h.From || h.from || b.sender || (b.envelope && b.envelope.from) || (b.FromFull && b.FromFull.Email) || '';
  const fromEmail = extractEmail(fromRaw) || extractEmail(b.FromFull && b.FromFull.Email) || extractEmail(b.envelope && b.envelope.from) || '';
  const fromName = b.FromName || (b.FromFull && b.FromFull.Name) || displayName(fromRaw) || '';
  const subject = clean(b.Subject || b.subject || h.Subject || h.subject || '');
  const text = b.TextBody || b.plain || b['body-plain'] || b.text || '';
  const html = b.HtmlBody || b.html || b['body-html'] || '';
  const dateStr = b.Date || b.date || h.Date || h.date || '';
  const messageId = b.MessageID || b['Message-ID'] || h['Message-ID'] || h['Message-Id'] || h['message-id'] || null;
  return { fromEmail, fromName, subject, text, html, dateStr, messageId };
}

export async function storeInbound(body) {
  const p = parseInbound(body);
  if (!p.fromEmail && !p.subject) { const e = new Error('Could not parse email payload.'); e.status = 400; throw e; }
  const senderDomain = rootDomain(domainOf(p.fromEmail));
  const preview = (clean(p.text) || stripHtml(p.html)).slice(0, 320);
  const offer = detectOffer(p.subject + ' — ' + preview);
  const receivedAt = (p.dateStr && !isNaN(Date.parse(p.dateStr))) ? new Date(p.dateStr) : new Date();
  await pool.query(
    `INSERT INTO emails(message_id, sender_email, sender_domain, from_name, subject, preview, html, offer, received_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (message_id) DO NOTHING`,
    [p.messageId, p.fromEmail.slice(0, 200), senderDomain, clean(p.fromName).slice(0, 160),
     p.subject.slice(0, 400), preview, String(p.html || '').slice(0, 400000), offer, receivedAt],
  );
  return { ok: true, routedTo: senderDomain, subject: p.subject };
}

function cadencePerWeek(dates) {
  if (dates.length < 2) return null;
  const ms = dates.map((d) => +new Date(d)).sort((a, b) => a - b);
  const days = (ms[ms.length - 1] - ms[0]) / 86400000;
  if (days < 1) return dates.length;
  return Math.round((dates.length / days) * 7 * 10) / 10;
}

export async function getEmails(host) {
  const root = rootDomain(String(host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''));
  if (!process.env.DATABASE_URL) return { host, root, storage: false, emails: [], summary: null };
  if (!root) { const e = new Error('Missing host.'); e.status = 400; throw e; }
  const r = await pool.query(
    `SELECT from_name, sender_email, subject, preview, offer, received_at
     FROM emails WHERE sender_domain = $1 ORDER BY received_at DESC LIMIT 16`, [root]);
  const emails = r.rows.map((e) => ({
    from: e.from_name || e.sender_email,
    subject: e.subject,
    preview: e.preview,
    offer: e.offer || '',
    date: e.received_at,
  }));
  const offers = [...new Set(emails.map((e) => e.offer).filter(Boolean))];
  const summary = emails.length ? {
    count: emails.length,
    perWeek: cadencePerWeek(emails.map((e) => e.date)),
    latest: emails[0].date,
    offers: offers.slice(0, 6),
  } : null;
  return { host, root, storage: true, emails, summary };
}
