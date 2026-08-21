// api/delete-image.js — Vercel serverless function.
//
// POST { publicId: string, resourceType?: 'image'|'video' } -> deletes that
// asset from Cloudinary.
//
// Same logic as netlify/functions/delete-image.js, just wrapped for
// Vercel's (req, res) handler signature instead of Netlify's event/handler.
//
// Uploads from the client use an UNSIGNED preset (see CLOUDINARY_UPLOAD_PRESET
// in app.html) — that's fine for uploads, but Cloudinary's delete endpoint
// requires a signed request, which needs the API secret. That secret can
// never live in client code, so deletion has to go through this server
// function instead. A "success" here covers both real outcomes Cloudinary
// can report for a delete: 'ok' or 'not found' — from the client's point of
// view both mean the same thing, which is "this publicId no longer exists
// in Cloudinary," and it doesn't matter whether that's because we just
// deleted it or because it was already gone (e.g. a retry after a network
// blip on a previous attempt).
//
// resourceType selects which destroy endpoint gets hit (image vs video) —
// Cloudinary treats these as separate asset namespaces, so an asset
// uploaded as resource_type 'video' is never found (and never actually
// deleted, silently) by the image/destroy endpoint. Defaults to 'image'
// when the client doesn't send one, matching the old behavior for anything
// uploaded before this field existed. Per Cloudinary's signed-request
// rules, resource_type is deliberately NOT part of the signed param string
// below (same as api_key and file) — only its URL path.

const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); }
    catch (e) { res.status(400).json({ error: 'Invalid JSON body' }); return; }
  }
  body = body || {};

  const publicId = body.publicId;
  if (!publicId || typeof publicId !== 'string') {
    res.status(400).json({ error: 'publicId (string) is required' });
    return;
  }
  const resourceType = body.resourceType === 'video' ? 'video' : 'image';

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    res.status(500).json({ error: 'Cloudinary server credentials are not configured' });
    return;
  }

  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = 'public_id=' + publicId + '&timestamp=' + timestamp;
  const signature = crypto.createHash('sha1').update(paramsToSign + apiSecret).digest('hex');

  const form = new URLSearchParams();
  form.append('public_id', publicId);
  form.append('timestamp', timestamp);
  form.append('api_key', apiKey);
  form.append('signature', signature);

  try {
    const cloudRes = await fetch('https://api.cloudinary.com/v1_1/' + cloudName + '/' + resourceType + '/destroy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await cloudRes.json().catch(() => ({}));

    if (!cloudRes.ok || (data.result !== 'ok' && data.result !== 'not found')) {
      console.error('delete-image: Cloudinary destroy failed for', publicId, '(' + resourceType + ')', data);
      res.status(502).json({ error: (data.error && data.error.message) || 'Cloudinary delete failed', result: data.result });
      return;
    }
    res.status(200).json({ result: data.result });
  } catch (err) {
    console.error('delete-image: request to Cloudinary failed', err);
    res.status(502).json({ error: 'Failed to reach Cloudinary' });
  }
};
