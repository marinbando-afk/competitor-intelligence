// ONE definition of "which capture are we talking about, and can we trust it?"
//
// Every wrong report on 29 Jul came from the same structural fault: the app (insights.js)
// and the Slack brief (signals.js) each picked their own rows and compared whatever they
// found. Different selection rules over the same data means the two surfaces disagree by
// construction — and when a capture came back empty or truncated, each degraded differently
// and invented a different story:
//   • Glov  — "Facebook pages retired" from a capture that hit the ad cap (pages fall out
//             of the newest-first window at random) and a 0-ad day.
//   • CurrentBody — "raised in price today (29 Jul to 29 Jul)" from a same-day pair with no
//             product feed.
//   • Glov  — app said "no changes since last capture" while Slack announced a Christmas sale.
//
// The rule this module enforces, for every channel and every surface:
//   A CHANGE may only be asserted by comparing two HEALTHY captures from two DIFFERENT days.
// Anything else describes the present, or says nothing.

import { recentSnapshots } from './snapshots.js';

// Is there real content in this row for this channel?
export function captureUsable(channel, row) {
  const d = row && row.data;
  if (!d) return false;
  if (channel === 'ads') return Array.isArray(d.ads) && d.ads.length > 0;
  if (channel === 'website') return !!(d.summary || d.banner || d.shot || d.shotFrom);
  if (channel === 'email') return Array.isArray(d.emails) && d.emails.length > 0;
  return Object.keys(d).length > 0;
}
// Does this row carry the machine-readable product feed a price/product diff needs?
export function hasFeed(row) { return !!(row && row.data && row.data.summary); }

// Resolve the capture pair every surface must use.
//   day/data      — the newest USABLE capture (never an empty row dressed up as "today")
//   prevDay/prev  — the newest usable capture from an EARLIER day (never the same day)
//   comparable    — true only when a change may legitimately be asserted
//   truncated     — the capture hit its collection cap, so ABSENCE proves nothing
//   stale         — the newest usable capture is not from today
export async function resolveCapture(host, channel, opts = {}) {
  const todayStr = opts.today || new Date().toISOString().slice(0, 10);
  const rows = await recentSnapshots(host, channel, opts.depth || 8);
  const curRow = rows.find((r) => captureUsable(channel, r)) || null;
  const day = curRow ? String(curRow.day).slice(0, 10) : '';
  const prevRow = curRow
    ? rows.find((r) => String(r.day).slice(0, 10) < day && captureUsable(channel, r)) || null
    : null;

  const cap = Number(opts.cap || 0);
  const nowN = channel === 'ads' && curRow ? (curRow.data.ads || []).length : 0;
  const prevN = channel === 'ads' && prevRow ? (prevRow.data.ads || []).length : 0;
  const truncated = !!(cap && nowN >= Math.floor(cap * 0.95));
  const thin = !!(prevN && nowN && nowN < prevN * 0.6);

  // A price/product diff additionally needs the feed on BOTH sides.
  const feedBoth = channel !== 'website' || (hasFeed(curRow) && hasFeed(prevRow));

  return {
    day, data: curRow ? curRow.data : null,
    prevDay: prevRow ? String(prevRow.day).slice(0, 10) : '', prev: prevRow ? prevRow.data : null,
    ok: !!curRow,
    stale: !!(day && day !== todayStr),
    truncated, thin,
    // absence ("retired", "dropped", "gone") is only evidence from a complete capture
    canJudgeAbsence: !!(curRow && !truncated && !thin),
    comparable: !!(curRow && prevRow && feedBoth),
  };
}

// One sentence naming exactly what was compared — so the app, Slack and the weekly report
// all state the same provenance instead of each implying a different one.
export function captureProvenance(c) {
  if (!c.ok) return 'No usable capture yet.';
  if (!c.comparable) return 'Showing the ' + c.day + ' capture; no earlier comparable capture, so no change is claimed.';
  return 'Comparing ' + c.prevDay + ' → ' + c.day + '.';
}
