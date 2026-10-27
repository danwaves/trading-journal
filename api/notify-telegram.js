// Maps who a notification is FOR (recipient_email) to their Telegram chat ID.
const EMAIL_TO_CHAT = {
  'danwaves.services@gmail.com': process.env.TELEGRAM_CHAT_ID_YOU,
  'oa777410@gmail.com': process.env.TELEGRAM_CHAT_ID_PARTNER,
};

export default async function handler(req, res) {
  const isGet = req.method === 'GET';
  const secret = isGet ? req.query.secret : (req.query.secret || req.body?.secret);

  if (secret !== process.env.NOTIFY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const chatIds = [];
  let message;

  // Supabase Database Webhook shape: { type: "INSERT", table: "notifications", record: {...} }
  const isSupabaseWebhook = !isGet && req.body?.table === 'notifications' && req.body?.record;

  if (isSupabaseWebhook) {
    const { recipient_email, message: recordMessage, deep_link } = req.body.record;
    const chatId = EMAIL_TO_CHAT[recipient_email];
    if (!chatId) {
      // Unknown email — don't error the webhook, just skip quietly.
      return res.status(200).json({ ok: true, skipped: 'unknown recipient_email', recipient_email });
    }
    chatIds.push(chatId);
    // Append the deep link on its own line when one was captured. Telegram
    // auto-links bare URLs in plain text, so no markdown/entities needed.
    message = deep_link ? `${recordMessage}\n\n${deep_link}` : recordMessage;
  } else {
    // Manual/test path: ?secret=...&target=you|partner|both&message=...
    const target = isGet ? req.query.target : req.body?.target;
    message = isGet ? req.query.message : req.body?.message;
    if (target === 'you' || target === 'both') chatIds.push(process.env.TELEGRAM_CHAT_ID_YOU);
    if (target === 'partner' || target === 'both') chatIds.push(process.env.TELEGRAM_CHAT_ID_PARTNER);
    if (!chatIds.length) {
      return res.status(400).json({ error: 'target must be you, partner, or both' });
    }
  }

  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  // Telegram rejects anything over 4096 characters; trim so a long comment or
  // note can never make the whole message fail.
  if (message.length > 4000) message = message.slice(0, 3990) + '…';

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const results = await Promise.all(chatIds.map((chatId) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    })
      .then((r) => r.json())
      // A network failure for one chat must not crash the whole handler.
      .catch((e) => ({ ok: false, description: 'fetch failed: ' + ((e && e.message) || e) }))
  ));

  // Telegram answers HTTP 200 + { ok: false } for bad chat ids, blocked bots,
  // etc. That used to be returned as a success and never looked at. Log it, and
  // return 502 so the failure shows up in Supabase's webhook response log.
  const failed = results.filter((r) => !r || r.ok !== true);
  if (failed.length) {
    console.error('Telegram sendMessage failed:', JSON.stringify(failed));
    return res.status(502).json({ ok: false, results });
  }

  return res.status(200).json({ ok: true, results });
    }
