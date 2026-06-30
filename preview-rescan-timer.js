// POPPA'S preview scanner controller.
// Band-aware loader with direct ticket rendering, row selection, graph view, EM/IV color coding, and Next Records CTA.
(function(){
  var LIMIT = 50;
  var pageOffset = 0;
  var nextOffset = null;
  var pollTimer = null;
  var currentRows = [];

  function el(id){ return document.getElementById(id); }
  function text(id, value){ var x=el(id); if(x) x.textContent = value; }
  function html(id, value){ var x=el(id); if(x) x.innerHTML = value; }
  function val(id, fallback){ var x=el(id); return x && x.value !== undefined && x.value !== '' ? x.value : fallback; }
  function msgOut(value, kind){ if(typeof msg === 'function') msg(value, kind || 'warn'); else console.log(value); }
  function esc(v){ return String(v == null ? '—' : v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function money(v){ var n=Number(v); return Number.isFinite(n) ? '$' + n.toFixed(2) : '—'; }
  function pct(v,d){ var n=Number(v); return Number.isFinite(n) ? n.toFixed(d == null ? 2 : d) + '%' : '—'; }
  function clock(sec){ var m=Math.floor(sec/60); var s=String(sec%60).padStart(2,'0'); return m + ':' + s; }

  function injectUiFixes(){
    if(document.getElementById('preview-ui-restore-css')) return;
    var st=document.createElement('style');
    st.id='preview-ui-restore-css';
    st.textContent='.table-wrap{position:relative}.table-wrap th{position:sticky;top:0;z-index:8;background:#061225}.em-out{color:var(--green)!important;font-weight:900}.em-near{color:var(--amber)!important;font-weight:900}.em-in{color:var(--red)!important;font-weight:900}.iv-inflated{color:var(--amber);font-weight:900}.iv-fair{color:var(--green);font-weight:900}.iv-deflated{color:var(--red);font-weight:900}.result-row{cursor:pointer}.result-row.row-active td{background:rgba(123,220,255,.13)!important;box-shadow:inset 3px 0 0 var(--cyan)}#loadNextBtn{display:inline-block!important;margin-left:10px}';
    document.head.appendChild(st);
  }

  function hideExtraControls(){
    var run=el('runScanBtn'), reset=el('resetBtn'), rescan=el('rescanBtn');
    if(run) run.style.display='none';
    if(reset) reset.style.display='none';
    if(rescan){ rescan.style.display=''; rescan.textContent='↻ Re-scan Live Data'; rescan.classList.add('primary'); }
  }

  function readDte(){
    var raw = val('dteWindow','15-45');
    var m = String(raw).match(/(\d+)\s*-\s*(\d+)/);
    return { min: m ? m[1] : '15', max: m ? m[2] : '45' };
  }

  function normalizeRank(){
    var r=String(val('rankBy','edge')).toLowerCase();
    if(r.indexOf('roc')>=0) return 'roc';
    if(r.indexOf('prob')>=0) return 'prob';
    if(r.indexOf('iv')>=0) return 'iv';
    return 'edge';
  }

  function readBandParams(offset){
    var dte = readDte();
    var width = val('spreadWidth','5');
    var q = new URLSearchParams();
    LIMIT = parseInt(val('maxResults','50'),10) || 50;
    q.set('limit', String(LIMIT));
    q.set('offset', String(offset || 0));
    q.set('rocMin', val('rocMin','5'));
    q.set('rocMax', val('rocMax','10'));
    q.set('minProb', val('minProb','90'));
    q.set('ivMin', val('ivMin','30'));
    q.set('minOI', val('minOI','10000'));
    q.set('minShortOI', val('minShortOI','1'));
    q.set('maxSpread', val('maxSpread','0.25'));
    q.set('dteMin', dte.min);
    q.set('dteMax', dte.max);
    q.set('excludeEarnings', val('excludeEarnings','yes'));
    q.set('idx', val('idxSel','both'));
    q.set('width', width === '0' ? '0' : width);
    q.set('rankBy', normalizeRank());
    q.set('passersTop', 'yes');
    q.set('_ts', String(Date.now()));
    return q;
  }

  async function getJson(url, ms){
    var controller = new AbortController();
    var timeout = setTimeout(function(){ controller.abort(); }, ms || 15000);
    try{
      var res = await fetch(url, { cache:'no-store', headers:{ accept:'application/json' }, signal: controller.signal });
      return await res.json();
    } finally { clearTimeout(timeout); }
  }

  function ivStatusFor(r){
    var raw = r.ivStatus || r.monthlyChainIVStatus || r.chainIVStatus;
    if(raw && String(raw).toLowerCase() !== 'all') return String(raw);
    var iv = Number(r.iv || r.monthlyChainIV || 0);
    if(!Number.isFinite(iv) || iv <= 0) return 'Fair';
    if(iv >= 40) return 'Inflated';
    if(iv < 30) return 'Deflated';
    return 'Fair';
  }
  function ivClass(v){ v=String(v).toLowerCase(); if(v.indexOf('inflated')>=0) return 'iv-inflated'; if(v.indexOf('deflated')>=0) return 'iv-deflated'; return 'iv-fair'; }
  function emClass(v){ v=String(v||'').toLowerCase(); if(v.indexOf('outside')>=0) return 'em-out'; if(v.indexOf('inside')>=0) return 'em-in'; if(v.indexOf('near')>=0) return 'em-near'; return ''; }

  function renderRows(rows, append){
    var body = el('resultsBody');
    if(!body) return;
    currentRows = append ? currentRows.concat(rows || []) : (rows || []);
    if(!currentRows.length){
      body.innerHTML = '<tr><td colspan="99" class="empty">No rows match the current Band Intake values.</td></tr>';
      renderTicket(null);
      return;
    }
    body.innerHTML = currentRows.map(function(r, i){
      var prob = r.prob != null ? r.prob : (r.probOtm != null ? Math.round(Number(r.probOtm) * 100) : null);
      var oi = r.openInterest || r.monthlyOI || r.oi || 0;
      var review = r.reviewStatus || r.note || (r.passed ? 'Matches primary filters ✓' : 'Candidate for manual review');
      var ivs = ivStatusFor(r);
      var ems = r.expectedMoveStatus || r.emStatus || 'Verify';
      return '<tr class="result-row" data-row="'+i+'">' +
        '<td>'+(i+1)+'</td>' +
        '<td><strong>'+esc(r.symbol)+'</strong></td>' +
        '<td>'+esc(r.sector || r.market || '—')+'</td>' +
        '<td>'+money(r.spot)+'</td>' +
        '<td>'+esc(r.dte != null ? r.dte + 'd' : '—')+'</td>' +
        '<td>'+esc(r.nextEarnings || r.earningsDate || 'Verify')+'</td>' +
        '<td>'+pct(r.iv,1)+'</td>' +
        '<td>'+esc(r.expectedMove != null ? '±' + money(r.expectedMove) : 'Verify')+'</td>' +
        '<td class="'+emClass(ems)+'">'+esc(ems)+'</td>' +
        '<td class="'+ivClass(ivs)+'">'+esc(ivs)+'</td>' +
        '<td>'+Number(oi || 0).toLocaleString()+'</td>' +
        '<td>'+pct(prob,0)+'</td>' +
        '<td>'+money(r.credit)+'</td>' +
        '<td>'+money(r.width != null && r.credit != null ? Number(r.width)-Number(r.credit) : r.risk)+'</td>' +
        '<td>'+pct(r.roc,2)+'</td>' +
        '<td>'+money(r.spreadMax)+'</td>' +
        '<td class="signal review">'+esc(review)+'</td>' +
      '</tr>';
    }).join('');
    bindRows();
    selectRow(0);
  }

  function bindRows(){
    var body=el('resultsBody'); if(!body) return;
    Array.prototype.forEach.call(body.querySelectorAll('tr[data-row]'), function(tr){
      tr.onclick=function(){ selectRow(Number(tr.getAttribute('data-row') || 0)); };
    });
  }

  function findTicketPanel(){
    var panels=Array.prototype.slice.call(document.querySelectorAll('.panel'));
    for(var i=0;i<panels.length;i++){
      var t=panels[i].textContent || '';
      if(t.indexOf('ORDER TICKET')>=0 || t.indexOf('Tap a result')>=0 || t.indexOf('Run a scan, then select')>=0 || t.indexOf('Candidate Ticket')>=0) return panels[i];
    }
    return null;
  }

  function selectRow(idx){
    var row=currentRows[idx];
    var body=el('resultsBody');
    if(body){
      Array.prototype.forEach.call(body.querySelectorAll('tr'), function(tr){ tr.classList.remove('row-active'); });
      var active=body.querySelector('tr[data-row="'+idx+'"]');
      if(active) active.classList.add('row-active');
    }
    renderTicket(row);
  }

  function renderTicket(r){
    var p=findTicketPanel();
    if(!p) return;
    if(!r){
      p.innerHTML='<p class="eyebrow">Order Ticket · 4-Leg Iron Condor</p><h2 class="title">Tap a result to build the ticket.</h2><div class="note">Run a scan, then select a candidate.</div>';
      return;
    }
    var risk = r.width != null && r.credit != null ? Number(r.width)-Number(r.credit) : Number(r.risk || 0);
    var prob = r.prob != null ? r.prob : (r.probOtm != null ? Math.round(Number(r.probOtm)*100) : null);
    var spot = Number(r.spot || 0), low=Number(r.expectedLow || 0), high=Number(r.expectedHigh || 0);
    var min=Math.min(low||spot, spot, Number(r.shortPut||spot));
    var max=Math.max(high||spot, spot, Number(r.shortCall||spot));
    var pctSpot = max>min ? Math.max(0, Math.min(100, (spot-min)/(max-min)*100)) : 50;
    p.innerHTML='<p class="eyebrow">Order Ticket · 4-Leg Iron Condor</p><h2 class="title">'+esc(r.symbol)+' Candidate Ticket</h2>'+ '<div class="note"><strong>Educational review only:</strong> verify live option chain pricing, liquidity, earnings, and risk before any decision.</div>'+ '<div class="ticket">'+ '<div class="leg sell"><span>Sell Put</span><strong>'+esc(r.shortPut || 'Verify')+'</strong></div>'+ '<div class="leg"><span>Buy Put</span><strong>'+esc(r.longPut || 'Verify')+'</strong></div>'+ '<div class="leg sell"><span>Sell Call</span><strong>'+esc(r.shortCall || 'Verify')+'</strong></div>'+ '<div class="leg"><span>Buy Call</span><strong>'+esc(r.longCall || 'Verify')+'</strong></div>'+ '</div>'+ '<div class="ticket-math">'+ '<div class="tm"><span>Credit</span><strong>'+money(r.credit)+'</strong></div>'+ '<div class="tm"><span>Max Risk</span><strong>'+money(risk)+'</strong></div>'+ '<div class="tm"><span>ROC</span><strong>'+pct(r.roc,2)+'</strong></div>'+ '<div class="tm"><span>Anchor P(OTM)</span><strong>'+pct(prob,0)+'</strong></div>'+ '</div>'+ '<div class="viz"><span class="eyebrow">Expected Move / Spot View</span><div class="bar"><span class="spot" style="left:'+pctSpot+'%"></span></div><div class="vizlabels"><span>Expected Low '+money(low)+'</span><span>Spot '+money(spot)+'</span><span>Expected High '+money(high)+'</span></div></div>'+ '<ul class="review-list"><li>EM Status: <b class="'+emClass(r.expectedMoveStatus)+'">'+esc(r.expectedMoveStatus || 'Verify')+'</b></li><li>IV Status: <b class="'+ivClass(ivStatusFor(r))+'">'+esc(ivStatusFor(r))+'</b></li><li>Review Status: '+esc(r.reviewStatus || r.note || 'Candidate for manual review')+'</li></ul>';
  }

  function updateStats(data){
    var total = data.total || 0;
    var matched = data.matched || 0;
    var returned = currentRows.length || data.returned || (data.results ? data.results.length : 0);
    text('truthDataMode', data.filterMode || 'band-aware-preview-slice');
    text('truthLastScan', data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '—');
    text('truthUniverse', (data.universeCount || '—') + ' symbols');
    text('truthBuild', data.building ? 'Building — rows available' : 'Ready');
    text('scanMode', data.building ? 'Building — live rows shown' : 'Live board ready');
    text('universeCount', data.universeCount || data.scanned || '—');
    text('pulledCount', data.scanned || '—');
    text('condorCount', data.withCondor || total || '—');
    text('activeMatches', matched.toLocaleString());
    text('candidateCount', returned.toLocaleString());
  }

  function showStatus(data){
    var progress = data.progress || {};
    var buildText = data.building ? ' Scan still building' + (progress.scanned && progress.total ? ': ' + progress.scanned + ' of ' + progress.total + ' symbols scanned.' : '.') : ' Scan board ready.';
    if((data.returned || 0) > 0){
      html('explanation','Loaded <strong>'+(currentRows.length||data.returned||0).toLocaleString()+'</strong> displayed rows from <strong>'+(data.matched||0).toLocaleString()+'</strong> candidates matching the current Band Intake values. '+buildText);
      msgOut('Live rows loaded. '+(currentRows.length||data.returned||0)+' displayed; '+(data.matched||0)+' matched.', 'ok');
      return;
    }
    if((data.total || 0) > 0){
      html('explanation','Live board is available, but <strong>no rows match</strong> the current Band Intake values. Widen ROC, IV, bid/ask, earnings, OI, or width filters. '+buildText);
      msgOut('Live board available, but no rows match the current Band Intake values.', 'warn');
      return;
    }
    html('explanation','No scanner board is available yet. A fresh scan has been requested. Typical scan time is about 5 minutes.');
    msgOut('No scanner board is available yet. Fresh scan requested.', 'warn');
  }

  function setupNextButton(){
    var b=el('loadNextBtn');
    var rescan=el('rescanBtn');
    if(!b && rescan){ b=document.createElement('button'); b.id='loadNextBtn'; b.className='btn secondary'; rescan.insertAdjacentElement('afterend', b); }
    if(!b) return;
    var has = nextOffset !== null && nextOffset !== undefined;
    b.style.display='inline-block';
    b.disabled=!has;
    b.textContent=has ? ('Load Next ' + LIMIT + ' Records') : 'All Records Loaded';
    b.onclick=function(){ if(has) appendNextRows(); };
  }

  async function loadBoard(){
    var rescan = el('rescanBtn');
    if(rescan){ rescan.disabled = true; rescan.textContent = 'Scanning…'; }
    hideExtraControls(); injectUiFixes(); pageOffset = 0;
    var data = await getJson('/.netlify/functions/scan-results-preview?' + readBandParams(0).toString(), 15000);
    currentRows=[];
    renderRows(data.results || [], false);
    nextOffset = data.nextOffset;
    updateStats(data);
    showStatus(data);
    setupNextButton();
    if(rescan){ rescan.disabled = false; rescan.textContent = '↻ Re-scan Live Data'; }
    return data;
  }

  async function appendNextRows(){
    if(nextOffset === null || nextOffset === undefined) return;
    pageOffset = nextOffset;
    var b=el('loadNextBtn'); if(b){ b.disabled=true; b.textContent='Loading…'; }
    var data = await getJson('/.netlify/functions/scan-results-preview?' + readBandParams(pageOffset).toString(), 15000);
    renderRows(data.results || [], true);
    nextOffset = data.nextOffset;
    updateStats(data);
    showStatus(data);
    setupNextButton();
  }

  async function startTimedScan(){
    try { await fetch('/.netlify/functions/scan-build-background', { method:'POST' }); } catch(e) { console.warn(e); }
    var elapsed = 0;
    if(pollTimer) clearInterval(pollTimer);
    var rescan = el('rescanBtn');
    if(rescan){ rescan.disabled = true; rescan.textContent = 'Scanning… ~5 min'; }
    pollTimer = setInterval(async function(){
      elapsed += 10;
      if(rescan) rescan.textContent = 'Scanning… ' + clock(elapsed);
      try{
        var data = await loadBoard();
        if((data.total || 0) > 0){ clearInterval(pollTimer); pollTimer = null; }
      }catch(e){ console.warn('Waiting for scan board', e); }
      if(elapsed >= 360){ clearInterval(pollTimer); pollTimer = null; if(rescan){ rescan.disabled = false; rescan.textContent = '↻ Re-scan Live Data'; } }
    }, 10000);
  }

  async function rescan(){
    try{
      var data = await loadBoard();
      if(!(data.total || 0)) startTimedScan();
    }catch(e){
      console.warn(e);
      html('explanation','Unable to read the live board yet. Starting a fresh timed scan. Typical scan time is about 5 minutes.');
      renderRows([], false);
      startTimedScan();
    }
  }

  function boot(){
    injectUiFixes(); hideExtraControls(); setupNextButton();
    var btn = el('rescanBtn'); if(btn) btn.onclick = rescan;
    html('explanation','Loading scanner using the default Band Intake values. After changing any Band field, press <strong>Re-scan Live Data</strong>.');
    setTimeout(rescan, 300);
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 800);
})();
