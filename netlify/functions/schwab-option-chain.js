// POPPA'S Option Scanner v3 — Schwab option-chain market data test function
// Purpose: pull Schwab/TOS option-chain market data for a test symbol using server-side OAuth.
// Security posture: market-data only. This function never calls Schwab account, trading, position, balance,
// order, transaction, or ACCT_ACTIVITY endpoints. It never returns Schwab access tokens, refresh tokens,
// client secrets, account IDs, account hashes, balances, positions, orders, or trading data.

const DEFAULT_TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const DEFAULT_API_BASE_URL = "https://api.schwabapi.com";
const OPTION_CHAIN_PATH = "/marketdata/v1/chains";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
  "Pragma": "no-cache",
  "Expires": "0",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

const ALLOWED_MARKET_DATA_PATHS = new Set([
  OPTION_CHAIN_PATH
]);

const BLOCKED_TERMS = [
  "account",
  "accounts",
  "acct_activity",
  "accountactivity",
  "accountnumber",
  "accounthash",
  "hashvalue",
  "balance",
  "balances",
  "position",
  "positions",
  "order",
  "orders",
  "transaction",
  "transactions",
  "trade",
  "trading"
];

const DEFAULT_SAFE_PARAMS = {
  contractType: "ALL",
  includeQuotes: "TRUE",
  strategy: "SINGLE",
  range: "ALL"
};

const FORWARDED_CHAIN_PARAMS = [
  "contractType",
  "strikeCount",
  "includeUnderlyingQuote",
  "strategy",
  "interval",
  "strike",
  "range",
  "fromDate",
  "toDate",
  "volatility",
  "underlyingPrice",
  "interestRate",
  "daysToExpiration",
  "expMonth",
  "optionType",
  "entitlement",
  "includeQuotes"
];

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function getEnv(name, fallback = "") {
  return (process.env[name] || fallback || "").trim();
}

function requireEnv(names) {
  const missing = names.filter((name) => !getEnv(name));
  if (missing.length) {
    const error = new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
    error.status = 500;
    error.safeDetails = { missingEnv: missing };
    throw error;
  }
}

function assertMarketDataOnlyConfig() {
  if (getEnv("SCHWAB_ACCOUNT_ACCESS_ENABLED") === "true") {
    const error = new Error("Blocked: SCHWAB_ACCOUNT_ACCESS_ENABLED must not be true for POPPA'S market-data-only setup.");
    error.status = 403;
    throw error;
  }

  if (getEnv("SCHWAB_TRADING_ACCESS_ENABLED") === "true") {
    const error = new Error("Blocked: SCHWAB_TRADING_ACCESS_ENABLED must not be true for POPPA'S market-data-only setup.");
    error.status = 403;
    throw error;
  }
}

function assertNoBlockedTerms(value, label = "value") {
  const text = String(value || "").toLowerCase();
  const matched = BLOCKED_TERMS.find((term) => text.includes(term));
  if (matched) {
    const error = new Error(`Blocked ${label}: market-data-only function cannot reference ${matched}.`);
    error.status = 403;
    throw error;
  }
}

function assertAllowedMarketDataPath(pathname) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (!ALLOWED_MARKET_DATA_PATHS.has(normalizedPath)) {
    const error = new Error(`Blocked Schwab path: ${normalizedPath}. Only market-data option-chain path is allowed.`);
    error.status = 403;
    throw error;
  }
  assertNoBlockedTerms(normalizedPath, "Schwab path");
}

function basicAuthHeader() {
  const clientId = getEnv("SCHWAB_CLIENT_ID");
  const clientSecret = getEnv("SCHWAB_CLIENT_SECRET");
  const encoded = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

async function refreshAccessToken() {
  requireEnv(["SCHWAB_CLIENT_ID", "SCHWAB_CLIENT_SECRET", "SCHWAB_TOKEN_URL", "SCHWAB_REFRESH_TOKEN"]);
  assertMarketDataOnlyConfig();

  const tokenUrl = getEnv("SCHWAB_TOKEN_URL", DEFAULT_TOKEN_URL);
  assertNoBlockedTerms(tokenUrl, "token URL");

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: getEnv("SCHWAB_REFRESH_TOKEN")
    })
  });

  const rawText = await response.text();
  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    parsed = { raw: "[non-json token response redacted]" };
  }

  if (!response.ok || !parsed.access_token) {
    const error = new Error("Unable to refresh Schwab access token.");
    error.status = response.status || 500;
    error.safeDetails = {
      status: response.status,
      statusText: response.statusText,
      schwabError: parsed.error || null,
      schwabErrorDescription: parsed.error_description || null
    };
    throw error;
  }

  return {
    accessToken: parsed.access_token,
    metadata: {
      token_type: parsed.token_type || null,
      expires_in: parsed.expires_in || null,
      scope: parsed.scope || null,
      access_token_present: true,
      refresh_token_returned_by_refresh: Boolean(parsed.refresh_token)
    }
  };
}

function normalizeSymbol(symbol) {
  const normalized = String(symbol || "AAPL").trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(normalized)) {
    const error = new Error("Invalid symbol. Use a normal equity ticker such as AAPL, AMZN, MSFT, SPY, or QQQ.");
    error.status = 400;
    throw error;
  }
  return normalized;
}

function buildOptionChainUrl(url) {
  requireEnv(["SCHWAB_API_BASE_URL"]);
  assertMarketDataOnlyConfig();
  assertAllowedMarketDataPath(OPTION_CHAIN_PATH);

  const apiBase = getEnv("SCHWAB_API_BASE_URL", DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  assertNoBlockedTerms(apiBase, "API base URL");

  const chainUrl = new URL(`${apiBase}${OPTION_CHAIN_PATH}`);
  chainUrl.searchParams.set("symbol", normalizeSymbol(url.searchParams.get("symbol")));

  for (const [key, value] of Object.entries(DEFAULT_SAFE_PARAMS)) {
    chainUrl.searchParams.set(key, value);
  }

  for (const key of FORWARDED_CHAIN_PARAMS) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") {
      assertNoBlockedTerms(key, "query parameter name");
      assertNoBlockedTerms(value, `query parameter ${key}`);
      chainUrl.searchParams.set(key, value);
    }
  }

  return chainUrl;
}

async function fetchOptionChain(url) {
  const { accessToken, metadata } = await refreshAccessToken();
  const chainUrl = buildOptionChainUrl(url);
  assertAllowedMarketDataPath(chainUrl.pathname);

  const response = await fetch(chainUrl.toString(), {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json"
    }
  });

  const rawText = await response.text();
  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    parsed = { raw: "[non-json option-chain response redacted]" };
  }

  if (!response.ok) {
    const error = new Error("Schwab option-chain market data request failed.");
    error.status = response.status;
    error.safeDetails = {
      status: response.status,
      statusText: response.statusText,
      schwabError: parsed.error || null,
      schwabErrorDescription: parsed.error_description || null,
      requestedPath: chainUrl.pathname,
      requestedSymbol: chainUrl.searchParams.get("symbol")
    };
    throw error;
  }

  return { data: parsed, tokenMetadata: metadata, requestedUrl: chainUrl };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mapValues(mapLike) {
  if (!mapLike || typeof mapLike !== "object") return [];
  return Object.values(mapLike).flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return Object.values(value).flat();
    return [];
  });
}

function extractContracts(chain = {}) {
  const calls = mapValues(chain.callExpDateMap);
  const puts = mapValues(chain.putExpDateMap);
  return {
    calls,
    puts,
    all: [...calls, ...puts]
  };
}

function findFieldNames(object, matcher, found = new Set(), depth = 0) {
  if (!object || typeof object !== "object" || depth > 5) return found;

  for (const [key, value] of Object.entries(object)) {
    if (matcher(key, value)) found.add(key);
    if (value && typeof value === "object") {
      findFieldNames(value, matcher, found, depth + 1);
    }
  }

  return found;
}

function pickFirstDefined(object, keys) {
  if (!object || typeof object !== "object") return undefined;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
}

function sanitizeContract(contract = {}) {
  return {
    putCall: contract.putCall || null,
    symbol: contract.symbol || null,
    description: contract.description || null,
    expirationDate: contract.expirationDate || null,
    daysToExpiration: toNumber(contract.daysToExpiration),
    strikePrice: toNumber(contract.strikePrice),
    bid: toNumber(contract.bid),
    ask: toNumber(contract.ask),
    mark: toNumber(contract.mark),
    last: toNumber(contract.last),
    volatility: toNumber(contract.volatility),
    delta: toNumber(contract.delta),
    gamma: toNumber(contract.gamma),
    theta: toNumber(contract.theta),
    vega: toNumber(contract.vega),
    rho: toNumber(contract.rho),
    openInterest: toNumber(contract.openInterest),
    totalVolume: toNumber(contract.totalVolume),
    theoreticalOptionValue: toNumber(contract.theoreticalOptionValue),
    theoreticalVolatility: toNumber(contract.theoreticalVolatility),
    probabilityOTM: toNumber(pickFirstDefined(contract, [
      "probabilityOTM",
      "probabilityOtm",
      "probOTM",
      "probOtm",
      "probabilityOutOfTheMoney",
      "pOTM"
    ])),
    quoteTimeInLong: contract.quoteTimeInLong || null,
    tradeTimeInLong: contract.tradeTimeInLong || null
  };
}

function summarizeOptionChain(chain = {}) {
  const { calls, puts, all } = extractContracts(chain);
  const sampleCalls = calls.slice(0, 5).map(sanitizeContract);
  const samplePuts = puts.slice(0, 5).map(sanitizeContract);

  const fieldNames = Array.from(findFieldNames(chain, (key) => true)).sort();
  const volatilityFields = Array.from(findFieldNames(chain, (key) => /vol|iv/i.test(key))).sort();
  const probabilityFields = Array.from(findFieldNames(chain, (key) => /prob|otm|itm/i.test(key))).sort();
  const expectedMoveFields = Array.from(findFieldNames(chain, (key) => /expected|move/i.test(key))).sort();

  return {
    symbol: chain.symbol || null,
    status: chain.status || null,
    strategy: chain.strategy || null,
    interval: chain.interval || null,
    isDelayed: chain.isDelayed ?? null,
    isIndex: chain.isIndex ?? null,
    interestRate: toNumber(chain.interestRate),
    underlyingPrice: toNumber(chain.underlyingPrice),
    volatility: toNumber(chain.volatility),
    daysToExpiration: toNumber(chain.daysToExpiration),
    numberOfContracts: toNumber(chain.numberOfContracts) || all.length,
    callContractCount: calls.length,
    putContractCount: puts.length,
    fieldDiscovery: {
      topLevelFields: Object.keys(chain).sort(),
      volatilityOrIVFields: volatilityFields,
      probabilityFields,
      expectedMoveFields,
      hasTopLevelVolatility: chain.volatility !== undefined,
      hasProbabilityOTMField: probabilityFields.length > 0,
      hasExpectedMoveField: expectedMoveFields.length > 0,
      discoveredFieldCount: fieldNames.length
    },
    samples: {
      calls: sampleCalls,
      puts: samplePuts
    }
  };
}

function statusPayload() {
  return {
    ok: true,
    endpoint: "schwab-option-chain",
    purpose: "Schwab/TOS market-data-only option-chain pull for POPPA'S scanner testing",
    marketDataOnly: true,
    accountAccessEnabled: false,
    tradingAccessEnabled: false,
    env: {
      SCHWAB_CLIENT_ID: Boolean(getEnv("SCHWAB_CLIENT_ID")),
      SCHWAB_CLIENT_SECRET: Boolean(getEnv("SCHWAB_CLIENT_SECRET")),
      SCHWAB_TOKEN_URL: Boolean(getEnv("SCHWAB_TOKEN_URL")),
      SCHWAB_API_BASE_URL: Boolean(getEnv("SCHWAB_API_BASE_URL")),
      SCHWAB_REFRESH_TOKEN: Boolean(getEnv("SCHWAB_REFRESH_TOKEN"))
    },
    allowedPath: OPTION_CHAIN_PATH,
    blockedCategories: [
      "ACCT_ACTIVITY",
      "accounts",
      "balances",
      "positions",
      "orders",
      "transactions",
      "trading"
    ],
    sampleUsage: "/.netlify/functions/schwab-option-chain?symbol=AAPL",
    optionalParams: FORWARDED_CHAIN_PARAMS
  };
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  }

  if (req.method !== "GET") {
    return json({ ok: false, error: "Method not allowed. Use GET only." }, 405);
  }

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return json({ ok: false, error: "Invalid request URL." }, 400);
  }

  try {
    const action = String(url.searchParams.get("action") || "chain").toLowerCase();

    if (["status", "health", "test"].includes(action)) {
      return json(statusPayload());
    }

    if (action !== "chain") {
      return json({ ok: false, error: `Unsupported action: ${action}`, allowedActions: ["status", "chain"] }, 400);
    }

    const includeRaw = url.searchParams.get("includeRaw") === "true";
    const startedAt = new Date().toISOString();
    const result = await fetchOptionChain(url);
    const summary = summarizeOptionChain(result.data);

    const payload = {
      ok: true,
      endpoint: "schwab-option-chain",
      action: "chain",
      marketDataOnly: true,
      accountAccessEnabled: false,
      tradingAccessEnabled: false,
      tokenReturnedToFrontend: false,
      accountDataReturnedToFrontend: false,
      dataSource: "Schwab/TOS Market Data API",
      requestedAt: startedAt,
      receivedAt: new Date().toISOString(),
      requestedPath: result.requestedUrl.pathname,
      requestedSymbol: result.requestedUrl.searchParams.get("symbol"),
      requestParams: Object.fromEntries(result.requestedUrl.searchParams.entries()),
      tokenMetadata: result.tokenMetadata,
      summary,
      notes: [
        "This is a market-data-only option-chain test endpoint.",
        "The response intentionally does not include Schwab tokens or account data.",
        "Use fieldDiscovery to confirm Schwab/TOS monthly volatility/IV, Probability OTM, and expected-move field availability before scanner mapping."
      ]
    };

    if (includeRaw) {
      payload.rawOptionChain = result.data;
      payload.rawDataWarning = "Raw market-data option-chain included because includeRaw=true. Do not use this mode for broad public frontend display.";
    }

    return json(payload);
  } catch (error) {
    return json({
      ok: false,
      endpoint: "schwab-option-chain",
      error: error.message || "Schwab option-chain function error.",
      details: error.safeDetails || undefined,
      marketDataOnly: true,
      tokenReturnedToFrontend: false,
      accountDataReturnedToFrontend: false
    }, error.status || 500);
  }
}
