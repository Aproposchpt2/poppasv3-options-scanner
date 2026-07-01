// POPPA'S preview scanner controller — Supabase-backed paged UX.
// Render/refresh pulls first 50. User CTA pulls the next 50.
// CTA workflow: Scan Next 50 / Records Still Loading / All Records Loaded.
(function(){
  var RESULTS_ENDPOINT = '/.netlify/functions/scan-results-db';
  var FORCE_ENDPOINT = '/.netlify/functions/force-scan-db';
  var LIMIT = 50;
  var nextOffset = null;
  var currentRows = [];
  var lastScanData = null;
  var filterDebounce = null;
  var sortState = { key: null, dir: 1 };

  function el(id){ return document.getElementById(id); }
  function text(id, value){ var x=el(id); if(x) x.textContent = value; }
  function html(id, value){ var x=el(id); if(x) x.innerHTML = value; }
  function val(id, fallback){ var x=el(id); return x && x.value !== undefined && x.value !== '' ? x.value : fallback; }
  function esc(v){ return String(v == null || v === '' ? '—' : v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function money(v){ var n=Number(v); return Number.isFinite(n) ? '$' + n.toFixed(2) : '—'; }
  function pct(v,d){ var n=Number(v); return Number.isFinite(n) ? n.toFixed(d == null ? 2 : d) + '%' : '—'; }
  function msgOut(value, kind){ if(typeof msg === 'function') msg(value, kind || 'warn'); else console.log(value); }

  function injectUiFixes(){
    if(document.getElementById('preview-supabase-css')) return;
    var st=document.createElement('style');
    st.id='preview-supabase-css';
    st.textContent='\
.table-wrap{position:relative;overflow:auto!important;max-height:78vh;-webkit-overflow-scrolling:touch;scrollbar-gutter:stable;border:1px solid var(--line);border-radius:14px}\
.table-wrap table{border-collapse:separate!important;border-spacing:0}\
.table-wrap thead{position:sticky;top:0;z-index:30}\
.table-wrap thead th,.table-wrap th{position:sticky!important;top:0!important;z-index:40!important;background:#061225!important;color:var(--muted);box-shadow:0 2px 0 var(--line),0 10px 18px rgba(0,0,0,.35);background-clip:padding-box}\
.table-wrap thead th:first-child,.table-wrap th:first-child{left:0;z-index:45!important}\
.em-out{color:var(--green)!important;font-weight:900}.em-near{color:var(--amber)!important;font-weight:900}.em-in{color:var(--red)!important;font-weight:900}.iv-inflated{color:var(--amber);font-weight:900}.iv-fair{color:var(--green);font-weight:900}.iv-deflated{color:var(--red);font-weight:900}.result-row{cursor:pointer}.result-row.row-active td{background:rgba(123,220,255,.13)!important;box-shadow:inset 3px 0 0 var(--cyan)}#loadNextBtn{display:inline-block!important;margin-left:10px}\
@media(max-width:620px){.table-wrap{max-height:70vh}.table-wrap thead th,.table-wrap th{top:0!important;font-size:.62rem;line-height:1.2}}';
    document.head.appendChild(st);
  }

  function hideExtraControls(){
    ['runScanBtn','resetBtn','rescanBtn'].forEach(function(id){ var b=el(id); if(b){ b.style.display='none'; b.disabled=true; } });
  }

  function ensureIvAll(){
    var s=el('ivStatusSel');
    if(!s) return;
    var hasAll=false;
    Array.prototype.forEach.call(s.options,function(o){ if(String(o.value).toLowerCase()==='all') hasAll=true; });
    if(!hasAll){ var opt=document.createElement('option'); opt.value='All'; opt.textContent='All'; s.insertBefore(opt, s.firstChild); }
    s.value='All';
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
    if(r.indexOf('credit')>=0) return 'credit';
    return 'edge';
  }

  function readBandParams(offset){
    var dte = readDte();
    var width = val('spreadWidth','5');
    var q = new URLSearchParams();
    LIMIT = 50;
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
    q.set('ivStatus', val('ivStatusSel','All'));
    q.set('emStatus', val('emStatusSel', val('expectedMoveStatus','Outside Expected Move')));
    q.set('_ts', String(Date.now()));
    return q;
  }

  async function getJson(url, ms){
    var controller = new AbortController();
    var timeout = setTimeout(function(){ controller.abort(); }, ms || 20000);
    try{
      var res = await fetch(url, { cache:'no-store', headers:{ accept:'application/json' }, signal: controller.signal });
      var data = await res.json().catch(function(){ return null; });
      if(!res.ok) throw new Error((data && data.error) || ('HTTP '+res.status));
      return data || {};
    } finally { clearTimeout(timeout); }
  }

  function postScan(action){
    var suffix = action ? ('?action=' + encodeURIComponent(action)) : '';
    return getJson(FORCE_ENDPOINT + suffix, 30000).catch(function(e){ console.warn('scan control', e); return null; });
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
      body.innerHTML = '<tr><td colspan="99" class="empty">No rows match the current Band Intake values yet.</td></tr>';
      renderTicket(null);
      return;
    }
    body.innerHTML = currentRows.map(function(r, i){
      var prob = r.prob != null ? r.prob : (r.probOtm != null ? Math.round(Number(r.probOtm) * 100) : null);
      var oi = r.openInterest || r.monthlyOI || r.oi || 0;
      var review = r.reviewStatus || r.note || 'Matches current Band Intake values ✓';
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
        '<td>'+money(r.maxRisk != null ? r.maxRisk : (r.width != null && r.credit != null ? Number(r.width)-Number(r.credit) : r.risk))+'</td>' +
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
      p.innerHTML='<p class="eyebrow">Order Ticket · 4-Leg Iron Condor</p><h2 class="title">Tap a result to build the ticket.</h2><div class="note">Rows load 50 at a time from the latest Supabase EOD dataset.</div>';
      return;
    }
    var risk = r.maxRisk != null ? Number(r.maxRisk) : (r.width != null && r.credit != null ? Number(r.width)-Number(r.credit) : Number(r.risk || 0));
    var prob = r.prob != null ? r.prob : (r.probOtm != null ? Math.round(Number(r.probOtm)*100) : null);
    var spot = Number(r.spot || 0), low=Number(r.expectedLow || 0), high=Number(r.expectedHigh || 0);
    var min=Math.min(low||spot, spot, Number(r.shortPut||spot));
    var max=Math.max(high||spot, spot, Number(r.shortCall||spot));
    var pctSpot = max>min ? Math.max(0, Math.min(100, (spot-min)/(max-min)*100)) : 50;
    p.innerHTML='<p class="eyebrow">Order Ticket · 4-Leg Iron Condor</p><h2 class="title">'+esc(r.symbol)+' Candidate Ticket</h2>'+ '<div class="note"><strong>Educational review only:</strong> verify live option chain pricing, liquidity, earnings, and risk before any decision.</div>'+ '<div class="ticket">'+ '<div class="leg sell"><span>Sell Put</span><strong>'+esc(r.shortPut || 'Verify')+'</strong></div>'+ '<div class="leg"><span>Buy Put</span><strong>'+esc(r.longPut || 'Verify')+'</strong></div>'+ '<div class="leg sell"><span>Sell Call</span><strong>'+esc(r.shortCall || 'Verify')+'</strong></div>'+ '<div class="leg"><span>Buy Call</span><strong>'+esc(r.longCall || 'Verify')+'</strong></div>'+ '</div>'+ '<div class="ticket-math">'+ '<div class="tm"><span>Credit</span><strong>'+money(r.credit)+'</strong></div>'+ '<div class="tm"><span>Max Risk</span><strong>'+money(risk)+'</strong></div>'+ '<div class="tm"><span>ROC</span><strong>'+pct(r.roc,2)+'</strong></div>'+ '<div class="tm"><span>Anchor P(OTM)</span><strong>'+pct(prob,0)+'</strong></div>'+ '</div>'+ '<div class="viz"><span class="eyebrow">Expected Move / Spot View</span><div class="bar"><span class="spot" style="left:'+pctSpot+'%"></span></div><div class="vizlabels"><span>Expected Low '+money(low)+'</span><span>Spot '+money(spot)+'</span><span>Expected High '+money(high)+'</span></div></div>'+ '<ul class="review-list"><li>EM Status: <b class="'+emClass(r.expectedMoveStatus)+'">'+esc(r.expectedMoveStatus || 'Verify')+'</b></li><li>IV Status: <b class="'+ivClass(ivStatusFor(r))+'">'+esc(ivStatusFor(r))+'</b></li><li>Review Status: '+esc(r.reviewStatus || r.note || 'Matches current Band Intake values ✓')+'</li></ul>';
  }

  function updateStats(data){
    var total = data.total || 0;
    var matched = data.matched || 0;
    var returned = currentRows.length || data.returned || (data.results ? data.results.length : 0);
    text('truthDataMode', data.filterMode || 'supabase-band-aware-page');
    text('truthLastScan', data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '—');
    text('truthUniverse', (data.universeCount || '—') + ' symbols');
    text('truthBuild', data.building ? 'Building — rows available' : (data.noScan ? 'Not started' : 'Ready'));
    text('scanMode', data.building ? 'Building — Supabase rows shown' : (data.noScan ? 'Starting Supabase scan' : 'Supabase board ready'));
    text('universeCount', data.universeCount || data.scanned || '—');
    text('pulledCount', data.scanned || '—');
    text('condorCount', data.withCondor || total || '—');
    text('activeMatches', matched.toLocaleString());
    text('candidateCount', returned.toLocaleString());
  }

  function showStatus(data){
    var progress = data.progress || {};
    var buildText = data.building ? ' Dataset still building' + (progress.scanned && progress.total ? ': ' + progress.scanned + ' of ' + progress.total + ' symbols scanned.' : '.') : ' Dataset ready.';
    if(data.noScan){
      html('explanation','No Supabase scan exists yet. Starting the first preview scan now.');
      msgOut('Starting Supabase scan.', 'warn');
      return;
    }
    if((data.returned || 0) > 0){
      html('explanation','Loaded <strong>'+(currentRows.length||data.returned||0).toLocaleString()+'</strong> displayed rows from <strong>'+(data.matched||0).toLocaleString()+'</strong> candidates matching the current Band Intake values. Use <strong>Scan Next 50</strong> to pull the next page. '+buildText);
      msgOut('Supabase rows loaded. '+(currentRows.length||data.returned||0)+' displayed; '+(data.matched||0)+' matched.', 'ok');
      return;
    }
    if((data.total || 0) > 0 || data.building){
      html('explanation','Supabase scan is available, but <strong>no rows match</strong> the current Band Intake values yet. Widen ROC, IV, bid/ask, earnings, OI, EM Status, IV Status, or width filters. '+buildText);
      msgOut('Supabase board available, but no rows match current Band Intake values.', 'warn');
      return;
    }
    html('explanation','Waiting for Supabase-backed scanner rows.');
    msgOut('Waiting for Supabase-backed scanner rows.', 'warn');
  }

  function setupNextButton(){
    var b=el('loadNextBtn');
    var anchor=el('rescanBtn') || document.querySelector('.actions .btn') || document.querySelector('button');
    if(!b){ b=document.createElement('button'); b.id='loadNextBtn'; b.className='btn secondary'; if(anchor) anchor.insertAdjacentElement('afterend', b); }
    if(!b) return;
    var has = nextOffset !== null && nextOffset !== undefined;
    var building = !!(lastScanData && lastScanData.building);
    b.style.display='inline-block';
    if(has){
      b.disabled=false;
      b.textContent='Scan Next ' + LIMIT;
      b.onclick=function(){ appendNextRows(); };
    } else if(building){
      b.disabled=true;
      b.textContent='Records Still Loading';
      b.onclick=null;
    } else {
      b.disabled=true;
      b.textContent='All Records Loaded';
      b.onclick=null;
    }
  }

  async function loadBoard(append, offset){
    hideExtraControls(); injectUiFixes();
    var data = await getJson(RESULTS_ENDPOINT + '?' + readBandParams(offset || 0).toString(), 25000);
    if(data.noScan){ await postScan('start'); }
    renderRows(data.results || [], !!append);
    nextOffset = data.nextOffset;
    lastScanData = data;
    updateStats(data);
    showStatus(data);
    setupNextButton();
    return data;
  }

  async function appendNextRows(){
    if(nextOffset === null || nextOffset === undefined) return;
    var b=el('loadNextBtn'); if(b){ b.disabled=true; b.textContent='Scanning Next ' + LIMIT + '…'; }
    try{ await loadBoard(true, nextOffset); }
    catch(e){ console.warn(e); msgOut('Unable to scan next 50 records from Supabase.', 'warn'); setupNextButton(); }
  }

  function valueForSort(r, key){
    if(key==='symbol') return String(r.symbol||'');
    if(key==='sector') return String(r.sector||r.market||'');
    if(key==='dte') return Number(r.dte||0);
    if(key==='iv') return Number(r.iv||0);
    if(key==='em') return String(r.expectedMoveStatus||'');
    if(key==='oi') return Number(r.openInterest||0);
    if(key==='prob') return Number(r.prob||0);
    if(key==='credit') return Number(r.credit||0);
    if(key==='risk') return Number(r.maxRisk||r.risk||0);
    if(key==='roc') return Number(r.roc||0);
    if(key==='spread') return Number(r.spreadMax||0);
    return Number(r.score||0);
  }

  function bindHeaderSort(){
    var heads=document.querySelectorAll('th');
    Array.prototype.forEach.call(heads,function(th,idx){
      th.onclick=function(){
        if(!currentRows.length) return;
        var keys=['rank','symbol','sector','spot','dte','earnings','iv','move','em','ivstatus','oi','prob','credit','risk','roc','spread','review'];
        var key=keys[idx] || 'score';
        sortState.dir = sortState.key === key ? -sortState.dir : 1;
        sortState.key = key;
        currentRows.sort(function(a,b){
          var av=valueForSort(a,key), bv=valueForSort(b,key);
          if(typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * sortState.dir;
          return ((av||0)-(bv||0)) * sortState.dir;
        });
        renderRows(currentRows, false);
      };
    });
  }

  function bindBandChanges(){
    var ids=['idxSel','rocMin','rocMax','spreadWidth','minProb','ivMin','ivStatusSel','minOI','minShortOI','maxSpread','dteWindow','excludeEarnings','emStatusSel','rankBy','maxResults'];
    ids.forEach(function(id){
      var x=el(id); if(!x) return;
      x.addEventListener('change', function(){
        clearTimeout(filterDebounce);
        filterDebounce=setTimeout(function(){ currentRows=[]; nextOffset=null; loadBoard(false,0).catch(console.warn); }, 350);
      });
      if(x.tagName === 'INPUT') x.addEventListener('input', function(){
        clearTimeout(filterDebounce);
        filterDebounce=setTimeout(function(){ currentRows=[]; nextOffset=null; loadBoard(false,0).catch(console.warn); }, 650);
      });
    });
  }

  async function boot(){
    injectUiFixes(); hideExtraControls(); ensureIvAll(); setupNextButton(); bindHeaderSort(); bindBandChanges();
    html('explanation','Loading the first 50 scanner rows from Supabase using the default Band Intake values.');
    try{ await loadBoard(false,0); }
    catch(e){
      console.warn(e);
      html('explanation','Supabase read endpoint is not ready yet. Starting the Supabase scan controller.');
      await postScan('start');
    }
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 500);
})();
