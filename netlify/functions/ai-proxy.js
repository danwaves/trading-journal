// Server-side proxy to the Anthropic API. The browser never sees the real
// API key — it lives only in Netlify's ANTHROPIC_API_KEY environment
// variable, injected at runtime via process.env. The app's two AI call
// sites (screenshot auto-fill in the New Trade form, and AI Insights on the
// dashboard) both POST the exact Anthropic Messages API request shape here
// and read the response as if it came straight from Anthropic — so this
// function is a thin pass-through, not a reshaping layer.
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server misconfigured: ANTHROPIC_API_KEY is not set in Netlify environment variables.' }),
    };
  }

  try {
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: event.body,
    });

    const responseText = await anthropicResponse.text();

    return {
      statusCode: anthropicResponse.status,
      headers: { 'Content-Type': 'application/json' },
      body: responseText,
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Proxy request to Anthropic failed: ' + (err && err.message ? err.message : String(err)) }),
    };
  }
};