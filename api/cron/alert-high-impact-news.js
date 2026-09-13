// api/cron/alert-high-impact-news.js
//
// Phase B4 — 30-minutes-before high-impact Telegram alert.
//
// Trigger: cron-job.org, every ~5 minutes (NOT GitHub Actions — see the
// roadmap doc for why: this needs tighter timing precision than Phase B1's
// news fetch, and GitHub Actions' scheduler can slip 5-15+ min under load).
//
// What it does each run:
//   1. Pulls high-impact forex_news rows that haven't been alerted yet.
//   2. Keeps only the ones whose event_time is roughly 30 minutes away
//      (a 25-35 min window, so a 5-minute cadence can never miss one even
//      if a run or two gets skipped/delayed).
//   3. For each match, sends ONE Telegram message to BOTH of you via the
//      existing /api/notify-telegram endpoint (shared market info, not a
//      "who did what" partner-routed notification — no recipient logic
//      needed here, just target: "both").
//   4. Stamps alerted_at on that row so later runs skip it.
//
// Env vars required:
//   NOTIFY_SECRET              - same shared secret used by the other
//                                 endpoints; this job checks it AND passes
//                                 it through when calling /api/notify-telegram
//   SUPABASE_URL                - your Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY   - service role key (bypasses RLS for the
//                                 alerted_at update). If fetch-forex-news.js
//                                 uses a different env var name for this,
//                                 rename the two references below to match.
//
// Required schema change before this can run (see accompanying SQL file):
//   alter table forex_news add column alerted_at timestamptz;
//
// Fix (this version) — root cause of the intermittent 500s seen in
// cron-job.org's history (roughly half of runs failing, and specifically
// the SLOW ones failing — 6-10s vs ~2s for successes):
//   Previously, if the per-event fetch to /api/notify-telegram (or the
//   Supabase PATCH) THREW outright — a network hiccup, a timeout, the site
//   being mid-cold-start — that exception wasn't caught locally. It escaped
//   the loop and hit the outer catch, which killed the ENTIRE run with a
//   500, even if other due events that same run had already alerted fine,
//   and even though a single flaky outbound call is exactly the kind of
//   thing that deserves "skip this one, retry next cycle" rather than
//   "fail everything." Two changes fix this:
//     1. Every per-event step now has its own try/catch, so one event's
//        network failure can never take down the others or the run itself.
//     2. Every outbound fetch has an explicit timeout (AbortController), so
//        a hanging call fails fast and predictably instead of potentially
//        running long enough to get killed by the platform's own timeout.
//   The run now only returns 500 for a genuine top-level problem (bad env
//   vars, the initial forex_news SELECT itself failing) — never because of
//   one flaky per-event send.


const SITE_URL = 'https://danfxt.vercel.app';
const WINDOW_MIN_MINUTES = 25; // don't alert if event is further out than this
const WINDOW_MAX_MINUTES = 35; // don't alert if event is closer than this / already passed
const FETCH_TIMEOUT_MS = 8000; // fail fast rather than hang toward the platform's own limit

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  const secret = req.query.secret;
  if (!secret || secret !== process.env.NOTIFY_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'missing supabase env vars' });
  }

  try {
    // 1. Pull candidate rows: high-impact, not yet alerted.
    const selectUrl =
      `${SUPABASE_URL}/rest/v1/forex_news` +
      `?impact=ilike.*high*&alerted_at=is.null&select=id,event_time,currency,title,impact`;
    const selectRes = await fetchWithTimeout(selectUrl, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    });
    if (!selectRes.ok) {
      const body = await selectRes.text();
      throw new Error(`forex_news select failed: ${selectRes.status} ${body}`);
    }
    const rows = await selectRes.json();

    // 2. Keep only events landing ~30 minutes from now.
    const now = Date.now();
    const due = rows.filter((r) => {
      if (!r.event_time) return false;
      const minutesUntil = (new Date(r.event_time).getTime() - now) / 60000;
      return minutesUntil >= WINDOW_MIN_MINUTES && minutesUntil <= WINDOW_MAX_MINUTES;
    });

    // 3. Process each due event independently — one event's failure (of any
    // kind, including a thrown network error) is caught right here and can
    // never affect the others or the overall run. Run them in parallel too,
    // since they're independent of each other and this keeps total run time
    // low even when several events land in the same 5-minute cycle.
    const results = await Promise.allSettled(
      due.map(async (event) => {
        const timeLabel = new Date(event.event_time).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
        });
        const message =
          `📰 High-impact news in ~30 min\n` +
          `${event.currency || ''} — ${event.title || ''}\n` +
          `Time: ${timeLabel}`;

        // Send via the existing notify-telegram endpoint, both chats.
        const notifyRes = await fetchWithTimeout(
          `${SITE_URL}/api/notify-telegram?secret=${encodeURIComponent(process.env.NOTIFY_SECRET)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'both', message }),
          }
        );
        if (!notifyRes.ok) {
          console.error('notify-telegram failed for event', event.id, await notifyRes.text());
          return { id: event.id, alerted: false };
        }

        // Mark this event alerted so future runs skip it.
        const patchRes = await fetchWithTimeout(
          `${SUPABASE_URL}/rest/v1/forex_news?id=eq.${event.id}`,
          {
            method: 'PATCH',
            headers: {
              apikey: SERVICE_KEY,
              Authorization: `Bearer ${SERVICE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ alerted_at: new Date().toISOString() }),
          }
        );
        if (!patchRes.ok) {
          console.error('alerted_at update failed for event', event.id, await patchRes.text());
          // Telegram message already went out; worst case is a duplicate on
          // the next run if this keeps failing, which is still safer than
          // silently losing the alert.
          return { id: event.id, alerted: false, sentButNotStamped: true };
        }

        return { id: event.id, alerted: true };
      })
    );

    let alerted = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.alerted) {
        alerted++;
      } else if (r.status === 'rejected') {
        // A per-event exception (timeout, network error, etc.) lands here —
        // logged and skipped, never thrown further. Next run will retry it
        // since alerted_at only gets stamped on success.
        console.error('event processing failed:', r.reason);
      }
    }

    return res.status(200).json({ ok: true, checked: rows.length, due: due.length, alerted });
  } catch (err) {
    console.error('alert-high-impact-news error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
