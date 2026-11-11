// Spec Gate: shortlist AI-predicted designs with a guaranteed false-discovery rate.
// Pure ES module (browser, Web Worker, Node). Three parts:
//   1) a 2-D steady conduction solver for a cooled turbine-blade section (ground truth "build"),
//   2) a Gaussian-process surrogate (stand-in for a Large Physics Model) with post-hoc sigma scaling,
//   3) conformal selection (Jin & Candes 2023): conformal p-values + Benjamini-Hochberg, which guarantees
//      E[#out-of-spec among shortlisted / #shortlisted] <= q when calibration and candidate designs are exchangeable.

// ---------------- randomness ----------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rng) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---------------- geometry + solver ----------------
export const BLADE = {
  chord: 0.05,            // m
  thick: 0.30,            // NACA 00xx thickness ratio (thick HPT-like section)
  nx: 120, ny: 40,        // grid over x in [0,1], y in [-0.2, 0.2] (chord units)
  k: 20,                  // W/mK, nickel superalloy
  Tgas: 1700, hLE: 4200, hTE: 1500, hDecay: 0.10, // hot-gas side: leading-edge stagnation peak
  Tc: 850, hc: 9000,      // internal coolant
  xEval: 0.75,            // peak metal temperature evaluated on x <= 0.75 (TE has separate ejection cooling)
  nHoles: 3, rMin: 0.016, rMax: 0.040, wallMin: 0.012, gapMin: 0.012, xMin: 0.07, xMax: 0.70,
};
export function halfThickness(x, t = BLADE.thick) {
  if (x <= 0 || x >= 1) return 0;
  return 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
}
/** Design vector: [x1,y1,r1, x2,y2,r2, x3,y3,r3] in chord units; holes sorted by x (canonical order). */
export function canonical(d) {
  const h = []; for (let i = 0; i < d.length; i += 3) h.push([d[i], d[i + 1], d[i + 2]]);
  h.sort((a, b) => a[0] - b[0]); return h.flat();
}
export function feasible(d, B = BLADE) {
  const n = d.length / 3;
  for (let i = 0; i < n; i++) {
    const [x, y, r] = [d[3 * i], d[3 * i + 1], d[3 * i + 2]];
    if (x < B.xMin || x > B.xMax || r < B.rMin || r > B.rMax) return false;
    // wall thickness: distance from circle to the surface, sampled along the hole's x-extent
    for (let s = -1; s <= 1; s += 0.25) {
      const xs = x + s * r, yt = halfThickness(xs, B.thick);
      const dy = Math.sqrt(Math.max(0, r * r - (s * r) ** 2));
      if (Math.abs(y) + dy > yt - B.wallMin) return false;
    }
    for (let j = 0; j < i; j++) {
      const dd = Math.hypot(x - d[3 * j], y - d[3 * j + 1]);
      if (dd < r + d[3 * j + 2] + B.gapMin) return false;
    }
  }
  return true;
}
export function sampleDesign(rng, B = BLADE) {
  for (let tries = 0; tries < 10000; tries++) {
    const d = [];
    for (let i = 0; i < B.nHoles; i++) {
      const x = B.xMin + (B.xMax - B.xMin) * rng();
      const r = B.rMin + (B.rMax - B.rMin) * rng();
      const room = Math.max(0, halfThickness(x, B.thick) - r - B.wallMin);
      const y = (2 * rng() - 1) * room;
      d.push(x, y, r);
    }
    const c = canonical(d);
    if (feasible(c, B)) return c;
  }
  throw new Error('sampleDesign: no feasible design');
}
export function coolantArea(d) { let a = 0; for (let i = 0; i < d.length; i += 3) a += Math.PI * d[i + 2] ** 2; return a; }

/**
 * Finite-volume steady conduction on the blade section with Robin (convective) boundaries to hot gas outside and
 * coolant inside the holes. Returns {Tmax, field (Float32Array nx*ny, NaN outside metal), cells, iters, residual}.
 */
export function solve(d, B = BLADE, opt = {}) {
  const { nx, ny } = B; const dx = 1 / nx, dy = 0.4 / ny; const h = dx * B.chord; // physical cell size (square)
  const N = nx * ny;
  const kind = new Uint8Array(N); // 0 gas, 1 metal, 2 coolant
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = (i + 0.5) * dx, y = -0.2 + (j + 0.5) * dy;
    let k = Math.abs(y) <= halfThickness(x, B.thick) ? 1 : 0;
    if (k) for (let q = 0; q < d.length; q += 3) if ((x - d[q]) ** 2 + (y - d[q + 1]) ** 2 <= d[q + 2] ** 2) { k = 2; break; }
    kind[j * nx + i] = k;
  }
  const idx = new Int32Array(N).fill(-1); let M = 0;
  for (let c = 0; c < N; c++) if (kind[c] === 1) idx[c] = M++;
  const diag = new Float64Array(M), rhs = new Float64Array(M);
  const nbr = new Int32Array(M * 4).fill(-1), gnb = new Float64Array(M * 4);
  const Gs = B.k; // metal-metal conductance per unit span (square cells)
  const robin = (hc) => (hc * h) / (1 + (hc * h) / (2 * B.k));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i; const m = idx[c]; if (m < 0) continue;
    const x = (i + 0.5) * dx;
    const hg = B.hTE + (B.hLE - B.hTE) * Math.exp(-x / B.hDecay);
    const nb = [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]];
    nb.forEach(([a, b], q) => {
      const kc = (a < 0 || b < 0 || a >= nx || b >= ny) ? 0 : kind[b * nx + a];
      if (kc === 1) { diag[m] += Gs; nbr[4 * m + q] = idx[b * nx + a]; gnb[4 * m + q] = Gs; }
      else if (kc === 0) { const g = robin(hg); diag[m] += g; rhs[m] += g * B.Tgas; }
      else { const g = robin(B.hc); diag[m] += g; rhs[m] += g * B.Tc; }
    });
  }
  // Preconditioned conjugate gradient (SPD system)
  const T = new Float64Array(M).fill(0.5 * (B.Tgas + B.Tc));
  const Ap = (p, out) => { for (let m = 0; m < M; m++) { let s = diag[m] * p[m]; for (let q = 0; q < 4; q++) { const n = nbr[4 * m + q]; if (n >= 0) s -= gnb[4 * m + q] * p[n]; } out[m] = s; } };
  const r = new Float64Array(M), z = new Float64Array(M), p = new Float64Array(M), q = new Float64Array(M);
  Ap(T, q); for (let m = 0; m < M; m++) { r[m] = rhs[m] - q[m]; z[m] = r[m] / diag[m]; p[m] = z[m]; }
  let rz = 0; for (let m = 0; m < M; m++) rz += r[m] * z[m];
  const bn = Math.sqrt(rhs.reduce((s, v) => s + v * v, 0)) || 1;
  let it = 0, res = 1;
  for (; it < (opt.maxIter || 4000); it++) {
    Ap(p, q); let pq = 0; for (let m = 0; m < M; m++) pq += p[m] * q[m];
    const al = rz / pq; let rr = 0;
    for (let m = 0; m < M; m++) { T[m] += al * p[m]; r[m] -= al * q[m]; rr += r[m] * r[m]; }
    res = Math.sqrt(rr) / bn; if (res < (opt.tol || 1e-10)) break;
    let rz2 = 0; for (let m = 0; m < M; m++) { z[m] = r[m] / diag[m]; rz2 += r[m] * z[m]; }
    const be = rz2 / rz; rz = rz2; for (let m = 0; m < M; m++) p[m] = z[m] + be * p[m];
  }
  const field = new Float32Array(N).fill(NaN);
  let Tmax = -Infinity, at = -1;
  for (let c = 0; c < N; c++) { const m = idx[c]; if (m < 0) continue; field[c] = T[m]; const x = ((c % nx) + 0.5) * dx; if (x <= B.xEval && T[m] > Tmax) { Tmax = T[m]; at = c; } }
  return { Tmax, at, field, kind, cells: M, iters: it, residual: res, nx, ny };
}

// ---------------- Gaussian-process surrogate ----------------
function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i * n + j]; for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
    if (i === j) { if (s <= 0) throw new Error('not SPD'); L[i * n + i] = Math.sqrt(s); } else L[i * n + j] = s / L[j * n + j];
  }
  return L;
}
function cholSolve(L, n, b) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}
/** Fit an RBF-ARD GP. Lengthscales: per-dimension base scale times a global factor chosen by marginal likelihood. */
export function fitGP(X, y, opt = {}) {
  const n = X.length, D = X[0].length;
  const lo = Array.from({ length: D }, (_, d) => Math.min(...X.map(r => r[d]))), hi = Array.from({ length: D }, (_, d) => Math.max(...X.map(r => r[d])));
  const norm = (r) => r.map((v, d) => (v - lo[d]) / ((hi[d] - lo[d]) || 1));
  const Z = X.map(norm);
  const ym = y.reduce((a, b) => a + b, 0) / n, ys = Math.sqrt(y.reduce((a, b) => a + (b - ym) ** 2, 0) / n) || 1;
  const t = y.map(v => (v - ym) / ys);
  const noise = opt.noise ?? 1e-3;
  let best = null;
  for (const ell of opt.ells || [0.25, 0.35, 0.5, 0.7, 1.0]) {
    const A = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      let s = 0; for (let d = 0; d < D; d++) { const e = (Z[i][d] - Z[j][d]) / ell; s += e * e; }
      const v = Math.exp(-0.5 * s) + (i === j ? noise : 0); A[i * n + j] = v; A[j * n + i] = v;
    }
    let L; try { L = cholesky(A, n); } catch { continue; }
    const alpha = cholSolve(L, n, t);
    let logdet = 0; for (let i = 0; i < n; i++) logdet += Math.log(L[i * n + i]);
    const ll = -0.5 * t.reduce((s, v, i) => s + v * alpha[i], 0) - logdet;
    if (!best || ll > best.ll) best = { ell, L, alpha, ll };
  }
  const { ell, L, alpha } = best;
  function predict(x) {
    const z = norm(x); const kx = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let d = 0; d < D; d++) { const e = (z[d] - Z[i][d]) / ell; s += e * e; } kx[i] = Math.exp(-0.5 * s); }
    let mu = 0; for (let i = 0; i < n; i++) mu += kx[i] * alpha[i];
    // variance: k(x,x) - v'v with v = L^-1 kx
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = kx[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * v[k]; v[i] = s / L[i * n + i]; }
    let vv = 0; for (let i = 0; i < n; i++) vv += v[i] * v[i];
    const sd = Math.sqrt(Math.max(1e-12, 1 + noise - vv));
    return { mu: ym + ys * mu, sd: ys * sd };
  }
  return { predict, ell, ll: best.ll, n };
}

/** Post-hoc sigma scaling (the standard practice): smallest factor s such that mu +/- z*s*sd covers `target` of calibration. */
export function sigmaScale(mu, sd, y, target = 0.95, z = 1.96) {
  const r = y.map((v, i) => Math.abs(v - mu[i]) / (z * sd[i])).sort((a, b) => a - b);
  return r[Math.min(r.length - 1, Math.ceil(target * r.length) - 1)];
}

// ---------------- conformal selection (Jin & Candes 2023) ----------------
/**
 * Score: larger = more confidently in spec. s(x) = (limit - mu(x)) / sd(x).
 * Conformal p-value for candidate j (null: candidate is OUT of spec, y > limit):
 *   p_j = (1 + #{calibration i out of spec with s_i >= s_j}) / (n + 1).
 */
export function conformalPValues(calS, calBad, candS) {
  const bad = calS.filter((_, i) => calBad[i]).sort((a, b) => a - b); // ascending
  const n = calS.length;
  return candS.map(s => {
    // count bad calibration scores >= s via binary search
    let lo = 0, hi = bad.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bad[m] < s) lo = m + 1; else hi = m; }
    return (1 + (bad.length - lo)) / (n + 1);
  });
}
/** Benjamini-Hochberg at level q. Returns {selected: Set of indices, k, threshold}. */
export function benjaminiHochberg(p, q) {
  const m = p.length; const order = p.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  let k = 0; for (let r = 1; r <= m; r++) if (order[r - 1][0] <= (q * r) / m) k = r;
  const thr = k ? (q * k) / m : 0;
  const selected = new Set(); for (let r = 0; r < k; r++) selected.add(order[r][1]);
  return { selected, k, threshold: thr };
}
export function specGate(cal, cand, limit, q) {
  const calS = cal.mu.map((m, i) => (limit - m) / cal.sd[i]);
  const calBad = cal.y.map(v => v > limit);
  const candS = cand.mu.map((m, i) => (limit - m) / cand.sd[i]);
  const p = conformalPValues(calS, calBad, candS);
  const bh = benjaminiHochberg(p, q);
  return { p, score: candS, ...bh };
}
/** Realized false-discovery proportion and power when ground truth is known (evaluation only). */
export function evaluate(selected, yTrue, limit) {
  let sel = 0, bad = 0, good = 0, goodSel = 0;
  yTrue.forEach((v, i) => { const s = selected.has ? selected.has(i) : selected[i]; if (v <= limit) good++; if (s) { sel++; if (v > limit) bad++; else goodSel++; } });
  return { selected: sel, falseDiscoveries: bad, fdp: sel ? bad / sel : 0, power: good ? goodSel / good : 0, inSpecTotal: good };
}
