// POPPA'S preview timed rescan controller.
// Restores the original homepage scan UX: timed rescan, five-minute notice, polling, then render.
(function(){
  var LIMIT = 500;
  var pageOffset = 0;
  var nextOffset = null;
  var totalRows = 0;
  var pollTimer = null;

  function el(id){ return document.getElementById(id); }
  function say(text, kind){ if(typeof msg === 'function') msg(text, kind || 'warn'); else console.log(text); }
  function setText(id, text){ var x=el(id); if(x) x.textContent=text; }
  function setHTML(id, html){ var x=el(id); if(x) x.innerHTML=html; }
  function clock(sec){ var m=Math.floor(sec/60); var s=String(sec%60).padStart(2,'0'); return m + ':' + s; }

  function setNextButton(){
    var b = el('loadNextBtn');
    if(!b){
      var reset = el('resetBtn');
      if(reset){
        b = document.createElement('button');
        b.className = 'btn secondary';
        b.id = 'loadNextBtn';
        reset.insertAdjacentElement('afterend', b);
      }
    }
    if(!b) return;
    var has = nextOffset !== null && nextOffset !== undefined;
    b.disabled = !has;
    b.textContent = has ? 'Load Next 500 Records' : 'All Records Loaded';
    b.onclick = function(){ if(has){ pageOffset = nextOffset; loadLivePage(true); } };
  }

  async function loadLivePage(append){
    var url = '/.netlify/functions/scan-results-preview?limit=' + LIMIT + '&offset=' + pageOffset + '&_ts=' + Date.now();
    var res = await fetch(url, { cache:'no-store', headers:{ accept:'application/json' } });
    var data = await res.json();
    if(!data || !Array.isArray(data.results) || !data.results.length) throw new Error('No live rows returned');

    var incoming = data.results.map(map);
    if(append) allRows = allRows.concat(incoming); else allRows = incoming;
    totalRows = data.total || data.matched || allRows.length;
    nextOffset = (data.nextOffset !== undefined && data.nextOffset !== null) ? data.nextOffset : (data.hasMore ? pageOffset + LIMIT : null);

    setText('universeCount', data.universeCount || data.scanned || '—');
    setText('pulledCount', data.scanned || '—');
    setText('condorCount', data.withCondor || data.total || allRows.length);
    setText('activeMatches', allRows.length.toLocaleString());
    setText('truthDataMode', data.filterMode || 'Live preview slice');
    setText('truthLastScan', data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '—');
    setText('truthUniverse', (data.universeCount || '—') + ' symbols');
    setText('truthBuild', data.building ? 'Finalizing with live rows' : 'Ready');
    setText('scanMode', data.building ? 'Live board finalizing' : 'Live board ready');
    setHTML('explanation','Loaded <strong>' + allRows.length.toLocaleString() + '</strong> of <strong>' + totalRows.toLocaleString() + '</strong> live records before display filtering. ' + (data.userMessage || ''));

    setNextButton();
    if(typeof apply === 'function') apply();
    if(typeof showTicket === 'function' && typeof lastRows !== 'undefined' && lastRows.length) showTicket(0);
    say('Live board loaded. ' + allRows.length.toLocaleString() + ' of ' + totalRows.toLocaleString() + ' records available in the table.', 'ok');
    return data;
  }

  async function runLatest(){
    var run = el('runScanBtn');
    if(run) run.disabled = true;
    pageOffset = 0; nextOffset = null; allRows = []; setNextButton();
    say('Checking latest available live board…', 'warn');
    try { await loadLivePage(false); }
    catch(e){
      console.warn(e);
      say('Live board is not ready yet. Press Re-scan Live Data to start a timed scan. Typical scan time is about 5 minutes.', 'warn');
      setHTML('explanation','Live board is not ready yet. Use <strong>Re-scan Live Data</strong> to start a timed scan. Typical scan time is about 5 minutes.');
    }
    if(run) run.disabled = false;
  }

  async function startTimedRescan(){
    var b = el('rescanBtn');
    var run = el('runScanBtn');
    if(b){ b.disabled = true; b.textContent = 'Scanning… ~5 min'; }
    if(run) run.disabled = true;
    pageOffset = 0; nextOffset = null; allRows = []; setNextButton();
    say('Fresh scan in progress. Pulling delayed/EOD option chains. This can take approximately 5 minutes.', 'warn');
    setText('scanMode','Fresh scan running…');
    setHTML('explanation','⏳ <strong>Fresh scan in progress:</strong> pulling delayed/EOD option chains. This can take approximately 5 minutes.');
    var body = el('resultsBody');
    if(body) body.innerHTML = '<tr><td colspan="99" class="empty">Fresh scan in progress. Waiting for live scan board…</td></tr>';

    try { await fetch('/.netlify/functions/scan-build-background', { method:'POST' }); } catch(e){ console.warn(e); }

    var elapsed = 0;
    if(pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async function(){
      elapsed += 10;
      var t = clock(elapsed);
      if(b) b.textContent = 'Scanning… ' + t;
      setHTML('explanation','⏳ <strong>Fresh scan in progress:</strong> elapsed ' + t + '. Waiting for the live scan board. Typical scan time is about 5 minutes.');
      try {
        var status = await (await fetch('/.netlify/functions/force-eod-pull?status=1&_ts=' + Date.now(), { cache:'no-store' })).json();
        if(status && status.latestResults > 0){
          await loadLivePage(false);
          clearInterval(pollTimer); pollTimer = null;
          if(b){ b.disabled = false; b.textContent = '↻ Re-scan Live Data'; }
          if(run) run.disabled = false;
        }
      } catch(e){ console.warn('Still waiting for scan board', e); }

      if(elapsed >= 360){
        clearInterval(pollTimer); pollTimer = null;
        if(b){ b.disabled = false; b.textContent = '↻ Re-scan Live Data'; }
        if(run) run.disabled = false;
        say('Scan is still building. Please wait a little longer, then press Run Scanner Now or Re-scan Live Data again.', 'warn');
      }
    }, 10000);
  }

  function boot(){
    var rescan = el('rescanBtn');
    var run = el('runScanBtn');
    if(rescan) rescan.onclick = startTimedRescan;
    if(run){ run.disabled = false; run.onclick = runLatest; }
    setNextButton();
    setHTML('explanation','Press <strong>Run Scanner Now</strong> to check the latest cached board, or <strong>Re-scan Live Data</strong> to start a fresh timed scan. A fresh delayed/EOD scan can take approximately 5 minutes.');
    say('Ready. Press Run Scanner Now or Re-scan Live Data. Fresh scans can take approximately 5 minutes.', 'warn');
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 800);
})();
