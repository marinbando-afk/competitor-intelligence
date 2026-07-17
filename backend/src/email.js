// Email intelligence — a "seeded inbox" pipeline. One monitored address is
// subscribed to every competitor's newsletter; an inbound-email service (e.g.
// CloudMailin) POSTs each received email to /api/inbound-email. We route it to
// the right competitor by the SENDER's domain, detect offers, and store it.
//
//   POST /api/inbound-email   (from the inbound service)  -> stores one email
//   GET  /api/emails?host=theoodie.com                    -> { emails, summary }

import Anthropic from '@anthropic-ai/sdk';
import { pool } from './db.js';

// The monitored inbox users subscribe to competitors' newsletters with.
const INBOX = process.env.INBOX_ADDRESS || 'b76eccaaa8ce3a2923a9@cloudmailin.net';

// Same cheap judge the ad pipeline uses for "same brand or different company?".
const ALIAS_MODEL = process.env.BRAND_MODEL || 'claude-haiku-4-5';
let _ai; function aiClient() { if (!_ai) _ai = new Anthropic(); return _ai; }

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

// Pull the content images (the "screenshot") out of a marketing email's HTML,
// skipping tracking pixels and spacers.
function emailImages(html) {
  if (!html) return [];
  const out = [];
  const re = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 4) {
    const u = m[1].trim();
    if (!/^https:\/\//i.test(u)) continue;
    if (/(pixel|beacon|\/open\b|\/o\/|spacer|width=1\b|height=1\b|1x1|\btrk\b|track\.)/i.test(u)) continue;
    if (out.indexOf(u) < 0) out.push(u);
  }
  return out;
}

// ── Sending-domain aliases ─────────────────────────────────────────────────────
// Brands very often send their newsletters from a SEPARATE marketing domain: Glov
// Beauty's site is glovbeauty.com but its email comes from tryglov.com. Routing was a
// strict sender_domain = host match, so 16 real Glov emails sat in the inbox invisible
// to the app while its Email card said "waiting for their first email" (found 17 Jul).
//
// Two stages, mirroring the ad pipeline. A cheap TOKEN filter picks candidates (recall,
// free), then the AI judges each one (precision). The filter alone already excludes the
// dangerous case for nothing: "Pacific Foods" shares no token with campbells.com, so
// Campbell's corporate newsletter is never even considered for Pacific — exactly the
// "never show a different company's data" rule. The judge then kills the substring
// coincidences the filter can't ("glov" also lives inside "gloves.com").
//
// NOTE: deliberately NOT the ads' sameBrandVerdicts — its "different registrable domain
// => DIFFERENT" rule (added for brodo.ma) is right for ad landings and wrong here, since
// a separate sending domain is normal and expected for email.
const _alias = new Map();                       // root -> { at, domains: [] }
const ALIAS_TTL = 6 * 60 * 60 * 1000;
const ALIAS_STOP = new Set(['the', 'and', 'for', 'shop', 'store', 'official', 'ltd', 'inc', 'llc', 'brand', 'online', 'cosmetics', 'beauty', 'skin', 'care', 'fashion', 'clothing', 'apparel', 'group', 'collective', 'australia', 'organics', 'foods', 'company']);
function aliasToks(s) {
  return [...new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !ALIAS_STOP.has(w)))];
}

const depunct = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Extra sender domains that are genuinely THIS brand's.
export async function aliasDomains(root, name) {
  const c = _alias.get(root);
  if (c && Date.now() - c.at < ALIAS_TTL) return c.domains;

  let domains = null;   // null = "couldn't compute" → do NOT cache (retry next call, don't
                        //        lock in an empty result); [] = "computed, genuinely none".
  try {
    // Every OTHER sender we've captured — candidates for "actually this brand". Aggregate ALL
    // distinct sender NAMES per domain (not just one) so a brand that signs some emails "Laura"
    // and others "Laura | Glov Beauty" is still recognised by the name that carries the brand.
    const r = await pool.query(
      `SELECT sender_domain, string_agg(DISTINCT COALESCE(from_name,''), ' ') AS names, COUNT(*)::int AS n
       FROM emails WHERE sender_domain <> $1 AND sender_domain <> '' GROUP BY sender_domain`, [root]);
    const ownN = (await pool.query('SELECT COUNT(*)::int AS n FROM emails WHERE sender_domain = $1', [root])).rows[0].n;

    const rootLabel = depunct(root.split('.')[0]);
    const toks = [...new Set(aliasToks(name).concat(aliasToks(root.split('.')[0])))];

    // TIER 1 — DETERMINISTIC, no AI. The sender literally NAMES the brand: the brand's
    // domain-root label appears in a sender name (Glov's "Laura | Glov Beauty" → "…glovbeauty…"
    // contains "glovbeauty"). That is proof, so it must not depend on a non-deterministic
    // judge that can flip and then get cached for 6h — the exact reason Glov's 16 emails kept
    // vanishing from the panel while the cached AI read still showed them (found 17 Jul).
    // Precise: a different firm sharing the word "glov" won't ALSO carry "glovbeauty" in its
    // sender name. Guard rootLabel length ≥ 5 so a short/generic label can't coincidence-match.
    const confirmed = new Set();
    if (rootLabel.length >= 5) for (const x of r.rows) if (depunct(x.names).indexOf(rootLabel) >= 0) confirmed.add(x.sender_domain);

    // TIER 2 — AI judge for the AMBIGUOUS remainder: a domain that shares a token but does NOT
    // strongly name the brand. Token filter (recall) → judge (precision), same as before.
    let cands = toks.length ? r.rows.filter((x) => {
      const hay = depunct(x.sender_domain + ' ' + x.names);
      return toks.some((t) => hay.indexOf(t) >= 0);
    }) : [];
    if (!ownN && !cands.length) cands = r.rows;                       // zero-own-mail brand → widen to all
    cands = cands.filter((x) => !confirmed.has(x.sender_domain));     // don't re-judge what's already proven

    if (cands.length && process.env.ANTHROPIC_API_KEY) {
      try {
        const rows = cands.map((x, i) => `${i + 1}. sender_name="${clean(x.names) || '(none)'}" sending_domain="${x.sender_domain}"`).join('\n');
        const system =
          `Decide for each row whether the EMAIL SENDER is the SAME brand as the target, or a DIFFERENT company. ` +
          `Target brand: "${name}". Its OFFICIAL SITE is ${root}. ` +
          `These are newsletters captured in one shared inbox subscribed to MANY different brands, so most senders belong to OTHER companies. ` +
          `IMPORTANT: a brand very often sends email from a SEPARATE marketing/sending domain rather than its website domain — e.g. "try<brand>.com", "get<brand>.com", "<brand>mail.com", "e.<brand>.com", "shop<brand>.com", or an ESP subdomain. So a DIFFERENT registrable domain is NOT by itself evidence of a different company — judge the SENDER NAME together with the domain. ` +
          `SAME = the sender_name clearly identifies the target brand (its own name, or "<person> | <brand>", "<brand> Team") AND the sending domain is consistent with that brand. ` +
          `DIFFERENT = any separate company: a competitor, a retailer that stocks the brand, a PARENT or SIBLING company (a parent's own corporate newsletter is NOT the target's — e.g. "Campbell's" <campbells.com> is NOT "Pacific Foods"), an affiliate, or an unrelated business that merely SHARES A WORD with the target. Do NOT call it the same just because the brand's letters appear inside another word (e.g. "glov" also appears in "gloves.com"; "Foodie" is not "The Oodie"). ` +
          `PRECISION FIRST: it is far better to MISS one of the brand's newsletters than to attribute a DIFFERENT company's email to it. If you are not confident, answer DIFFERENT. ` +
          `Return ONLY minified JSON: {"v":[{"i":1,"same":true|false}, ...]}, one entry per row.`;
        const resp = await aiClient().messages.create({ model: ALIAS_MODEL, max_tokens: 600, system, messages: [{ role: 'user', content: rows }] });
        const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim().replace(/^```(?:json)?|```$/g, '').trim();
        const arr = (JSON.parse(txt).v || []);
        cands.forEach((x, i) => { const v = arr.find((y) => Number(y.i) === i + 1); if (v && v.same) confirmed.add(x.sender_domain); });
      } catch (e) {
        // A flaky judge must NOT discard the deterministic Tier-1 matches — keep those.
        console.warn('aliasDomains judge ' + root + ': ' + e.message);
      }
    }
    domains = [...confirmed];
  } catch (e) {
    console.warn('aliasDomains ' + root + ': ' + e.message);
    domains = null;   // DB error → don't cache, just retry next time
  }
  if (domains !== null) _alias.set(root, { at: Date.now(), domains });
  return domains || [];
}

export async function getEmails(host, name) {
  const root = rootDomain(String(host || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''));
  if (!process.env.DATABASE_URL) return { host, root, inbox: INBOX, storage: false, emails: [], summary: null };
  if (!root) { const e = new Error('Missing host.'); e.status = 400; throw e; }
  // The brand's own domain ALWAYS counts; aliases are extra sending domains it uses.
  const alias = await aliasDomains(root, clean(name) || root.split('.')[0]);
  const froms = [root, ...alias];
  const r = await pool.query(
    `SELECT id, from_name, sender_email, subject, preview, offer, received_at, html
     FROM emails WHERE sender_domain = ANY($1) ORDER BY received_at DESC LIMIT 16`, [froms]);
  const emails = r.rows.map((e) => ({
    id: e.id,
    from: e.from_name || e.sender_email,
    subject: e.subject,
    preview: e.preview,
    offer: e.offer || '',
    date: e.received_at,
    hasFull: !!(e.html && e.html.length > 40),
    images: emailImages(e.html),
  }));
  const offers = [...new Set(emails.map((e) => e.offer).filter(Boolean))];
  const summary = emails.length ? {
    count: emails.length,
    perWeek: cadencePerWeek(emails.map((e) => e.date)),
    latest: emails[0].date,
    offers: offers.slice(0, 6),
  } : null;
  // `alias` is surfaced so it's visible WHY a brand's mail is (or isn't) matching —
  // this bug was invisible for weeks precisely because nothing showed the routing.
  return { host, root, alias, inbox: INBOX, storage: true, emails, summary };
}

// Full stored HTML of one captured email, for the in-app preview.
export async function getEmailHtml(idArg) {
  const id = parseInt(idArg, 10);
  if (!process.env.DATABASE_URL || !id) return null;
  const r = await pool.query(
    'SELECT subject, from_name, sender_email, received_at, html FROM emails WHERE id = $1', [id]);
  if (!r.rows[0]) return null;
  const e = r.rows[0];
  return { subject: e.subject || '(no subject)', from: e.from_name || e.sender_email, date: e.received_at, html: e.html || '' };
}

// Monitoring: the most recent captured emails across every sender (any brand).
export async function recentEmails() {
  if (!process.env.DATABASE_URL) return { storage: false, emails: [] };
  const r = await pool.query(
    `SELECT sender_domain, from_name, subject, offer, received_at
     FROM emails ORDER BY received_at DESC LIMIT 15`);
  return {
    storage: true,
    count: r.rowCount,
    emails: r.rows.map((e) => ({ domain: e.sender_domain, from: e.from_name, subject: e.subject, offer: e.offer || '', date: e.received_at })),
  };
}
