// PER-CLIENT CHANNEL ACCESS — which of the four intelligence channels a client receives.
//
// Founder, 12 Aug: "restrict some clients to monitor only social media posts, no web/email/
// ads." Stored on users.channels (NULL = all four = the normal plan).
//
// This is a DELIVERY filter, not a capture filter. Snapshots are keyed by host and shared
// across every tenant watching that brand (see the tenant-neutral rule in snapshots.js), so
// skipping a capture for one client would blind everyone else on the same competitor.
// Every surface a restricted client reads — dashboard channel cards, the daily Slack brief,
// the AI analyst's context — filters through allows() instead.

export const ALL_CHANNELS = ['ads', 'social', 'website', 'email'];
export const CHANNEL_LABEL = { ads: 'Ads', social: 'Organic Social', website: 'Website', email: 'Email' };

// Normalise anything the admin panel or DB hands us to either NULL (unrestricted) or a
// stable-ordered subset. An EMPTY selection normalises to NULL rather than to "nothing":
// a mis-click in the admin panel must never leave a paying client with a blank dashboard.
export function normChannels(v) {
  if (v == null) return null;
  const raw = Array.isArray(v) ? v : String(v).split(',');
  const picked = new Set(raw.map((s) => String(s || '').trim().toLowerCase()).filter((k) => ALL_CHANNELS.includes(k)));
  const list = ALL_CHANNELS.filter((k) => picked.has(k));
  if (!list.length || list.length === ALL_CHANNELS.length) return null;
  return list;
}

// The one question every surface asks. NULL channels = everything allowed.
export function allows(channels, k) { return !channels || channels.includes(k); }

export function channelsLabel(channels) {
  if (!channels) return 'All channels';
  return channels.map((k) => CHANNEL_LABEL[k] || k).join(' + ') + ' only';
}

export async function userChannels(pool, uid) {
  if (!pool || !uid) return null;
  try {
    const r = await pool.query('SELECT channels FROM users WHERE id = $1', [uid]);
    return normChannels(r.rows[0] && r.rows[0].channels);
  } catch (e) { return null; }   // a failed lookup must not silently restrict a client
}
