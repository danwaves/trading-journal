// Media Comments & Notify Roadmap, Phase 4.
// GET /api/go/:short_id -> 302 redirect to whatever target_url was stored
// for that short_id in the `short_links` table. Uses the service-role key
// (same pattern as api/cron/alert-high-impact-news.js) so it works
// regardless of the short_links RLS policies.
module.exports = async function handler(req, res) {
  const { short_id } = req.query;
  if (!short_id) {
    res.status(400).send('Missing short_id');
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const resp = await fetch(
      `${supabaseUrl}/rest/v1/short_links?short_id=eq.${encodeURIComponent(short_id)}&select=target_url`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    if (!resp.ok) {
      const body = await resp.text();
      console.error('go/[short_id] select failed:', resp.status, body);
      res.status(502).send('Something went wrong looking up that link.');
      return;
    }
    const rows = await resp.json();
    const target = Array.isArray(rows) && rows[0] && rows[0].target_url;
    if (!target) {
      res.status(404).send('That link has expired or moved.');
      return;
    }
    res.writeHead(302, { Location: target });
    res.end();
  } catch (e) {
    console.error('go/[short_id] error:', e);
    res.status(500).send('Something went wrong.');
  }
};
  
