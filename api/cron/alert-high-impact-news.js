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

const SITE_URL = 'https://danfxt.vercel.app';
const WINDOW_MIN_MINUTES = 25; // don't alert if event is further out than this
const WINDOW_MAX_MINUTES = 35; // don't alert if event is closer than this / already passed

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
      `?impact=ilike.*high*&alerted_at=is.null&select=id,event_time,currency,title,forex,impact`;
    const selectRes = await fetch(selectUrl, {
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

    let alerted = 0;
    for (const event of due) {
      const timeLabel = new Date(event.event_time).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      });
      const message =
        `📰 High-impact news in ~30 min\n` +
        `${event.currency || ''} — ${event.title || ''}\n` +
        `Time: ${timeLabel}` +
        (event.forex !== null && event.forex !== undefined ? `\nForecast: ${event.forex}` : '');

      // 3. Send via the existing notify-telegram endpoint, both chats.
      const notifyRes = await fetch(
        `${SITE_URL}/api/notify-telegram?secret=${encodeURIComponent(process.env.NOTIFY_SECRET)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'both', message }),
        }
      );
      if (!notifyRes.ok) {
        console.error('notify-telegram failed for event', event.id, await notifyRes.text());
        continue; // don't stamp alerted_at if the send failed — retry next run
      }

      // 4. Mark this event alerted so future runs skip it.
      const patchRes = await fetch(
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
      } else {
        alerted++;
      }
    }

    return res.status(200).json({ ok: true, checked: rows.length, alerted });
  } catch (err) {
    console.error('alert-high-impact-news error:', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
