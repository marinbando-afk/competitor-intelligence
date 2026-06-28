// AI chat — answers questions grounded in a competitor's captured data
// (live ads, organic social, captured emails) via the Claude API.
//
//   POST /api/chat  { name, host, country, handles, context, question, messages[] }
//
// Requires ANTHROPIC_API_KEY in Railway. Model override: ANTHROPIC_MODEL (default Opus 4.8).

import Anthropic from '@anthropic-ai/sdk';
import { fetchAds } from './ads.js';
import { fetchSocial } from './social.js';
import { getEmails } from './email.js';
import { latestSnapshot, recentSnapshots } from './snapshots.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

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
    if (!a || !a.ads || !a.ads.length) a = await fetchAds(name, country, false, true); // fallback: warm cache
    if (a && a.ads && a.ads.length) {
      out.push(`META ADS (${a.country || country}): ${a.active} active across ${(a.platforms || []).join(', ')}; newest ${a.newest}.`);
      a.ads.slice(0, 14).forEach((ad) => out.push(`  • ad ${ad.started} [${ad.hasVideo ? 'video' : 'image'}]${ad.page ? ` page:${ad.page}` : ''}: ${oneLine(ad.text).slice(0, 150)}${ad.cta ? ` [CTA ${ad.cta}]` : ''}${ad.landing ? ` -> lands ${ad.landing}` : ''}${ad.link ? ` | ${ad.link}` : ''}`));
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
          out.push(`  • ${dayOf(p.date)} ${p.kind || 'post'}: ${oneLine(p.text).slice(0, 110)} | ${eng}${p.url ? ` | ${p.url}` : ''}`);
        });
      }
    } catch (e) { /* skip platform on error */ }
  }

  try {
    const em = await getEmails(host);
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

export async function chat(body) {
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

  const today = new Date().toISOString().slice(0, 10);
  const system =
    `You are IntelAI, a sharp competitor-intelligence analyst for an eCommerce brand. ` +
    `Answer the user's question about the competitor "${name}" using ONLY the DATA below — their live ads, organic social posts, and captured marketing emails.\n\n` +
    `Rules:\n` +
    `- Ground every claim in the data; cite specific dates, numbers, platforms and offers when relevant.\n` +
    `- If the data doesn't contain the answer, say so plainly and suggest what to watch to find out — never speculate or invent facts, dates, or figures.\n` +
    `- The DATA spans the recent capture window (often ~30 days of posts), not just today — for questions about a range ("last 30 days") or superlatives ("highest engagement", "best post"), scan the FULL list and compare the numbers given.\n` +
    `- Whenever you reference a specific post, ad, or email, include its link/URL from the data, in full and on its own, so the user can open it directly. If a post has no link in the data, say so.\n` +
    `- Lead with the answer. Be concise and direct (a few sentences or tight bullets). Do NOT narrate your reasoning or restate the question — give the final answer only.\n` +
    `- Write for a busy marketer: practical and specific.\n\n` +
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
