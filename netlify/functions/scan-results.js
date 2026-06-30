// POPPA'S Option Scanner — unfiltered cached-board results endpoint.
// GTM rule: return all pulled scanner-board candidates. User-facing filtering happens in the
// "Define your return band" scanner intake controls on index.html.

import { getStore } from "@netlify/blobs";

const num = (v, d) => {
  if (v === null || v === undefined || v === "") return d;
  const n = +v;
  return Number.isFinite(n) ? n : d;
};

const json = (o, maxAge) => new Response(JSON.stringify(o), {
  status: 200,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=" + (maxAge || 600)
  }
});

const hasValue = v => v !== null && v !== undefined && Number.isFinite(+v);
const rocOf = r => (r.roc != null ? r.roc : (r.credit && r.width && r.width - r.credit > 0 ? r.credit / (r.width - r.credit) * 100 : 0));
const probOf = r => (r.prob != null ? r.prob : Math.round((r.probOtm || 0) * 100));
const chainIVOf = r => num(r.monthlyChainIV ?? r.chainIV ?? r.iv, 0);
const shortPutOI = r => num(r.shortPutOI ?? r.putShortOI ?? r.oiMin, null);
const shortCallOI = r => num(r.shortCallOI ?? r.callShortOI ?? r.oiMin, null);
const longPutOI = r => num(r.longPutOI, null);
const longCallOI = r => num(r.longCallOI, null);
const spreadOf = r => hasValue(r.spreadMax) ? +r.spreadMax : (hasValue(r.spread) ? +r.spread : null);

const expectedMoveFor = r => {
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
  const put = num(r.shortPut, null), call = num(r.shortCall, null);

  if (hasValue(put) && hasValue(call)) {
    const buffer = Math.max(move * 0.10, spot * 0.005);
    if (put < low && call > high) status = "Outside EM";
    else if (put >= low + buffer || call <= high - buffer) status = "Inside EM";
    else status = "Near EM";
  }

  return { expectedMove: move, expectedLow: low, expectedHigh: high, expectedMoveStatus: status };
};

function normalizedRow(r) {
  const monthlyChainIV = chainIVOf(r);
  const em = expectedMoveFor(r);
  return {
    ...r,
    iv: Number.isFinite(monthlyChainIV) ? +monthlyChainIV.toFixed(1) : 0,
    monthlyChainIV: Number.isFinite(monthlyChainIV) ? +monthlyChainIV.toFixed(1) : 0,
    roc: +rocOf(r).toFixed(2),
    prob: probOf(r),
    shortPutOI: shortPutOI(r),
    shortCallOI: shortCallOI(r),
    longPutOI: longPutOI(r),
    longCallOI: longCallOI(r),
    spreadMax: spreadOf(r),
    expectedMove: em.expectedMove,
    expectedLow: em.expectedLow,
    expectedHigh: em.expectedHigh,
    expectedMoveStatus: em.expectedMoveStatus,
    reviewStatus: r.passed ? "Matches primary filters ✓" : (r.note || "Candidate for manual review")
  };
}

function sortRows(rows, rankBy, passersTop) {
  return rows.sort((a, b) => {
    if (passersTop && (b.passed ? 1 : 0) - (a.passed ? 1 : 0)) return (b.passed ? 1 : 0) - (a.passed ? 1 : 0);
    if (rankBy === "roc") return rocOf(b) - rocOf(a);
    return (b.edge || b.score || 0) - (a.edge || a.score || 0) || rocOf(b) - rocOf(a);
  });
}

export default async (req) => {
  const store = getStore("poppas-scan");
  let board = null;
  try { board = await store.get("latest", { type: "json" }); } catch (_) {}

  if (!board || !Array.isArray(board.results)) {
    try {
      const base = process.env.URL || process.env.DEPLOY_URL;
      if (base) fetch(`${base}/.netlify/functions/scan-build-background`, { method: "POST" });
    } catch (_) {}

    return json({
      building: true,
      filterMode: "unfiltered-board",
      serverFiltersRemoved: true,
      scanMode: "Building full scan…",
      earningsShield: "verify before trade",
      probabilityDisclosure: "Anchor-leg probability only; not guaranteed whole-condor probability.",
      userMessage: "Scanner board is not available yet. A build was requested.",
      results: []
    }, 30);
  }

  if (board.building) {
    const stale = Date.now() - new Date(board.generatedAt || 0).getTime() > 3 * 60 * 1000;
    if (stale) {
      try {
        const base = process.env.URL || process.env.DEPLOY_URL;
        if (base) fetch(`${base}/.netlify/functions/scan-build-background?continue=1`, { method: "POST" });
      } catch (_) {}
    }
  }

  const q = (() => { try { return new URL(req.url).searchParams; } catch (_) { return new URLSearchParams(); } })();
  const rankBy = q.get("rankBy") || "edge";
  const passersTop = q.get("passersTop") === "yes" || q.get("passersTop") === "true";

  const rows = sortRows(board.results.map(normalizedRow), rankBy, passersTop);

  return json({
    strategy: board.strategy || "SP500_Tight_Condor_Scan",
    scanMode: board.scanMode || "Cached delayed/EOD scan",
    dataSource: board.dataSource || "Stored scan board",
    generatedAt: board.generatedAt,
    universeCount: board.universeCount,
    scanned: board.scanned,
    withCondor: board.withCondor ?? rows.length,
    passCount: board.passCount,
    earningsShield: board.earningsShield || "verify before trade",
    earningsFlagged: board.earningsFlagged,
    probabilityDisclosure: "Anchor-leg probability only; not guaranteed whole-condor probability.",
    monthlyChainIVDisclosure: board.monthlyChainIVDisclosure || "Monthly Chain IV may vary by data source, model, and snapshot time.",
    building: !!board.building,
    progress: board.progress || null,
    total: board.withCondor ?? rows.length,
    matched: rows.length,
    returned: rows.length,
    filterMode: "unfiltered-board",
    serverFiltersRemoved: true,
    userMessage: "All pulled scanner-board candidates are returned. Use the Define your return band controls on the scanner page to narrow the display. Educational review only; not trade recommendations.",
    results: rows
  }, board.building ? 60 : 600);
};
