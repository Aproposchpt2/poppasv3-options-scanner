// POPPA'S Option Scanner v3 — Supabase REST scan control endpoint.
// Controls status/start/continue/restart without Supabase JS client.

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
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
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(opts.headers || {})
    }
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} failed ${res.status}: ${text}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json") && text) return { data: JSON.parse(text), headers: res.headers };
  return { data: text, headers: res.headers };
}

function baseUrl(req) {
  try {
    const u = new URL(req.url);
    return process.env.URL || process.env.DEPLOY_URL || `${u.protocol}//${u.host}`;
  } catch (_) {
    return process.env.URL || process.env.DEPLOY_URL || "";
  }
}

function ageSeconds(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
}

async function latestRun() {
  const { data } = await sbFetch("scan_runs?select=*&order=started_at.desc&limit=1");
  return Array.isArray(data) ? data[0] : null;
}

async function readState() {
  const run = await latestRun();
  if (!run) {
    return {
      ok: true,
      action: "status",
      status: "empty",
      scanRunId: null,
      building: false,
      stale: false,
      progress: { scanned: 0, total: 0, rows: 0 },
      recommendation: "EMPTY: start a Supabase-backed scan.",
      endpoints: {
        status: "/.netlify/functions/force-scan-db?status=1",
        triggerScan: "/.netlify/functions/force-scan-db",
        scanBuilder: "/.netlify/functions/scan-build-db",
        scanResults: "/.netlify/functions/scan-results-db"
      }
    };
  }

  const updatedAge = ageSeconds(run.updated_at || run.started_at);
  const status = String(run.status || "").toLowerCase();
  const building = ["running", "stale"].includes(status);
  const stale = building && updatedAge !== null && updatedAge > 240;
  let recommendation = "READY: latest Supabase scan is available.";
  if (building && stale) recommendation = "STALE BUILD: continue Supabase scan.";
  else if (building) recommendation = "BUILDING: continue polling Supabase scan.";
  else if (status === "failed") recommendation = "FAILED: restart Supabase scan after reviewing error.";

  return {
    ok: true,
    action: "status",
    status: run.status,
    scanRunId: run.id,
    strategy: run.strategy,
    scanMode: run.scan_mode,
    dataSource: run.data_source,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    completedAt: run.completed_at,
    ageSeconds: updatedAge,
    building,
    stale,
    error: run.error || null,
    universeCount: run.universe_count || 0,
    scanned: run.scanned_count || 0,
    candidateCount: run.candidate_count || 0,
    passCount: run.pass_count || 0,
    pendingIndex: run.pending_index || 0,
    progress: {
      scanned: run.scanned_count || 0,
      total: run.universe_count || 0,
      rows: run.candidate_count || 0
    },
    backendFiltersRemoved: !!run.metadata?.backendFiltersRemoved,
    upstreamFiltersOnly: run.metadata?.upstreamFiltersOnly || ["Monthly option chain", "15-45 DTE"],
    recommendation,
    endpoints: {
      status: "/.netlify/functions/force-scan-db?status=1",
      triggerScan: "/.netlify/functions/force-scan-db",
      scanBuilder: "/.netlify/functions/scan-build-db",
      scanResults: "/.netlify/functions/scan-results-db"
    }
  };
}

export default async (req) => {
  try {
    const method = req.method || "GET";
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || (method === "POST" ? "start" : "status");

    if ((method === "GET" && action === "status") || url.searchParams.has("status")) {
      return json(await readState());
    }

    const base = baseUrl(req);
    if (!base) return json({ ok: false, error: "No base URL available to trigger scan-build-db." }, 500);

    const qs = action === "restart" ? "?restart=1" : (action === "continue" ? "?continue=1" : "");
    const endpoint = `${base}/.netlify/functions/scan-build-db${qs}`;
    let trigger;
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { accept: "application/json" } });
      let body;
      try { body = await res.json(); } catch (_) { body = await res.text().catch(() => null); }
      trigger = { ok: res.ok, status: res.status, body };
    } catch (err) {
      trigger = { ok: false, error: String(err?.message || err) };
    }

    const state = await readState();
    return json({
      ok: !!trigger?.ok,
      action,
      triggeredEndpoint: endpoint,
      trigger,
      state
    }, trigger?.ok ? 200 : 500);
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
};
