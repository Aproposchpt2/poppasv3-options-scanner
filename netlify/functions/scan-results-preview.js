// POPPA'S Option Scanner v3 — preview-safe live results endpoint.
// Returns an unfiltered slice of the cached scanner board so the preview page can render live data
// without attempting to download the full 100k+ row board in one browser request.

import { getStore } from "@netlify/blobs";

const STORE = "poppas-scan";
const LATEST_KEY = "latest";

const num = (v, d) => {
  if (v === null || v === undefined || v === "") return d;
  const n = +v;
  return Number.isFinite(n) ? n : d;
};

const hasValue = v => v !== null && v !== undefined && Number.isFinite(+v);
const rocOf = r => (r.roc != null ? r.roc : (r.credit && r.width && r.width - r.credit > 0 ? r.credit / (r.width - r.credit) * 100 : 0));
const probOf = r => (r.prob != null ? r.prob : Math.round((r.probOtm || 0) * 100));
const chainIVOf = r => num(r.monthlyChainIV ?? r.chainIV ?? r.iv, 0);
const spreadOf = r => hasValue(r.spreadMax) ? +r.spreadMax : (hasValue(r.spread) ? +r.spread : null);

function json(body, maxAge = 60) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=" + maxAge
    }
  });
}

function expectedMoveFor(r) {
  const spot = num(r.spot, null), iv = chainIVOf(r), dte = num(r.dte, null);
  if (!hasValue(spot) || !hasValue(iv) || !hasValue(dte) || spot <= 0 || iv <= 0 || dte <= 0) {
    return {
      expectedMove: r.expectedMove ?? null,
      expectedLow: r.expectedLow ?? null,
      expectedHigh: r.expectedHigh ?? null,
      expectedMoveStatus: r.expectedMoveStatus || "Verify"
    };
  }

  const move = hasValue(r.expectedMove) ? +r.expectedMove : +(spot * (iv / 100) * Math.sqrt(dte / 365)).toFixed(2);
  const low = hasValue(r.expectedLow) ? +r.expectedLow : +(spot - move).toFixed(2);
  const high = hasValue(r.expectedHigh) ? +r.expectedHigh : +(spot + move).toFixed(2);
  let status = r.expectedMoveStatus || "Review";
  const put = num(r.shortPut ?? r.putSell, null), call = num(r.shortCall ?? r.callSell, null);

  if (hasValue(put) && hasValue(call)) {
    const buffer = Math.max(move * 0.10, spot * 0.005);
    if (put < low && call > high) status = "Outside EM";
    else if (put >= low + buffer || call <= high - buffer) status = "Inside EM";
    else status = "Near EM";
  }

  return { expectedMove: move, expectedLow: low, expectedHigh: high, expectedMoveStatus: status };
}

function normalizedRow(r) {
  const monthlyChainIV = chainIVOf(r);
  const em = expectedMoveFor(r);
  return {
    ...r,
    iv: Number.isFinite(monthlyChainIV) ? +monthlyChainIV.toFixed(1) : 0,
    monthlyChainIV: Number.isFinite(monthlyChainIV) ? +monthlyChainIV.toFixed(1) : 0,
    roc: +rocOf(r).toFixed(2),
    prob: probOf(r),
    shortPutOI: num(r.shortPutOI ?? r.putShortOI ?? r.oiMin, null),
    shortCallOI: num(r.shortCallOI ?? r.callShortOI ?? r.oiMin, null),
    longPutOI: num(r.longPutOI, null),
    longCallOI: num(r.longCallOI, null),
    spreadMax: spreadOf(r),
    expectedMove: em.expectedMove,
    expectedLow: em.expectedLow,
    expectedHigh: em.expectedHigh,
    expectedMoveStatus: em.expectedMoveStatus,
    reviewStatus: r.passed ? "Matches primary filters ✓" : (r.note || "Candidate for manual review")
  };
}

function sortRows(rows, rankBy = "edge", passersTop = false) {
  return rows.sort((a, b) => {
    if (passersTop && (b.passed ? 1 : 0) - (a.passed ? 1 : 0)) return (b.passed ? 1 : 0) - (a.passed ? 1 : 0);
    if (rankBy === "roc") return rocOf(b) - rocOf(a);
    if (rankBy === "prob") return probOf(b) - probOf(a);
    if (rankBy === "iv") return chainIVOf(b) - chainIVOf(a);
    return (b.edge || b.score || 0) - (a.edge || a.score || 0) || rocOf(b) - rocOf(a);
  });
}

export default async (req) => {
  const q = (() => { try { return new URL(req.url).searchParams; } catch (_) { return new URLSearchParams(); } })();
  const limit = Math.min(Math.max(parseInt(q.get("limit") || "5000", 10) || 5000, 1), 10000);
  const offset = Math.max(parseInt(q.get("offset") || "0", 10) || 0, 0);
  const rankBy = q.get("rankBy") || "edge";
  const passersTop = q.get("passersTop") === "yes" || q.get("passersTop") === "true";

  const store = getStore(STORE);
  const board = await store.get(LATEST_KEY, { type: "json" }).catch(() => null);

  if (!board || !Array.isArray(board.results)) {
    try {
      const base = process.env.URL || process.env.DEPLOY_URL;
      if (base) fetch(`${base}/.netlify/functions/scan-build-background`, { method: "POST" });
    } catch (_) {}

    return json({
      ok: true,
      building: true,
      hasRows: false,
      total: 0,
      matched: 0,
      returned: 0,
      offset,
      limit,
      filterMode: "unfiltered-preview-slice",
      serverFiltersRemoved: true,
      userMessage: "Scanner board is not available yet. A build was requested.",
      results: []
    }, 30);
  }

  const totalRows = board.results.length;
  const sorted = sortRows(board.results.map(normalizedRow), rankBy, passersTop);
  const rows = sorted.slice(offset, offset + limit);

  return json({
    ok: true,
    strategy: board.strategy || "SP500_Tight_Condor_Scan",
    scanMode: board.scanMode || "Cached delayed/EOD scan",
    dataSource: board.dataSource || "Stored scan board",
    generatedAt: board.generatedAt,
    universeCount: board.universeCount,
    scanned: board.scanned,
    withCondor: board.withCondor ?? totalRows,
    passCount: board.passCount,
    building: !!board.building,
    progress: board.progress || null,
    total: totalRows,
    matched: totalRows,
    returned: rows.length,
    offset,
    limit,
    hasRows: rows.length > 0,
    previewSlice: true,
    filterMode: "unfiltered-preview-slice",
    serverFiltersRemoved: true,
    userMessage: board.building
      ? "Live board rows are available while the scan is still finalizing. Displaying a preview-safe unfiltered slice."
      : "Live board is ready. Displaying a preview-safe unfiltered slice.",
    results: rows
  }, board.building ? 30 : 300);
};
