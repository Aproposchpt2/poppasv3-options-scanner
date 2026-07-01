// POPPA'S Option Scanner v3 — optimized option-chain storage builder.
// Parallel build path: stores clean monthly option-chain rows only.
// Upstream ingestion filters only: monthly third-Friday expirations + 15-45 DTE + duplicate option-record removal.
// No ROC/probability/IV/OI/spread/earnings/width/ranking filters are applied here.

const CHUNK = 60;
const CONCURRENCY = 6;
const MAX_RUN_MS = 20 * 1000;
const SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const STRATEGY = "SP500_OptionChain_Storage_v1";
const SCAN_MODE = "CBOE EOD · monthly option-chain rows only · 15-45 DTE · Supabase option-chain storage";
const DATA_SOURCE = "CBOE EOD/delayed quotes; ingestion stores clean monthly option-chain rows only. Band Intake controls all candidate review filters.";

const CURATED = [
  ["NVDA","NVIDIA","Technology","both"],["TSLA","Tesla","Consumer Disc.","both"],["AMD","Advanced Micro Devices","Technology","both"],
  ["AAPL","Apple","Technology","both"],["MSFT","Microsoft","Technology","both"],["META","Meta Platforms","Communications","both"],
  ["AMZN","Amazon","Consumer Disc.","both"],["GOOGL","Alphabet","Communications","both"],["AVGO","Broadcom","Technology","both"],
  ["NFLX","Netflix","Communications","both"],["MU","Micron","Technology","both"],["MRVL","Marvell","Technology","both"],
  ["QCOM","Qualcomm","Technology","both"],["AMAT","Applied Materials","Technology","both"],["LRCX","Lam Research","Technology","both"],
  ["KLAC","KLA Corp","Technology","both"],["INTC","Intel","Technology","both"],["ON","ON Semiconductor","Technology","both"],
  ["ENPH","Enphase","Technology","both"],["FSLR","First Solar","Technology","both"],["SMCI","Super Micro","Technology","both"],
  ["PLTR","Palantir","Technology","both"],["ADBE","Adobe","Technology","both"],["PANW","Palo Alto Networks","Technology","both"],
  ["CRWD","CrowdStrike","Technology","both"],["ABNB","Airbnb","Consumer Disc.","both"],["SBUX","Starbucks","Consumer Disc.","both"],
  ["BKNG","Booking","Consumer Disc.","both"],["MRNA","Moderna","Health Care","both"],["COST","Costco","Consumer Staples","both"],
  ["COIN","Coinbase","Financials","both"],["APP","AppLovin","Technology","both"],["DASH","DoorDash","Consumer Disc.","both"],
  ["CSCO","Cisco","Technology","both"],["TMUS","T-Mobile","Communications","both"],["AMGN","Amgen","Health Care","both"],
  ["GILD","Gilead Sciences","Health Care","both"],["PEP","PepsiCo","Consumer Staples","both"],["MDLZ","Mondelez","Consumer Staples","both"],
  ["MSTR","Strategy","Technology","ndx"],["MARA","MARA Holdings","Financials","ndx"],["RIOT","Riot Platforms","Financials","ndx"],
  ["SOFI","SoFi Technologies","Financials","ndx"],["DKNG","DraftKings","Consumer Disc.","ndx"],["ARM","Arm Holdings","Technology","ndx"],
  ["ROKU","Roku","Communications","ndx"],["HOOD","Robinhood","Financials","ndx"],["SNOW","Snowflake","Technology","ndx"],
  ["DDOG","Datadog","Technology","ndx"],["PDD","PDD Holdings","Consumer Disc.","ndx"],["AFRM","Affirm","Financials","ndx"],
  ["RBLX","Roblox","Communications","ndx"]
];

const cboeUrl = s => `https://cdn.cboe.com/api/global/delayed_quotes/options/${s}.json`;
const parseOcc = s => {
  const m = String(s || "").match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  return m ? { y: 2000 + +m[2], mo: +m[3], d: +m[4], type: m[5], strike: +m[6] / 1000 } : null;
};
const dteOf = (y, mo, d, now) => Math.round((Date.UTC(y, mo - 1, d) - now) / 864e5);
const isThirdFriday = (y, mo, d) => { const x = new Date(Date.UTC(y, mo - 1, d)); return x.getUTCDay() === 5 && d >= 15 && d <= 21; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => Number.isFinite(Number(v)) ? Number(v) : null;
const ivPct = v => { const x = num(v); return x == null ? null : (x > 1.5 ? x : x * 100); };
const mid = o => { const b = num(o.bid), a = num(o.ask); return b == null || a == null ? null : +((b + a) / 2).toFixed(2); };

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function sbConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return { url: url.replace(/\/$/, ""), key };
}

async function sbFetch(path, opts = {}) {
  const { url, key } = sbConfig();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} failed ${res.status}: ${text}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json") && text) return { data: JSON.parse(text), headers: res.headers };
  return { data: text, headers: res.headers };
}

async function sbCount(table, filter = "") {
  const suffix = `${table}?select=id${filter ? `&${filter}` : ""}`;
  const { headers } = await sbFetch(suffix, { method: "HEAD", headers: { Prefer: "count=exact" } });
  const cr = headers.get("content-range") || "";
  const m = cr.match(/\/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function parseCsvLine(ln) {
  const r = []; let cur = "", q = false;
  for (const ch of ln) { if (ch === '"') q = !q; else if (ch === "," && !q) { r.push(cur); cur = ""; } else cur += ch; }
  r.push(cur); return r;
}

async function loadUniverse() {
  try {
    const r = await fetch(SP500_CSV);
    if (!r.ok) throw new Error("csv " + r.status);
    const lines = (await r.text()).split(/\r?\n/).filter(Boolean);
    lines.shift();
    const override = Object.fromEntries(CURATED.map(([s, , , m]) => [s, m]));
    const seen = new Set(), uni = [];
    for (const ln of lines) {
      const f = parseCsvLine(ln);
      const sym = (f[0] || "").trim().toUpperCase();
      if (!sym || sym.includes(".")) continue;
      if (seen.has(sym)) continue;
      seen.add(sym);
      uni.push([sym, (f[1] || sym).trim(), (f[2] || "S&P 500").trim(), override[sym] || "sp"]);
    }
    for (const c of CURATED) if (!seen.has(c[0])) { uni.push(c); seen.add(c[0]); }
    return uni.length >= 50 ? uni : CURATED;
  } catch (_) { return CURATED; }
}

async function fetchSym(sym, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(cboeUrl(sym), { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal });
      if (r.ok) { const j = await r.json(); clearTimeout(t); return j.data || j; }
    } catch (_) {} finally { clearTimeout(t); }
    await sleep(200 + Math.random() * 250);
  }
  return null;
}

function chainRows(ch, sym, name, sector, market, now) {
  if (!ch || !Array.isArray(ch.options)) return [];
  const spot = num(ch.current_price);
  if (spot == null || spot <= 0) return [];
  const out = [];
  for (const o of ch.options) {
    const p = parseOcc(o.option); if (!p) continue;
    const dte = dteOf(p.y, p.mo, p.d, now);
    if (dte < 15 || dte > 45) continue;
    if (!isThirdFriday(p.y, p.mo, p.d)) continue;
    const expiry = `${p.y}-${String(p.mo).padStart(2,"0")}-${String(p.d).padStart(2,"0")}`;
    out.push({
      symbol: sym,
      name,
      sector,
      market: market || "both",
      spot,
      expiry,
      dte,
      option_type: p.type,
      strike: p.strike,
      bid: num(o.bid),
      ask: num(o.ask),
      mid: mid(o),
      delta: num(o.delta),
      iv: ivPct(o.iv),
      open_interest: Number.isFinite(Number(o.open_interest)) ? Number(o.open_interest) : 0,
      volume: Number.isFinite(Number(o.volume)) ? Number(o.volume) : 0,
      occ_symbol: o.option,
      monthly_chain: true,
      raw_chain_rule: "monthly third-Friday expiration, 15-45 DTE only",
      source_payload: o
    });
  }
  return out;
}

function optionKey(r) { return [r.scan_run_id, r.symbol, r.expiry, r.option_type, r.strike, r.occ_symbol].join("|"); }

async function insertRows(scanRunId, rows) {
  if (!rows.length) return 0;
  const seen = new Map();
  for (const r of rows) {
    const mapped = { ...r, scan_run_id: scanRunId };
    seen.set(optionKey(mapped), mapped);
  }
  const mapped = Array.from(seen.values());
  for (let i = 0; i < mapped.length; i += 1000) {
    await sbFetch("scan_option_chain?on_conflict=scan_run_id,symbol,expiry,option_type,strike,occ_symbol", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(mapped.slice(i, i + 1000))
    });
  }
  return mapped.length;
}

async function optionCount(scanRunId) { return sbCount("scan_option_chain", `scan_run_id=eq.${encodeURIComponent(scanRunId)}`); }

async function createRun() {
  const universe = await loadUniverse();
  const body = [{
    strategy: STRATEGY,
    status: "running",
    scan_mode: SCAN_MODE,
    data_source: DATA_SOURCE,
    universe_count: universe.length,
    scanned_count: 0,
    candidate_count: 0,
    pass_count: 0,
    pending_index: 0,
    metadata: {
      universe,
      createdBy: "scan-build-chain-db-rest",
      optimizedChainStorage: true,
      backendFiltersRemoved: true,
      upstreamFiltersOnly: ["Monthly option chain", "15-45 DTE", "Duplicate option-record removal"]
    }
  }];
  const { data } = await sbFetch("scan_runs?select=*", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
  return data[0];
}

async function latestActiveRun() {
  const { data } = await sbFetch(`scan_runs?select=*&strategy=eq.${encodeURIComponent(STRATEGY)}&status=in.(running,stale)&order=started_at.desc&limit=1`);
  return Array.isArray(data) ? data[0] : null;
}
async function loadRun(restart) { if (restart) return createRun(); const active = await latestActiveRun(); return active || createRun(); }
async function updateRun(id, updates) { await sbFetch(`scan_runs?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(updates) }); }
function baseUrl(req) { try { const u = new URL(req.url); return process.env.URL || process.env.DEPLOY_URL || `${u.protocol}//${u.host}`; } catch (_) { return process.env.URL || process.env.DEPLOY_URL || ""; } }

export default async (req) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const restart = url.searchParams.get("restart") === "1" || url.searchParams.get("action") === "restart";
  let run;
  try { run = await loadRun(restart); } catch (err) { return json({ ok: false, error: String(err?.message || err) }, 500); }
  let universe = Array.isArray(run.metadata?.universe) ? run.metadata.universe : null;
  if (!universe) universe = await loadUniverse();
  const d = new Date();
  const now = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let pending = Math.max(0, Number(run.pending_index || 0));
  let scanned = Math.max(0, Number(run.scanned_count || 0));
  const total = universe.length;
  let lastBatchRows = 0;
  let lastInsertedRows = 0;

  try {
    while (pending < total && (Date.now() - t0) < MAX_RUN_MS) {
      const batch = universe.slice(pending, pending + CHUNK);
      const queue = [...batch];
      const allRows = [];
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length) {
          const [sym, name, sector, market] = queue.shift();
          const ch = await fetchSym(sym);
          scanned++;
          if (ch) allRows.push(...chainRows(ch, sym, name, sector, market, now));
          await sleep(40 + Math.random() * 80);
        }
      }));
      lastInsertedRows = allRows.length ? await insertRows(run.id, allRows) : 0;
      lastBatchRows = allRows.length;
      pending += batch.length;
      const count = await optionCount(run.id);
      await updateRun(run.id, {
        status: pending >= total ? "completed" : "running",
        universe_count: total,
        scanned_count: scanned,
        pending_index: pending,
        candidate_count: count,
        pass_count: count,
        completed_at: pending >= total ? new Date().toISOString() : null,
        error: null,
        metadata: {
          ...(run.metadata || {}),
          universe,
          optimizedChainStorage: true,
          backendFiltersRemoved: true,
          upstreamFiltersOnly: ["Monthly option chain", "15-45 DTE", "Duplicate option-record removal"],
          lastSymbolBatchSize: batch.length,
          lastGeneratedOptionRows: lastBatchRows,
          lastInsertedOptionRows: lastInsertedRows
        }
      });
    }
  } catch (err) {
    try { await updateRun(run.id, { status: "failed", error: String(err?.message || err) }); } catch (_) {}
    return json({ ok: false, scanRunId: run.id, error: String(err?.message || err) }, 500);
  }

  const complete = pending >= total;
  if (!complete) {
    const base = baseUrl(req);
    if (base) { try { fetch(`${base}/.netlify/functions/scan-build-chain-db?continue=1`, { method: "POST" }); } catch (_) {} }
  }
  const count = await optionCount(run.id);
  return json({
    ok: true,
    scanRunId: run.id,
    status: complete ? "completed" : "running",
    scanned,
    total,
    pendingIndex: pending,
    optionChainRows: count || 0,
    lastBatchRows,
    lastInsertedRows,
    optimizedChainStorage: true,
    backendFiltersRemoved: true,
    upstreamFiltersOnly: ["Monthly option chain", "15-45 DTE", "Duplicate option-record removal"],
    framework: "v3 optimized option-chain storage · Supabase REST persistence"
  });
};
