// FINDINGS ENGINE — code decides WHAT is true; the model only phrases it.
//
// The old pipeline handed the model raw captures and asked "what's interesting?", then tried
// to catch untrue sentences afterwards. That is an infinite list of wrong statements to
// enumerate, and a week of real failures proved it:
//   Casa       "ad destination switched today"      — 2 ads sampled out of ~30
//   Ancestral  "1 new product: Freedom Field Balm"  — reported four days earlier
//   Bonafide   "new funnel: bonafide.us"            — every earlier capture held zero ads
//   UKLASH     "new subscription sale live today"   — same offer, re-worded by our own reader
//   Glov       "nine persona pages dropped"         — capture was at its collection cap
//
// Every one asserts something the data cannot support. So findings are now COMPUTED here,
// each carrying its own evidence and dates, and the model receives only this closed list.
// A claim that does not exist as a finding cannot be written, because nothing suggests it.
//
// Design rules:
//   • NEW requires proof of absence: an earlier capture that actually held data, and the item
//     missing from it. An empty history proves nothing.
//   • ENDED requires a complete capture. Thin or capped captures can never assert absence.
//   • Every finding carries `since`/`seen` dates and the evidence behind it.
//   • When nothing is provable, the honest output is an empty list — not a guess.

import { pool } from './db.js';
import { diffWebsite } from './website.js';
import { sameBannerText, isSaleBanner, offerFlags } from './occasions.js';

const dOf = (v) => String(v instanceof Date ? v.toISOString() : v || '').slice(0, 10);
const domOf = (u) => String(u || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '').toLowerCase();

async function history(host, channel, days = 45) {
  const r = await pool.query(
    `SELECT to_char(day,'YYYY-MM-DD') AS day, data FROM snapshots
      WHERE host = $1 AND channel = $2 ORDER BY day DESC LIMIT $3`, [host, channel, days]);
  return r.rows;
}

// ── ADS ───────────────────────────────────────────────────────────────────────
// Exported for test/findings.test.js — the engine decides what is true, so its rules are
// pinned by fixtures replaying the real failures (Bonafide's empty history, capped captures).
export function adsFindings(rows, capN) {
  const out = [], today = rows[0];
  if (!today) return out;
  const ads = (today.data && today.data.ads) || [];
  const earlier = rows.slice(1).filter((r) => ((r.data && r.data.ads) || []).length > 0);

  // Capture health decides what may be asserted at all.
  const counts = rows.map((r) => ((r.data && r.data.ads) || []).length).filter((n) => n > 0).sort((a, b) => a - b);
  const typical = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  const thin = !!(typical && ads.length < typical * 0.5);
  const capped = ads.length >= Math.floor(capN * 0.95);

  out.push({
    type: 'context', key: 'ads.volume',
    text: ads.length + ' ads captured on ' + today.day + (typical ? ' (typical for this brand: ' + typical + ')' : ''),
    evidence: { count: ads.length, typical },
  });

  if (!earlier.length) {
    out.push({
      type: 'limit', key: 'ads.nohistory',
      text: 'No earlier capture for this brand held any ads, so nothing in today\'s ads can be described as new, first, or a change.',
    });
  }

  // What we have EVER seen before today.
  const seenDom = new Map(), seenPage = new Map();
  for (const r of earlier) {
    for (const a of ((r.data && r.data.ads) || [])) {
      const d = domOf(a.landing); if (d && !seenDom.has(d)) seenDom.set(d, r.day);
      if (a.page && !seenPage.has(a.page)) seenPage.set(a.page, r.day);
    }
  }

  const domNow = new Map(), pageNow = new Map();
  for (const a of ads) {
    const d = domOf(a.landing); if (d) domNow.set(d, (domNow.get(d) || 0) + 1);
    if (a.page) pageNow.set(a.page, (pageNow.get(a.page) || 0) + 1);
  }

  // Present-tense facts are always safe to state.
  if (domNow.size) {
    out.push({
      type: 'state', key: 'ads.destinations',
      text: 'All ' + ads.length + ' ads in today\'s capture run to ' + [...domNow.keys()].join(', ') + '.',
      evidence: { domains: [...domNow.entries()] },
    });
  }
  if (pageNow.size) {
    out.push({
      type: 'state', key: 'ads.pages',
      text: 'The ' + ads.length + ' ads captured today run from ' + [...pageNow.keys()].map((p) => '"' + String(p).trim() + '"').join(', ') + '.',
      evidence: { pages: [...pageNow.entries()] },
    });
  }

  if (ads.length) {
    out.push({ type: 'limit', key: 'ads.notcensus', text: 'This capture is what the Ad Library returned, not a proven-complete inventory: whitelisted ads from third-party pages may exist outside it. Scope every statement to what was captured.' });
  }

  // NEW only with proof of absence from a capture that actually held ads.
  if (earlier.length && !thin) {
    for (const [d] of domNow) {
      if (!seenDom.has(d)) out.push({ type: 'new', key: 'ads.newDomain:' + d, text: 'Ad landing domain ' + d + ' appears for the first time; it was absent from every earlier capture that held ads (back to ' + earlier[earlier.length - 1].day + ').', evidence: { domain: d } });
    }
    for (const [p] of pageNow) {
      if (!seenPage.has(p)) out.push({ type: 'new', key: 'ads.newPage:' + p, text: 'Ads appear from "' + String(p).trim() + '" for the first time; this page was absent from every earlier capture that held ads.', evidence: { page: p } });
    }
  }

  // NEW CREATIVES — the launches themselves (founder, 7 Aug: "anything new is very useful —
  // the user needs to know what their competitors are launching"). Domains and pages almost
  // never change, so without per-creative findings the ads read had nothing NEW to phrase and
  // the gate rightly stripped whatever the model improvised — reports went quiet while the
  // Oodie was launching daily. Proof is per item and SAMPLING-SAFE, two conditions together:
  // the ad's id was never in an earlier capture AND Meta's own start_date is on/after the
  // last day we captured ads. An old ad that merely rotated into a capped window fails the
  // date test; a genuinely fresh ad passes both. First-capture days still prove nothing.
  if (earlier.length) {
    const seenIds = new Set();
    for (const r of earlier) for (const a of ((r.data && r.data.ads) || [])) if (a.id) seenIds.add(String(a.id));
    // Recency window: 7 days back from today's capture (founder freshness rule — "new"
    // means this week). Anchoring on the previous capture day alone missed the lag-tail:
    // with capped 100-ad windows a fresh ad can take days to rotate into view, and an ad
    // started 5 Aug but first SEEN on the 8th is still news. The id test keeps every
    // re-sighting out; the date test keeps genuinely old ads out.
    const cutoff = new Date(Date.parse(today.day + 'T00:00:00Z') - 7 * 864e5).toISOString().slice(0, 10);
    const fresh = ads
      .filter((a) => a.id && !seenIds.has(String(a.id)) && /^\d{4}-\d{2}-\d{2}$/.test(String(a.started || '')) && a.started >= cutoff)
      .sort((a, b) => String(b.started).localeCompare(String(a.started)));
    const fmtOf2 = (a) => (a.hasVideo ? 'video' : String(a.format || 'image').toLowerCase());
    for (const a of fresh.slice(0, 6)) {
      const hook = String(a.text || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 110);
      out.push({
        type: 'new', key: 'ads.launch:' + a.id,
        text: 'New ad launched ' + a.started + ' (Meta start date) — ' + fmtOf2(a) + ' from "' + String(a.page || '').trim() + '"' + (hook ? ', opening: "' + hook + '"' : '') + (domOf(a.landing) ? ' → ' + domOf(a.landing) : '') + '.',
        evidence: { id: a.id, started: a.started, format: fmtOf2(a), page: a.page || '', landing: a.landing || '', link: a.link || '', cta: a.cta || '' },
      });
    }
    if (fresh.length) {
      const nVid = fresh.filter((a) => a.hasVideo).length;
      const since = fresh[fresh.length - 1].started;
      // Carry the CREATIVE SUBSTANCE, not just the count (founder, 9 Aug: "can you give an
      // angle or hook or ad style summary in cases like this one") — the newest opening
      // line and where the batch drives, so a mass-launch day reads as WHAT they are
      // saying, never as capture arithmetic.
      const hook = String(fresh[0].text || fresh[0].title || '').replace(/\s+/g, ' ').trim().slice(0, 110);
      const doms = [...new Set(fresh.map((a) => domOf(a.landing)).filter(Boolean))].slice(0, 3);
      out.push({
        type: 'new', key: 'ads.launches',
        text: fresh.length + ' new ad' + (fresh.length > 1 ? 's' : '') + ' launched since ' + since + ' (Meta start dates; ' + nVid + ' video, ' + (fresh.length - nVid) + ' image/carousel)' + (hook ? '; newest opens: "' + hook + '"' : '') + (doms.length ? ' → ' + doms.join(', ') : '') + (fresh.length > 6 ? ' — the 6 newest are itemised above' : '') + '.',
        evidence: { count: fresh.length, video: nVid, since, hook, landing: doms.join(', ') },
      });
    }
  }

  // ABSENCE is only evidence from a complete capture.
  if (earlier.length && !thin && !capped && ads.length) {
    const prev = earlier[0];
    const prevPages = new Set(((prev.data && prev.data.ads) || []).map((a) => a.page).filter(Boolean));
    const gone = [...prevPages].filter((p) => !pageNow.has(p));
    if (gone.length) out.push({ type: 'absence', key: 'ads.pagesGone', text: 'Pages running ads on ' + prev.day + ' but not in today\'s full capture: ' + gone.join(', ') + '. Treat as not seen today, not as retired.', evidence: { gone } });
  } else if (thin || capped) {
    out.push({ type: 'limit', key: 'ads.sample', text: 'Today\'s ad capture is ' + (capped ? 'at the collection cap — a rolling window of their newest ads, not the full library' : 'a thin slice (' + ads.length + ' of a typical ' + typical + ')') + '. Nothing may be described as dropped, retired, switched or shifted from it.' });
  }

  // Out-of-season offers (computed in occasions.js, identity attached).
  try {
    for (const f of offerFlags(ads, new Date(today.day + 'T00:00:00Z')).slice(0, 3)) {
      // NO date clause (founder, 9 Aug): "live since <ad start>" implied the offer began
      // the day the newest ad did; offer age is unknowable and live-since dating is clutter.
      out.push({ type: 'state', key: 'ads.staleOffer:' + f.fp, text: '"' + f.label + '" offer is running ' + f.monthsSince + ' months out of season.', evidence: { page: f.page, quote: f.quote, link: f.link } });
    }
  } catch (e) { /* optional */ }

  // LANDING-URL HEALTH — resolved at capture time (landcheck.js): where each ad domain
  // ACTUALLY lands. Catches dead funnels (founder, 9 Aug: "get.thetallowedtruth.com is
  // giving me 404 — you must catch this") and silent retirements ("even more useful if
  // you tested the URL and caught they are redirecting try-derm to their homepage").
  const lands = (today.data && today.data.landings) || null;
  if (lands) {
    for (const [d, r] of Object.entries(lands)) {
      if (!r || r.error) continue;                       // network failure ≠ dead page
      if (r.status === 404 || r.status === 410) {
        out.push({ type: 'state', key: 'ads.landDown:' + d, text: 'Ad landing page ' + (r.url || d) + ' is DEAD — it returned HTTP ' + r.status + ' when checked on ' + today.day + '; ads are paying for clicks to a broken page.', evidence: { domain: d, url: r.url, status: r.status } });
      } else if (r.finalUrl) {
        const fh = domOf(r.finalUrl);
        if (fh && fh !== d) out.push({ type: 'state', key: 'ads.landRedirect:' + d + '>' + fh, text: 'Ad landing domain ' + d + ' now REDIRECTS to ' + r.finalUrl + ' — the ' + d + ' funnel is not being served; ad traffic lands on ' + fh + ' instead.', evidence: { domain: d, url: r.url, finalUrl: r.finalUrl } });
      }
    }
  }
  return out;
}

// ── WEBSITE ───────────────────────────────────────────────────────────────────
export function websiteFindings(rows) {
  const out = [], today = rows[0];
  if (!today) return out;
  const cur = today.data || {};
  const prev = rows.slice(1).find((r) => r.data && r.data.summary);
  const bannerNow = cur.banner || '';

  // ROTATION IS THE NORM (founder, 6 Aug — Glov). Announcement bars cycle sale + social
  // proof + USP slides, so one capture is a SAMPLE of the bar, not the bar. Surface the other
  // slides we have seen recently, and say plainly that today's slide proves nothing about the
  // others still being there.
  const slides = [];
  for (const r of rows.slice(0, 14)) {
    const b2 = r.data && r.data.banner;
    if (b2 && !slides.some((x) => sameBannerText(x.text, b2))) slides.push({ text: b2, day: r.day, sale: isSaleBanner(b2) });
  }
  if (slides.length > 1) {
    out.push({
      type: 'context', key: 'web.rotation',
      text: 'Their announcement bar ROTATES — slides seen recently: ' + slides.slice(0, 4).map((x) => '"' + x.text + '" (' + x.day + ')').join(', ') +
        '. Today\'s captured slide is one of several; the others are almost certainly still running. Never treat a slide missing today as removed, or a slide seen today as newly added.',
      evidence: { slides: slides.slice(0, 5) },
    });
  }

  if (bannerNow && bannerNow.trim().length > 2) {
    // Date the banner from its own history, tolerant of re-wording and rotation.
    let since = today.day;
    for (const r of rows.slice(1)) {
      const b = r.data && r.data.banner;
      if (b && sameBannerText(b, bannerNow)) since = r.day; else if (b) break;
    }
    const isNew = since === today.day && rows.length > 1 && rows.slice(1).some((r) => r.data);
    out.push({
      type: isNew ? 'new' : 'state', key: 'web.banner',
      text: isSaleBanner(bannerNow)
        ? ('Storefront promo: "' + bannerNow + '"' + (isNew ? ' — first seen today; earlier captures showed a different banner.' : ' — unchanged since ' + since + '.'))
        : ('Storefront announcement bar shows operational messaging (not a promo): "' + bannerNow + '".'),
      evidence: { banner: bannerNow, since },
    });
  }

  if (!prev) {
    out.push({ type: 'limit', key: 'web.nohistory', text: 'No earlier storefront capture with a product feed, so no product or price change can be established.' });
    return out;
  }

  const changes = diffWebsite(prev.data.summary, cur.summary) || [];
  if (!changes.length) {
    out.push({ type: 'state', key: 'web.nochange', text: 'Storefront compared ' + prev.day + ' → ' + today.day + ': prices, products and sale scope unchanged.' });
  } else {
    // Products already seen in ANY earlier capture can never be new.
    const known = new Set();
    for (const r of rows.slice(1)) {
      const items = (r.data && r.data.summary && r.data.summary.items) || {};
      for (const h of Object.keys(items)) { known.add(h); const t = items[h] && items[h].title; if (t) known.add(String(t).toLowerCase()); }
    }
    for (const c of changes) {
      const isAdd = /new product|new listing/i.test(c);
      if (isAdd) {
        const named = [...known].filter((k) => k.length >= 5 && c.toLowerCase().indexOf(k) >= 0);
        if (named.length) { out.push({ type: 'state', key: 'web.relisting', text: 'Storefront listing change involves products already on their site (' + named.slice(0, 3).join(', ') + ') — a re-listing or variant, not a new product.', evidence: { known: named.slice(0, 5) } }); continue; }
      }
      out.push({ type: isAdd ? 'new' : 'change', key: 'web.change:' + c.slice(0, 40), text: c + ' (' + prev.day + ' → ' + today.day + ')', evidence: { change: c } });
    }
  }
  return out;
}

// ── SOCIAL / EMAIL — appearance only; a rolling window can never prove absence ─
export function windowFindings(rows, label, itemsOf) {
  const out = [], today = rows[0];
  if (!today) return out;
  const now = itemsOf(today.data) || [];
  const prev = rows.slice(1).find((r) => (itemsOf(r.data) || []).length);
  if (!now.length) {
    out.push({ type: 'limit', key: label + '.none', text: 'No ' + label + ' content captured on ' + today.day + '. This does not establish that they posted nothing — only that we hold none for that day.' });
    return out;
  }
  out.push({ type: 'context', key: label + '.count', text: now.length + ' ' + label + ' items captured on ' + today.day + ' (we store only the newest; older items rotate out of view).' });
  if (prev) {
    const seen = new Set((itemsOf(prev.data) || []).map((p) => p.id || p.link || p.text));
    const fresh = now.filter((p) => !seen.has(p.id || p.link || p.text));
    for (const p of fresh.slice(0, 4)) {
      out.push({ type: 'new', key: label + '.new:' + (p.id || p.link || String(p.text || '').slice(0, 20)), text: 'New ' + label + ' item since ' + prev.day + ': "' + String(p.text || p.subject || '').replace(/\s+/g, ' ').slice(0, 110) + '"', evidence: { link: p.link || '', views: p.views || null, date: p.date || null } });
    }
  }
  return out;
}

// ── PUBLIC ────────────────────────────────────────────────────────────────────
export async function computeFindings(host, opts = {}) {
  const capN = Number(process.env.ADS_COUNT) || 50;
  const [ads, web, ig, tt, fb, em] = await Promise.all([
    history(host, 'ads'), history(host, 'website'),
    history(host, 'instagram', 8), history(host, 'tiktok', 8), history(host, 'facebook', 8), history(host, 'email', 8),
  ]);
  return {
    host,
    ads: adsFindings(ads, capN),
    website: websiteFindings(web),
    social: [].concat(
      windowFindings(ig, 'Instagram', (d) => d && d.posts),
      windowFindings(tt, 'TikTok', (d) => d && d.posts),
      windowFindings(fb, 'Facebook', (d) => d && d.posts)),
    email: windowFindings(em, 'email', (d) => d && d.emails),
  };
}

// Render one channel's findings as the ONLY material the model may write from.
export function findingsBlock(list) {
  if (!list || !list.length) return '';
  return 'COMPUTED FINDINGS — these are the ONLY things established by the data. Write your read using ONLY these.\n' +
    'You may rephrase, order and connect them, and explain what they mean for the reader. You may NOT add any\n' +
    'claim that is not here — especially anything being new, first, changed, dropped, launched or switched.\n' +
    'Findings marked "limit" describe what the data CANNOT establish: respect them and never work around them.\n\n' +
    list.map((f) => '[' + f.type + '] ' + f.text).join('\n');
}
