export default async function handler(req, res) {
  const isGet = req.method === 'GET';
  const secret = isGet ? req.query.secret : req.body?.secret;
  const target = isGet ? req.query.target : req.body?.target;
  const message = isGet ? req.query.message : req.body?.message;

  if (secret !== process.env.NOTIFY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  const chatIds = [];
  if (target === 'you' || target === 'both') chatIds.push(process.env.TELEGRAM_CHAT_ID_YOU);
  if (target === 'partner' || target === 'both') chatIds.push(process.env.TELEGRAM_CHAT_ID_PARTNER);
  if (!chatIds.length) {
    return res.status(400).json({ error: 'target must be you, partner, or both' });
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
