// ── Priority-ordered daily signals for the Slack brief ────────────────────────
// Detects, per competitor, the moves the founder cares about MOST, in strict
// priority order:
//   1. SALE change      — a sale started/ended/changed, or the promo banner changed
//   2. NEW funnel       — a landing page / domain in an ad we hadn't seen before
//   3. NEW Facebook page— the brand advertising from a page it wasn't using before
//   4. NEW products     — products added to the storefront
//   5. NEW ad angle     — a fresh creative whose angle hasn't run in the last 2 weeks
//
// Everything is grounded in captured data (no invention). Detection is deliberately
// CONSERVATIVE — when unsure whether something is genuinely new, we stay silent
// rather than cry wolf (same precision-first discipline as ad attribution).

import { recentSnapshots, allSnapshots, latestSnapshot, saveSnapshot } from './snapshots.js';
import { diffWebsite } from './website.js';
import { adsChanges, adDomain, isFunnelUrl } from './ads.js';
import { offerFlags, isSaleBanner } from './occasions.js';

const DAY = 86400000;
const ANGLE_WINDOW_DAYS = 14;   // "at least the last 2 weeks"

// ── Tier-2 "routine activity" helpers ─────────────────────────────────────────
// A one-line "what was it about" for a new ad / post / email, built from fields ALREADY
// captured (the AI hook/angle from the warm, the email subject) — so Tier 2 costs no extra
// AI call. Everything is diffed against the PREVIOUS capture, so a given ad/post/email is
// "new" exactly once and never needs stored state.
const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
function clip(s, n) { s = oneLine(s); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function adAbout(a) { return clip((a && (a.hook || a.angle || a.text || a.title)) || 'new creative', 90); }
function postAbout(p) { return clip((p && (p.hook || p.text || p.kind)) || 'new post', 90); }
// True only when an ad's REAL launch date (Meta's "started running") is within the last N days.
// No date, or an older one, → NOT new — the ground truth for "newly launched", immune to the
// scrape-flakiness that makes an old ad look new when it drops out of a capture and returns.
function startedWithinDays(started, todayStr, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(started || ''));
  if (!m) return false;
  const age = (Date.parse(todayStr + 'T00:00:00Z') - Date.UTC(+m[1], +m[2] - 1, +m[3])) / DAY;
  return age >= 0 && age <= n;
}
const OFFER_STATE = '_offerstate';   // internal channel — never served publicly (see snapshots.js)
const OFFER_STATE_TTL_DAYS = 400;    // forget a fingerprint long after its ad can plausibly still run

// A real promo banner is a short headline. Older snapshots may hold a model's non-answer
// prose ("I don't see any active promotion…") — never compare those as if they were
// banners, or we'd report a bogus "Promo changed" between two pieces of explanation.
function bannerOk(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/^(i (don'?t|do not|can'?t|cannot)\b|there (is|are) no\b|no (active|visible|current)?\s*(promotion|promo|sale|offer|banner)|none\b|n\/?a\b|unable\b)/i.test(t)) return false;
  return t.split(/\s+/).length <= 16 && t.length <= 120;
}

// Normalise an angle to a comparable fingerprint: significant lowercase word-stems,
// sorted and de-duplicated. Short/stopword tokens are dropped so wording drift
// ("scarcity urgency" vs "urgency + scarcity") maps to the same set.
const STOP = new Set(['the', 'and', 'for', 'with', 'your', 'you', 'our', 'that', 'this', 'from', 'into', 'over', 'via', 'off', 'per', 'ad', 'ads', 'angle', 'a', 'an', 'of', 'to', 'on', 'in', 'is', 'it', 'as', 'at', 'by']);
function angleTokens(s) {
  return [...new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w)))];
}
// Two angles count as the SAME when their significant tokens overlap heavily (Jaccard
// ≥ 0.5) — biased toward "already seen" so we don't over-report reworded repeats.
function sameAngle(aTok, bTok) {
  if (!aTok.length || !bTok.length) return false;
  const bset = new Set(bTok);
  const inter = aTok.filter((t) => bset.has(t)).length;
  return inter / (aTok.length + bTok.length - inter) >= 0.5;
}

// Ad angles seen in the [today-14d, yesterday] window (excludes today).
async function priorAngles(host, todayStr) {
  const cutoff = new Date(Date.parse(todayStr) - ANGLE_WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const snaps = await allSnapshots(host, 'ads');   // oldest → newest
  const seen = [];
  for (const s of snaps) {
    if (!s.day || s.day >= todayStr || s.day < cutoff) continue;
    for (const a of (s.data && s.data.ads) || []) {
      const t = angleTokens(a.angle);
      if (t.length) seen.push(t);
    }
  }
  return seen;
}

// #5 — genuinely NEW creatives today whose angle hasn't run in the last 2 weeks.
async function newAngles(host, freshAds, todayStr) {
  if (!freshAds || !freshAds.length) return [];
  const prior = await priorAngles(host, todayStr);
  const out = [], emitted = [];
  for (const a of freshAds) {
    const tok = angleTokens(a.angle);
    if (!tok.length) continue;                                   // no angle read → can't claim it's new
    if (prior.some((p) => sameAngle(tok, p))) continue;          // ran within the window → not new
    if (emitted.some((p) => sameAngle(tok, p))) continue;        // already surfaced this round
    emitted.push(tok);
    out.push({ angle: a.angle, link: a.link || '', image: a.image || '' });
    if (out.length >= 2) break;   // a genuinely new angle is rare — surface at most the top 2
  }
  return out;
}

// #0 — a live ad leaning on an out-of-season occasion ("Black Friday" in July). Ranks ABOVE
// a sale CHANGE: it says the discount is effectively their permanent price.
//
// Fake-timer signals ("Today only" running 52 days) were REMOVED 17 Jul — the founder's
// call: "this is common sense for ecom brands, don't call out fake timers". See occasions.js.
//
// Unlike every other signal here, this one is not a day-over-day diff — the offer is stale
// every single day, so a diff would report it either forever (noise) or never. It is
// announced ONCE, the first day it's seen, and then goes quiet.
//
// The "already announced" set is stored per HOST (like the snapshots it's derived from), so
// the fact is tenant-neutral — no client data. A fingerprint is treated as fresh while
// firstSeen === today, so every client tracking the same brand still hears it on day one,
// in whatever order their briefs happen to build; from day two, nobody does.
async function newStaleOffers(host, ads, todayStr, commit) {
  const flags = offerFlags(ads, new Date(todayStr + 'T00:00:00Z'));
  if (!flags.length) return [];

  const st = await latestSnapshot(host, OFFER_STATE);
  const seen = (st && st.seen && typeof st.seen === 'object') ? st.seen : {};

  const fresh = [], byFp = new Set();
  for (const f of flags) {
    if (byFp.has(f.fp)) continue;                        // identical ads → one announcement
    if (seen[f.fp] && seen[f.fp] !== todayStr) continue; // announced on an earlier day → stay quiet
    byFp.add(f.fp);
    fresh.push(f);
  }
  if (!fresh.length) return [];

  // Only a REAL delivery marks the announcement as made — a PREVIEW (daily-brief preview,
  // announce preview) used to consume the once-only state, so the actual morning brief then
  // stayed silent about it forever (audit bug).
  if (commit) {
    const next = {};
    const cutoff = new Date(Date.parse(todayStr) - OFFER_STATE_TTL_DAYS * DAY).toISOString().slice(0, 10);
    for (const [fp, day] of Object.entries(seen)) if (typeof day === 'string' && day >= cutoff) next[fp] = day;
    for (const f of fresh) if (!next[f.fp]) next[f.fp] = todayStr;
    await saveSnapshot(host, OFFER_STATE, { seen: next });
  }

  return fresh;
}

// Rotation guard: has this SALE banner (or a near-identical one) already shown in the recent
// capture window? If so, the "new" appearance today is just the announcement bar cycling back
// to its sale slide — not a new sale. Compares normalised text against the last ~10 captures.
const SALE_LOOKBACK = 10;
function normBanner(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
async function saleBannerSeenRecently(host, banner, todayStr) {
  const target = normBanner(banner);
  if (!target) return true;   // nothing to compare → don't fire
  try {
    const snaps = await allSnapshots(host, 'website');   // oldest → newest
    const prior = snaps.filter((s) => s.day && s.day < todayStr).slice(-SALE_LOOKBACK);
    for (const s of prior) {
      const b = s.data && s.data.banner;
      if (b && isSaleBanner(b) && normBanner(b) === target) return true;   // this exact sale ran before → rotation
    }
    return false;
  } catch (e) { return true; }   // on any doubt, stay quiet (precision-first)
}

// Detect everything for one host. Returns a structured object; empty arrays / null
// mean "no signal". Never throws — a subsystem with no data just yields nothing.
export async function dailySignals(host, commit) {
  const out = { staleOffer: [], sale: null, funnel: [], fbPage: [], products: [], angle: [], activity: { ads: [], posts: [], emails: [], website: [] } };
  if (!host) return out;
  const todayStr = new Date().toISOString().slice(0, 10);

  // 1 + 4) Website: sale change (count or promo banner) and new products.
  try {
    // Compare today's capture against the most recent EARLIER capture that actually got the
    // product feed — skipping days where the scrape came back empty/rate-limited (Seranova's
    // storefront returned no summary on 18 Jul). Diffing against a broken capture is what makes
    // a report falsely quiet OR falsely "changed"; fall back to the last good one instead.
    const web = await recentSnapshots(host, 'website', 6);
    const cur = web[0] && web[0].data;
    const prev = (web.slice(1).find((s) => s.data && s.data.summary) || {}).data;
    if (cur && cur.summary && prev && prev.summary) {
      const diffs = diffWebsite(prev.summary, cur.summary) || [];
      // The RELIABLE sale event: the count of discounted PRODUCTS changed (from products.json,
      // not the rotating banner). This is the primary trigger.
      const saleLine = diffs.find((d) => /^Sale (started|ended)/i.test(d));
      if (saleLine) out.sale = saleLine;
      else {
        // Banner fallback — but ROTATION-SAFE. Shopify announcement bars cycle several slides,
        // so we only ever capture one of them. Rules the founder set (17 Jul):
        //  • a "free shipping / free returns / new arrivals" banner is NEVER a promo (isSaleBanner);
        //  • a rotation from a sale slide to a non-sale slide is NOT "sale ended";
        //  • the SAME sale seen on some days and not others (rotation) must not re-fire.
        // So: only a genuine SALE banner, and only if it hasn't shown in the recent capture
        // window (i.e. it's actually new, not just the sale slide coming back around).
        const saleB = bannerOk(cur.banner) && isSaleBanner(cur.banner) ? String(cur.banner).trim() : '';
        if (saleB && !(await saleBannerSeenRecently(host, saleB, todayStr))) {
          out.sale = 'Sale live: ' + saleB;
        }
      }
      out.products = diffs.filter((d) => /new product/i.test(d));
      // Tier-2: any OTHER real storefront change (price moves, products removed, lowest-price
      // shift) still counts as activity, so a changed site is never marked "all quiet". Sale
      // start/end and new products are priority (above), so exclude them here; a rotating
      // banner is NOT in diffs, so it correctly never counts.
      out.activity.website = diffs.filter((d) => !/^Sale (started|ended)/i.test(d) && !/new product/i.test(d));
    }
  } catch (e) { /* no website signal */ }

  // 2 + 3 + 5) Ads: new funnel, new Facebook page, new angle.
  try {
    const adSnap = (await recentSnapshots(host, 'ads', 1))[0];
    const todayAds = (adSnap && adSnap.data && Array.isArray(adSnap.data.ads)) ? adSnap.data.ads : [];
    if (todayAds.length) {
      // 0) Stale/fake offers — independent of adsChanges: a fake sale is worth announcing
      // even on the baseline capture, when there is no previous day to diff against.
      try { out.staleOffer = await newStaleOffers(host, todayAds, todayStr, !!commit); } catch (e) { /* no offer signal */ }
      const ch = await adsChanges(host, todayAds, adSnap.day);   // diff as of the CAPTURE's day, not the wall clock
      if (ch && !ch.baseline) {
        out.funnel = (ch.signals.landings || []).filter((l) => l && l.domain);   // [{domain, url}]
        out.fbPage = (ch.signals.pages || []).filter(Boolean);                    // [pageName]
        out.angle = await newAngles(host, ch.newAds || [], todayStr);
        // Tier-2 "new ad": a genuinely NEWLY-LAUNCHED ad, judged by the ad's own START DATE —
        // NOT merely "appeared in today's capture but not yesterday's". Meta's Ad Library
        // returns an incomplete set on some pulls, so an OLD ad (Artem's, live since 26 May)
        // that blips out of one capture and returns was falsely flagged "new" (19 Jul). The
        // start date can't be fooled by that. `ch.newAds` still gates it to first-appearance so
        // a real new ad is reported once; the date filter kills the reappearance false positives.
        out.activity.ads = (ch.newAds || []).filter((a) => startedWithinDays(a.started, todayStr, 3))
          .slice(0, 3).map((a) => ({ about: adAbout(a), link: a.link || '' }));
      } else if (ch && ch.baseline) {
        // BASELINE day (capture-depth jump): the ad-count diff is unreliable, but "have we EVER
        // seen this page / landing domain before?" is depth-proof — a page identity doesn't
        // inflate when the scrape pulls deeper. So the founder's priority signals (new FB page,
        // new funnel) still fire on a baseline day, judged against ALL recent history; only the
        // ad-count flood and angle work stay suppressed. (Glov's doctor-persona pages arrived
        // on exactly such a day, 20 Jul, and the brief stayed silent — this is that fix.)
        try {
          const hist = (await allSnapshots(host, 'ads')).filter((s) => s.day && s.day < (adSnap.day || todayStr));
          if (hist.length) {   // genuinely first capture ever → nothing to compare, stay quiet
            const prevPages = new Set(), prevLand = new Set();
            for (const s of hist) for (const a of ((s.data && s.data.ads) || [])) {
              if (a.page) prevPages.add(String(a.page).toLowerCase());
              const dm = adDomain(a.landing); if (dm) prevLand.add(dm);
            }
            out.fbPage = [...new Set(todayAds.filter((a) => a.page && !prevPages.has(String(a.page).toLowerCase())).map((a) => a.page))];
            const seenDm = new Set();
            for (const a of todayAds) {
              const dm = adDomain(a.landing);
              if (dm && !prevLand.has(dm) && !seenDm.has(dm) && isFunnelUrl(a.landing)) { seenDm.add(dm); out.funnel.push({ domain: dm, url: a.landing }); }
            }
          }
        } catch (e) { /* stay quiet on a baseline day we can't judge */ }
      }
    }
  } catch (e) { /* no ads signal */ }

  // Tier-2: new ORGANIC posts vs the previous capture, per platform.
  try {
    for (const [pf, label] of [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['facebook', 'Facebook']]) {
      const snaps = await recentSnapshots(host, pf, 6);
      const cur = (snaps[0] && snaps[0].data && snaps[0].data.posts) || [];
      if (!cur.length) continue;
      // prev = the most recent EARLIER capture that actually returned posts — skip a failed/empty
      // scrape, which would otherwise make every current post look "new".
      const prevSnap = snaps.slice(1).find((s) => s.data && Array.isArray(s.data.posts) && s.data.posts.length);
      if (!prevSnap) continue;   // no good prior capture → can't call anything new yet
      const prevUrls = new Set(prevSnap.data.posts.map((p) => p.url).filter(Boolean));
      const fresh = cur.filter((p) => p.url && !prevUrls.has(p.url));
      if (fresh.length) {
        const newest = fresh.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
        out.activity.posts.push({ platform: label, count: fresh.length, about: postAbout(newest), url: newest.url || '' });
      }
    }
  } catch (e) { /* no post activity */ }

  // Tier-2: new EMAILS vs the previous capture (diffed by row id — self-expiring, no AI).
  try {
    const eSnaps = await recentSnapshots(host, 'email', 6);
    const cur = (eSnaps[0] && eSnaps[0].data && eSnaps[0].data.emails) || [];
    // prev = most recent EARLIER capture that actually held emails (skip an empty/failed one).
    const prevSnap = eSnaps.slice(1).find((s) => s.data && Array.isArray(s.data.emails) && s.data.emails.length);
    if (cur.length && prevSnap) {
      const prevIds = new Set(prevSnap.data.emails.map((e) => e.id).filter((x) => x != null));
      const fresh = cur.filter((e) => e.id != null && !prevIds.has(e.id));
      out.activity.emails = fresh.slice(0, 3).map((e) => ({ subject: clip(e.subject || '(no subject)', 70), offer: e.offer || '' }));
    }
  } catch (e) { /* no email activity */ }

  return out;
}

// True when any signal fired.
export function hasSignal(s) {
  return !!(s && ((s.staleOffer && s.staleOffer.length) || s.sale || (s.funnel && s.funnel.length) || (s.fbPage && s.fbPage.length) || (s.products && s.products.length) || (s.angle && s.angle.length)));
}

// Render one brand's signals as Slack mrkdwn lines, in PRIORITY ORDER.
// Returns [] when nothing fired (caller shows "all quiet").
//
// Deliberately spare: the 💡/✅ on the brand line already carries the at-a-glance status,
// so a per-line icon would double-code what the words say — and a repeated 🎯 stops being
// an anchor anyway. Sale/product strings already name themselves ("Sale widened — …",
// "2 new products: …"), so they get NO label prefix or it reads twice. Ad URLs are long
// enough to wrap onto their own line, so they're linked behind short text instead.
export function signalLines(s) {
  if (!s) return [];
  const lines = [];
  const link = (u, label) => (u ? ' — <' + u + '|' + label + ' ↗>' : '');
  // Announced once, so it leads — and it says the thing outright rather than making the
  // reader infer it from a date. Numbers come from occasions.js, never from a model.
  for (const f of (s.staleOffer || [])) {
    lines.push('Fake sale: “' + f.label + '” still live — ' + f.monthsSince + ' months out of season, running ' +
      f.running + ' days' + link(f.link, 'view ad'));
  }
  if (s.sale) lines.push(s.sale);
  for (const f of (s.funnel || [])) lines.push('New funnel: ' + f.domain + link(f.url, 'open'));
  for (const p of (s.fbPage || [])) lines.push('New FB page advertising: ' + p);
  for (const pr of (s.products || [])) lines.push(pr);
  for (const a of (s.angle || [])) lines.push('New angle (2wk+): ' + a.angle + link(a.link, 'view ad'));
  return lines;
}

// Tier-2 lines: routine activity (new ad / email / organic post + what it was about). Shown
// only when NO priority signal fired, so a brand is never both a "big move" and "routine".
export function hasActivity(s) {
  const a = s && s.activity;
  return !!(a && ((a.ads || []).length || (a.emails || []).length || (a.posts || []).length || (a.website || []).length));
}
export function activityLines(s) {
  if (!s || !s.activity) return [];
  const a = s.activity, lines = [];
  const link = (u, label) => (u ? ' — <' + u + '|' + label + ' ↗>' : '');
  for (const ad of (a.ads || [])) lines.push('New ad — “' + ad.about + '”' + link(ad.link, 'view'));
  for (const em of (a.emails || [])) lines.push('New email — “' + em.subject + '”' + (em.offer ? ' [' + em.offer + ']' : ''));
  for (const p of (a.posts || [])) {
    lines.push((p.count > 1 ? p.count + ' new ' + p.platform + ' posts, latest: ' : 'New ' + p.platform + ' post — ') + '“' + p.about + '”' + link(p.url, 'view'));
  }
  for (const w of (a.website || [])) lines.push('Website change — ' + w);
  return lines;
}
