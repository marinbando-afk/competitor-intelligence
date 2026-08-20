// qalog.js — ONE ledger for every silent downgrade in the pipeline (founder, 20 Aug:
// "how can we fix all of these so I never ask the same question again"). The repeat-
// question loop existed because failures degraded QUIETLY: claim strips and sense-check
// removals went to console.warn, Block Kit fell back invisibly, and the founder was the
// monitoring system. Everything lands here; qa.js drains it into the daily 🧯 digest and
// /api/coverage serves the tail — decay must announce itself before the founder sees it.
export const qaEvents = [];

export function qaLog(kind, label, detail) {
  qaEvents.push({
    at: new Date().toISOString().slice(0, 16),
    kind: String(kind || '').slice(0, 30),
    label: String(label || '').slice(0, 60),
    detail: String(detail || '').slice(0, 160),
  });
  if (qaEvents.length > 300) qaEvents.splice(0, qaEvents.length - 300);
}

// Drain for the daily digest: grouped counts + a few samples, then the ledger resets so
// tomorrow's digest reports tomorrow's events.
export function qaDrain() {
  const events = qaEvents.splice(0, qaEvents.length);
  const byKind = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return { events, byKind, total: events.length };
}
