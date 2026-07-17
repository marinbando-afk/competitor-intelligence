// AI chat — answers questions grounded in a competitor's captured data
// (live ads, organic social, captured emails) via the Claude API.
//
//   POST /api/chat  { name, host, country, handles, context, question, messages[] }
//
// Requires ANTHROPIC_API_KEY in Railway. Model override: CHAT_MODEL (default Sonnet 4.6 — Q&A over captured data).

import Anthropic from '@anthropic-ai/sdk';
import { fetchAds } from './ads.js';
import { fetchSocial } from './social.js';
import { getEmails } from './email.js';
import { latestSnapshot, recentSnapshots } from './snapshots.js';
import { funnelFacts, getInsights } from './insights.js';
import { offerFacts } from './occasions.js';

const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-6';

// Lazy so the server still boots when ANTHROPIC_API_KEY isn't set yet.
let _client;
function client() { if (!_client) _client = new Anthropic(); return _client; }

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const dayOf = (s) => String(s || '').split('T')[0].split(' ')[0];

// Merge posts across recent daily snapshots (deduped) so the chat sees the FULL
// captured set — e.g. "highest-engagement post in the last 30 days" works even if
// we only started monitoring a week ago (the scraper returns ~30 days of posts).
async function allPosts(host, pf) {
  const snaps = await recentSnapshots(host, pf, 8);
  const byKey = new Map();
  let handle = '';
  for (const s of snaps) {
    const d = s.data || {};
    if (d.handle) handle = d.handle;
    for (const p of (d.posts || [])) {
      const key = p.url || ((p.text || '').slice(0, 40) + '|' + dayOf(p.date));
      const prev = byKey.get(key);
      if (!prev || ((p.views || 0) + (p.likes || 0)) > ((prev.views || 0) + (prev.likes || 0))) byKey.set(key, p);
    }
  }
  return { handle, posts: [...byKey.values()] };
}

// Pull together everything we already have on this competitor (cache-only: no live scrape).
async function assembleContext({ name, host, country, handles }) {
  const out = [];
  try {
    let a = await latestSnapshot(host, 'ads');               // persisted daily snapshot (complete)
    if (!a || !a.ads || !a.ads.length) a = await fetchAds(name, country, false, true, host); // fallback: warm cache
    if (a && a.ads && a.ads.length) {
      out.push(`META ADS (${a.country || country}): ${a.active} active across ${(a.platforms || []).join(', ')}; newest ${a.newest}.`);
      const ff = funnelFacts(a.ads, name);
      out.push('  ' + ff.text.replace(/\n/g, '\n  '));   // pages + landing domains + third-party flags — the SAME view the AI-read panel uses
      // Same offer-timing ground truth the AI-read panel gets, so chat can't contradict it
      // when asked "are they running a sale?" — computed dates, never the model's own math.
      const of_ = offerFacts(a.ads, new Date());
      if (of_) out.push('  ' + of_.trim().replace(/\n/g, '\n  '));
      // surface every third-party ad (the publisher advertorials), then a sample of own-page ads
      const third = a.ads.filter(ff.isThird), first = a.ads.filter((x) => !ff.isThird(x));
      const sample = third.slice(0, 8).concat(first.slice(0, Math.max(10, 24 - Math.min(third.length, 8))));
      sample.forEach((ad) => out.push(`  • ad ${ad.started} [${ad.hasVideo ? 'video' : 'image'}]${ff.isThird(ad) ? ' (3RD-PARTY PLACEMENT)' : ''}${ad.page ? ` page:${ad.page}` : ''}: ${oneLine(ad.text).slice(0, 150)}${ad.hook ? ` | HOOK: ${oneLine(ad.hook)}` : ''}${ad.angle ? ` · ANGLE: ${oneLine(ad.angle)}` : ''}${ad.creative ? ` · CREATIVE: ${oneLine(ad.creative)}` : ''}${ad.cta ? ` [CTA ${ad.cta}]` : ''}${ad.landing ? ` -> lands ${ad.landing}` : ''}${ad.link ? ` | ${ad.link}` : ''}`));
    }
  } catch (e) { /* skip channel on error */ }

  for (const [pf, key, label] of [['instagram', 'ig', 'Instagram'], ['tiktok', 'tt', 'TikTok'], ['facebook', 'fb', 'Facebook']]) {
    const h = handles && handles[key];
    if (!h && !host) continue;
    try {
      let { handle: hh, posts } = await allPosts(host, pf);  // merged across recent daily snapshots
      if (!posts.length) { const s = await fetchSocial(pf, h, host, false, true); posts = (s && s.posts) || []; hh = (s && s.handle) || hh; }
      if (posts.length) {
        posts.sort((x, y) => String(y.date).localeCompare(String(x.date)));
        out.push(`${label} @${hh || h || '?'} — ${posts.length} posts captured (recent window, newest first; each has engagement + link):`);
        posts.slice(0, 20).forEach((p) => {
          const eng = [p.views != null ? `${p.views} views` : '', p.likes != null ? `${p.likes} likes` : '', p.comments != null ? `${p.comments} comments` : '', p.shares != null ? `${p.shares} shares` : ''].filter(Boolean).join(', ');
          out.push(`  • ${dayOf(p.date)} ${p.kind || 'post'}: ${oneLine(p.text).slice(0, 110)}${p.hook ? ` | HOOK: ${oneLine(p.hook)}` : ''}${p.angle ? ` · ANGLE: ${oneLine(p.angle)}` : ''} | ${eng}${p.url ? ` | ${p.url}` : ''}`);
        });
      }
    } catch (e) { /* skip platform on error */ }
  }

  try {
    const em = await getEmails(host, name);
    if (em && em.emails && em.emails.length) {
      const sm = em.summary || {};
      out.push(`EMAILS captured: ${em.emails.length}${sm.perWeek ? `, ~${sm.perWeek}/week` : ''}; latest ${dayOf(sm.latest)}.`);
      em.emails.slice(0, 10).forEach((e) => out.push(`  • email ${dayOf(e.date)}: ${oneLine(e.subject).slice(0, 130)}${e.offer ? ` [offer ${e.offer}]` : ''}`));
    } else if (em && em.storage) {
      out.push('EMAILS: monitoring active, none captured yet.');
    }
  } catch (e) { /* skip emails on error */ }

  return out.join('\n');
}

function buildMessages(history, question) {
  const msgs = [];
  if (Array.isArray(history)) {
    history.slice(-8).forEach((m) => {
      const role = m && m.role === 'assistant' ? 'assistant' : 'user';
      const content = oneLine(m && (m.content || m.text));
      if (content) msgs.push({ role, content });
    });
  }
  msgs.push({ role: 'user', content: String(question) });
  if (msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: 'Hi' });
  return msgs;
}

export async function chat(body, uid) {
  body = body || {};
  const question = oneLine(body.question);
  if (!question) { const e = new Error('Ask a question first.'); e.status = 400; throw e; }
  if (!process.env.ANTHROPIC_API_KEY) { const e = new Error('AI chat isn’t switched on yet — add ANTHROPIC_API_KEY in Railway, then redeploy.'); e.status = 503; throw e; }

  const name = oneLine(body.name) || 'this competitor';
  const host = oneLine(body.host);
  const country = (oneLine(body.country) || 'ALL').toUpperCase();
  const handles = body.handles || {};
  const extra = oneLine(body.context).slice(0, 1500);

  let data = await assembleContext({ name, host, country, handles });
  if (extra) data = (data ? data + '\n' : '') + 'WEBSITE / OFFERS: ' + extra;
  if (!data) data = 'No data has been captured for this competitor yet.';

  // Load the same insights the user is looking at in-app, so the chat NEVER contradicts the AI-read panel.
  let analysis = '';
  try {
    const ins = await getInsights(host, name, false);   // shared, tenant-neutral snapshot (no per-viewer tailoring)
    if (ins) {
      const parts = [];
      for (const [k, label] of [['ads', 'Ads'], ['social', 'Social'], ['website', 'Website'], ['email', 'Email']]) {
        const c = ins[k];
        if (c && (c.summary || (c.bullets && c.bullets.length))) parts.push(`${label}: ${c.summary || ''}${(c.bullets || []).length ? '\n    - ' + c.bullets.join('\n    - ') : ''}`);
      }
      if (parts.length) analysis = parts.join('\n');
    }
  } catch (e) { /* analysis is best-effort */ }

  const today = new Date().toISOString().slice(0, 10);
  const system =
    `You are WatchBack — the SAME competitor-intelligence analyst that produced the on-screen "AI read" the user sees in the app. ` +
    `Answer the user's question about the competitor "${name}" using the IN-APP ANALYSIS and the DATA below (their live ads with a FUNNEL FACTS breakdown of pages and landing domains, organic social posts, and captured emails).\n\n` +
    `Rules:\n` +
    `- Be CONSISTENT with the IN-APP ANALYSIS below — it is your own conclusion shown to the user. If they ask about something it states (e.g. third-party advertorial placements), confirm and ELABORATE using the supporting ads/pages/domains; never deny it or claim you didn't say it.\n` +
    `- The FUNNEL FACTS list every page and landing domain across ALL the ads and flag genuine THIRD-PARTY placements (publisher advertorials, media/affiliate partners). Treat them as ground truth — they are real even if a specific ad isn't in the sample list below.\n` +
    `- Ground every claim in the data/analysis; cite specific dates, numbers, platforms, pages, domains and offers when relevant.\n` +
    `- TODAY IS ${today}. A live sale is always worth naming. If an OFFER TIMING FACTS block is present it is computed ground truth: the brand is running an offer that is out of season (an occasion months past) or asserting a deadline it has already outlived. Say so plainly whenever sales, offers, discounts, urgency or pricing come up — quote its numbers verbatim and never do your own date arithmetic.\n` +
    `- Only say something "isn't captured" if it is genuinely absent from BOTH the analysis and the data — and never claim the analysis itself doesn't exist. Never speculate or invent figures.\n` +
    `- The DATA spans the recent capture window (often ~30 days), not just today — for ranges ("last 30 days") or superlatives ("highest engagement"), scan the FULL list and compare the numbers given.\n` +
    `- When you reference a specific post, ad, or email, include its link/URL from the data, in full and on its own. If an item has no link in the data, say so.\n` +
    `- Lead with the answer. Be concise and direct. Don't narrate reasoning or restate the question.\n` +
    `- Write for a busy marketer: practical and specific.\n\n` +
    (analysis ? `IN-APP ANALYSIS — the AI read currently shown to the user (this is established; be consistent with it):\n${analysis}\n\n` : '') +
    `DATA (as of ${today}):\n${data}`;

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: buildMessages(body.messages, question),
  });
  const answer = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { answer: answer || '(no answer)', model: MODEL };
}
