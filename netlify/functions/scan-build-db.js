// POPPA'S Option Scanner v3 — Supabase REST scan builder.
// Backend rule: generate broad raw monthly Iron Condor candidates only.
// Upstream ingestion filters only: monthly option chain + 15-45 DTE + duplicate structural record removal.
// User Band Intake values are applied in scan-results-db.js, not here.

const CHUNK = 8;
const CONCURRENCY = 2;
const MAX_RUN_MS = 20 * 1000;
const SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const STRATEGY = "SP500_Tight_Condor_Scan_v3_RawMonthlyFirst";
const SCAN_MODE = "CBOE EOD · Monthly option chain only · 15-45 DTE · Supabase persistence";
const DATA_SOURCE = "CBOE EOD/delayed quotes; ingestion extracts monthly option-chain records with 15-45 DTE only. All other filters are user Band Intake controls.";
const UPSTREAM_FILTERS_ONLY = ["Monthly option chain", "15-45 DTE", "Duplicate structural record removal"];

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
const parseOcc = s => { const m = String(s || "").match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/); return m ? { y: 2000 + +m[2], mo: +m[3], d: +m[4], type: m[5], strike: +m[6] / 1000 } : null; };
const dteOf = (y, mo, d, now) => Math.round((Date.UTC(y, mo - 1, d) - now) / 864e5);
const isThirdFriday = (y, mo, d) => { const x = new Date(Date.UTC(y, mo - 1, d)); return x.getUTCDay() === 5 && d >= 15 && d <= 21; };
const ivPct = v => (v > 1.5 ? v : v * 100);
const widthsFor = spot => spot < 250 ? [5, 10] : [10, 5];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hasNum = v => Number.isFinite(+v);
const bid = o => hasNum(o.bid) ? +o.bid : 0;
const ask = o => hasNum(o.ask) ? +o.ask : 0;
const mid = o => +((bid(o) + ask(o)) / 2).toFixed(2);
const round2 = n => Number.isFinite(+n) ? +(+n).toFixed(2) : null;

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

function expectedMoveFields(spot, iv, dte, shortPut, shortCall) {
  const s = +spot, v = +iv, d = +dte;
  if (!Number.isFinite(s) || !Number.isFinite(v) || !Number.isFinite(d) || s <= 0 || v <= 0 || d <= 0) return { expectedMove: null, expectedLow: null, expectedHigh: null, expectedMoveStatus: "Verify" };
  const move = +(s * (v / 100) * Math.sqrt(d / 365)).toFixed(2);
  const low = +(s - move).toFixed(2);
  const high = +(s + move).toFixed(2);
  let status = "Review";
  const put = +shortPut, call = +shortCall;
  if (Number.isFinite(put) && Number.isFinite(call)) {
    const buffer = Math.max(move * 0.10, s * 0.005);
    if (put < low && call > high) status = "Outside EM";
    else if (put >= low + buffer || call <= high - buffer) status = "Inside EM";
    else status = "Near EM";
  }
  return { expectedMove: move, expectedLow: low, expectedHigh: high, expectedMoveStatus: status };
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

async function loadEarnings(days = 90) {
  const map = {}, base = Date.now(), queue = [];
  for (let i = 0; i <= days; i++) queue.push(new Date(base + i * 864e5).toISOString().slice(0, 10));
  async function worker() {
    while (queue.length) {
      const d = queue.shift();
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch("https://api.nasdaq.com/api/calendar/earnings?date=" + d, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/plain, */*" }, signal: ctrl.signal });
        if (r.ok) { const j = await r.json(); for (const row of ((j.data && j.data.rows) || [])) { const s = (row.symbol || "").toUpperCase().trim(); if (s && (!map[s] || d < map[s])) map[s] = d; } }
      } catch (_) {} finally { clearTimeout(t); }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  return map;
}

async function fetchSym(sym, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    try { const r = await fetch(cboeUrl(sym), { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal }); if (r.ok) { const j = await r.json(); clearTimeout(t); return j.data || j; } }
    catch (_) {} finally { clearTimeout(t); }
    await sleep(300 + Math.random() * 250);
  }
  return null;
}

function nearestByStrike(set, type, target) {
  let b = null, bd = Infinity;
  for (const o of set) { if (o.type !== type) continue; const d = Math.abs(o.strike - target); if (d < bd) { bd = d; b = o; } }
  return b;
}

function qualityScore(x) {
  return [x.roc >= 5 && x.roc <= 10, x.probOtm >= 0.90, x.iv >= 30, x.monthlyOI >= 10000, x.shortPutOI >= 1 && x.shortCallOI >= 1, x.spreadMax <= 0.25, !x.earnInWindow, x.expectedMoveStatus === "Outside EM", x.credit > 0, x.width > 0].filter(Boolean).length;
}

function scanAll(ch, sym, name, sector, market, now, earningsMap = {}, todayStr = "") {
  if (!ch || !Array.isArray(ch.options)) return [];
  const spot = +ch.current_price;
  if (!Number.isFinite(spot) || spot <= 0) return [];
  const monthly = [];
  for (const o of ch.options) {
    const p = parseOcc(o.option); if (!p) continue;
    const dte = dteOf(p.y, p.mo, p.d, now);
    if (dte < 15 || dte > 45) continue;
    if (!isThirdFriday(p.y, p.mo, p.d)) continue;
    monthly.push({ ...o, type: p.type, strike: p.strike, dte, ek: `${p.y}-${String(p.mo).padStart(2,"0")}-${String(p.d).padStart(2,"0")}` });
  }
  if (!monthly.length) return [];
  const byExp = {}; monthly.forEach(o => { (byExp[o.ek] = byExp[o.ek] || []).push(o); });
  const out = [];
  for (const ek of Object.keys(byExp)) {
    const set = byExp[ek];
    const monthlyOI = set.reduce((s, o) => s + (o.open_interest || 0), 0);
    const calls = set.filter(o => o.type === "C" && o.strike > spot).sort((a,b) => a.strike - b.strike);
    const puts = set.filter(o => o.type === "P" && o.strike < spot).sort((a,b) => b.strike - a.strike);
    const erDate = earningsMap[sym] || null;
    const earnInWindow = !!(erDate && erDate >= todayStr && erDate <= ek);
    for (const widthTarget of widthsFor(spot)) {
      const putStructures = [], callStructures = [];
      for (const sp of puts) { const lp = nearestByStrike(set, "P", sp.strike - widthTarget); if (lp && lp.strike < sp.strike) putStructures.push({ sp, lp }); }
      for (const sc of calls) { const lc = nearestByStrike(set, "C", sc.strike + widthTarget); if (lc && lc.strike > sc.strike) callStructures.push({ sc, lc }); }
      for (const ps of putStructures) for (const cs of callStructures) {
        const { sp, lp } = ps, { sc, lc } = cs;
        const callW = +(lc.strike - sc.strike).toFixed(2), putW = +(sp.strike - lp.strike).toFixed(2);
        if (callW <= 0 || putW <= 0) continue;
        const width = Math.max(callW, putW);
        const credit = round2((bid(sc) + bid(sp)) - (ask(lc) + ask(lp)));
        const midCredit = round2((mid(sc) + mid(sp)) - (mid(lc) + mid(lp)));
        const maxRisk = Number.isFinite(width - credit) ? round2(width - credit) : null;
        const roc = Number.isFinite(maxRisk) && maxRisk > 0 ? +(credit / maxRisk * 100).toFixed(2) : -999;
        const iv = Math.max(ivPct(sc.iv || 0), ivPct(sp.iv || 0));
        const putDelta = Math.abs(+sp.delta || 0), callDelta = Math.abs(+sc.delta || 0);
        const putProbOtm = +(1 - putDelta).toFixed(3), callProbOtm = +(1 - callDelta).toFixed(3);
        const probOtm = +Math.min(putProbOtm, callProbOtm).toFixed(3);
        const spreadMax = +Math.max(ask(sc) - bid(sc), ask(sp) - bid(sp), ask(lc) - bid(lc), ask(lp) - bid(lp)).toFixed(2);
        const shortPutOI = sp.open_interest || 0, shortCallOI = sc.open_interest || 0;
        const longPutOI = lp.open_interest || 0, longCallOI = lc.open_interest || 0;
        const em = expectedMoveFields(spot, iv, sc.dte, sp.strike, sc.strike);
        const score = qualityScore({ roc, probOtm, iv, monthlyOI, shortPutOI, shortCallOI, spreadMax, earnInWindow, expectedMoveStatus: em.expectedMoveStatus, credit, width });
        out.push({ symbol: sym, name, sector, market: market || "both", spot: round2(spot), iv: +iv.toFixed(1), hv: +iv.toFixed(1), dte: sc.dte, expiry: ek, earnings: earnInWindow, earnings_date: earnInWindow ? erDate : null, next_earnings: erDate, short_put: sp.strike, long_put: lp.strike, short_call: sc.strike, long_call: lc.strike, credit, mid_credit: midCredit, width, max_risk: maxRisk, roc, prob_otm: probOtm, put_prob_otm: putProbOtm, call_prob_otm: callProbOtm, short_delta: +Math.max(putDelta, callDelta).toFixed(3), open_interest: monthlyOI, short_put_oi: shortPutOI, short_call_oi: shortCallOI, long_put_oi: longPutOI, long_call_oi: longCallOI, spread_max: spreadMax, expected_move: em.expectedMove, expected_low: em.expectedLow, expected_high: em.expectedHigh, expected_move_status: em.expectedMoveStatus, passed: true, score, review_status: "Raw monthly-chain candidate — apply Band Intake filters", note: "Raw candidate. User Band Intake values determine display eligibility.", raw_chain_eligible: true, raw_chain_rule: "monthly third-Friday expiration, 15-45 DTE only", source_payload: { symbol: sym, option_put_short: sp.option, option_put_long: lp.option, option_call_short: sc.option, option_call_long: lc.option } });
      }
    }
  }
  return out;
}

function candidateKey(r) {
  return [r.scan_run_id, r.symbol, r.expiry, r.short_put, r.long_put, r.short_call, r.long_call, r.width].join("|");
}

async function insertRows(scanRunId, rows) {
  if (!rows.length) return 0;
  const seen = new Map();
  for (const r of rows) {
    const mapped = { ...r, scan_run_id: scanRunId };
    seen.set(candidateKey(mapped), mapped);
  }
  const mapped = Array.from(seen.values());
  for (let i = 0; i < mapped.length; i += 500) {
    await sbFetch("scan_candidates?on_conflict=scan_run_id,symbol,expiry,short_put,long_put,short_call,long_call,width", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(mapped.slice(i, i + 500)) });
  }
  return mapped.length;
}

async function candidateCount(scanRunId) { return sbCount("scan_candidates", `scan_run_id=eq.${encodeURIComponent(scanRunId)}`); }
async function createRun() {
  const universe = await loadUniverse();
  const earnings = await loadEarnings(90);
  const body = [{ strategy: STRATEGY, status: "running", scan_mode: SCAN_MODE, data_source: DATA_SOURCE, universe_count: universe.length, scanned_count: 0, candidate_count: 0, pass_count: 0, pending_index: 0, metadata: { universe, earnings, createdBy: "scan-build-db-rest", backendFiltersRemoved: true, upstreamFiltersOnly: UPSTREAM_FILTERS_ONLY, autoFillMode: "short-batch-supabase-queue" } }];
  const { data } = await sbFetch("scan_runs?select=*", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
  return data[0];
}
async function latestActiveRun() { const { data } = await sbFetch("scan_runs?select=*&status=in.(running,stale)&order=started_at.desc&limit=1"); return Array.isArray(data) ? data[0] : null; }
async function loadRun(restart) { if (restart) return createRun(); const active = await latestActiveRun(); return active || createRun(); }
async function updateRun(id, updates) { await sbFetch(`scan_runs?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(updates) }); }
function baseUrl(req) { try { const u = new URL(req.url); return process.env.URL || process.env.DEPLOY_URL || `${u.protocol}//${u.host}`; } catch (_) { return process.env.URL || process.env.DEPLOY_URL || ""; } }

async function enqueueContinuation(req, scanRunId) {
  const base = baseUrl(req);
  if (!base) return { queued: false, reason: "no-base-url" };
  const endpoint = `${base}/.netlify/functions/scan-build-db?continue=1&scanRunId=${encodeURIComponent(scanRunId)}`;
  try {
    const { data } = await sbFetch("rpc/enqueue_scan_continue", { method: "POST", body: JSON.stringify({ p_url: endpoint }) });
    return { queued: true, requestId: data, endpoint, queue: "supabase-pg-net" };
  } catch (err) {
    return { queued: false, error: String(err?.message || err), endpoint, queue: "supabase-pg-net" };
  }
}

export default async (req) => {
  const t0 = Date.now();
  const url = new URL(req.url);
  const restart = url.searchParams.get("restart") === "1" || url.searchParams.get("action") === "restart";
  let run;
  try { run = await loadRun(restart); } catch (err) { return json({ ok: false, error: String(err?.message || err) }, 500); }
  let universe = Array.isArray(run.metadata?.universe) ? run.metadata.universe : null;
  let earnings = run.metadata?.earnings || null;
  if (!universe) universe = await loadUniverse();
  if (!earnings) earnings = await loadEarnings(90);
  const d = new Date();
  const now = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const todayStr = new Date(now).toISOString().slice(0, 10);
  let pending = Math.max(0, Number(run.pending_index || 0));
  let scanned = Math.max(0, Number(run.scanned_count || 0));
  const total = universe.length;
  let lastBatchRows = 0;
  let lastInsertedRows = 0;
  let batchesProcessed = 0;
  try {
    while (pending < total && (Date.now() - t0) < MAX_RUN_MS) {
      const batch = universe.slice(pending, pending + CHUNK);
      const queue = [...batch];
      const allRows = [];
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, async () => {
        while (queue.length) {
          const [sym, name, sector, market] = queue.shift();
          const ch = await fetchSym(sym);
          scanned++;
          if (ch) allRows.push(...scanAll(ch, sym, name, sector, market, now, earnings, todayStr));
          await sleep(80 + Math.random() * 180);
        }
      }));
      lastInsertedRows = allRows.length ? await insertRows(run.id, allRows) : 0;
      lastBatchRows = allRows.length;
      pending += batch.length;
      batchesProcessed++;
      const count = await candidateCount(run.id);
      await updateRun(run.id, { status: pending >= total ? "completed" : "running", universe_count: total, scanned_count: scanned, pending_index: pending, candidate_count: count, pass_count: count, completed_at: pending >= total ? new Date().toISOString() : null, error: null, metadata: { ...(run.metadata || {}), universe, earnings, backendFiltersRemoved: true, upstreamFiltersOnly: UPSTREAM_FILTERS_ONLY, autoFillMode: "short-batch-supabase-queue", batchSize: CHUNK, concurrency: CONCURRENCY, maxRunMs: MAX_RUN_MS, batchesProcessed, lastSymbolBatchSize: batch.length, lastGeneratedRows: lastBatchRows, lastInsertedRows, lastContinuationAt: new Date().toISOString() } });
    }
  } catch (err) {
    try { await updateRun(run.id, { status: "failed", error: String(err?.message || err) }); } catch (_) {}
    return json({ ok: false, scanRunId: run.id, error: String(err?.message || err) }, 500);
  }
  const complete = pending >= total;
  const continuation = complete ? { queued: false, reason: "complete" } : await enqueueContinuation(req, run.id);
  const count = await candidateCount(run.id);
  return json({ ok: true, scanRunId: run.id, status: complete ? "completed" : "running", scanned, total, pendingIndex: pending, candidateCount: count || 0, lastBatchRows, lastInsertedRows, batchesProcessed, continuation, backendFiltersRemoved: true, upstreamFiltersOnly: UPSTREAM_FILTERS_ONLY, framework: "v3 raw monthly-chain first · Supabase REST persistence" });
};
