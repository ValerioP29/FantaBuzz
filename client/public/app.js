/* global Toastify, XLSX */
const socket = io();
let registered = false;
let youAreHost = false;

// Tentativo di resume sessione da localStorage
(function tryResume(){
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('teamSession') || 'null'); } catch(_){}
  if (!saved?.teamId || !saved?.key) return; // niente da fare

  socket.emit('team:resume', { teamId: saved.teamId, key: saved.key }, (res)=>{
    if (res?.ok) {
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


function $(id){ return document.getElementById(id); }
const notify = (text, type='info') => {
  const bg = type === 'success' ? "linear-gradient(135deg,#22c55e,#16a34a)"
           : type === 'error'   ? "linear-gradient(135deg,#ef4444,#b91c1c)"
           : "linear-gradient(135deg,#7dd3fc,#38bdf8)";
  Toastify({ text, duration: 2400, gravity: "top", position: "right", backgroundColor: bg }).showToast();
};

/* ===== RENDER LATO PARTECIPANTI ===== */
function renderParticipantsManage(s){
  const ul = $('manageList'); ul.innerHTML = '';
  for (const p of s.participants){
    const li = document.createElement('li');
    li.innerHTML = `<span>${p.name}</span>
      <div>
        ${youAreHost ? `<button class="btn btn-outline btn-kick" data-id="${p.id}">Rimuovi</button>` : ''}
        <strong>${p.credits}</strong>
      </div>`;
    ul.appendChild(li);
  }
  if (youAreHost){
    for (const b of document.querySelectorAll('.btn-kick')){
      b.onclick = () => {
        const id = b.dataset.id;
        socket.emit('host:kick', { teamId: id }, (res)=>{
          if(res?.error) notify(res.error, 'error');
          else notify('Partecipante rimosso', 'success');
        });
      };
    }
  }
}

function renderHistory(s){
  const ul = $('historyList'); ul.innerHTML = '';
  const list = s.recentAssignments || [];
  for (const h of list.slice().reverse()){ // più recenti in alto
    const li = document.createElement('li');
    const when = new Date(h.at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    li.innerHTML = `
      <span>${h.playerName || '—'} <small>(${h.role || '—'})</small>
        <span class="meta">a ${h.teamName} per ${h.price} • ${when}</span>
      </span>
      <div>
        ${youAreHost ? `<button class="btn btn-outline btn-undo" data-id="${h.id}">Elimina</button>` : ''}
      </div>`;
    ul.appendChild(li);
  }
  if (youAreHost){
    for (const b of document.querySelectorAll('.btn-undo')){
      b.onclick = () => {
        const id = b.dataset.id;
        if (!confirm('Confermi l’eliminazione di questa aggiudicazione?')) return;
        socket.emit('host:undoPurchase', { historyId: id }, (res)=>{
          if(res?.error) notify(res.error, 'error');
          else notify('Aggiudicazione eliminata', 'success');
        });
      };
    }
  }
}

function renderAcquisitions(list){
  const ul = $('acqList'); ul.innerHTML='';
  for (const a of list){
    const li = document.createElement('li');
    li.innerHTML = `<span>${a.player} <small>(${a.role})</small></span><strong>${a.price}</strong>`;
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
  $('countdown').textContent = '—';
}

/* ===== APPLY STATE ===== */
function applyState(s){
  if (!registered) return;

  $('phaseBadge').textContent = s.phase || '—';
  youAreHost = !!s.youAreHost;
  $('hostStatus').textContent = youAreHost ? 'Banditore' : 'Partecipante';

  const hostLockedByOther = s.hostLockedBy && !youAreHost;
  $('btnHostToggle').disabled = hostLockedByOther;
  $('btnHostToggle').classList.toggle('active-host', youAreHost);
  $('btnHostToggle').title = hostLockedByOther ? 'Banditore già assegnato' : '';

  const duringAuction = ['RUNNING','ARMED','COUNTDOWN'].includes(s.phase);
  $('btnRoll').disabled = !youAreHost || duringAuction;

  // Slot
  const currentName = s.currentPlayer?.name || null;
    // Slot
    drawSlotWindow(s.currentPlayer, s.prevPlayer, s.nextPlayer);

  // Riepilogo
  $('sumBid').textContent = s.topBid;
  $('sumLeader').textContent = s.leaderName || '—';
  $('sumCredits').textContent = s.youCredits ?? '—';
  $('countdown').textContent =
    (s.phase === 'COUNTDOWN' ? s.countdownSec :
     (s.phase === 'ARMED' ? '3' : '—'));

  renderParticipantsManage(s);
  renderHistory(s);
  renderAcquisitions(s.acquisitions || []);

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
    if (res?.error){ notify(res.error, 'error'); return; }

    // <<< SALVA LA SESSIONE >>>
    try {
      localStorage.setItem('teamSession', JSON.stringify({ teamId: res.teamId, key: res.key }));
    } catch(_) {}

    registered = true;
    $('screenLogin').classList.add('hidden');
    $('screenMain').classList.remove('hidden');

    if ($('regHost').checked) {
      socket.emit('host:toggle', {}, (r)=>{ if (r?.error) notify(r.error, 'error'); });
    }
    notify('Sei dentro. Buona asta.', 'success');
  });
};


/* ===== Host controls ===== */
$('btnHostToggle').onclick = () =>
  socket.emit('host:toggle', {}, (res)=> res?.error ? notify(res.error, 'error')
                                                    : notify(res.host ? 'Hai preso il ruolo di banditore' : 'Hai lasciato il ruolo', 'info'));

$('btnRoll').onclick = () =>
  socket.emit('host:toggleRoll', {}, (res)=> res?.error ? notify(res.error, 'error')
                                                        : notify(res.rolling ? 'Rullo in riproduzione' : 'Rullo in pausa', 'info'));

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
    socket.emit('host:toggleRoll', {}, ()=>{});
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
    const inc = Number(b.dataset.inc);
    socket.emit('team:bid_inc', { amount: inc }, (res)=>{
      if(res?.error) notify(res.error, 'error');
    });
    try{ navigator.vibrate?.(12); }catch(_){}
  };
}
$('btnFreeBid').onclick = ()=>{
  const val = Number($('freeBid').value || 0);
  socket.emit('team:bid_free', { value: val }, (res)=>{
    if(res?.error) notify(res.error, 'error');
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
      // XLSX -> JSON -> normalizza -> CSV
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type:'array' });

      // prendi il primo foglio che ha intestazioni con "Nome" e "R."
      let sheet = null, headerRow = 0;
      for (const name of wb.SheetNames){
        const ws = wb.Sheets[name];
        const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
        if (!aoa || !aoa.length) continue;
        for (let r=0;r<Math.min(10, aoa.length); r++){
          const row = (aoa[r]||[]).map(x=>String(x||'').trim());
          if (row.includes('Nome') && row.includes('R.')) { sheet = ws; headerRow = r; break; }
        }
        if (sheet) break;
      }
      if (!sheet) throw new Error('Non trovo intestazioni "Nome" e "R." nel file XLSX');

      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
      const header = rows[headerRow].map(x=>String(x||'').trim());
      const idx = Object.fromEntries(header.map((h,i)=>[h,i]));

      const pick = (arr, key) => {
        const i = idx[key];
        return i != null ? arr[i] : '';
      };

      // costruisci righe normalizzate
      const normRows = [];
      for (let r = headerRow + 1; r < rows.length; r++){
        const arr = rows[r] || [];
        const fuori = String(pick(arr, 'Fuori lista') || '');
        if (fuori.includes('*')) continue;

        const nome = String(pick(arr,'Nome') || '').trim();
        if (!nome) continue;

        const ruoloRaw = pick(arr,'R.');
        const ruolo = normalizeRole(ruoloRaw);
        if (!['P','D','C','A'].includes(ruolo)) continue;

        const squadra = String(pick(arr,'Sq.') || '').trim();
        const fm = numIT(pick(arr,'FM'));

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
    const res = await fetch('/api/listone/import', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({
        csv: csvText,
        map: { name:'Nome', role:'Ruolo', team:'Squadra', fm:'FM', out:'Fuori lista' }
      })
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'Errore import');
    notify(`Importati ${j.imported} giocatori`, 'success');
  } catch (err) {
    console.error(err);
    notify(err.message || 'Errore import', 'error');
  } finally {
    e.target.value = '';
  }
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

function logoutLocal(){
  try { localStorage.removeItem('teamSession'); } catch(_){}
  location.reload();
}

$('btnLogout').onclick = logoutLocal;

