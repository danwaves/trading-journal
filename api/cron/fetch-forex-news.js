import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // needs write access, use service role not anon key
);

function stableId(event) {
  // Forex Factory feed has no unique ID, so derive one from stable fields
  const raw = `${event.date}-${event.time}-${event.country}-${event.title}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}

function parseEventTime(dateStr, timeStr) {
  // Feed format: date "MM-DD-YYYY", time "h:mma" or "All Day"/"Tentative"
  if (!timeStr || /all day|tentative/i.test(timeStr)) return null;
  const combined = `${dateStr} ${timeStr}`;
  const parsed = new Date(combined);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export default async function handler(req, res) {
  // Protect the cron endpoint the same way as notify-telegram
  const secret = req.query.secret;
  if (secret !== process.env.NOTIFY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const response = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (!response.ok) {
      return res.status(502).json({ error: 'failed to fetch forex factory feed', status: response.status });
    }
    const events = await response.json();

    const rows = events
      .map((e) => {
        const eventTime = parseEventTime(e.date, e.time);
        if (!eventTime) return null; // skip All Day / Tentative entries with no fixed time
        return {
          id: stableId(e),
          event_time: eventTime,
          currency: e.country,
          title: e.title,
          impact: e.impact,
          forecast: e.forecast || null,
          previous: e.previous || null,
          actual: e.actual || null,
        };
      })
      .filter(Boolean);

    if (!rows.length) {
      return res.status(200).json({ ok: true, upserted: 0, message: 'no events with fixed times this run' });
    }

    const { error } = await supabase
      .from('forex_news')
      .upsert(rows, { onConflict: 'id' });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true, upserted: rows.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
    }
