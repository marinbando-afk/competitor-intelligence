// Weekly intelligence report — one per competitor per week (Monday–Sunday),
// synthesized from the week's daily snapshots and hosted at a shareable link
// (report.html?host=…). Generated automatically every Monday for the completed
// week; a current-week draft is generated once mid-week so new brands aren't
// empty, then overwritten with the full week on Monday (same day-key upsert).
//
//   GET /api/weekly?host=theoodie.com[&week=2026-06-29]  -> { report }

import Anthropic from '@anthropic-ai/sdk';
import { pool } from './db.js';
import { diffWebsite } from './website.js';
import { getMyBrand } from './brand.js';
import { rootDomain } from './email.js';

const MODEL = process.env.INSIGHTS_MODEL || 'claude-sonnet-4-6';
let _client;
function client() { if (!_client) _client = new Anthropic(); return _client; }

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
function cleanHost(h) { return String(h || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase(); }

// Monday (UTC) of the week containing `d`, as YYYY-MM-DD.
export function mondayOf(d) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}
function addDays(iso, n) { const x = new Date(iso + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(iso) { const x = new Date(iso + 'T00:00:00Z'); return DOW[x.getUTCDay()] + ' ' + x.getUTCDate() + ' ' + MON[x.getUTCMonth()]; }

export async function getWeekly(host, week) {
  if (!process.env.DATABASE_URL) return null;
  host = cleanHost(host);
  const q = week
    ? await pool.query(`SELECT day::text AS day, data FROM snapshots WHERE host=$1 AND channel='weekly' AND day=$2 LIMIT 1`, [host, week])
    : await pool.query(`SELECT day::text AS day, data FROM snapshots WHERE host=$1 AND channel='weekly' ORDER BY day DESC LIMIT 1`, [host]);
  return q.rows[0] ? q.rows[0].data : null;
}

// Compact, factual digest of the week for the analyst.
async function weekDigest(host, start, end) {
  const r = await pool.query(
    `SELECT channel, day::text AS day, data FROM snapshots WHERE host=$1 AND channel = ANY($2) AND day BETWEEN $3 AND $4 ORDER BY day ASC`,
    [host, ['ads', 'website', 'instagram', 'tiktok', 'facebook', 'insights'], start, end],
  );
  if (!r.rows.length) return null;
  const by = {};
  for (const row of r.rows) { (by[row.channel] = by[row.channel] || []).push(row); }
  const parts = [];
  const stats = { adsStart: null, adsEnd: null, newAds: 0, posts: 0, emails: 0, saleNow: false };

  // Ads: active-count trajectory + ads launched inside the week (from the latest capture).
  if (by.ads && by.ads.length) {
    const counts = by.ads.map((x) => `${fmtDay(x.day.slice(0, 10))}: ${((x.data && x.data.ads) || []).length} active`);
    const last = by.ads[by.ads.length - 1].data || {};
    const ads = last.ads || [];
    stats.adsStart = ((by.ads[0].data && by.ads[0].data.ads) || []).length;
    stats.adsEnd = ads.length;
    const fresh = ads.filter((a) => a.started && a.started >= start && a.started <= end);
    stats.newAds = fresh.length;
    parts.push('ADS — active count by day: ' + counts.join('; ') + '.');
    if (fresh.length) {
      parts.push('Ads LAUNCHED this week (' + fresh.length + '):');
      fresh.slice(0, 10).forEach((a) => parts.push(`  • [${a.started}] ${a.hasVideo ? 'VIDEO' : 'IMAGE'}${a.page ? ' page:"' + a.page + '"' : ''}: ${oneLine(a.text).slice(0, 140)}`));
    } else parts.push('No brand-new ads launched inside this week (running set is continuing creatives).');
  }

  // Website: first vs last day diff + sale status + captured banners.
  if (by.website && by.website.length) {
    const first = by.website[0].data || {}, last = by.website[by.website.length - 1].data || {};
    stats.saleNow = !!(last.summary && last.summary.onSale);
    const changes = (first.summary && last.summary) ? diffWebsite(first.summary, last.summary) : [];
    const banners = [...new Set(by.website.map((x) => x.data && x.data.banner).filter(Boolean))];
    parts.push('WEBSITE — ' + (last.summary ? `${last.summary.products} products, ${last.summary.onSale || 0} discounted at week end.` : 'no product feed.'));
    if (banners.length) parts.push('On-site promo headline(s) captured this week: ' + banners.map((b) => `"${b}"`).join(' · '));
    parts.push(changes.length ? 'Changes across the week: ' + changes.join('; ') : 'No structural storefront changes across the week.');
  }

  // Social: posts PUBLISHED within the week (engagement = cumulative lifetime totals).
  for (const pf of ['instagram', 'tiktok', 'facebook']) {
    if (!by[pf] || !by[pf].length) continue;
    const last = by[pf][by[pf].length - 1].data || {};
    const posts = (last.posts || []).filter((p) => { const d = String(p.date || '').slice(0, 10); return d >= start && d <= end; });
    stats.posts += posts.length;
    if (posts.length) {
      parts.push(pf.toUpperCase() + ` @${last.handle || '?'} — ${posts.length} post(s) published this week (engagement shown is lifetime-to-date):`);
      posts.slice(0, 6).forEach((p) => parts.push(`  • [${String(p.date).slice(0, 10)}] ${p.kind || 'post'}${p.views != null ? ' · ' + p.views + ' views' : p.likes != null ? ' · ' + p.likes + ' likes' : ''}: ${oneLine(p.text).slice(0, 110)}`));
    } else parts.push(pf.toUpperCase() + `: no new posts published this week.`);
  }

  // Emails received in the window.
  try {
    const em = await pool.query(
      `SELECT received_at::text AS d, subject, offer FROM emails WHERE sender_domain=$1 AND received_at >= $2 AND received_at < ($3::date + 1) ORDER BY received_at ASC`,
      [rootDomain(host), start, end],
    );
    stats.emails = em.rows.length;
    if (em.rows.length) {
      parts.push('EMAIL — ' + em.rows.length + ' campaign(s) received this week:');
      em.rows.forEach((e) => parts.push(`  • [${e.d.slice(0, 10)}] ${oneLine(e.subject).slice(0, 110)}${e.offer ? ' [offer: ' + e.offer + ']' : ''}`));
    } else parts.push('EMAIL: no campaigns received this week.');
  } catch (e) { /* emails optional */ }

  return { text: parts.join('\n'), stats };
}

// Generate (or regenerate) one competitor's weekly report. Upserts on (host,'weekly',weekStart).
export async function generateWeekly(host, name, weekStart) {
  if (!process.env.DATABASE_URL || !process.env.ANTHROPIC_API_KEY) return null;
  host = cleanHost(host);
  const end = addDays(weekStart, 6);
  const digest = await weekDigest(host, weekStart, end);
  if (!digest) return null;

  const me = await getMyBrand();
  const system =
    `You are WatchBack, a sharp eCommerce competitor-intelligence analyst writing the WEEKLY report on "${name}" for the week ${fmtDay(weekStart)}–${fmtDay(end)}. ` +
    `Rules, same as always: use ONLY the week's data below; cite dates, numbers, offers; every claim must trace to the data. Engagement counts are cumulative lifetime totals — a newer post showing fewer is normal, never a decline. Read deliberate moves as strategy with rationale; marketplace funnels are a channel choice, not a weakness. MATERIALITY: tiny fluctuations (an ad or two, one post) are routine rotation — never call them a pullback or strategic shift; reserve interpretation for material moves. Sanity-check every number ("would this look absurd to their own marketer?"). Complete sentences that never trail off.\n` +
    `Return ONLY minified JSON, no markdown: {"headline":"<the week in <=14 words>","summary":["<one takeaway, <=12 words, telegraphic — lead with the fact, drop filler words>", ...4 to 6 bullets, the week's most important developments in priority order],"timeline":[{"day":"Mon 29 Jun","channel":"ads|social|website|email","event":"<one dated, real event, <=22 words>"}, ...only real dated events from the data, max 8, chronological],"channels":{"ads":{"summary":"<=20 words","bullets":["<=22 words each", ...max 3]},"social":{...same},"website":{...same},"email":{...same}},"move":"<${me && me.profile ? 'ONE concrete counter-move for ' + me.name + ' grounded in their profile below, realistic about cost/effort' : 'ONE concrete, realistic counter-move for a brand competing with them'}, 2 sentences max>"}` +
    (me && me.profile ? `\nADVISING BRAND — ${me.name}${me.mainProduct ? ' (main product: ' + me.mainProduct + ')' : ''}: ${me.profile}` : '');

  const resp = await client().messages.create({ model: MODEL, max_tokens: 1600, system, messages: [{ role: 'user', content: digest.text }] });
  const txt = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  let report;
  try { report = JSON.parse(txt.replace(/^```json?\s*/i, '').replace(/\s*```$/, '')); } catch (e) { return null; }
  if (!report || !report.headline) return null;

  const data = { brand: name, host, week: { start: weekStart, end, label: fmtDay(weekStart) + ' – ' + fmtDay(end) }, stats: digest.stats, report, generatedAt: new Date().toISOString() };
  await pool.query(
    `INSERT INTO snapshots(host, channel, day, data) VALUES($1, 'weekly', $2, $3)
     ON CONFLICT (host, channel, day) DO UPDATE SET data = EXCLUDED.data, created_at = now()`,
    [host, weekStart, JSON.stringify(data)],
  );
  return data;
}

// Called from the daily refresh. Monday (in CRON_TZ): regenerate every brand's report
// for the just-completed week. Other days: create the current week's draft once for
// brands that have data but no report yet (so a newly added competitor isn't empty).
export async function ensureWeeklies(brands, isMonday) {
  const out = [];
  const today = new Date().toISOString().slice(0, 10);
  const curMon = mondayOf(today);
  for (const b of (brands || [])) {
    try {
      if (isMonday) {
        const prevMon = addDays(curMon, -7);
        const r = await generateWeekly(b.host, b.name, prevMon);
        if (r) out.push(r);
      } else {
        const cur = await getWeekly(b.host, curMon);
        // Missing, or stored in the old paragraph-summary format → (re)generate in the
        // current short-bullet format. One-time self-migration; no-op once converted.
        if (!cur || !Array.isArray(cur.report && cur.report.summary)) {
          const r = await generateWeekly(b.host, b.name, curMon);
          if (r) out.push(r);
        }
      }
    } catch (e) { console.warn('weekly ' + b.host + ':', e.message); }
  }
  if (out.length) console.log('✓ weekly reports generated: ' + out.map((x) => x.host).join(', '));
  return out;
}
