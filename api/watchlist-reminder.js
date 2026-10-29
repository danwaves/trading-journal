// Danwaves — watchlist update reminder (Telegram).
// Deploy path: /api/watchlist-reminder.js (Vercel serverless function).
//
// What it does each time it is called:
//   1. Skips Saturday and Sunday (market closed — no daily update is owed).
//   2. Loads every OPEN watchlist idea (status idea / pending).
//   3. For each idea works out whether its OWNER (created_by) has posted an
//      update today — the same rule the app uses for the coloured "last
//      updated" tag on each card (see watchlistLastUpdateInfo() in app.html):
//        - an update = a follow-up on the idea's trail written by the owner,
//          or the original post if there are none yet;
//        - "due"    = nothing posted today, no completed weekday missed;
//        - "missed" = at least one completed Mon–Fri with no update.
//   4. Sends each owner ONE Telegram message listing only their own ideas
//      that need attention. Nothing owed = no message.
//
// Calling it:
//   - Vercel Cron (see vercel.json snippet) — Vercel sends
//       Authorization: Bearer <CRON_SECRET>
//     automatically when a CRON_SECRET environment variable exists.
//   - Or any outside scheduler / a browser:
//       /api/watchlist-reminder?secret=<NOTIFY_SECRET>
//   Extra options on the URL:
//       &dry=1    show who would be messaged and what it would say — sends nothing
//       &force=1  run even on a weekend (for testing)
//
// Environment variables (all but the last two already exist for the other
// notification functions):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID_YOU, TELEGRAM_CHAT_ID_PARTNER
//   NOTIFY_SECRET                — same one notify-telegram.js checks
//   CRON_SECRET                  — NEW, only needed for Vercel Cron (any long random string)
//   REMINDER_TIMEZONE            — NEW, optional. Which clock decides "today".
//                                  Defaults to Africa/Lagos. Use any IANA name.

const { createClient } = require('@supabase/supabase-js');

const APP_URL = 'https://danfxt.vercel.app';

// Who is who: the account email stamped on each idea -> name + Telegram chat.
function people() {
  return {
    'danwaves.services@gmail.com': { name: 'Dan', chatId: process.env.TELEGRAM_CHAT_ID_YOU },
    'oa777410@gmail.com': { name: 'Ako', chatId: process.env.TELEGRAM_CHAT_ID_PARTNER },
  };
}

// --- calendar helpers: "days" are whole local calendar days in `tz`, held as a
// day number (days since 1970-01-01) so weekday maths never depends on the
// server's own timezone. ---
function localDay(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ts));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / 86400000);
}
function isWeekdayNum(dayNum) {
  const g = new Date(dayNum * 86400000).getUTCDay();
  return g !== 0 && g !== 6;
}
function dayLabel(dayNum) {
  return new Date(dayNum * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Mirrors watchlistLastUpdateInfo() in app.html. Returns null for closed ideas.
function reminderStatus(item, nowTs, tz) {
  const status = item.status || 'idea';
  if (status !== 'idea' && status !== 'pending') return null;
  const created = Number(item.created_at);
  if (!created) return null;
  let ts = created;
  (Array.isArray(item.trail) ? item.trail : []).forEach((e) => {
    if (!e || !e.timestamp) return;
    if (item.created_by && e.createdBy && e.createdBy !== item.created_by) return; // the other account's follow-ups don't count for the owner
    if (Number(e.timestamp) > ts) ts = Number(e.timestamp);
  });
  const today = localDay(nowTs, tz);
  const last = localDay(ts, tz);
  if (last >= today) return { state: 'ok' };
  let missed = 0;
  for (let d = last + 1; d < today && d - last < 400; d++) {
    if (isWeekdayNum(d)) missed++;
  }
  return missed > 0
    ? { state: 'missed', missed, lastDay: last }
    : { state: 'due', missed: 0, lastDay: last };
}

function buildMessage(name, due, missed) {
  const lines = [`⏰ ${name}, your watchlist needs an update`];
  if (missed.length) {
    lines.push('', 'Missed days:');
    missed.forEach((m) => lines.push(`• ${m.label} — missed ${m.missed} ${m.missed === 1 ? 'day' : 'days'} (last update ${dayLabel(m.lastDay)})`));
  }
  if (due.length) {
    lines.push('', 'Due today:');
    due.forEach((d) => lines.push(`• ${d.label}`));
  }
  lines.push('', 'Post an update on each one (even just "still valid") before the day ends.', APP_URL);
  return lines.join('\n');
}

module.exports = async function handler(req, res) {
  const query = req.query || {};
  const auth = req.headers && req.headers.authorization ? req.headers.authorization : '';
  const okCron = !!process.env.CRON_SECRET && auth === 'Bearer ' + process.env.CRON_SECRET;
  const okSecret = !!process.env.NOTIFY_SECRET && query.secret === process.env.NOTIFY_SECRET;
  if (!okCron && !okSecret) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const dry = query.dry === '1';
  const force = query.force === '1';
  const tz = process.env.REMINDER_TIMEZONE || 'Africa/Lagos';
  const now = Date.now();

  if (!isWeekdayNum(localDay(now, tz)) && !force) {
    res.status(200).json({ ok: true, skipped: 'weekend — market closed', timezone: tz });
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase
    .from('watchlist_items')
    .select('id, pair, direction, created_by, created_at, status, trail');
  if (error) {
    console.error('watchlist-reminder: could not load watchlist_items:', error);
    res.status(500).json({ error: error.message });
    return;
  }

  const roster = people();
  const byOwner = {};
  (data || []).forEach((item) => {
    const owner = roster[item.created_by];
    if (!owner) return; // legacy ideas with no owner, or an unknown account — nobody to nudge
    const info = reminderStatus(item, now, tz);
    if (!info || info.state === 'ok') return;
    const label = `${item.pair || 'Idea'} (${String(item.direction || '').toUpperCase()})`;
    const bucket = byOwner[item.created_by] || (byOwner[item.created_by] = { due: [], missed: [] });
    if (info.state === 'missed') bucket.missed.push({ label, missed: info.missed, lastDay: info.lastDay });
    else bucket.due.push({ label });
  });

  const plan = Object.keys(byOwner).map((email) => ({
    email,
    name: roster[email].name,
    chatId: roster[email].chatId,
    message: buildMessage(roster[email].name, byOwner[email].due, byOwner[email].missed),
  }));

  if (dry) {
    res.status(200).json({ ok: true, dry: true, timezone: tz, wouldSend: plan.map((p) => ({ to: p.name, message: p.message })) });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const results = await Promise.all(plan.map(async (p) => {
    if (!p.chatId) return { to: p.name, ok: false, description: 'no Telegram chat id configured' };
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: p.chatId, text: p.message.length > 4000 ? p.message.slice(0, 3990) + '…' : p.message }),
      });
      const body = await r.json();
      return { to: p.name, ok: body.ok === true, description: body.description };
    } catch (e) {
      return { to: p.name, ok: false, description: 'fetch failed: ' + ((e && e.message) || e) };
    }
  }));

  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.error('watchlist-reminder: Telegram send failed:', JSON.stringify(failed));
  res.status(failed.length ? 502 : 200).json({ ok: failed.length === 0, timezone: tz, sent: results });
};
