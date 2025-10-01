let storedHostToken = null;

function bootstrapStoredHostToken() {
  let token = null;
  try {
    token = localStorage.getItem('hostToken');
  } catch (_) {}
  if (token) setStoredHostToken(token);
}

function setStoredHostToken(token) {
  storedHostToken = token || null;
  try {
    if (storedHostToken) {
      localStorage.setItem('hostToken', storedHostToken);
    } else {
      localStorage.removeItem('hostToken');
    }
  } catch (_) {}
  socket.auth = socket.auth || {};
  if (storedHostToken) {
    socket.auth.hostToken = storedHostToken;
  } else if (socket?.auth && 'hostToken' in socket.auth) {
    delete socket.auth.hostToken;
  }
}

function getHostToken() {
  if (socket?.auth?.hostToken) return socket.auth.hostToken;
  return storedHostToken;
}

function ensureClientId() {
  let id = null;
  try {
    id = localStorage.getItem('clientId');
    if (!id) {
      const gen = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      id = gen;
      localStorage.setItem('clientId', id);
    }
  } catch (_) {}
  return id;
}

const socket = io({ autoConnect: false });
socket.auth = socket.auth || {};

const clientId = ensureClientId();
if (clientId) socket.auth.clientId = clientId;

bootstrapStoredHostToken();
socket.connect();

let registered = false;
let youAreHost = false;
let lastPlayerName = null;

// Tentativo di resume sessione da localStorage
(function tryResume(){
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('teamSession') || 'null'); } catch(_){}
  if (!saved?.teamId || !saved?.key) return; // niente da fare

  socket.emit('team:resume', { teamId: saved.teamId, key: saved.key }, (res)=>{
    if (res?.ok) {
      try { localStorage.setItem('teamSession', JSON.stringify({ teamId: res.teamId, key: res.key })); } catch(_){}
       const myCsv = `/api/export/team/${res.teamId}.csv`;
       const a = $('btnExportMy'); if (a) a.href = myCsv;
      registered = true;
      $('screenLogin').classList.add('hidden');
      $('screenMain').classList.remove('hidden');
      notify(`Bentornato, ${res.name}`, 'success');
    } else {
      // token non valido o team sparito: pulisci e resta in login
      try { localStorage.removeItem('teamSession'); } catch(_){}
      if (res?.error) console.warn('Resume fallito:', res.error);
    }
  });
})();

const initialHostToken = getHostToken();
if (initialHostToken) {
  socket.emit('host:reclaim', { token: initialHostToken }, (res)=>{
    if(res?.ok) {
      notify('Ruolo banditore ripristinato','info');
      youAreHost = true;
      __hostView = 'controls';
      if (window.__last_state) {
        applyHostPanels(window.__last_state);
        applyRollMsUI(window.__last_state);
        syncSearchVisibility(window.__last_state);
      } else {
        applyHostPanels({ youAreHost: true });
      }
    } else {
      notify(res?.error || 'Impossibile ripristinare il ruolo banditore', 'error');
    }
  });
}


(function prefillFromQuery(){
  try {
    const q = new URLSearchParams(location.search);
    const t = (q.get('team') || '').trim();
    if (t) {
      $('regName').value = t;
      $('screenLogin').classList.remove('hidden');
      $('screenMain').classList.add('hidden');
    }
  } catch(_){}
})();



function $(id){ return document.getElementById(id); }

const toastBackgrounds = {
  success: 'var(--toast-success)',
  error: 'var(--toast-error)',
  info: 'var(--toast-info)'
};

function notify(text, type = 'info') {
  const key = toastBackgrounds[type] ? type : 'info';
  Toastify({
    text,
    duration: 2400,
    gravity: 'top',
    position: 'center',
    className: `toast-theme toast-${key}`,
    style: { background: toastBackgrounds[key] }
  }).showToast();
}

function updateRollToggleUI(isRolling) {
  const btn = $('btnRollToggle');
  if (!btn) return;
  const stateEl = btn.querySelector('.roll-state');
  btn.classList.toggle('is-rolling', !!isRolling);
  if (stateEl) stateEl.textContent = isRolling ? 'Pausa' : 'Play';
  btn.setAttribute('aria-pressed', isRolling ? 'true' : 'false');
}

const countdownClasses = ['countdown-idle', 'countdown-safe', 'countdown-warning', 'countdown-danger'];

function updateCountdownUI(phase, countdownSec) {
  const el = $('countdown');
  if (!el) return;

  const safeNumber = (value) => {
    const num = typeof value === 'number' ? value : Number.parseInt(value, 10);
    return Number.isFinite(num) ? num : null;
  };

  let display = '—';
  let state = 'countdown-idle';

  if (phase === 'COUNTDOWN') {
    display = countdownSec ?? '—';
    const sec = safeNumber(countdownSec);
    if (sec !== null) {
      if (sec >= 3) state = 'countdown-safe';
      else if (sec === 2) state = 'countdown-warning';
      else state = 'countdown-danger';
    }
  } else if (phase === 'ARMED') {
    display = '3';
    state = 'countdown-safe';
  }

  el.textContent = display;
  el.classList.remove(...countdownClasses);
  if (state) el.classList.add(state);
}

function renderEmptyState(listEl, message) {
  if (!listEl) return;
  const li = document.createElement('li');
  li.classList.add('empty-state');
  li.textContent = message;
  listEl.appendChild(li);
}

/* ===== RENDER LATO PARTECIPANTI ===== */
function renderParticipantsManage(s){
  const ul = $('manageList');
  if (!ul) return;
  ul.innerHTML = '';
  const total = s.participants.length;
  const countEl = $('participantsCount');
  if (countEl) {
    countEl.textContent = total;
    countEl.setAttribute('aria-label', `Totale partecipanti: ${total}`);
  }
  if (!total) {
    renderEmptyState(ul, 'Nessun partecipante registrato al momento.');
    return;
  }
  for (const p of s.participants){
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="delete-manager">
        <span class="fs-5">${p.name}</span>
      </div>
      <div class="list-actions">
        ${youAreHost ? `<button class="btn btn-outline btn-kick" data-id="${p.id}"><i class="bi bi-x-octagon fw-bold fs-3"></i></button>` : ''}
        <strong class="fs-5">${p.credits}</strong>
      </div>`;
    ul.appendChild(li);
  }
  if (youAreHost){
    ul.querySelectorAll('.btn-kick').forEach((b)=>{
      b.onclick = () => {
        const id = b.dataset.id;
        socket.emit('host:kick', { teamId: id }, (res)=>{
          if(res?.error) notify(res.error, 'error');
          else notify('Partecipante rimosso', 'success');
        });
      };
    });
  }
}

function renderHistory(s){
  const ul = $('historyList');
  if (!ul) return;
  ul.innerHTML = '';
  const list = s.recentAssignments || [];
  const total = list.length;
  const countEl = $('historyCount');
  if (countEl) {
    countEl.textContent = total;
    countEl.setAttribute('aria-label', `Totale aggiudicazioni registrate: ${total}`);
  }
  if (!total) {
    renderEmptyState(ul, 'Nessuna aggiudicazione registrata.');
    return;
  }
  for (const h of list.slice().reverse()){ // più recenti in alto
    const li = document.createElement('li');
    const when = new Date(h.at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    li.innerHTML = `
      <div>
        <span>${h.playerName || '—'} <small>(${h.role || '—'})</small>
          <span class="meta">a ${h.teamName} per ${h.price} • ${when}</span>
        </span>
      </div>
      <div class="list-actions">
        ${youAreHost ? `<button class="btn btn-outline btn-undo" data-id="${h.id}">Elimina</button>` : ''}
      </div>`;
    ul.appendChild(li);
  }
  if (youAreHost){
    ul.querySelectorAll('.btn-undo').forEach((b)=>{
      b.onclick = () => {
        const id = b.dataset.id;
        if (!confirm('Confermi l’eliminazione di questa aggiudicazione?')) return;
        socket.emit('host:undoPurchase', { historyId: id }, (res)=>{
          if(res?.error) notify(res.error, 'error');
          else notify('Aggiudicazione eliminata', 'success');
        });
      };
    });
  }
}

function renderAcquisitions(list){
  const ul = $('acqList');
  if (!ul) return;
  ul.innerHTML='';
  const items = Array.isArray(list) ? list : [];
  const total = items.length;
  const countEl = $('acqCount');
  if (countEl) {
    countEl.textContent = total;
    countEl.setAttribute('aria-label', `Totale acquisti: ${total}`);
  }
  if (!total) {
    renderEmptyState(ul, 'Non hai ancora effettuato acquisti.');
    return;
  }
  for (const a of items){
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <span>${a.player} <small>(${a.role})</small></span>
      </div>
      <strong>${a.price}</strong>`;
    ul.appendChild(li);
  }
}

/* ===== SLOT ANIMATO ===== */
let animating = false;
function drawSlotWindow(current, prev, next){
  const inner = $('slotInner');

  const row = (p, cls) => {
    if (!p) return `<div class="slot-item ${cls} is-empty">—</div>`;
    const team = p.team ? `<span class="meta">${p.team}</span>` : '';
    const fm = Number.isFinite(p.fm) ? `<span class="meta">FM ${p.fm.toFixed(2)}</span>` : '';
    return `
      <div class="slot-item ${cls}">
        <div class="line main">
          <span class="name">${p.name}</span>
          ${p.role ? `<span class="role">${p.role}</span>` : ''}
        </div>
        <div class="line sub">${team}${team && fm ? ' • ' : ''}${fm}</div>
      </div>`;
  };

  // prima render senza animazione
  if (!inner.dataset.ready){
    inner.innerHTML = `
      <div class="slot-stack">
        ${row(prev, 'prev')}
        ${row(current, 'current')}
        ${row(next, 'next')}
      </div>`;
    inner.dataset.ready = '1';
    return;
  }

  if (animating) return;
  animating = true;

  // animazione leggerissima
  const stack = document.createElement('div');
  stack.className = 'slot-stack anim';
  stack.innerHTML = `
    ${row(prev, 'prev')}
    ${row(current, 'current')}
    ${row(next, 'next')}
  `;
  inner.innerHTML = '';
  inner.appendChild(stack);

  requestAnimationFrame(()=> stack.classList.add('in'));
  setTimeout(()=>{ animating = false; }, 380);
}



function resetSummaryUI(){
  $('sumBid').textContent = 0;
  $('sumLeader').textContent = '—';
  updateCountdownUI('IDLE');
}

function applyRollMsUI(s){
  const sel  = $('hostRollMs');
  const box  = $('rollControls');
  if (!sel || !box) return;

  const canShow = s.youAreHost;
  box.style.display = canShow ? '' : 'none';

  // sync valore dal server
  if (s.rollMs && String(sel.value) !== String(s.rollMs)) {
    sel.value = String(s.rollMs);
  }
   window.dispatchEvent(new Event('navbar:recheck'));
}

function applyHostPanels(s){
  if (!s.youAreHost && __hostView !== 'summary') {
    __hostView = 'summary';
  }

  const isControlsView = s.youAreHost && __hostView === 'controls';

  if (cardCtrl) cardCtrl.style.display = isControlsView ? '' : 'none';
  if (cardImport) cardImport.style.display = isControlsView ? '' : 'none';
  if (cardParticipants) cardParticipants.style.display = '';
  if (cardHistory) cardHistory.style.display = '';

  const sw = $('hostViewSwitch');
  if (sw) sw.style.display = s.youAreHost ? '' : 'none';

  const wrap = $('mainWrap');
  if (wrap) wrap.dataset.hostView = isControlsView ? 'controls' : 'summary';

  const btnSummary = $('btnHostViewSummary');
  const btnControls = $('btnHostViewControls');
  if (btnSummary) btnSummary.classList.toggle('active', __hostView === 'summary' || !s.youAreHost);
  if (btnControls) {
    btnControls.classList.toggle('active', isControlsView);
    btnControls.disabled = !s.youAreHost;
  }
   window.dispatchEvent(new Event('navbar:recheck'));
}

/* ===== APPLY STATE ===== */
function applyState(s){
  window.__last_state = s;

  youAreHost = !!s.youAreHost;
  $('hostStatus').textContent = youAreHost ? 'Banditore' : 'Partecipante';

  const hostLockedByOther = s.hostLockedBy && !youAreHost;
  $('btnHostToggle').disabled = hostLockedByOther;
  $('btnHostToggle').classList.toggle('active-host', youAreHost);
  $('btnHostToggle').title = hostLockedByOther ? 'Banditore già assegnato' : '';

  const duringAuction = ['RUNNING','ARMED','COUNTDOWN'].includes(s.phase);
  $('btnRollToggle').disabled = !youAreHost || duringAuction;
  updateRollToggleUI(!!s.rolling);

  const filtersLockedMsg = 'Puoi cambiare filtri solo quando l’asta è ferma o dopo l’assegnazione.';
  const searchInput = $('searchPlayer');
  if (searchInput) {
    searchInput.disabled = duringAuction;
    searchInput.title = duringAuction ? filtersLockedMsg : '';
  }
  document.querySelectorAll('.rolebar .role').forEach((btn) => {
    btn.disabled = duringAuction;
    btn.title = duringAuction ? filtersLockedMsg : '';
  });
  const btnRandom = $('btnRandom');
  if (btnRandom) {
    btnRandom.disabled = duringAuction;
    btnRandom.title = duringAuction ? filtersLockedMsg : '';
  }

  // Slot
  drawSlotWindow(s.currentPlayer, s.prevPlayer, s.nextPlayer);

  // Riepilogo
  $('sumBid').textContent = s.topBid;
  $('sumLeader').textContent = s.leaderName || '—';
  $('sumCredits').textContent = s.youCredits ?? '—';
  updateCountdownUI(s.phase, s.countdownSec);

  renderParticipantsManage(s);
  renderHistory(s);
  renderAcquisitions(s.acquisitions || []);
  applyHostPanels(s);
  applyRollMsUI(s);
  syncSearchVisibility(s);



  // SOLD → auto-assign client-side (banditore o vincitore)
  window.__soldHandled = window.__soldHandled || false;
  if (s.phase === 'SOLD') {
    const canHandle = (s.youAreHost || s.youState === 'LEADING');
    if (canHandle && !window.__soldHandled) {
      window.__soldHandled = true;
      socket.emit('winner:autoAssign', {}, (res)=>{
        if (res?.error) {
          const alreadyAssigned = (Array.isArray(s.acquisitions) && s.acquisitions.length > 0);
          if (alreadyAssigned) notify('Giocatore assegnato', 'success');
          else notify(res.error, 'error');
        } else {
          notify('Giocatore assegnato', 'success');
          resetSummaryUI();
        }
      });
    }
  } else {
    window.__soldHandled = false;
  }

  // Abilitazione offerte
  const bidsBox = $('bidsBox');
  const canBid = (s.phase === 'ROLLING' && s.rolling) || ['RUNNING','ARMED','COUNTDOWN'].includes(s.phase);
  for (const b of document.querySelectorAll('.btn.inc')) b.disabled = !canBid;
  $('freeBid').disabled = !canBid;
  $('btnFreeBid').disabled = !canBid;
  bidsBox.classList.toggle('disabled', !canBid);
}

/* ===== Socket ===== */
socket.on('state', applyState);

/* ===== Login ===== */
$('btnEnter').onclick = () => {
  const name = $('regName').value.trim();
  const credits = Number($('regCredits').value || 0);
  if (!name) { notify('Inserisci nome squadra', 'error'); return; }

  socket.emit('team:register', { name, credits }, (res)=>{
    if(res?.error){ notify(res.error, 'error'); return; }

    // SALVA QUI la sessione per il resume
      try { localStorage.setItem('teamSession', JSON.stringify({ teamId: res.teamId, key: res.key })); } catch(_){}
      const myCsv = `/api/export/team/${res.teamId}.csv`;
      const a = $('btnExportMy'); if (a) a.href = myCsv;
    registered = true;
    $('screenLogin').classList.add('hidden');
    $('screenMain').classList.remove('hidden');

    if ($('regHost').checked) {
      socket.emit('host:toggle', {}, (r)=>{ if(r?.error) notify(r.error, 'error'); });
    }
    notify('Sei dentro. Buona asta.', 'success');
  });
};


/* ===== Host controls ===== */
$('btnHostToggle').onclick = () => {
  const payload = {};
  if (!document.body.dataset.hostPinAsked) {
    const pin = prompt('PIN banditore (se configurato):') || '';
    payload.pin = pin;
  }
  socket.emit('host:toggle', payload, (res)=>{
    if(res?.error) {
      delete document.body.dataset.hostPinAsked;
      return notify(res.error, 'error');
    }
    if (res.host && res.hostToken) {
      document.body.dataset.hostPinAsked = '1';
      setStoredHostToken(res.hostToken);
      notify('Hai preso il ruolo di banditore', 'info');
    } else if (!res.host) {
      delete document.body.dataset.hostPinAsked;
      setStoredHostToken(null);
      notify('Hai lasciato il ruolo', 'info');
    }
  });
};


/* Velocità rullo: select hostRollMs */
const rollSel = $('hostRollMs');
if (rollSel) {
  rollSel.onchange = () => {
    const ms = Number(rollSel.value);
    socket.emit('host:setRollMs', { ms }, (res) => {
      if (res?.error) return notify(res.error, 'error');
      notify(`Rullo impostato a ${res.rollMs} ms`, 'info');
      // niente timer client: è server-driven. Ci basta notificare.
    });
  };
}


$('btnRollToggle')?.addEventListener('click', () => {
  socket.emit('host:toggleRoll', {}, (res)=> {
    if(res?.error) return notify(res.error, 'error');
    updateRollToggleUI(!!res.rolling);
    notify(res.rolling ? 'Rullo in riproduzione' : 'Rullo in pausa', 'info');
  });
});



/* Filtri ruolo toggle */
document.querySelectorAll('.rolebar .role').forEach(b => {
  b.onclick = () => {
    const role = b.dataset.role;
    const isActive = b.classList.contains('active');
    const target = isActive ? 'ALL' : role;

    // aggiorna visivamente
    document.querySelectorAll('.rolebar .role').forEach(x => x.classList.remove('active'));
    if (target !== 'ALL') b.classList.add('active');

    // manda al server
    socket.emit('host:setRoleFilter', { role: target }, (res)=>{
      if(res?.error) notify(res.error, 'error');
      else {
        if (target === 'ALL') notify('Filtro rimosso (tutti i ruoli)', 'info');
        else notify(`Filtro attivo: ${target}`, 'info');
      }
    });

    // fermo il rullo quando cambio filtro
    socket.emit('host:stopRoll', {}, ()=>{});
  };
});


$('btnRandom').onclick = () => {
  socket.emit('host:randomStart', {}, (res)=>{
    if(res?.error) notify(res.error, 'error');
    else { lastPlayerName = null; notify(`Lettera di partenza: ${res.letter}`, 'info'); }
  });
};

/* ===== Offerte ===== */
for (const b of document.querySelectorAll('.btn.inc')){
  b.onclick = () => {
    b.classList.add('pressed');
    setTimeout(()=> b.classList.remove('pressed'), 120);
    const inc = Number(b.dataset.inc);
    socket.emit('team:bid_inc', { amount: inc }, (res)=>{
      if(res?.error) return notify(res.error, 'error');
      if(res?.warn)  notify(res.warn, 'info');
    });
    try{ navigator.vibrate?.(12); }catch(_){}
  };
}

$('btnFreeBid').onclick = ()=>{
  const el = $('freeBid');
  const val = Number(el.value || 0);
  socket.emit('team:bid_free', { value: val }, (res)=>{
    if(res?.error) return notify(res.error, 'error');
    if(res?.warn)  notify(res.warn, 'info');
    el.value = '';      // reset
    el.blur?.();        // togli focus
  });
  try{ navigator.vibrate?.([10,40,10]); }catch(_){}
};


/* ===== Import XLSX/CSV dal browser ===== */
const btnImport = $('btnImportFile');
const fileInput = $('fileImport');

btnImport.onclick = () => fileInput.click();

fileInput.onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    let csvText = '';

    if (file.name.toLowerCase().endsWith('.csv')) {
      // CSV diretto
      csvText = await file.text();
        } else {
      // XLSX -> JSON -> normalizza -> CSV con alias header robusti
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type:'array' });

      // Definizione alias header
      const HDR = {
        name: [/^nome$/i],
        role: [/^r\.?$|^ruolo$/i],
        team: [/^sq\.?$|^squadra$/i],
        fm:   [/^fm$|^fantamedia$/i],
        out:  [/^fuori\s*lista$|^fuorilista$/i],
      };
      const matchHeaderIndex = (headerArr, rxArr) => {
        const idx = headerArr.findIndex(h => rxArr.some(rx => rx.test(h)));
        return idx >= 0 ? idx : null;
      };

      // trova il primo foglio che abbia "nome" e "ruolo/r."
      let sheet = null, headerRow = 0, header = null, idx = null;
      for (const name of wb.SheetNames){
        const ws = wb.Sheets[name];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
        if (!aoa || !aoa.length) continue;
        for (let r=0;r<Math.min(10, aoa.length); r++){
          const row = (aoa[r]||[]).map(x=>String(x||'').trim());
          const iName = matchHeaderIndex(row, HDR.name);
          const iRole = matchHeaderIndex(row, HDR.role);
          if (iName != null && iRole != null) {
            sheet = ws; headerRow = r; header = row;
            idx = {
              name: matchHeaderIndex(header, HDR.name),
              role: matchHeaderIndex(header, HDR.role),
              team: matchHeaderIndex(header, HDR.team),
              fm:   matchHeaderIndex(header, HDR.fm),
              out:  matchHeaderIndex(header, HDR.out),
            };
            break;
          }
        }
        if (sheet) break;
      }
      if (!sheet) throw new Error('Intestazioni mancanti: servono almeno Nome e Ruolo/R.');

      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
      const pick = (arr, key) => {
        const i = idx[key];
        return i != null ? arr[i] : '';
      };

      // costruisci righe normalizzate
      const normRows = [];
      for (let r = headerRow + 1; r < rows.length; r++){
        const arr = rows[r] || [];
        const fuori = String(pick(arr, 'out') || '');
        if (fuori.includes('*')) continue;

        const nome = String(pick(arr,'name') || '').trim();
        if (!nome) continue;

        const ruoloRaw = pick(arr,'role');
        const ruolo = normalizeRole(ruoloRaw);
        if (!['P','D','C','A'].includes(ruolo)) continue;

        const squadra = String(pick(arr,'team') || '').trim();
        const fm = numIT(pick(arr,'fm'));

        normRows.push({ Nome:nome, Squadra:squadra, Ruolo:ruolo, FM:fm });
      }

      // CSV con header fissi
      const headerOut = ['Nome','Squadra','Ruolo','FM','Fuori lista'];
      const lines = [headerOut.join(';')];
      for (const r of normRows){
        const vals = [
          r.Nome,
          r.Squadra,
          r.Ruolo,
          r.FM === '' ? '' : String(r.FM).replace('.', ','),
          ''
        ].map(v => {
          const s = String(v ?? '');
          return /[;"\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
        });
        lines.push(vals.join(';'));
      }
      csvText = lines.join('\n');
    }

    // POST al backend
    const headers = { 'Content-Type':'application/json' };
    const hostToken = getHostToken();
    if (hostToken) headers['x-host-token'] = hostToken;
    const res = await fetch('/api/listone/import', {
      method:'POST',
      headers,
      body: JSON.stringify({
        csv: csvText,
        map: { name:'Nome', role:'Ruolo', team:'Squadra', fm:'FM', out:'Fuori lista' }
      })
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'Errore import');

    // <<< Preview validi/scartati >>>
    notify(`Importati ${j.imported} • Scartati ${j.rejected}`, 'success');

  } catch (err) {
    console.error(err);
    notify(err.message || 'Errore import', 'error');
  } finally {
    e.target.value = '';
  }
};

$('btnHostSkip').onclick = () =>
  socket.emit('host:skip', {}, (res)=> res?.error ? notify(res.error,'error') : notify('Avanti di uno','info'));

$('btnHostBackN').onclick = () => {
  const n = Number(prompt('Quanti indietro?', '1') || '1');
  socket.emit('host:backN', { n }, (res)=> res?.error ? notify(res.error,'error') : notify(`Indietro di ${n}`,'info'));
};

/* ===== Utils per import lato client ===== */
function normalizeRole(v){
  const s = String(v||'').trim().toUpperCase();
  if (!s) return '';
  if (['P','POR','PORTIERE','GK'].includes(s)) return 'P';
  if (['D','DIF','DIFENSORE','DEF'].includes(s)) return 'D';
  if (['C','CEN','CENTROCAMPISTA','MID'].includes(s)) return 'C';
  if (['A','ATT','ATTACCANTE','FW'].includes(s)) return 'A';
  return s[0];
}
function numIT(v){
  if (v==null || v==='') return '';
  const n = Number(String(v).replace(',', '.').replace(/\s/g,''));
  return Number.isFinite(n) ? n : '';
}

$('searchPlayer')?.addEventListener('input', (e)=>{
  const q = e.target.value || '';
  socket.emit('host:setFilterName', { q }, (res)=>{
    if(res?.error) notify(res.error,'error');
  });
});

// Solo host vede l’input
function syncSearchVisibility(s){
  const el = $('searchPlayer');
  if (!el) return;
  const canShow = s.youAreHost && __hostView === 'controls';
  el.style.display = canShow ? '' : 'none';
}


function logoutLocal(){
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('teamSession') || 'null'); } catch(_){}

  // se non c’è sessione salvata, fai solo cleanup
  if (!saved?.teamId || !saved?.key) {
    try { localStorage.removeItem('teamSession'); } catch(_){}
    location.reload();
    return;
  }

  // prova a dire al server di rimuovere il team
  socket.emit('team:leave', {}, (res) => {
    if (res?.ok) {
      try { localStorage.removeItem('teamSession'); } catch(_){}
      location.reload();
    } else {
      notify(res?.error || 'Impossibile uscire ora', 'error');
      // se vuoi forzare solo logout locale senza rimuovere il team, sblocca qui:
      // try { localStorage.removeItem('teamSession'); } catch(_){}
      // location.reload();
    }
  });
}

$('btnHostExitAndClose').addEventListener('click', () => {
  if (!confirm('Confermi? Verranno rimossi partecipanti e aggiudicazioni.')) return;
  socket.emit('host:exitAndClose', {}, (res) => {
    if (res?.error) return notify(res.error, 'error');
    setStoredHostToken(null);
    notify('Asta chiusa. Sessione azzerata.', 'info');
    location.reload(); // <<< meglio forzare reset
  });
});



document.addEventListener("DOMContentLoaded", () => {
  const btn =  $('btnLogout');
  if (btn) {
     btn.onclick = logoutLocal;
  }
})

socket.on('you:kicked', ()=>{
  try {
    localStorage.removeItem('teamSession');
  } catch(_){}
  setStoredHostToken(null);
  location.href = '/';
});


const vAside = document.querySelector('aside.col-left');
const cardCtrl = $('ctrlCard');
const cardImport = $('importCard');
const cardParticipants = $('participantsCard');
const cardHistory = $('historyCard');

let __hostView = 'summary'; // 'summary' | 'controls'


function applyHostViewSwitch(s){
  const sw = $('hostViewSwitch');
  if (sw) sw.style.display = s.youAreHost ? '' : 'none';
}

$('btnHostViewSummary')?.addEventListener('click', ()=>{
  __hostView = 'summary';
  if (window.__last_state) {
    applyHostPanels(window.__last_state);
    applyRollMsUI(window.__last_state);
    syncSearchVisibility(window.__last_state);
  }
});

$('btnHostViewControls')?.addEventListener('click', ()=>{
  __hostView = 'controls';
  if (window.__last_state) {
    applyHostPanels(window.__last_state);
    applyRollMsUI(window.__last_state);
    syncSearchVisibility(window.__last_state);
  }
});

(function setupNavbarFade() {
  const navbar = document.querySelector('.topbar');
  if (!navbar) return;

  let isHidden = false;
  let ticking = false;
  let debounceTimer = null;
  let recheckTimer = null;
  const HIDE_THRESHOLD = 30; // Nascondi quando più vicino di 30px
  const SHOW_THRESHOLD = 150; // Mostra quando più lontano di 150px

  // Determina il punto di trigger in base al ruolo
  function getTriggerElement() {
    // Usa sempre historyCard che è più in alto
    return document.getElementById('historyCard');
  }

  function updateNavbar() {
    const triggerElement = getTriggerElement();
    
    if (!triggerElement) {
      if (isHidden) {
        navbar.classList.remove('hidden');
        isHidden = false;
      }
      ticking = false;
      return;
    }

    const navbarRect = navbar.getBoundingClientRect();
    const triggerRect = triggerElement.getBoundingClientRect();

    const navbarBottom = navbarRect.bottom;
    const triggerTop = triggerRect.top;

    // Distanza tra navbar bottom e trigger top
    const distance = triggerTop - navbarBottom;

    // Isteresi molto ampia con debounce
    if (distance < HIDE_THRESHOLD && !isHidden) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        navbar.classList.add('hidden');
        isHidden = true;
      }, 100);
    } else if (distance > SHOW_THRESHOLD && isHidden) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        navbar.classList.remove('hidden');
        isHidden = false;
      }, 100);
    }

    ticking = false;
  }

  function requestTick() {
    if (!ticking) {
      window.requestAnimationFrame(updateNavbar);
      ticking = true;
    }
  }

  // Event listener per scroll
  window.addEventListener('scroll', requestTick, { passive: true });

  // Re-check quando cambia lo stato (es. diventi banditore)
  window.addEventListener('navbar:recheck', () => {
    // Non forzare la visibilità: durante i piccoli assestamenti di layout (es. rullo)
    // la distanza reale potrebbe non essere cambiata abbastanza da richiedere il
    // toggle. Limitandoci a programmare un nuovo calcolo evitiamo che la navbar
    // venga mostrata per poi essere subito nascosta, eliminando il lampeggio.
    clearTimeout(debounceTimer);
    if (recheckTimer) {
      clearTimeout(recheckTimer);
    }
    recheckTimer = setTimeout(() => {
      ticking = false;
      requestTick();
      recheckTimer = null;
    }, 100);
  });

  // Check iniziale
  setTimeout(updateNavbar, 100);
})();