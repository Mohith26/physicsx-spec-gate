// PhysicsX · Blade cooling · Spec gate (unofficial concept demo). Every number is computed in this page by
// src/core.js from data/designs.json; "Build" runs the real finite-volume conduction solver in the browser.
import * as C from './src/core.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LS = 'px-spec-gate-v1';
const COST = 6.8; // US$ per build, illustrative (the platform header shows Builds 5 · US$ 34)
const S = { panel: 'plot', D: null, q: 0.1, L: null, x: 'area', mode: 'temp', sel: null, view: 'campaign', builds: {}, log: [], gate: null, cache: new Map() };

// ---------- persistence + routing ----------
function load() { try { const v = JSON.parse(localStorage.getItem(LS)); if (v) { S.builds = v.builds || {}; S.log = v.log || []; if (v.q) S.q = v.q; if (v.L) S.L = v.L; } } catch { /* ignore */ } }
function save() { try { localStorage.setItem(LS, JSON.stringify({ builds: S.builds, log: S.log, q: S.q, L: S.L })); } catch { /* ignore */ } }
function parse() {
  const h = location.hash.replace(/^#\/?/, ''); const [p, qs] = h.split('?'); const u = new URLSearchParams(qs || '');
  S.view = p === 'log' ? 'log' : p === 'vault' ? 'vault' : 'campaign';
  if (u.has('q')) S.q = Math.min(0.5, Math.max(0.01, +u.get('q')));
  if (u.has('L')) S.L = +u.get('L');
  if (u.has('d')) S.sel = +u.get('d');
  if (u.has('x')) S.x = u.get('x') === 'sd' ? 'sd' : 'area';
}
function go(patch = {}, replace = false) {
  Object.assign(S, patch);
  const u = new URLSearchParams(); if (S.sel != null) u.set('d', S.sel); u.set('q', S.q); if (S.L !== S.D.limit) u.set('L', S.L); if (S.x !== 'area') u.set('x', S.x);
  const h = `#/${S.view === 'campaign' ? 'campaign' : S.view}?${u}`;
  if (replace) history.replaceState(null, '', h); else history.pushState(null, '', h);
  save(); render();
}
window.addEventListener('popstate', () => { parse(); render(); });

// ---------- model ----------
function idx() { const { train, cal, pool } = S.D.split; return { cal: [...Array(cal).keys()].map(i => i + train), pool: [...Array(pool).keys()].map(i => i + train + cal) }; }
function computeGate() {
  const key = S.q + '|' + S.L; if (S.cache.has(key)) return (S.gate = S.cache.get(key));
  const D = S.D; const { cal, pool } = idx();
  const c = { mu: cal.map(i => D.mu[i]), sd: cal.map(i => D.sd[i]), y: cal.map(i => D.tmax[i]) };
  const t = { mu: pool.map(i => D.mu[i]), sd: pool.map(i => D.sd[i]) };
  const g = C.specGate(c, t, S.L, S.q);
  const scale = C.sigmaScale(c.mu, c.sd, c.y, 0.95, 1.96);
  let naive = 0, uq = 0; t.mu.forEach((m, i) => { if (m <= S.L) naive++; if (m + 1.645 * scale * t.sd[i] <= S.L) uq++; });
  const order = [...g.selected].sort((a, b) => g.p[a] - g.p[b] || g.score[b] - g.score[a]);
  S.gate = { ...g, pool, cal, scale, naive, uq, order, calBad: c.y.filter(v => v > S.L).length };
  S.cache.set(key, S.gate); return S.gate;
}
const area = (i) => C.coolantArea(S.D.designs[i]) * (S.D.blade.chord * 1000) ** 2; // mm^2
const did = (i) => 'D-' + S.D.ids[i];
function buildOne(i) {
  if (S.builds[i] != null) return S.builds[i];
  const r = C.solve(S.D.designs[i]); const T = Math.round(r.Tmax * 100) / 100;
  S.builds[i] = T; S.log.push({ at: new Date().toISOString(), id: did(i), i, pred: S.D.mu[i], sim: T, limit: S.L, shortlisted: S.gate.selected.has(S.gate.pool.indexOf(i)), cost: COST });
  return T;
}

// ---------- shell ----------
function icons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.5 } }); }
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2400); }
const caret = (open) => `<span class="caret"><svg viewBox="0 0 10 10"><path d="${open ? 'M1 3h8L5 8z' : 'M3 1v8l5-4z'}"/></svg></span>`;
function renderTree() {
  const sel = S.view === 'campaign';
  $('#tree').innerHTML = `
    <div class="tr">${caret(true)}<span class="t">Blade cooling</span></div>
    <div class="tr lvl2" data-dlg="objective"><span class="chip">Objective</span><span class="t">Objective: Min coolant flow…</span></div>
    <div class="tr lvl2" data-dlg="constraint"><span class="chip">Constraint</span><span class="t">Constraints: Tmax ≤ ${S.L} K…</span></div>
    <div class="tr lvl2"><span class="t">HPT-blade-section.step</span></div>
    <div class="tr lvl1 ${sel ? 'on' : ''}" data-go="campaign">${caret(true)}<span class="chip">Campaign</span><span class="t">Spec gate · explore</span><span class="sp"></span><i data-lucide="git-branch"></i></div>
    <div class="tr lvl3" data-dlg="strategy"><span class="chip">Strategy</span><span class="t">Strategy: Conformal…</span></div>
    <div class="tr">${caret(false)}<span class="t">Reconstruction</span></div>`;
  document.querySelectorAll('.sl').forEach(a => a.classList.toggle('on', a.dataset.view === S.view));
}

// ---------- center: campaign ----------
function renderCampaign() {
  const g = computeGate(); const D = S.D;
  const builtShort = g.order.map(j => g.pool[j]).filter(i => S.builds[i] != null);
  const builtBad = builtShort.filter(i => S.builds[i] > S.L).length;
  const nb = Object.keys(S.builds).length;
  if (S.sel == null || !D.designs[S.sel]) S.sel = g.pool[g.order[0] ?? 0];
  $('#center').innerHTML = `
  <div class="chead">
    <div class="ctitle">Spec gate · explore <span class="pen"><i data-lucide="pencil"></i></span>
      <span class="acts"><button type="button" title="Run" aria-label="Run"><i data-lucide="play"></i></button><button type="button" title="Pause" aria-label="Pause"><i data-lucide="pause"></i></button><button type="button" title="Stop" aria-label="Stop"><i data-lucide="square"></i></button></span></div>
    <div class="metrics">
      <span>FDR budget<button class="inl" data-act="q" aria-label="Change false-shortlist budget">${Math.round(S.q * 100)}%</button></span>
      <span>Shortlisted<b>${g.k.toLocaleString()}</b><span class="up">↑ ${(g.k / g.pool.length * 100).toFixed(1)}%</span></span>
      <span>In spec ≥<b>${Math.ceil(g.k * (1 - S.q)).toLocaleString()}</b></span>
      <span class="right"><span>Builds<b>${nb}</b></span><span>US $<b>${(nb * COST).toFixed(0)}</b></span></span>
    </div>
  </div>
  <section class="panel plot" aria-label="Selection plot">
    <div class="ptitle">Selection plot <button class="ib" data-act="filter" aria-label="Filter"><i data-lucide="filter"></i></button><span class="r"><span class="sub" style="color:var(--muted);font-size:12.5px">${builtShort.length ? `Audit: ${builtBad}/${builtShort.length} built shortlisted designs out of spec` : 'No shortlisted designs built yet'}</span><button class="ib" data-act="audit" aria-label="Build an audit sample" title="Build 20 shortlisted designs"><i data-lucide="plus"></i></button></span></div>
    <div class="chart" id="chart"></div>
    <div class="axisbtn"><button class="btn" data-act="xaxis">${S.x === 'area' ? 'Coolant area (mm²)' : 'Model σ (K)'} <i data-lucide="chevron-down"></i></button></div>
    <div class="legend"><span><span class="sq" style="background:#fff"></span>Selected design</span><span><span class="sq" style="background:#aaabaf"></span>Shortlisted</span><span><span class="sq" style="background:#3d4046"></span>Not shortlisted</span><span><span class="sq" style="border:1px solid #ff6b63"></span>Built · out of spec</span><span><span class="sq" style="background:var(--purple)"></span>Baseline</span></div>
  </section>
  <section class="panel exp" id="exp"></section>`;
  icons(); drawChart(); drawExp();
}

function chartTools() { return `<div class="charttools" role="group" aria-label="Plot or table"><button type="button" data-panel="plot" aria-pressed="${S.panel === 'plot'}" title="Scatter" aria-label="Scatter view"><i data-lucide="scatter-chart"></i></button><button type="button" data-panel="table" aria-pressed="${S.panel === 'table'}" title="Table" aria-label="Table view"><i data-lucide="table-2"></i></button></div>`; }
function drawTable(el) {
  const g = S.gate, D = S.D; const list = g.order.slice(0, 60);
  el.innerHTML = `<div style="max-height:290px;overflow:auto;margin-right:40px"><table class="tbl"><thead><tr><th>Design</th><th class="n">Pred. Tmax (K)</th><th class="n">±1.96σ</th><th class="n">p-value</th><th class="n">Coolant (mm²)</th><th>Built</th></tr></thead><tbody>${list.map(j => { const i = g.pool[j]; const b = S.builds[i]; return `<tr class="click" data-open="${i}" ${i === S.sel ? 'style="background:#1c1f24"' : ''}><td>${did(i)}</td><td class="n">${D.mu[i].toFixed(1)}</td><td class="n">${(1.96 * D.sd[i] * g.scale).toFixed(1)}</td><td class="n">${g.p[j].toFixed(4)}</td><td class="n">${area(i).toFixed(1)}</td><td>${b == null ? '<span class="pill mut">no</span>' : b > S.L ? `<span class="pill bad">${b.toFixed(1)} K</span>` : `<span class="pill ok">${b.toFixed(1)} K</span>`}</td></tr>`; }).join('')}</tbody></table></div>${chartTools()}<div class="sub" style="color:var(--muted);font-size:12px;margin-top:6px">Top ${list.length} of ${g.k.toLocaleString()} shortlisted designs by p-value</div>`;
  icons(); el.querySelectorAll('[data-open]').forEach(r => r.addEventListener('click', () => go({ sel: +r.dataset.open })));
}
function drawChart() {
  const el = $('#chart'); if (!el) return; const g = S.gate, D = S.D;
  if (S.panel === 'table') return drawTable(el);
  const W = Math.max(560, el.clientWidth), H = 290, L0 = 92, R0 = 44, T0 = 10, B0 = 26;
  const xs = g.pool.map(i => S.x === 'area' ? area(i) : D.sd[i] * g.scale), ys = g.pool.map(i => D.mu[i]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.floor(Math.min(...ys) / 20) * 20, ymax = Math.ceil(Math.max(...ys) / 20) * 20;
  const X = (v) => L0 + (v - xmin) / (xmax - xmin) * (W - L0 - R0), Y = (v) => T0 + (1 - (v - ymin) / (ymax - ymin)) * (H - T0 - B0);
  const out = [];
  out.push(`<rect x="${L0}" y="${T0}" width="${W - L0 - R0}" height="${Math.max(0, Y(S.L) - T0)}" fill="#2b2f40" opacity=".55"/>`);
  out.push(`<line x1="${L0}" x2="${W - R0}" y1="${Y(S.L)}" y2="${Y(S.L)}" stroke="#6b7bd6" stroke-dasharray="3 3"/>`);
  for (let v = ymin; v <= ymax; v += 40) out.push(`<text x="${L0 - 10}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`);
  const xstep = S.x === 'area' ? 5 : 5; for (let v = Math.ceil(xmin / xstep) * xstep; v <= xmax; v += xstep) out.push(`<text x="${X(v)}" y="${H - 6}" text-anchor="middle">${v}</text>`);
  out.push(`<line x1="${L0}" x2="${L0}" y1="${T0}" y2="${H - B0}" stroke="#2a2d32"/><line x1="${L0}" x2="${W - R0}" y1="${H - B0}" y2="${H - B0}" stroke="#2a2d32"/>`);
  // points: not shortlisted first, then shortlisted, built, selected
  const sel = g.selected; const pts = [[], [], []];
  g.pool.forEach((i, j) => { const s = sel.has(j); const b = S.builds[i]; const tier = s ? 1 : 0; pts[b != null ? 2 : tier].push([i, j, s, b]); });
  for (const [i, j, s, b] of [...pts[0], ...pts[1], ...pts[2]]) {
    const x = X(xs[j]), y = Y(ys[j]);
    if (b != null) { const bad = b > S.L; out.push(`<rect class="pt" data-i="${i}" x="${x - 3}" y="${y - 3}" width="6" height="6" fill="${bad ? 'none' : (s ? '#aaabaf' : '#3d4046')}" stroke="${bad ? '#ff6b63' : '#2fd36b'}" stroke-width="1.2"/>`); }
    else out.push(`<rect class="pt" data-i="${i}" x="${x - 2}" y="${y - 2}" width="4" height="4" fill="${s ? '#aaabaf' : '#3d4046'}"/>`);
  }
  // baseline (true values; it is an existing, simulated design)
  const bx = S.x === 'area' ? C.coolantArea(D.baseline.design) * (D.blade.chord * 1000) ** 2 : null;
  if (bx != null) out.push(`<rect x="${X(bx) - 4.5}" y="${Y(D.baseline.tmax) - 4.5}" width="9" height="9" fill="#6822e4"><title>Baseline design · simulated ${D.baseline.tmax.toFixed(1)} K</title></rect>`);
  out.push(`<rect x="${L0 + 8}" y="${T0 + 6}" width="${S.L >= 1000 ? 214 : 200}" height="20" rx="4" fill="#101216" opacity=".85"/><text x="${L0 + 16}" y="${T0 + 20}" fill="#c3c8e6">predicted Tmax > ${S.L} K (out of spec)</text>`);
  for (let v = Math.ceil(xmin / 5) * 5; v <= xmax; v += 5) out.push(`<line x1="${X(v)}" x2="${X(v)}" y1="${T0}" y2="${H - B0}" stroke="#1a1d22"/>`);
  const si = S.sel; const sj = g.pool.indexOf(si);
  if (sj >= 0) out.push(`<rect x="${X(xs[sj]) - 5}" y="${Y(ys[sj]) - 5}" width="10" height="10" fill="#fff"/>`);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted peak metal temperature versus ${S.x === 'area' ? 'coolant area' : 'model uncertainty'} for 3,000 candidate designs">${out.join('')}
    <g transform="translate(12,${T0 + 50})"><rect x="0" y="0" width="22" height="${H - B0 - T0 - 100}" rx="3" fill="#15171b" stroke="#3a3d42"/><text transform="translate(15,${(H - B0 - T0 - 100) / 2}) rotate(-90)" text-anchor="middle" font-size="11" style="font-family:var(--font)">Pred. Tmax (K)</text></g></svg><div class="tip" id="tip"></div>${chartTools()}`;
  icons();
  const tip = $('#tip', el);
  el.querySelector('svg').addEventListener('mousemove', (e) => {
    const r = e.target.closest('.pt'); if (!r) { tip.style.display = 'none'; return; }
    const i = +r.dataset.i, j = g.pool.indexOf(i); const bx2 = el.getBoundingClientRect();
    tip.style.display = 'block'; tip.style.left = Math.min(bx2.width - 200, e.clientX - bx2.left + 12) + 'px'; tip.style.top = (e.clientY - bx2.top + 10) + 'px';
    tip.innerHTML = `<b>${did(i)}</b><br>Predicted <span class="m">${D.mu[i].toFixed(1)} ± ${(1.96 * D.sd[i] * g.scale).toFixed(1)} K</span><br>p-value <span class="m">${g.p[j].toFixed(4)}</span> · ${g.selected.has(j) ? 'shortlisted' : 'not shortlisted'}${S.builds[i] != null ? `<br>Built <span class="m">${S.builds[i].toFixed(1)} K</span>` : ''}`;
  });
  el.querySelector('svg').addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  el.querySelector('svg').addEventListener('click', (e) => { const r = e.target.closest('.pt'); if (r) go({ sel: +r.dataset.i }); });
}

// ---------- experiment panel (viewports) ----------
function drawExp() {
  const el = $('#exp'); if (!el) return; const g = S.gate, D = S.D; const i = S.sel; const j = g.pool.indexOf(i);
  const built = S.builds[i] != null; const inPool = j >= 0;
  const pv = inPool ? g.p[j] : null; const short = inPool && g.selected.has(j);
  const ci = 1.96 * D.sd[i] * g.scale;
  el.innerHTML = `<div class="exphead">Design ${did(i)} ${short ? '<span class="pill ok">Shortlisted</span>' : '<span class="pill mut">Not shortlisted</span>'} ${built ? (S.builds[i] > S.L ? '<span class="pill bad">Built · out of spec</span>' : '<span class="pill ok">Built · in spec</span>') : ''}
      <span class="r"><button class="btn" data-act="prev" aria-label="Previous shortlisted design" title="Previous (←)"><i data-lucide="chevron-left"></i></button><button class="btn" data-act="next" aria-label="Next shortlisted design" title="Next (→)"><i data-lucide="chevron-right"></i></button>
      <button class="btn ${built ? '' : 'pri'}" data-act="build" ${built ? 'disabled' : ''}><i data-lucide="hammer"></i>${built ? 'Built' : `Build · US$ ${COST.toFixed(2)}`}</button>
      <button class="btn" data-act="display">Display: ${S.mode === 'temp' ? 'Temperature' : 'Margin'} <i data-lucide="chevron-down"></i></button></span></div>
    <div class="views">
      <div class="vp"><div class="vt">Geometry <i data-lucide="maximize-2"></i></div><canvas id="cv-geo" width="480" height="200" aria-label="Blade section geometry with cooling holes"></canvas>
        <div class="omet"><div class="h">Output metrics</div>
          <div class="row"><span>Predicted Tmax (K)</span><b>${D.mu[i].toFixed(1)} ± ${ci.toFixed(1)}</b></div>
          <div class="row"><span>Conformal p-value</span><b>${pv != null ? pv.toFixed(4) : '–'}</b></div>
          <div class="row"><span>BH threshold</span><b>${g.threshold.toFixed(4)}</b></div>
          <div class="row"><span>Coolant area (mm²)</span><b>${area(i).toFixed(1)}</b></div>
          <div class="row"><span>Simulated Tmax (K)</span><b>${built ? S.builds[i].toFixed(1) : 'not built'}</b></div></div></div>
      <div class="vp"><div class="vt">Simulated <i data-lucide="maximize-2"></i></div>${built ? `<canvas id="cv-sim" width="480" height="200" aria-label="Simulated temperature field"></canvas>` : `<div class="empty">Not built yet.<br>Build runs the finite-volume conduction solve<br>(${D.blade.nx}×${D.blade.ny} grid, Robin boundaries).</div>`}</div>
      <div class="vp"><div class="vt">Margin to spec <i data-lucide="maximize-2"></i></div>${built ? `<canvas id="cv-del" width="480" height="200" aria-label="Temperature minus spec limit"></canvas>` : `<div class="empty">Predicted margin ${(S.L - D.mu[i]).toFixed(1)} K<br>${short ? `Shortlisted at p = ${pv.toFixed(4)} ≤ ${g.threshold.toFixed(4)}` : inPool ? `Needs p ≤ ${g.threshold.toFixed(4)} to be shortlisted` : 'Calibration design'}</div>`}</div>
    </div>`;
  icons();
  drawGeo($('#cv-geo'), i);
  if (built) { const r = solveCached(i); drawField($('#cv-sim'), r, S.mode === 'temp' ? 'temp' : 'margin'); drawField($('#cv-del'), r, 'margin'); }
}
const solCache = new Map();
function solveCached(i) { if (!solCache.has(i)) solCache.set(i, C.solve(S.D.designs[i])); return solCache.get(i); }
function bladeBox(cv) { const w = cv.width, h = cv.height; const sx = w * 0.92, ox = w * 0.04; return { w, h, X: (x) => ox + x * sx, Y: (y) => h / 2 - y * sx }; }
function drawGeo(cv, i) {
  if (!cv) return; const ctx = cv.getContext('2d'); const { w, h, X, Y } = bladeBox(cv); ctx.clearRect(0, 0, w, h);
  const d = S.D.designs[i];
  const grad = ctx.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, '#9a9a9a'); grad.addColorStop(1, '#5c5c5c');
  ctx.beginPath(); for (let k = 0; k <= 200; k++) { const x = k / 200; ctx.lineTo(X(x), Y(C.halfThickness(x))); } for (let k = 200; k >= 0; k--) { const x = k / 200; ctx.lineTo(X(x), Y(-C.halfThickness(x))); } ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  ctx.fillStyle = '#101216'; for (let q = 0; q < d.length; q += 3) { ctx.beginPath(); ctx.arc(X(d[q]), Y(d[q + 1]), d[q + 2] * (X(1) - X(0)), 0, 2 * Math.PI); ctx.fill(); }
  ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(X(S.D.blade.xEval), Y(0.18)); ctx.lineTo(X(S.D.blade.xEval), Y(-0.18)); ctx.stroke(); ctx.setLineDash([]);
}
function jet(t) { t = Math.min(1, Math.max(0, t)); const r = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 3))), g = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 2))), b = Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 1))); return [r * 255, g * 255, b * 255]; }
function drawField(cv, r, mode) {
  if (!cv) return; const ctx = cv.getContext('2d'); const { w, h, X, Y } = bladeBox(cv); ctx.clearRect(0, 0, w, h);
  const { nx, ny } = r; const dx = 1 / nx, dy = 0.4 / ny;
  let lo, hi; if (mode === 'margin') { lo = -60; hi = 60; } else { lo = Infinity; hi = -Infinity; r.field.forEach(v => { if (!Number.isNaN(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); }
  for (let j = 0; j < ny; j++) for (let i2 = 0; i2 < nx; i2++) {
    const v = r.field[j * nx + i2]; if (Number.isNaN(v)) continue;
    const val = mode === 'margin' ? v - S.L : v; const [R, G, B] = jet((val - lo) / (hi - lo));
    ctx.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
    const x0 = X(i2 * dx), y0 = Y(-0.2 + (j + 1) * dy); ctx.fillRect(x0, y0, X((i2 + 1) * dx) - x0 + 0.6, Y(-0.2 + j * dy) - y0 + 0.6);
  }
  // trailing edge (x > xEval) is outside the evaluated region: dim it and mark the boundary
  ctx.fillStyle = 'rgba(16,18,22,.62)'; ctx.fillRect(X(S.D.blade.xEval), 0, w - X(S.D.blade.xEval), h);
  ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(X(S.D.blade.xEval), Y(0.16)); ctx.lineTo(X(S.D.blade.xEval), Y(-0.16)); ctx.stroke(); ctx.setLineDash([]);
  const vp = cv.parentElement; let cb = vp.querySelector('.cbar'); if (!cb) { cb = document.createElement('div'); cb.className = 'cbar'; vp.appendChild(cb); }
  const g = 'linear-gradient(to top,' + Array.from({ length: 9 }, (_, k) => { const [R, G, B] = jet(k / 8); return `rgb(${R | 0},${G | 0},${B | 0})`; }).join(',') + ')';
  cb.innerHTML = `<div class="bar" style="background:${g}"></div><div class="lab"><span>${mode === 'margin' ? '+60 K' : Math.round(hi) + ' K'}</span><span>${mode === 'margin' ? '−60 K' : Math.round(lo) + ' K'}</span></div>`;
}

// ---------- agent panel ----------
function renderAgent() {
  const g = computeGate(); const D = S.D;
  const builtShort = g.order.map(j => g.pool[j]).filter(i => S.builds[i] != null);
  const bad = builtShort.filter(i => S.builds[i] > S.L).length;
  const ub = builtShort.length ? cpUpper(bad, builtShort.length) : null;
  $('#agent').innerHTML = `<div class="msgs" id="msgs">
    <div class="m-ev"><span class="tc">TC</span>Read <b>Teamcenter</b> HPT-blade-section.step</div>
    <div class="m-user">Find candidate cooling layouts that keep peak metal temperature at or below ${S.L} K. I can tolerate at most ${Math.round(S.q * 100)}% of the shortlist being out of spec.</div>
    <div class="m-ev">Read <b>${g.pool.length.toLocaleString()} candidates</b> scored by the LPM (mean and σ)</div>
    <div class="m-ev">Read <b>${g.cal.length} calibration builds</b> · ${g.calBad} out of spec</div>
    <div class="m-ag">I'll treat every candidate as out of spec unless the calibration builds say otherwise. For each design I count how many out-of-spec calibration designs looked at least as good to the model; that count is a conformal p-value. Benjamini-Hochberg on the p-values keeps the expected share of out-of-spec designs in the shortlist at or below ${Math.round(S.q * 100)}%, without trusting σ to be calibrated.</div>
    <div class="m-ev">Computed ${g.pool.length.toLocaleString()} conformal p-values · BH threshold <b>p ≤ ${g.threshold.toFixed(4)}</b></div>
    <div class="m-ag">Shortlisted <b>${g.k.toLocaleString()}</b> designs; expect at most ${Math.floor(g.k * S.q)} out of spec. For comparison, thresholding the prediction passes ${g.naive.toLocaleString()} with no error control, and a calibrated ±σ gate (1.645σ) passes ${g.uq.toLocaleString()}.</div>
    ${builtShort.length ? `<div class="m-ev">Built <b>${builtShort.length}</b> shortlisted designs · <b>${bad}</b> out of spec (${(100 * bad / builtShort.length).toFixed(1)}%, 95% upper bound ${(100 * ub).toFixed(1)}%)</div>` : ''}
    <div class="card"><div class="ct"><span>Spec gate</span><button class="ib" data-act="dismiss" aria-label="Dismiss"><i data-lucide="x"></i></button></div>
      <p>Shortlist ${g.k.toLocaleString()} of ${g.pool.length.toLocaleString()} designs at a ${Math.round(S.q * 100)}% false-shortlist budget (Tmax ≤ ${S.L} K).</p>
      <p>Audit by building a random sample of the shortlist to check the realized error rate.</p>
      <div class="cr"><button class="btn pri" data-act="audit">Build 20-design audit</button></div></div>
  </div>
  <form class="composer" id="composer"><span class="ctx">Spec gate · explore <i data-lucide="x"></i></span>
    <textarea id="cmd" rows="2" placeholder="How can I help you today?" aria-label="Command"></textarea>
    <div class="crow"><button type="button" class="ib" aria-label="Attach"><i data-lucide="paperclip"></i></button><span class="sp"></span><button type="button" class="model">Auto Intelligence <i data-lucide="chevron-down"></i></button><button class="send" aria-label="Send"><i data-lucide="arrow-up"></i></button></div>
    <div class="hint">Try: <kbd>q 5%</kbd> <kbd>limit 1580</kbd> <kbd>build 20</kbd> <kbd>open D-${D.ids[g.pool[g.order[0] ?? 0]]}</kbd> <kbd>export</kbd></div>
  </form>`;
  icons();
  const m = $('#msgs'); m.scrollTop = m.scrollHeight;
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); runCmd($('#cmd').value); });
  $('#cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runCmd(e.target.value); } });
}
function cpUpper(k, n, delta = 0.05) { if (k >= n) return 1; let lo = k / n, hi = 1; const cdf = (p) => { let s = 0, t = Math.pow(1 - p, n); for (let i = 0; i <= k; i++) { s += t; t *= (n - i) / (i + 1) * p / (1 - p); } return s; }; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (cdf(m) > delta) lo = m; else hi = m; } return hi; }
function runCmd(raw) {
  const s = raw.trim().toLowerCase(); if (!s) return;
  let m;
  if ((m = s.match(/^q\s*=?\s*([\d.]+)\s*%?$/))) { const v = +m[1]; const q = v > 1 ? v / 100 : v; if (q > 0 && q < 0.5) { go({ q }); toast(`Error budget set to ${Math.round(q * 100)}%`); } else toast('q must be between 1% and 49%'); return; }
  if ((m = s.match(/^limit\s*=?\s*(\d{4})/))) { const L = +m[1]; if (L > 1400 && L < 1700) { go({ L }); toast(`Spec limit set to ${L} K`); } else toast('Limit must be between 1400 and 1700 K'); return; }
  if ((m = s.match(/^build\s*(\d+)?/))) { audit(m[1] ? Math.min(100, +m[1]) : 20); return; }
  if ((m = s.match(/^open\s*d-?(\d+)/))) { const i = S.D.ids.indexOf(+m[1]); if (i >= 0) go({ sel: i }); else toast('No design ' + m[1]); return; }
  if (s === 'export') { exportCsv(); return; }
  toast('Commands: q 5%, limit 1580, build 20, open D-4321, export');
}

// ---------- actions ----------
function build(i) { const t0 = performance.now(); const T = buildOne(i); save(); render(); toast(`${did(i)} built in ${(performance.now() - t0).toFixed(0)} ms · Tmax ${T.toFixed(1)} K ${T > S.L ? '· out of spec' : '· in spec'}`); }
function audit(n) {
  const g = computeGate(); const pool = g.order.map(j => g.pool[j]).filter(i => S.builds[i] == null);
  if (!pool.length) { toast('Every shortlisted design is already built'); return; }
  const rng = C.mulberry32(Object.keys(S.builds).length + 17); const pick = C.shuffle(pool, rng).slice(0, n);
  const t0 = performance.now(); pick.forEach(buildOne); save(); render();
  const bad = pick.filter(i => S.builds[i] > S.L).length;
  toast(`Built ${pick.length} shortlisted designs in ${(performance.now() - t0).toFixed(0)} ms · ${bad} out of spec`);
}
function exportCsv() {
  const g = computeGate(); const D = S.D;
  const rows = ['design,predicted_tmax_K,sigma_K,coolant_area_mm2,conformal_p,shortlisted,built_tmax_K'];
  g.pool.forEach((i, j) => rows.push([did(i), D.mu[i], (D.sd[i] * g.scale).toFixed(3), area(i).toFixed(2), g.p[j].toFixed(5), g.selected.has(j) ? 1 : 0, S.builds[i] ?? ''].join(',')));
  dl(`spec-gate-q${Math.round(S.q * 100)}-L${S.L}.csv`, rows.join('\n'), 'text/csv');
  dl('spec-gate-summary.json', JSON.stringify({ q: S.q, limitK: S.L, candidates: g.pool.length, calibration: g.cal.length, shortlisted: g.k, bhThreshold: g.threshold, naivePasses: g.naive, sigmaGatePasses: g.uq, builds: Object.keys(S.builds).length }, null, 2), 'application/json');
  toast('Exported shortlist CSV and summary JSON');
}
function dl(name, text, type) { const u = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 500); }
function step(dir) { const g = S.gate; const list = g.order.map(j => g.pool[j]); if (!list.length) return; let k = list.indexOf(S.sel); k = k < 0 ? 0 : (k + dir + list.length) % list.length; go({ sel: list[k] }, true); }
function dialog(html, onOk) { const d = $('#dlg'); d.innerHTML = `<form method="dialog">${html}</form>`; d.onclose = () => { if (d.returnValue === 'ok' && onOk) onOk(d); }; d.showModal(); }
function pickQ() {
  dialog(`<div class="dh" id="dlgT">False-shortlist budget</div><div class="db">Benjamini-Hochberg on conformal p-values guarantees the expected share of out-of-spec designs in the shortlist is at most q (calibration and candidates drawn from the same design sampler).<br><br><select id="qsel" style="background:#1c2023;border:1px solid #2c3036;border-radius:6px;padding:6px;color:#fff">${[0.02, 0.05, 0.1, 0.2].map(q => `<option value="${q}" ${q === S.q ? 'selected' : ''}>q = ${q * 100}%</option>`).join('')}</select></div><div class="df"><button class="btn" value="cancel">Cancel</button><button class="btn pri" value="ok">Apply</button></div>`, (d) => go({ q: +$('#qsel', d).value }));
}
function keysHelp() { dialog(`<div class="dh" id="dlgT">Keyboard shortcuts</div><div class="db keys"><span><kbd>←</kbd> <kbd>→</kbd></span><span>Previous / next shortlisted design</span><span><kbd>B</kbd></span><span>Build the selected design</span><span><kbd>A</kbd></span><span>Build a 20-design audit sample</span><span><kbd>1</kbd>–<kbd>4</kbd></span><span>q = 2% / 5% / 10% / 20%</span><span><kbd>X</kbd></span><span>Toggle x-axis</span><span><kbd>D</kbd></span><span>Toggle temperature / margin</span><span><kbd>E</kbd></span><span>Export shortlist</span><span><kbd>/</kbd></span><span>Focus the agent composer</span><span><kbd>?</kbd></span><span>This help</span></div><div class="df"><button class="btn pri" value="ok">Close</button></div>`); }

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a) { const k = a.dataset.act; e.preventDefault();
    if (k === 'build') build(S.sel); else if (k === 'audit') audit(20); else if (k === 'q') pickQ(); else if (k === 'xaxis') go({ x: S.x === 'area' ? 'sd' : 'area' }, true);
    else if (k === 'display') go({ mode: S.mode === 'temp' ? 'margin' : 'temp' }, true); else if (k === 'prev') step(-1); else if (k === 'next') step(1);
    else if (k === 'dismiss') a.closest('.card').remove(); else if (k === 'filter') toast('Filter: use q and limit to change the shortlist'); else if (k === 'reset') reset();
    return; }
  const t = e.target.closest('[data-go]'); if (t) { go({ view: 'campaign' }); return; }
  const pn = e.target.closest('[data-panel]'); if (pn) { S.panel = pn.dataset.panel; drawChart(); return; }
  const dlgT = e.target.closest('[data-dlg]'); if (dlgT) { const w = dlgT.dataset.dlg;
    if (w === 'constraint') dialog(`<div class="dh" id="dlgT">Constraint</div><div class="db">Peak metal temperature on the first 75% of chord (the trailing edge has separate ejection cooling).<br><br>Tmax ≤ <select id="lsel" style="background:#1c2023;border:1px solid #2c3036;border-radius:6px;padding:6px;color:#fff">${[1560, 1570, 1580, 1590, 1600, 1610, 1620].map(v => `<option ${v === S.L ? 'selected' : ''}>${v}</option>`).join('')}</select> K</div><div class="df"><button class="btn" value="cancel">Cancel</button><button class="btn pri" value="ok">Apply</button></div>`, (d) => go({ L: +$('#lsel', d).value }));
    else if (w === 'objective') dialog(`<div class="dh" id="dlgT">Objective</div><div class="db">Minimise coolant flow (total cooling-hole area) subject to the temperature constraint. The spec gate decides which designs can be trusted to meet the constraint without a build; rank the shortlist by coolant area afterwards.</div><div class="df"><button class="btn pri" value="ok">Close</button></div>`);
    else dialog(`<div class="dh" id="dlgT">Strategy: conformal selection</div><div class="db">Score each candidate by (limit − μ)/σ from the LPM. For candidate j, p<sub>j</sub> = (1 + #{out-of-spec calibration designs with score ≥ s<sub>j</sub>}) / (n + 1). Benjamini-Hochberg at level q over the p-values controls the false-discovery rate at q (Jin &amp; Candès, 2023). Valid for any model and any σ; it needs calibration builds drawn the same way as the candidates.</div><div class="df"><button class="btn pri" value="ok">Close</button></div>`);
    return; }
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('textarea,input,select') || $('#dlg').open) return;
  const k = e.key;
  if (k === '?') return keysHelp(); if (k === '/') { e.preventDefault(); $('#cmd')?.focus(); return; }
  if (S.view !== 'campaign') return;
  if (k === 'ArrowRight') return step(1); if (k === 'ArrowLeft') return step(-1);
  if (k === 'b') return build(S.sel); if (k === 'a') return audit(20); if (k === 'e') return exportCsv();
  if (k === 'x') return go({ x: S.x === 'area' ? 'sd' : 'area' }, true); if (k === 'd') return go({ mode: S.mode === 'temp' ? 'margin' : 'temp' }, true);
  if (['1', '2', '3', '4'].includes(k)) return go({ q: [0.02, 0.05, 0.1, 0.2][+k - 1] });
});
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (S.view === 'campaign') drawChart(); }, 120); });
function reset() { S.builds = {}; S.log = []; S.q = 0.1; S.L = S.D.limit; save(); go({ sel: null }); toast('Demo state reset'); }

// ---------- other views ----------
function renderLog() {
  const rows = S.log.slice().reverse();
  $('#center').innerHTML = `<div class="page"><h2>Knowledge log · builds</h2>${rows.length ? `<table class="tbl"><thead><tr><th>Time</th><th>Design</th><th class="n">Predicted (K)</th><th class="n">Simulated (K)</th><th>Spec at build</th><th>Shortlisted</th><th class="n">US$</th></tr></thead><tbody>${rows.map(r => `<tr class="click" data-open="${r.i}"><td>${new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td><td>${r.id}</td><td class="n">${r.pred.toFixed(1)}</td><td class="n">${r.sim.toFixed(1)}</td><td>${r.sim > r.limit ? '<span class="pill bad">out of spec</span>' : '<span class="pill ok">in spec</span>'} ≤ ${r.limit} K</td><td>${r.shortlisted ? 'yes' : 'no'}</td><td class="n">${r.cost.toFixed(2)}</td></tr>`).join('')}</tbody></table>` : `<div class="empty" style="padding:60px;color:var(--muted);text-align:center">No builds yet. Build a design or run a 20-design audit from the campaign.</div>`}
  <div style="margin-top:14px;display:flex;gap:8px"><button class="btn" data-act="reset">Reset demo state</button></div></div>`;
  $('#center').querySelectorAll('[data-open]').forEach(r => r.addEventListener('click', () => go({ view: 'campaign', sel: +r.dataset.open })));
}
function renderVault() {
  const D = S.D; const { train, cal, pool } = D.split;
  $('#center').innerHTML = `<div class="page"><h2>Vault</h2><table class="tbl"><thead><tr><th>Asset</th><th>Kind</th><th class="n">Records</th><th>Notes</th></tr></thead><tbody>
    <tr><td>HPT-blade-section.step</td><td>Geometry</td><td class="n">1</td><td>NACA 00${Math.round(D.blade.thick * 100)} section, ${D.blade.chord * 1000} mm chord, 3 cooling holes</td></tr>
    <tr><td>training-builds</td><td>Simulation</td><td class="n">${train}</td><td>Used to fit the surrogate (GP stand-in for an LPM, ARD length ${D.gp.ell})</td></tr>
    <tr><td>calibration-builds</td><td>Simulation</td><td class="n">${cal}</td><td>Held out; used only by the spec gate</td></tr>
    <tr><td>candidate-pool</td><td>Inference</td><td class="n">${pool.toLocaleString()}</td><td>Predicted mean and σ per design</td></tr>
    <tr><td>conduction-solver</td><td>Solver</td><td class="n">–</td><td>Finite-volume, ${D.blade.nx}×${D.blade.ny}, PCG, Robin BCs (gas ${D.blade.Tgas} K, coolant ${D.blade.Tc} K)</td></tr></tbody></table></div>`;
}

function render() {
  if (!S.D) return; renderTree();
  if (S.view === 'log') { renderLog(); renderAgent(); icons(); return; }
  if (S.view === 'vault') { renderVault(); renderAgent(); icons(); return; }
  renderCampaign(); renderAgent();
}
async function boot() {
  icons(); load(); parse();
  try {
    const r = await fetch('data/designs.json'); if (!r.ok) throw new Error('designs.json: HTTP ' + r.status);
    S.D = await r.json(); if (S.L == null) S.L = S.D.limit; if (!history.state && !location.hash) history.replaceState(null, '', '#/campaign');
    render();
  } catch (e) { $('#center').innerHTML = `<div class="err"><b>Couldn't load the campaign</b><div style="color:var(--muted);margin:8px 0 12px">${esc(e.message)}</div><button class="btn" onclick="location.reload()">Retry</button></div>`; }
}
boot();
