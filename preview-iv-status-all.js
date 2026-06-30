// Adds an All option to the IV Status dropdown on the scanner preview page.
(function(){
  function findIvStatusSelect(){
    var ids = ['ivStatus','ivStatusFilter','ivStatusSel','ivFilter'];
    for(var i=0;i<ids.length;i++){
      var x=document.getElementById(ids[i]);
      if(x && x.tagName === 'SELECT') return x;
    }
    var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
    for(var j=0;j<labels.length;j++){
      var text=(labels[j].textContent||'').toLowerCase();
      if(text.indexOf('iv status') !== -1){
        var s=labels[j].querySelector('select');
        if(s) return s;
      }
    }
    return null;
  }

  function ensureAllOption(){
    var select = findIvStatusSelect();
    if(!select) return;
    var hasAll = Array.prototype.some.call(select.options,function(o){ return String(o.value).toLowerCase() === 'all'; });
    if(!hasAll){
      var opt = document.createElement('option');
      opt.value = 'all';
      opt.textContent = 'All';
      select.insertBefore(opt, select.firstChild);
    }
    select.value = 'all';
    Array.prototype.forEach.call(select.options,function(o){ o.selected = String(o.value).toLowerCase() === 'all'; });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', ensureAllOption);
  } else {
    ensureAllOption();
  }
  setTimeout(ensureAllOption, 1000);
})();
