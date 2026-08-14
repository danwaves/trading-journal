// POST { publicId: string, resourceType?: 'image'|'video' } -> deletes that
// asset from Cloudinary.
//
// Uploads from the client use an UNSIGNED preset (see CLOUDINARY_UPLOAD_PRESET
// in app.html) — that's fine for uploads, but Cloudinary's delete endpoint
// requires a signed request (api_key + timestamp + signature computed with
// the API secret). The secret can never live in app.html since that's
// public/static, so this function is the only place that holds it
// (as Netlify environment variables) and the only place allowed to sign
// deletes.
//
// Required Netlify env vars (Site settings -> Environment variables):
//   CLOUDINARY_CLOUD_NAME   (same value as CLOUDINARY_CLOUD_NAME in app.html)
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
//
// Treats Cloudinary's "not found" result as success (idempotent) — the goal
// is "this publicId no longer exists in Cloudinary," and it doesn't matter
// whether that's because we just deleted it or because it was already gone
// (e.g. a retry after a network blip on a previous attempt).
//
// Roadmap Step 4d: resourceType now selects which destroy endpoint gets hit
// (image vs video) — Cloudinary treats these as separate asset namespaces,
// so an asset uploaded as resource_type 'video' is never found (and never
// actually deleted, silently) by the image/destroy endpoint. Defaults to
// 'image' when the client doesn't send one, matching the old behavior for
// anything uploaded before this field existed. Per Cloudinary's signed-
// request rules, resource_type is deliberately NOT part of the signed
// param string below (same as api_key and file) — only its URL path.

const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const publicId = body.publicId;
  if (!publicId || typeof publicId !== 'string') {
    return { statusCode: 400, body: JSON.stringify({ error: 'publicId (string) is required' }) };
  }
  const resourceType = body.resourceType === 'video' ? 'video' : 'image';

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    console.error('delete-image: missing CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET env vars');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server is missing Cloudinary credentials' }) };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  // Cloudinary's signature is a SHA-1 hash of every param EXCEPT file/api_key/
  // signature/resource_type, sorted alphabetically, joined with '&', with the
  // API secret appended directly (no separator) — see Cloudinary's "Signed
  // requests" docs. Only public_id + timestamp are sent here, so this is the
  // full param string already in the required order.
  const paramsToSign = 'public_id=' + publicId + '&timestamp=' + timestamp;
  const signature = crypto.createHash('sha1').update(paramsToSign + apiSecret).digest('hex');

  const form = new URLSearchParams();
  form.append('public_id', publicId);
  form.append('timestamp', String(timestamp));
  form.append('api_key', apiKey);
  form.append('signature', signature);

  try {
    const res = await fetch('https://api.cloudinary.com/v1_1/' + cloudName + '/' + resourceType + '/destroy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || (data.result !== 'ok' && data.result !== 'not found')) {
      console.error('delete-image: Cloudinary destroy failed for', publicId, '(' + resourceType + ')', data);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: (data.error && data.error.message) || 'Cloudinary delete failed', result: data.result }),
      };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, result: data.result }) };
  } catch (err) {
    console.error('delete-image: request to Cloudinary failed for', publicId, err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Request to Cloudinary failed' }) };
  }
};
