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
import { sameBannerText, isSaleBanner, offerFlags, timerIn, TIMER_RE } from './occasions.js';

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
  // ONE SENTENCE FOR THE AD FOOTPRINT (founder, 12 Aug). Destination and origin used to be
  // two findings, and because these texts ship VERBATIM whenever the claim gate falls back,
  // Slack read: "Every captured ad runs to shop.mikmak.ai. The captured ads run from
  // 'Pacific Foods'." — the same subject announced twice. Where they run FROM and TO is one
  // fact about one set of ads, so it is one sentence.
  // R-ADS-HANDLE (founder, 12 Aug): quoted page names alone read ambiguously — say what they
  // ARE by appending "handle"/"handles".
  // R-ADS-RECENT (founder, 13 Aug — Luxe): "Every captured ad" leans on a capture size the
  // client doesn't know or remember; "Recent ads" carries the same scope in reader terms.
  const domList = [...domNow.keys()].join(', ');
  const pageList = [...pageNow.keys()].map((p) => '"' + String(p).trim() + '"').join(', ') + (pageNow.size > 1 ? ' handles' : ' handle');
  if (domNow.size && pageNow.size) {
    out.push({
      // No counts (founder, 10-11 Aug): capture arithmetic here would reach Slack verbatim.
      type: 'state', key: 'ads.footprint',
      text: 'Recent ads run to ' + domList + ' and from ' + pageList + '.',
      evidence: { domains: [...domNow.entries()], pages: [...pageNow.entries()] },
    });
  } else if (domNow.size) {
    out.push({ type: 'state', key: 'ads.destinations', text: 'Recent ads run to ' + domList + '.', evidence: { domains: [...domNow.entries()] } });
  } else if (pageNow.size) {
    out.push({ type: 'state', key: 'ads.pages', text: 'Recent ads run from ' + pageList + '.', evidence: { pages: [...pageNow.entries()] } });
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
      const nImg = fresh.length - nVid;
      const since = fresh[fresh.length - 1].started;
      // Founder, 12 Aug: the gate line was drowning in bookkeeping ("since 2026-08-10
      // (Meta start dates; 18 video, 0 image/carousel)"). Human dates ("yesterday"),
      // "all video" when the mix is uniform, and no trailing itemisation note — the
      // items are already listed above.
      const dayMinus1 = new Date(Date.parse(today.day + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
      const when = since === today.day ? 'today' : (since === dayMinus1 ? 'since yesterday' : 'since ' + since);
      // "all video" needs a plural to make sense — one ad is just "(video)" (founder, 12 Aug:
      // "what do you mean by all if you said it's 1 ad?").
      const mix = nImg === 0 ? (fresh.length === 1 ? 'video' : 'all video') : (nVid === 0 ? (fresh.length === 1 ? 'image' : 'all image') : nVid + ' video, ' + nImg + ' image');
      // Carry the CREATIVE SUBSTANCE, not just the count (founder, 9 Aug) — the newest
      // opening line and where the batch drives. Inner double quotes become singles so
      // a hook that opens with a quotation never renders as ""nested"" garbage, and the
      // clip lands on a word boundary instead of mid-sentence mush.
      let hook = String(fresh[0].text || fresh[0].title || '').replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim();
      if (hook.length > 90) hook = hook.slice(0, 90).replace(/\s+\S*$/, '') + '…';
      const doms = [...new Set(fresh.map((a) => domOf(a.landing)).filter(Boolean))].slice(0, 2);
      out.push({
        type: 'new', key: 'ads.launches',
        text: fresh.length + ' new ad' + (fresh.length > 1 ? 's' : '') + ' launched ' + when + ' (' + mix + ')' + (hook ? ' — newest opens: "' + hook + '"' : '') + (doms.length ? ' → ' + doms.join(', ') : '') + '.',
        evidence: { count: fresh.length, video: nVid, since, hook, landing: doms.join(', ') },
      });
    }
  }

  // HARD QUIET RULE support (founder, 13 Aug): the most recent ad LAUNCH ever captured
  // (max Meta start date), so a quiet day reads "no new ads yesterday — most recent
  // launched <date>" instead of a bare "no new ads" (bare allowed only past 7 days).
  let lastAd = null;
  for (const r of rows) for (const a of ((r.data && r.data.ads) || [])) {
    const st = String(a.started || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(st) && (!lastAd || st > lastAd.started)) lastAd = { started: st, a };
  }
  if (lastAd) {
    const days = Math.round((Date.parse(today.day) - Date.parse(lastAd.started)) / 864e5);
    const hook = String(lastAd.a.text || lastAd.a.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    out.push({
      type: 'context', key: 'ads.lastNew',
      text: 'Most recent ad launch: ' + lastAd.started + ' (' + days + ' days before this capture)' + (hook ? ' — opening: "' + hook + '"' : '') + '. QUIET RULE: within 7 days of it, never a bare "no new ads" — write "no new ads yesterday — most recent launched ' + lastAd.started + '". The bare phrasing is allowed only past 7 days.',
      evidence: { day: lastAd.started, days },
    });
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
    // A domain that doesn't serve must never render as a clickable link (founder, 10 Aug:
    // "you included the website that doesn't work") — a zero-width space after each dot
    // keeps it readable but stops Slack and the dashboard linkifier cold. And never print
    // querystrings ("why for god's sake are you including UTMs") — host + path only.
    const unlink = (h) => String(h).replace(/\./g, '.​');
    // Registrable brand label: casaandbeyond.com.au → "casaandbeyond". A redirect within
    // the same brand (…com.au → …com) is a geo/storefront hop, not a retired funnel.
    // Compared with punctuation stripped: casaandbeyond.com.au → casaand-beyond.com is
    // the SAME brand behind a hyphenated variant (founder, 12 Aug: reported as a retired
    // funnel; it wasn't).
    const sld = (h) => { const p = String(h).split('.'); let i = p.length - 2; if (i > 0 && /^(com|co|net|org|gov|edu)$/.test(p[i]) && String(p[i + 1] || '').length === 2) i--; return (p[i] || String(h)).replace(/[^a-z0-9]/gi, ''); };
    for (const [d, r] of Object.entries(lands)) {
      if (!r || r.error) continue;                       // network failure ≠ dead page
      if (r.status === 404 || r.status === 410) {
        const showUrl = unlink(String(r.url || d).replace(/^https?:\/\//, '').split('?')[0]);
        out.push({ type: 'change', key: 'ads.landDown:' + d, text: 'Ad landing page ' + showUrl + ' is DEAD — it returned HTTP ' + r.status + ' when checked on ' + today.day + '; ads are paying for clicks to a broken page. Do not link it.', evidence: { domain: d, url: r.url, status: r.status } });
      } else if (r.finalUrl) {
        const fh = domOf(r.finalUrl);
        if (fh && fh !== d && sld(fh) !== sld(d)) {
          let path = '';
          try { path = new URL(r.finalUrl).pathname; } catch (e) { /* host only */ }
          const dest = fh + (path && path !== '/' ? (path.length > 48 ? path.slice(0, 48) + '…' : path) : '');
          // Name the exact URL that was probed and when — we tested ONE representative ad
          // landing URL, not the whole domain (founder, 12 Aug: "domain X redirects" read
          // as a claim about the domain root, which serves fine).
          const probed = unlink(String(r.url || d).replace(/^https?:\/\//, '').split('?')[0]);
          out.push({ type: 'change', key: 'ads.landRedirect:' + d + '>' + fh, text: 'Ad landing page ' + probed + ' redirected to ' + dest + ' when checked on ' + today.day + ' — that ad\'s traffic ends up on ' + fh + ', a different site (one ad URL tested, not the whole ' + unlink(d) + ' domain).', evidence: { domain: d, url: r.url, finalUrl: r.finalUrl } });
        }
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
  // ROTATION vs REPLACEMENT: two distinct banner texts in the window can mean either, and
  // the count alone cannot tell them apart (Seranova, 12 Aug — a clean Summer→Back-to-School
  // swap looked identical to a two-slide rotation). The tell is INTERLEAVING: a rotating bar
  // shows its slides on overlapping days, while a replacement splits cleanly in time — every
  // sighting of the old text strictly before every sighting of the new one.
  const slides = [];
  for (const r of rows.slice(0, 14)) {
    const b2 = r.data && r.data.banner;
    if (!b2) continue;
    const hit = slides.find((x) => sameBannerText(x.text, b2));
    if (hit) { hit.days.push(r.day); hit.day = r.day; }               // r.day is older each step
    else slides.push({ text: b2, day: r.day, days: [r.day], sale: isSaleBanner(b2) });
  }
  const spanOf = (sl) => ({ first: sl.days[sl.days.length - 1], last: sl.days[0] });
  // Overlapping runs mean the texts alternate — that is a rotating bar, never a swap.
  const interleaved = slides.length > 1 && slides.some((a, i) => slides.some((b, j) => {
    if (i >= j) return false;
    const A = spanOf(a), B = spanOf(b);
    return A.first <= B.last && B.first <= A.last;
  }));
  // A REPLACEMENT looks like exactly two texts, not interleaved, where the OLDER one held
  // the bar for a run of days before the newer took over. Run length is what separates the
  // two cases: with one capture a day, a rotating bar shows a different slide each day, so
  // its runs are single days and never overlap — an interleaving test alone would read that
  // as a clean swap (it wrongly muted the Glov rotation fixture). An established banner that
  // ran for days and then stopped is a different animal.
  const cleanSplit = slides.length === 2 && !interleaved && slides[1].days.length >= 2;
  if (slides.length > 1 && !cleanSplit) {
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
    // WHAT IT REPLACED, and when we first saw the swap (Seranova, 12 Aug: "Back to School
    // Sale … active and unchanged" — it had replaced "SUMMER SALE: UP TO 58% OFF" the day
    // before). Dating was binary: "first seen today", else "unchanged across recent
    // captures" — so a banner that changed YESTERDAY was reported as stability, and the
    // change itself was never told. A swap inside the recent window is news on the day it
    // is spotted AND for a few days after, per the news-event-first rule: say what
    // replaced what, in time order, before interpreting anything.
    let prevBanner = null;
    for (const r of rows) {
      const b = r.data && r.data.banner;
      if (b && !sameBannerText(b, bannerNow)) { prevBanner = { text: b, day: r.day }; break; }
    }
    // RENAMED, NOT REPLACED (Seranova, 12 Aug — the founder asked when the "new Back to
    // School Sale" launched; there was no new sale). sameBannerText deliberately treats
    // "same discount + heavy word overlap" as ONE promo re-worded — that rule is what stops
    // a false "new sale launched" every time a bar is rephrased (UKLASH, 2 Aug). But it also
    // swallowed a real event: "SUMMER SALE: UP TO 58% OFF" became "Back to School Sale: up
    // to 58% off" overnight, and the read called it unchanged. The offer genuinely did not
    // change; its PRETEXT did, which is the evergreen-occasion tactic worth naming. So the
    // wording gets its own timeline alongside the promo's.
    // The slide list above groups by PROMO identity, and a rename is the same promo — so the
    // old and new wording collapse into one slide there. The rename test therefore needs its
    // own pass at the WORDING level: exact normalised text, its own runs, its own split test.
    const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
    const nowN = norm(bannerNow);
    const wordRuns = [];
    for (const r of rows.slice(0, 14)) {
      const b = r.data && r.data.banner;
      if (!b) continue;
      const hit = wordRuns.find((x) => norm(x.text) === norm(b));
      if (hit) hit.days.push(r.day); else wordRuns.push({ text: b, days: [r.day] });
    }
    let wordSince = today.day, priorWording = null;
    for (const r of rows.slice(1)) {
      const b = r.data && r.data.banner;
      if (!b) continue;
      if (norm(b) === nowN) { wordSince = r.day; continue; }
      priorWording = { text: b, day: r.day };
      break;
    }
    // Same shape as a promo replacement, judged on wording: exactly two wordings in the
    // window, the older one held the bar for a run of days, and it never comes back after
    // the new one starts (a reappearance would mean the bar is rotating, not renamed).
    const wordCleanSplit = wordRuns.length === 2 && wordRuns[1].days.length >= 2
      && !!priorWording && wordRuns[0].days.every((d) => d >= wordSince) && wordRuns[1].days.every((d) => d < wordSince);
    // Guard against the Frøya failure (a PARTIAL vision read of the same bar reported as a
    // replacement): a rename requires two genuinely different texts — neither containing the
    // other — carrying the SAME discount, with real wording differences on both sides.
    const words = (t) => new Set(norm(t).split(' ').filter((w) => w.length > 2));
    const pctOf = (t) => String((String(t || '').match(/\d+\s*%/g) || []).map((x) => x.replace(/\s+/g, '')).sort());
    let renamed = null;
    if (priorWording && sameBannerText(priorWording.text, bannerNow)) {
      const pN = norm(priorWording.text);
      const partialRead = nowN.indexOf(pN) >= 0 || pN.indexOf(nowN) >= 0;
      const A = words(bannerNow), B = words(priorWording.text);
      const onlyNow = [...A].filter((w) => !B.has(w)), onlyPrev = [...B].filter((w) => !A.has(w));
      if (!partialRead && wordCleanSplit && pctOf(bannerNow) === pctOf(priorWording.text) && pctOf(bannerNow) !== '[]'
          && onlyNow.length && onlyPrev.length) {
        const age = Math.round((Date.parse(today.day) - Date.parse(wordSince)) / 864e5);
        if (age <= 6) renamed = { from: priorWording.text, lastSeen: priorWording.day, since: wordSince };
      }
    }
    // A swap needs the older banner to sit strictly BEFORE the current one started, and the
    // window to be a clean split rather than a rotation — in a rotating bar no slide has
    // replaced any other, so "replaced X" would be a straight invention.
    const swapped = !!(prevBanner && prevBanner.day < since && cleanSplit);
    const daysSince = Math.round((Date.parse(today.day) - Date.parse(since)) / 864e5);
    // News for the days AFTER the swap too: the change is what matters, and a client reading
    // Wednesday's brief has not necessarily read Tuesday's.
    const recentSwap = swapped && daysSince >= 1 && daysSince <= 6;
    // Same headline discount under a new occasion name = the evergreen-pretext tactic, not
    // a new offer. Worth naming outright — it is the whole story of a swap like this one.
    const pct = (t) => (String(t || '').match(/\d+\s*%/g) || []).map((x) => x.replace(/\s+/g, ''));
    const sameDiscount = swapped && pct(bannerNow).length > 0 && String(pct(bannerNow)) === String(pct(prevBanner.text));
    // A ticking countdown makes the quoted banner stale within hours — strip the value
    // and name the TACTIC instead (founder, 10 Aug: the 50%-off clearance WITH THE TIMER
    // is the important callout). A timer on a banner already seen on earlier days has by
    // definition reset — an evergreen urgency timer, not a real deadline.
    const tm = timerIn(bannerNow);
    const seenBefore = since !== today.day;
    const quote = tm ? bannerNow.replace(TIMER_RE, '').replace(/\s{2,}/g, ' ').trim().replace(/[\s—–\-:,;]+$/, '') : bannerNow;
    // The dating clause, in time order: what replaced what, then how settled it is. Never
    // "launched"/"live since" — we know when we FIRST SAW it, not when they published it.
    let when;
    if (isNew && swapped) when = ' — first seen in today\'s capture, replacing "' + prevBanner.text + '" (last seen ' + prevBanner.day + ').';
    else if (isNew) when = ' — first seen today; earlier captures showed a different banner.';
    else if (recentSwap) when = ' — replaced "' + prevBanner.text + '" and was first seen in our ' + since + ' capture'
      + (sameDiscount ? '. Same headline discount, new occasion name: the offer did not change, only its pretext' : '') + '.';
    // A RENAMED SALE IS A NEW SALE (founder, 12 Aug: "it's a new sale if it was renamed from
    // Summer Sale to Back To School sale, the discount % is the same but it's a different
    // sale and this is the way how it should be treated"). The occasion IS the sale — the
    // matching discount is context, not grounds for calling it unchanged.
    else if (renamed) when = ' — a NEW SALE: it replaced "' + renamed.from + '" (last captured '
      + renamed.lastSeen + ') and was first captured ' + renamed.since + '. Same headline discount under a new occasion, so the economics are unchanged, but this is a distinct sale. We know when we first SAW it, not when they published it.';
    else when = ' — unchanged across recent captures.';
    // R-BANNER-OPS (founder, 13 Aug — Bonafide: "this is fucking standard in ecomm, don't
    // report free shipping offers"): an operational banner (free shipping/returns/new
    // arrivals) is NEVER reader-visible — typed 'context' so the machinery keeps banner
    // continuity but no surface ever phrases it. Only genuine promos ship as state/new.
    const opsBanner = !isSaleBanner(bannerNow);
    out.push({
      type: opsBanner ? 'context' : ((isNew || recentSwap || renamed) ? 'new' : 'state'), key: 'web.banner',
      text: opsBanner
        ? ('Announcement bar holds operational messaging only ("' + quote + '") — standard ecommerce, not reportable.')
        : ('Storefront promo: "' + quote + '"' + (tm ? ' — with a COUNTDOWN TIMER' + (seenBefore ? ' that keeps resetting day after day (evergreen urgency, not a real deadline)' : '') : '') + when),
      evidence: { banner: bannerNow, since, replaced: prevBanner || undefined, renamed: renamed || undefined, sameDiscount: sameDiscount || undefined, timer: tm || undefined },
    });
  }

  if (!prev) {
    out.push({ type: 'limit', key: 'web.nohistory', text: 'No earlier storefront capture with a product feed, so no product or price change can be established.' });
    return out;
  }

  const changes = diffWebsite(prev.data.summary, cur.summary) || [];
  if (!changes.length) {
    // R-PROV-01 (founder, 12 Aug): NEVER state the comparison window — briefs are daily,
    // so "vs yesterday" is implicit and "compared 2026-08-11 → 2026-08-12" only confuses.
    // Change/no-change statements are absolute; the dates live in evidence, not prose.
    out.push({ type: 'state', key: 'web.nochange', text: 'Storefront unchanged — same prices, products and sale.', evidence: { compared: prev.day + ' → ' + today.day } });
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
    // Daily cadence makes "since <date>" pure noise — a NEW item in a daily report is
    // implicitly since yesterday (founder, 13 Aug: "New email item since 2026-08-11" /
    // "New TikTok item since 2026-08-11" — "we spoke about this already"). Name the thing
    // plainly and clip the quote on a word boundary.
    for (const p of fresh.slice(0, 4)) {
      const noun = /email/i.test(label) ? 'email' : label + ' post';
      let q = String(p.text || p.subject || '').replace(/\s+/g, ' ').trim();
      if (q.length > 110) q = q.slice(0, 110).replace(/\s+\S*$/, '') + '…';
      out.push({ type: 'new', key: label + '.new:' + (p.id || p.link || String(p.text || '').slice(0, 20)), text: 'New ' + noun + ': "' + q + '"', evidence: { link: p.link || '', views: p.views || null, date: p.date || null } });
    }
  }
  // HARD QUIET RULE (founder, 13 Aug): a bare "no new posts/emails" may only be written
  // after 7+ quiet days; within the week the read must carry the most recent item.
  // Deterministic support: the last day a genuinely FRESH item appeared in the window.
  let lastNew = null;
  for (let i = 0; i < rows.length - 1 && !lastNew; i++) {
    const cur = itemsOf(rows[i].data) || [];
    if (!cur.length) continue;
    const older = rows.slice(i + 1).find((r) => (itemsOf(r.data) || []).length);
    if (!older) break;                                     // appeared before monitoring — age unknowable
    const seenO = new Set((itemsOf(older.data) || []).map((p) => p.id || p.link || p.text));
    const f2 = cur.filter((p) => !seenO.has(p.id || p.link || p.text));
    if (f2.length) lastNew = { day: rows[i].day, item: f2[0] };
  }
  if (lastNew) {
    const days = Math.round((Date.parse(today.day) - Date.parse(lastNew.day)) / 864e5);
    let q = String(lastNew.item.text || lastNew.item.subject || '').replace(/\s+/g, ' ').trim();
    if (q.length > 90) q = q.slice(0, 90).replace(/\s+\S*$/, '') + '…';
    out.push({
      type: 'context', key: label + '.lastNew',
      text: 'Most recent new ' + label + ' item appeared ' + lastNew.day + ' (' + days + ' days before this capture): "' + q + '". QUIET RULE: within 7 days of it, never a bare "no new …" — write "no new ' + label + ' yesterday — most recent: …". The bare phrasing is allowed only once the last new item is MORE than 7 days old.',
      evidence: { day: lastNew.day, days },
    });
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
