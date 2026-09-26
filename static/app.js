const $ = (id) => document.getElementById(id);
let TOKEN = sessionStorage.getItem('dg_token') || '';
let map, tileLayer, markerGroup, edgeGroup, chart, overviewData = null, currentDam = null;
let waveRAF = null, pollTimer = null, paused = false, tileKind = 'dark', LIST_FILTER = 'ALL';

const TILES = {
  dark: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', 'Esri Dark Gray'],
  sat:  ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', 'Esri World Imagery']
};
const STATUS_COLOR = { CRITICAL: '#E74C3C', WARNING: '#F5A524', SAFE: '#2ECC71', BREACH: '#FFFFFF' };

async function api(path, opts = {}) {
  const headers = Object.assign({ 'X-Auth': TOKEN }, opts.headers || {});
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) { logout(); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error('API ' + res.status);
  return res.json();
}
function logout() { sessionStorage.removeItem('dg_token'); TOKEN = ''; location.reload(); }
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3000);
}
function haversine(a, b) {
  const R = 6371, dLa = (b[0]-a[0])*Math.PI/180, dLo = (b[1]-a[1])*Math.PI/180;
  const s = Math.sin(dLa/2)**2 + Math.cos(a[0]*Math.PI/180)*Math.cos(b[0]*Math.PI/180)*Math.sin(dLo/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function countUp(el, target, suf, dur = 750) {
  const from = parseFloat(el.dataset.cur || '0');
  const t0 = performance.now();
  function step(now) {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    const v = from + (target - from) * e;
    el.textContent = (suf === '%') ? v.toFixed(1) + '%' : (Number.isInteger(target) ? Math.round(v) : v.toFixed(1));
    if (p < 1) requestAnimationFrame(step); else el.dataset.cur = target;
  }
  requestAnimationFrame(step);
}

/* ---------- login particle wave (yellow, FR24 accent) ---------- */
function startWaves() {
  const c = $('waves'); if (!c) return;
  const ctx = c.getContext('2d'); let t = 0;
  const resize = () => { c.width = innerWidth; c.height = innerHeight; };
  resize(); addEventListener('resize', resize);
  const ROWS = 6, N = 110;
  function frame() {
    ctx.clearRect(0, 0, c.width, c.height);
    for (let r = 0; r < ROWS; r++) for (let i = 0; i < N; i++) {
      const x = i / (N - 1) * c.width;
      const y = c.height * 0.52 + (r - ROWS / 2) * 74 + Math.sin(x * 0.0055 + t * 0.018 + r * 1.15) * (34 + r * 7);
      const a = 0.10 + 0.30 * (0.5 + 0.5 * Math.sin(t * 0.025 + i * 0.14 + r * 0.9));
      ctx.beginPath(); ctx.arc(x, y, 1.7, 0, 6.2832);
      ctx.fillStyle = `rgba(245,187,0,${a.toFixed(3)})`; ctx.fill();
    }
    t++; waveRAF = requestAnimationFrame(frame);
  }
  frame();
}
function stopWaves() { if (waveRAF) cancelAnimationFrame(waveRAF); waveRAF = null; }

/* ---------- auth ---------- */
async function tryLogin() {
  const body = JSON.stringify({ username: $('user').value.trim(), password: $('pass').value });
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) { $('login-err').textContent = 'ACCESS DENIED — invalid credentials'; return; }
    const d = await res.json();
    TOKEN = d.token; sessionStorage.setItem('dg_token', TOKEN);
    enterApp();
  } catch (e) { $('login-err').textContent = 'SERVER UNREACHABLE'; }
}

/* ---------- views ---------- */
function showView(name) {
  ['overview', 'dam', 'inspect'].forEach(v => {
    const el = $('view-' + v);
    if (v === name) { el.hidden = false; el.classList.remove('view-enter'); void el.offsetWidth; el.classList.add('view-enter'); }
    else el.hidden = true;
  });
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $('crumb').textContent = name === 'overview' ? 'Network' : name === 'dam' ? 'Intelligence / ' + (currentDam || '—') : 'Inspection';
  if (name === 'overview' && map) setTimeout(() => map.invalidateSize(), 80);
}

/* ---------- overview ---------- */
function kpiHTML(items, animate) {
  return items.map(([v, l, c, suf], i) =>
    `<div class="kpi${animate ? ' rise' : ''}" style="animation-delay:${i * 60}ms">
       <div class="v" data-val="${v}" data-suf="${suf || ''}" style="color:${c}">${animate ? '0' : v + (suf || '')}</div>
       <div class="l">${l}</div></div>`).join('');
}
function runCountUps(scope) { scope.querySelectorAll('.v[data-val]').forEach(el => countUp(el, parseFloat(el.dataset.val), el.dataset.suf)); }

function renderOverview(d, animate) {
  overviewData = d;
  const k = d.kpi;
  $('kpis').innerHTML = kpiHTML([
    [k.monitored, 'Tracked', '#FFFFFF', ''], [k.critical, 'Critical', '#E74C3C', ''],
    [k.warning, 'Warning', '#F5A524', ''], [k.safe, 'Safe', '#2ECC71', ''],
    [k.avg, 'National Avg Storage', '#F5BB00', '%']
  ], animate);
  runCountUps($('kpis'));

  const tk = d.dams.slice().sort((a, b) => b.peak - a.peak)
    .map(x => `<span class="tk"><i class="led ${x.status === 'CRITICAL' ? 'crit' : x.status === 'WARNING' ? 'warn' : 'ok'}"></i>${x.name} <b class="mono">${x.level}%</b> <span class="tk-mut">PEAK ${x.peak}%</span></span>`).join('');
  const tt = $('ticker-track'); if (tt) tt.innerHTML = tk + tk;

  $('stressed').innerHTML = d.dams.slice().sort((a, b) => b.peak - a.peak).slice(0, 5).map((x, i) => `
    <div class="st-row" data-dam="${x.name}">
      <span class="st-rank">${i + 1}.</span>
      <span class="st-name">${x.name} <span class="muted tiny">${x.state}</span></span>
      <span class="st-val"><i class="dot-o"></i><b class="mono">${x.peak}%</b></span>
    </div>`).join('');

  $('alerts').innerHTML = d.alerts.length ? d.alerts.map((a, i) => {
    const tag = a.breached ? 'BREACH' : a.status;
    const surgeLine = a.surge > 0 ? ` Cascade inflow +${a.surge}% from ${a.inflow_from.join(', ')}.` : '';
    const breachLine = a.breached ? ' DAM BREACH SIMULATION ACTIVE — surge routing downstream.' : '';
    return `<div class="alert-item ${a.breached || a.status === 'CRITICAL' ? 'crit' : 'warn'}${animate ? ' rise' : ''}" style="animation-delay:${i * 50}ms" data-dam="${a.name}">
      <div class="alert-head"><span class="chip ${tag}">${tag}</span><span class="alert-name">${a.name} — ${a.state}</span></div>
      <div class="alert-msg">Live ${a.level}% • forecast peak ${a.peak}%.${surgeLine}${breachLine || (a.status === 'CRITICAL' ? ' Spillway release probable within 48h.' : ' Inflow rising; gate operation review advised.')}</div>
    </div>`;
  }).join('') : '<div class="alert-msg" style="padding:14px">All monitored reservoirs within safe operating band.</div>';

  $('dam-rows').innerHTML = d.dams.slice().sort((a, b) => b.peak - a.peak).map((r, i) => `
    <tr data-dam="${r.name}" class="${animate ? 'rise' : ''}" style="animation-delay:${Math.min(i, 20) * 25}ms">
      <td><strong>${r.name}</strong></td><td class="muted">${r.state}</td><td class="muted">${r.river}</td>
      <td class="num">${r.level}</td><td class="num">${r.peak}</td>
      <td class="num" style="color:${r.surge > 0 ? '#F5A524' : 'inherit'}">${r.surge > 0 ? '+' + r.surge : '—'}</td>
      <td><span class="chip ${r.breached ? 'BREACH' : r.status}">${r.breached ? 'BREACH' : r.status}</span></td></tr>`).join('');

  renderSelector(false);
  renderMap(d.dams);
  renderEdges(d.edges || [], d.active_edges || []);
  document.querySelectorAll('[data-dam]').forEach(el => {
    if (el._bound) return; el._bound = true;
    el.addEventListener('click', () => openDam(el.dataset.dam));
  });
}

/* ---------- watchlist ---------- */
function renderSelector(animate) {
  if (!overviewData) return;
  const q = ($('dam-search').value || '').toLowerCase();
  let list = overviewData.dams.filter(d => (d.name + ' ' + d.state).toLowerCase().includes(q));
  if (LIST_FILTER !== 'ALL') list = list.filter(d => (d.breached ? 'CRITICAL' : d.status) === LIST_FILTER);
  list.sort((a, b) => b.peak - a.peak);
  $('dam-list').innerHTML = list.map((d, i) => `
    <button class="sel-item${animate ? ' rise' : ''}" style="animation-delay:${Math.min(i, 15) * 20}ms" data-dam="${d.name}">
      <span class="sel-name">${d.name}<br><span class="muted tiny">${d.state}</span></span>
      <span class="sel-right"><span class="mono tiny">${d.level}%</span><span class="chip ${d.breached ? 'BREACH' : d.status}">${d.breached ? 'B' : d.status[0]}</span></span>
    </button>`).join('') || '<div class="muted tiny" style="padding:10px 14px">No match.</div>';
  $('dam-list').querySelectorAll('[data-dam]').forEach(el => el.addEventListener('click', () => openDam(el.dataset.dam)));
}

/* ---------- map ---------- */
function renderMap(dams) {
  if (!map) {
    map = L.map('map', { zoomControl: true }).setView([22.8, 79.5], 5);
    setTile('dark');
    map.on('click', e => spotSelect(e.latlng));
  }
  if (markerGroup) map.removeLayer(markerGroup);
  markerGroup = L.layerGroup().addTo(map);
  dams.forEach(d => {
    const cls = d.breached ? 'mk-breach' : d.status === 'CRITICAL' ? 'mk-crit' : d.status === 'WARNING' ? 'mk-warn' : 'mk-safe';
    const size = d.breached ? 17 : d.status === 'CRITICAL' ? 15 : d.status === 'WARNING' ? 13 : 10;
    L.marker(d.coords, { icon: L.divIcon({ className: '', html: `<div class="mk ${cls}"></div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }) })
      .bindPopup(`<b>${d.name} Dam</b><br>Live ${d.level}% • Peak ${d.peak}%<br><b style="color:${STATUS_COLOR[d.breached ? 'BREACH' : d.status]}">${d.breached ? 'BREACH' : d.status}</b>`)
      .on('popupopen', () => setTimeout(() => openDam(d.name), 10))
      .addTo(markerGroup);
  });
}
function renderEdges(edges, active) {
  if (!map) return;
  if (!edgeGroup) edgeGroup = L.layerGroup().addTo(map);
  edgeGroup.clearLayers();
  const coord = {}; overviewData.dams.forEach(d => coord[d.name] = d.coords);
  const act = new Set(active.map(e => e.join('>')));
  edges.forEach(([u, d]) => {
    if (!coord[u] || !coord[d]) return;
    const isAct = act.has(u + '>' + d);
    L.polyline([coord[u], coord[d]], {
      color: isAct ? '#E74C3C' : '#243447', weight: isAct ? 2.5 : 1.2,
      dashArray: isAct ? '6 10' : '3 7', className: isAct ? 'flowline' : '', opacity: isAct ? 0.95 : 0.55
    }).addTo(edgeGroup);
  });
}
function setTile(kind) {
  tileKind = kind;
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILES[kind][0], { attribution: TILES[kind][1] }).addTo(map);
  map.getContainer().classList.toggle('teal', kind === 'dark');
  $('tile-dark').classList.toggle('active', kind === 'dark');
  $('tile-sat').classList.toggle('active', kind === 'sat');
}
function spotSelect(latlng) {
  if (!overviewData) return;
  let best = null, bd = 1e9;
  overviewData.dams.forEach(d => { const dist = haversine([latlng.lat, latlng.lng], d.coords); if (dist < bd) { bd = dist; best = d; } });
  if (best && bd <= 250) { toast(`SPOT-SELECT → ${best.name} (${bd.toFixed(0)} km from click)`); openDam(best.name); }
  else toast('No registered dam within 250 km of click point');
}

/* ---------- polling ---------- */
async function loadOverview(animate) {
  try {
    const d = await api('/api/overview');
    const changed = overviewData && JSON.stringify(d.dams.map(x => x.level)) !== JSON.stringify(overviewData.dams.map(x => x.level));
    renderOverview(d, animate);
    if (changed && !animate) {
      document.querySelectorAll('#dam-rows tr').forEach(tr => { tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash'); });
      if (d.breached.length) toast('Cascade surge propagating — telemetry refreshed');
    }
  } catch (e) { /* silent */ }
}

/* ---------- dam detail + cascade ---------- */
async function openDam(name) {
  currentDam = name;
  const d = await api('/api/dam/' + encodeURIComponent(name));
  showView('dam');
  $('dam-title').textContent = `${d.name} Dam — ${d.state} • ${d.river} River`;
  $('dam-pill').className = 'chip ' + (d.breached ? 'BREACH' : d.status);
  $('dam-pill').textContent = d.breached ? 'BREACH' : d.status;
  $('dam-kpis').innerHTML = kpiHTML([
    [d.level, 'Current Live Level', '#35C7F0', '%'],
    [d.peak, '48h Forecast Peak', d.status === 'SAFE' ? '#2ECC71' : '#E74C3C', '%'],
    [d.surge, 'Cascade Surge', d.surge > 0 ? '#F5A524' : '#9AA5A9', '%'],
    [d.slope, '24h Inflow Trend', '#F5A524', '%/d']
  ], true);
  runCountUps($('dam-kpis'));
  renderChart(d);
  renderCascade(d);
  $('sim-breach').onclick = async () => {
    await api('/api/sim/breach/' + encodeURIComponent(name), { method: 'POST' });
    toast('BREACH SIMULATION → ' + name + ' — routing surge downstream');
    await loadOverview(false); await openDam(name);
  };
  $('sim-reset').onclick = async () => {
    await api('/api/sim/reset', { method: 'POST' });
    toast('All breach simulations cleared');
    await loadOverview(false); await openDam(name);
  };
}
function renderCascade(d) {
  const c = d.cascade || { upstream: [], downstream: [] };
  const up = c.upstream.length
    ? c.upstream.map(u => `<span class="chip SAFE">${u.name}</span> <span class="muted tiny">${u.river}</span>`).join(' &nbsp; ')
    : '<span class="muted small">Head-water reservoir — no upstream dams in registry.</span>';
  const down = c.downstream.length
    ? `<table class="tbl"><thead><tr><th>Downstream Dam</th><th>Link</th><th class="r">Hop</th><th class="r">Projected Level</th></tr></thead><tbody>` +
      c.downstream.map(x => `<tr><td><strong>${x.name}</strong></td><td class="muted">${x.river}</td><td class="num">${x.hop}</td>
        <td class="num" style="color:${x.projected >= 95 ? '#E74C3C' : x.projected >= 88 ? '#F5A524' : '#2ECC71'}">${x.projected}%</td></tr>`).join('') +
      '</tbody></table>'
    : '<span class="muted small">Terminal reservoir — no downstream dams in registry.</span>';
  const banner = d.breached
    ? '<div class="verdict crit" style="margin:0 0 12px"><h3 style="color:#E74C3C">Breach simulation active</h3><div class="stats">Surge routing engaged — downstream reservoirs receiving cascade inflow (+22% hop⁻¹, coeff 0.65).</div></div>'
    : (d.surge > 0 ? `<div class="verdict crit" style="margin:0 0 12px"><h3 style="color:#F5A524">Receiving cascade inflow</h3><div class="stats">+${d.surge}% surge routed from ${d.inflow_from.join(', ')}.</div></div>` : '');
  $('cascade-body').innerHTML = banner +
    `<div class="tiny muted" style="letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px">Upstream reservoirs</div>
     <div style="margin-bottom:14px">${up}</div>
     <div class="tiny muted" style="letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px">Downstream impact projection (if this dam breaches)</div>${down}`;
  $('sim-breach').textContent = d.breached ? 'Breach Active' : 'Simulate Breach';
  $('sim-breach').disabled = !!d.breached;
}
function renderChart(d) {
  const labels = [...d.history.map(h => h.t), ...d.forecast.map(f => f.t)];
  const obs = [...d.history.map(h => h.v), ...d.forecast.map(() => null)];
  const fc = [...d.history.map(() => null), d.history[d.history.length - 1].v, ...d.forecast.slice(1).map(f => f.v)];
  if (chart) chart.destroy();
  chart = new Chart($('chart'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Observed (Sentinel-1 NDWI)', data: obs, borderColor: '#4A90D9', backgroundColor: 'rgba(74,144,217,.1)', fill: true, pointRadius: 0, borderWidth: 2, tension: .3 },
      { label: 'ML Forecast', data: fc, borderColor: '#E74C3C', pointRadius: 0, borderWidth: 2, borderDash: [2, 3], tension: .3 },
      { label: 'FRL Threshold', data: labels.map(() => 95), borderColor: 'rgba(231,76,60,.55)', pointRadius: 0, borderWidth: 1.5, borderDash: [7, 6] }
    ]},
    options: {
      maintainAspectRatio: false,
      animation: { duration: 950, easing: 'easeOutQuart' },
      plugins: { legend: { labels: { color: '#9AA5A9', font: { family: 'Roboto', size: 11 } } } },
      scales: {
        x: { ticks: { color: '#7b888c', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 10 }, grid: { color: 'rgba(51,58,61,.6)' } },
        y: { min: 0, max: 105, ticks: { color: '#7b888c', font: { family: 'JetBrains Mono', size: 10 } }, grid: { color: 'rgba(51,58,61,.6)' } }
      }
    }
  });
}
async function downloadReport() {
  if (!currentDam) return;
  const res = await fetch('/api/report/' + encodeURIComponent(currentDam), { headers: { 'X-Auth': TOKEN } });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = currentDam.replace(/ /g, '_') + '_RiskReport.txt';
  a.click();
  toast('Risk report exported');
}

/* ---------- inspection ---------- */
async function runInspect(file) {
  const fd = new FormData(); fd.append('file', file);
  const res = await fetch('/api/inspect', { method: 'POST', headers: { 'X-Auth': TOKEN }, body: fd });
  const d = await res.json();
  $('inspect-result').hidden = false;
  $('img-raw').src = URL.createObjectURL(file);
  $('img-edge').src = 'data:image/png;base64,' + d.edge_map;
  $('verdict').className = 'verdict fr-card ' + (d.cracked ? 'crit' : 'ok');
  $('verdict').innerHTML = `
    <h3 style="color:${d.cracked ? '#E74C3C' : '#2ECC71'}">${d.cracked ? 'Structural Damage Detected' : 'Structure Intact'}</h3>
    <div class="stats">Crack probability: ${d.probability}%<br>Edge-density score: ${d.density}% (threshold ${d.threshold}%)</div>
    <div class="alert-msg" style="margin-top:10px">${d.cracked ? 'ACTION: Dispatch physical inspection team. High seepage / fracture propagation risk on dam face.' : 'ACTION: None. Continue scheduled drone sweeps.'}</div>`;
  toast(d.cracked ? 'Inference complete — DAMAGE FLAGGED' : 'Inference complete — structure intact');
}

/* ---------- boot ---------- */
function startClock() {
  const tick = () => { $('clock').textContent = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST'; };
  tick(); setInterval(tick, 1000);
}
async function enterApp() {
  stopWaves();
  $('login').hidden = true; $('app').hidden = false;
  startClock();
  showView('overview');
  await loadOverview(true);
  pollTimer = setInterval(() => { if (!paused) loadOverview(false); }, 25000);
}
document.addEventListener('DOMContentLoaded', async () => {
  $('signin').addEventListener('click', tryLogin);
  $('pass').addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
  $('signout').addEventListener('click', logout);
  $('back').addEventListener('click', () => showView('overview'));
  $('dl-report').addEventListener('click', downloadReport);
  $('tile-dark').addEventListener('click', () => setTile('dark'));
  $('tile-sat').addEventListener('click', () => setTile('sat'));
  $('dam-search').addEventListener('input', () => renderSelector(false));
  document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.view === 'dam' && !currentDam) { toast('Select a dam from the map or watchlist first'); return; }
    showView(b.dataset.view);
  }));
  document.querySelectorAll('.fr-tab').forEach(b => b.addEventListener('click', () => {
    LIST_FILTER = b.dataset.filter;
    document.querySelectorAll('.fr-tab').forEach(x => x.classList.toggle('active', x === b));
    renderSelector(false);
  }));
  $('menu-btn').addEventListener('click', () => $('panels-left').classList.toggle('collapsed'));
  $('tb-tiles').addEventListener('click', () => { setTile(tileKind === 'dark' ? 'sat' : 'dark'); toast('Basemap: ' + (tileKind === 'dark' ? 'Chart' : 'Satellite')); });
  $('tb-pause').addEventListener('click', () => {
    paused = !paused;
    $('tb-pause').classList.toggle('active', paused);
    $('poll-tag').textContent = paused ? 'PAUSED' : 'POLL 25s';
    toast(paused ? 'Live polling paused' : 'Live polling resumed');
  });
  $('tb-inspect').addEventListener('click', () => showView('inspect'));
  $('file').addEventListener('change', e => { if (e.target.files[0]) runInspect(e.target.files[0]); });
  if (TOKEN) { try { await enterApp(); } catch (e) { startWaves(); } }
  else startWaves();
});