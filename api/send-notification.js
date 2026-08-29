// Danwaves Notifications — Phase 3 send endpoint.
// Deploy path: /api/send-notification.js (Vercel serverless function).
//
// What it does on each POST:
//   1. Checks the shared secret header (basic anti-spam, not a real auth boundary).
//   2. Records the event in the `notifications` table (Phase 1 schema) — this
//      doubles as an in-app history/fallback for Phase 6.
//   3. Looks up every push_subscriptions row for the recipient and sends a
//      real push to each one via web-push/VAPID.
//   4. If a push service reports a subscription is dead (404/410 — the user
//      uninstalled, cleared data, etc.), that row is deleted so it stops
//      being retried forever.
//
// Required Vercel environment variables:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY   — the pair from Phase 0
//   VAPID_SUBJECT                          — e.g. "mailto:you@example.com"
//   SUPABASE_URL                           — same project as the app
//   SUPABASE_SERVICE_ROLE_KEY              — service role key (bypasses RLS — keep secret, server-only)
//   NOTIFY_API_SECRET                      — must match NOTIFY_API_SECRET_CLIENT in app.html

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const providedSecret = req.headers['x-notify-secret'];
  if (!process.env.NOTIFY_API_SECRET || providedSecret !== process.env.NOTIFY_API_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { recipientEmail, senderEmail, type, sourceTable, sourceId, message, deepLink } = req.body || {};
  if (!recipientEmail || !senderEmail || !type || !sourceTable || !sourceId || !message) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  // 1. Record the event (best-effort — a logging failure shouldn't block the push).
  try {
    await supabase.from('notifications').insert({
      recipient_email: recipientEmail,
      sender_email: senderEmail,
      type,
      source_table: sourceTable,
      source_id: String(sourceId),
      message,
      deep_link: deepLink || '',
    });
  } catch (e) {
    console.error('Failed to record notification row (continuing to send push):', e);
  }

  // 2. Find every device the recipient has subscribed on.
  const { data: subs, error: subsError } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_email', recipientEmail);

  if (subsError) {
    console.error('Failed to look up push_subscriptions:', subsError);
    res.status(500).json({ error: 'Failed to look up subscriptions' });
    return;
  }
  if (!subs || subs.length === 0) {
    // Not an error — the recipient just hasn't enabled notifications on any device yet.
    res.status(200).json({ sent: 0, note: 'Recipient has no registered devices.' });
    return;
  }

  const payload = JSON.stringify({
    title: 'Danwaves',
    body: message,
    deepLink: deepLink || '',
    tag: `${sourceTable}:${sourceId}`,
  });

  let sent = 0;
  const deadSubIds = [];

  await Promise.all(subs.map(async (sub) => {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(pushSubscription, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        deadSubIds.push(sub.id); // subscription no longer valid — clean it up below
      } else {
        console.error('Push send failed for subscription', sub.id, err.statusCode, err.body);
      }
    }
  }));

  if (deadSubIds.length) {
    await supabase.from('push_subscriptions').delete().in('id', deadSubIds);
  }

  res.status(200).json({ sent, removed: deadSubIds.length });
};
