// POPPA'S Option Scanner v3 — Schwab OAuth callback receiver
// Purpose: provide a safe backend-only OAuth redirect endpoint for Schwab Developer App setup.
// Security: this function never displays, logs, stores, or returns authorization codes, tokens, account IDs,
// account hashes, balances, positions, orders, or any account/trading data.

const SECURITY_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function html(title, body, status = 200) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #070d18;
      color: #f4f7fb;
      font-family: Arial, Helvetica, sans-serif;
    }
    main {
      max-width: 760px;
      margin: 24px;
      padding: 28px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.03));
      box-shadow: 0 24px 70px rgba(0,0,0,.35);
    }
    .eyebrow {
      color: #d6ad47;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: .14em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }
    h1 { margin: 0 0 14px; font-size: 28px; line-height: 1.2; }
    p { color: #d7e3f3; line-height: 1.55; }
    .ok { color: #4df0a4; font-weight: 800; }
    .warn { color: #ffce6a; font-weight: 800; }
    code {
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px;
      padding: 2px 6px;
      color: #cfe7ff;
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">POPPA'S Option Scanner v3</div>
    ${body}
  </main>
</body>
</html>`, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  }

  if (req.method !== "GET") {
    return json({ ok: false, error: "Method not allowed. Schwab OAuth callback accepts GET only." }, 405);
  }

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return json({ ok: false, error: "Invalid request URL." }, 400);
  }

  const health = url.searchParams.get("health") === "1" || url.searchParams.get("test") === "1";
  if (health) {
    return json({
      ok: true,
      endpoint: "schwab-callback",
      purpose: "Schwab OAuth redirect receiver",
      redirectUriConfigured: Boolean(process.env.SCHWAB_REDIRECT_URI),
      marketDataOnly: true,
      accountAccessEnabled: process.env.SCHWAB_ACCOUNT_ACCESS_ENABLED === "true" ? false : false,
      tradingAccessEnabled: process.env.SCHWAB_TRADING_ACCESS_ENABLED === "true" ? false : false,
      tokenReturnedToFrontend: false,
      accountDataReturnedToFrontend: false
    });
  }

  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const description = url.searchParams.get("error_description") || "Schwab returned an authorization error.";
    return html(
      "Schwab authorization error",
      `<h1>Schwab authorization returned an error</h1>
       <p><span class="warn">Status:</span> Authorization was not completed.</p>
       <p><strong>Error:</strong> ${escapeHtml(oauthError)}</p>
       <p><strong>Description:</strong> ${escapeHtml(description)}</p>
       <p>No Schwab token, account data, order data, or trading data was returned by this endpoint.</p>`,
      400
    );
  }

  const hasCode = url.searchParams.has("code");
  if (hasCode) {
    return html(
      "Schwab callback received",
      `<h1>Schwab callback received</h1>
       <p><span class="ok">Status:</span> Authorization code detected by the backend callback endpoint.</p>
       <p>For security, this page does not display the authorization code and does not return any token values to the browser.</p>
       <p>Next step: the secure backend token-exchange function should exchange the authorization code server-side using <code>SCHWAB_CLIENT_ID</code>, <code>SCHWAB_CLIENT_SECRET</code>, <code>SCHWAB_REDIRECT_URI</code>, and <code>SCHWAB_TOKEN_URL</code>.</p>
       <p>Market-data-only rule remains active: do not authorize accounts, trading, balances, positions, orders, or ACCT_ACTIVITY.</p>`,
      200
    );
  }

  return html(
    "Schwab callback ready",
    `<h1>Schwab callback endpoint is ready</h1>
     <p><span class="ok">Status:</span> Deployed callback route is reachable.</p>
     <p>Use this exact endpoint path as the Schwab Developer Portal Callback URL / Redirect URI:</p>
     <p><code>/.netlify/functions/schwab-callback</code></p>
     <p>This endpoint is market-data-only and does not request or expose Schwab account information.</p>`,
    200
  );
}
