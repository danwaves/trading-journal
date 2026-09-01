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
    const { recipient_email, message: recordMessage } = req.body.record;
    const chatId = EMAIL_TO_CHAT[recipient_email];
    if (!chatId) {
      // Unknown email — don't error the webhook, just skip quietly.
      return res.status(200).json({ ok: true, skipped: 'unknown recipient_email', recipient_email });
    }
    chatIds.push(chatId);
    message = recordMessage;
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

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const results = await Promise.all(chatIds.map((chatId) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    }).then((r) => r.json())
  ));

  return res.status(200).json({ ok: true, results });
}
