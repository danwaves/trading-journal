// Danwaves — weekly recap (Telegram).
// Deploy path: /api/weekly-recap.js (Vercel serverless function).
//
// One message, sent to BOTH accounts, summarising Monday–Friday of the week:
//   - trades: won / lost / open, net P&L, win rate, per person, best and worst pair
//   - watchlist ideas closed that week as Missed or Invalidated
//   - the daily-update record per person (the same rule the P&L Calendar uses:
//     each weekday every open idea is owed one update from its OWNER; posting
//     the idea counts as that day's update; weekends owe nothing)
//
// The numbers repeat what the app shows, so they should always agree:
//   - win/loss = the trade's `result` column; open = anything else
//   - dollar result = rr_outcome.realizedR x $100. (The app's tradeRiskDollars()
//     only uses a risk % if one is stored on the trade — none is — so it is
//     always $100 per R.)
//   - ideas are counted in the week their LAST SAVE (updated_at) falls in.
//
// Calling it:
//   /api/weekly-recap?secret=<NOTIFY_SECRET>        (what GitHub Actions does)
//   or Authorization: Bearer <CRON_SECRET>
//   Options:  &dry=1            show the message(s) without sending anything
//             &week=YYYY-MM-DD  recap the week containing that date (default: this week)
//
// Environment variables (all already exist for the other functions):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN,
//   TELEGRAM_CHAT_ID_YOU, TELEGRAM_CHAT_ID_PARTNER, NOTIFY_SECRET,
//   CRON_SECRET (optional), REMINDER_TIMEZONE (optional, default Africa/Lagos —
//   decides where each day starts and ends)

const { createClient } = require('@supabase/supabase-js');

const APP_URL = 'https://danfxt.vercel.app';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function people() {
  return {
    'danwaves.services@gmail.com': { name: 'Dan', chatId: process.env.TELEGRAM_CHAT_ID_YOU },
    'oa777410@gmail.com': { name: 'Ako', chatId: process.env.TELEGRAM_CHAT_ID_PARTNER },
  };
}

// A "day" here is a whole local calendar day in `tz`, held as a day number
// (days since 1970-01-01), so weekday maths never depends on the server clock.
function localDay(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ts));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / 86400000);
}
function ymdToDay(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
function dayToYmd(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
function dayOfWeek(n) { return new Date(n * 86400000).getUTCDay(); }
function dayLabel(n) {
  return new Date(n * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function money(v) { return (v >= 0 ? '+' : '−') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US'); }

function tradeDollars(row) {
  let rr = row.rr_outcome;
  if (typeof rr === 'string') { try { rr = JSON.parse(rr); } catch (e) { rr = null; } }
  if (!rr || typeof rr.realizedR !== 'number') return null;
  return rr.realizedR * 100;
}
function tradeClass(row) {
  return row.result === 'win' ? 'win' : row.result === 'loss' ? 'loss' : 'open';
}
function stats(rows) {
  let wins = 0; let losses = 0; let open = 0; let net = 0;
  rows.forEach((r) => {
    const c = tradeClass(r);
    if (c === 'open') { open++; return; }
    if (c === 'win') wins++; else losses++;
    const d = tradeDollars(r);
    if (d !== null) net += d;
  });
  const resolved = wins + losses;
  return { trades: rows.length, wins, losses, open, net, resolved, winRate: resolved ? (wins / resolved) * 100 : 0 };
}

// Same rule as pnlCalendarDailyUpdateInfo() in app.html, on day numbers.
function dailyUpdateRecord(ideas, roster, monNum, friNum, todayNum, tz) {
  const rows = {};
  Object.keys(roster).forEach((email) => { rows[email] = { name: roster[email].name, days: 0, done: 0, missedDays: [], dueToday: false }; });
  for (let D = monNum; D <= friNum && D <= todayNum; D++) {
    if (!(dayOfWeek(D) >= 1 && dayOfWeek(D) <= 5)) continue;
    const perPerson = {};
    ideas.forEach((it) => {
      if (!rows[it.created_by] || !it.created_at) return;
      const createdDay = localDay(Number(it.created_at), tz);
      if (createdDay > D) return;
      const own = (Array.isArray(it.trail) ? it.trail : [])
        .filter((e) => e && e.timestamp && (!e.createdBy || e.createdBy === it.created_by))
        .map((e) => localDay(Number(e.timestamp), tz));
      const open = !it.status || it.status === 'idea' || it.status === 'pending';
      if (!open) {
        const lastOwn = Math.max(createdDay, ...own);
        if (lastOwn < D) return; // closed ideas owe updates only up to the owner's last update
      }
      const p = perPerson[it.created_by] || (perPerson[it.created_by] = { required: 0, updated: 0 });
      p.required++;
      if (createdDay === D || own.includes(D)) p.updated++;
    });
    Object.keys(perPerson).forEach((email) => {
      const p = perPerson[email];
      const row = rows[email];
      const complete = p.updated >= p.required;
      if (!complete && D === todayNum) { row.dueToday = true; return; } // today isn't over yet
      row.days++;
      if (complete) row.done++; else row.missedDays.push(DAY_NAMES[dayOfWeek(D)]);
    });
  }
  return Object.values(rows).filter((r) => r.days > 0 || r.dueToday);
}

function buildMessage({ monNum, friNum, tradeRows, closedMissed, closedInvalid, record, roster, todayNum }) {
  const lines = [`📊 Weekly recap — ${dayLabel(monNum)} – ${dayLabel(friNum)}`, ''];
  const st = stats(tradeRows);
  if (!st.trades) {
    lines.push('Trades: none this week.');
  } else {
    lines.push(`Trades: ${st.trades} (Won ${st.wins} · Lost ${st.losses}${st.open ? ' · Open ' + st.open : ''})`);
    lines.push(st.resolved ? `Net ${money(st.net)} · Win rate ${st.winRate.toFixed(0)}%` : 'No finished trades yet.');
    Object.keys(roster).forEach((email) => {
      const mine = tradeRows.filter((r) => r.created_by === email);
      if (!mine.length) return;
      const ms = stats(mine);
      lines.push(`• ${roster[email].name}: ${ms.trades} ${ms.trades === 1 ? 'trade' : 'trades'}${ms.resolved ? ', ' + money(ms.net) : ', no result yet'}`);
    });
    const byPair = {};
    tradeRows.forEach((r) => { (byPair[r.pair || '—'] || (byPair[r.pair || '—'] = [])).push(r); });
    const pairs = Object.keys(byPair).map((k) => ({ pair: k, s: stats(byPair[k]) })).filter((x) => x.s.resolved);
    if (pairs.length >= 2) {
      pairs.sort((a, b) => b.s.net - a.s.net);
      const best = pairs[0]; const worst = pairs[pairs.length - 1];
      lines.push(`Best pair: ${best.pair} ${money(best.s.net)} · Worst pair: ${worst.pair} ${money(worst.s.net)}`);
    }
  }
  lines.push('', `Ideas closed: Missed ${closedMissed} · Invalidated ${closedInvalid}`);
  if (record.length) {
    lines.push('', 'Daily updates (weekdays):');
    record.forEach((r) => {
      let line = `• ${r.name}: ${r.done} of ${r.days} ${r.days === 1 ? 'day' : 'days'}`;
      line += r.missedDays.length ? ` — missed ${r.missedDays.join(', ')}` : (r.days ? ' ✓' : '');
      lines.push(line);
    });
    const due = record.filter((r) => r.dueToday).map((r) => r.name);
    if (due.length) lines.push(`(${DAY_NAMES[dayOfWeek(todayNum)]} isn't over yet — still due for ${due.join(' and ')}.)`);
  }
  lines.push('', APP_URL);
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

  const tz = process.env.REMINDER_TIMEZONE || 'Africa/Lagos';
  const now = Date.now();
  const todayNum = localDay(now, tz);
  const anchor = query.week && /^\d{4}-\d{2}-\d{2}$/.test(query.week) ? ymdToDay(query.week) : todayNum;
  const monNum = anchor - ((dayOfWeek(anchor) + 6) % 7);
  const friNum = monNum + 4;
  const sunNum = monNum + 6;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const [tradesRes, ideasRes] = await Promise.all([
    supabase.from('trades').select('id, pair, direction, result, rr_outcome, created_by, trade_date')
      .gte('trade_date', dayToYmd(monNum)).lte('trade_date', dayToYmd(sunNum)),
    supabase.from('watchlist_items').select('id, pair, created_by, created_at, updated_at, status, trail'),
  ]);
  if (tradesRes.error || ideasRes.error) {
    const msg = (tradesRes.error || ideasRes.error).message;
    console.error('weekly-recap: could not load data:', msg);
    res.status(500).json({ error: msg });
    return;
  }

  const roster = people();
  const tradeRows = tradesRes.data || [];
  const ideas = ideasRes.data || [];
  const inWeek = (ts) => { if (!ts) return false; const d = localDay(Number(ts), tz); return d >= monNum && d <= sunNum; };
  const closedMissed = ideas.filter((it) => it.status === 'missed' && inWeek(it.updated_at)).length;
  const closedInvalid = ideas.filter((it) => it.status === 'invalidated' && inWeek(it.updated_at)).length;
  const record = dailyUpdateRecord(ideas, roster, monNum, friNum, todayNum, tz);
  const message = buildMessage({ monNum, friNum, tradeRows, closedMissed, closedInvalid, record, roster, todayNum });

  if (query.dry === '1') {
    res.status(200).json({ ok: true, dry: true, timezone: tz, message });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const targets = Object.values(roster);
  const results = await Promise.all(targets.map(async (p) => {
    if (!p.chatId) return { to: p.name, ok: false, description: 'no Telegram chat id configured' };
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: p.chatId, text: message.length > 4000 ? message.slice(0, 3990) + '…' : message }),
      });
      const body = await r.json();
      return { to: p.name, ok: body.ok === true, description: body.description };
    } catch (e) {
      return { to: p.name, ok: false, description: 'fetch failed: ' + ((e && e.message) || e) };
    }
  }));

  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.error('weekly-recap: Telegram send failed:', JSON.stringify(failed));
  res.status(failed.length ? 502 : 200).json({ ok: failed.length === 0, timezone: tz, sent: results });
};
