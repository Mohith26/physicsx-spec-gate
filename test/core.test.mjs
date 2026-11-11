import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../src/core.js';

const D = JSON.parse(readFileSync(new URL('../data/designs.json', import.meta.url)));
const R = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
const rng = C.mulberry32(5);

test('sampled designs are feasible and canonical (holes sorted by x, wall and gap limits respected)', () => {
  for (let k = 0; k < 200; k++) {
    const d = C.sampleDesign(rng);
    assert.ok(C.feasible(d));
    for (let i = 3; i < d.length; i += 3) assert.ok(d[i] >= d[i - 3]);
  }
});

test('solver obeys the maximum principle: metal temperature stays between coolant and gas temperature', () => {
  for (let k = 0; k < 10; k++) {
    const r = C.solve(C.sampleDesign(rng));
    r.field.forEach(v => { if (!Number.isNaN(v)) { assert.ok(v >= C.BLADE.Tc - 1e-6); assert.ok(v <= C.BLADE.Tgas + 1e-6); } });
    assert.ok(r.residual < 1e-8, 'PCG converged');
  }
});

test('solver is affine in the boundary temperatures (shift both by +100 K -> every cell +100 K)', () => {
  const d = C.sampleDesign(rng);
  const a = C.solve(d), b = C.solve(d, { ...C.BLADE, Tgas: C.BLADE.Tgas + 100, Tc: C.BLADE.Tc + 100 });
  assert.ok(Math.abs(b.Tmax - a.Tmax - 100) < 1e-6);
});

test('property: stronger internal cooling never raises peak temperature', () => {
  for (let k = 0; k < 8; k++) {
    const d = C.sampleDesign(rng);
    const lo = C.solve(d, { ...C.BLADE, hc: 4000 }).Tmax, hi = C.solve(d, { ...C.BLADE, hc: 12000 }).Tmax;
    assert.ok(hi <= lo + 1e-9);
  }
});

test('stored ground truth matches the solver on the stored geometry', () => {
  const r2 = C.mulberry32(77);
  for (let k = 0; k < 25; k++) { const i = Math.floor(r2() * D.designs.length); assert.ok(Math.abs(C.solve(D.designs[i]).Tmax - D.tmax[i]) < 0.01, 'design ' + i); }
});

test('GP surrogate interpolates its training data and is less certain far from it', () => {
  const X = D.designs.slice(0, 120), y = D.tmax.slice(0, 120);
  const gp = C.fitGP(X, y);
  const err = X.map((x, i) => Math.abs(gp.predict(x).mu - y[i]));
  assert.ok(Math.max(...err) < 5, 'max training error ' + Math.max(...err));
  const near = gp.predict(X[0]).sd, far = gp.predict(X[0].map((v, i) => (i % 3 === 2 ? v : v + 0.2))).sd;
  assert.ok(far > near);
});

test('sigma scaling reaches the requested calibration coverage', () => {
  const { train, cal } = D.split; const ix = [...Array(cal).keys()].map(i => i + train);
  const mu = ix.map(i => D.mu[i]), sd = ix.map(i => D.sd[i]), y = ix.map(i => D.tmax[i]);
  const s = C.sigmaScale(mu, sd, y, 0.95, 1.96);
  const cov = y.filter((v, i) => Math.abs(v - mu[i]) <= 1.96 * s * sd[i]).length / y.length;
  assert.ok(cov >= 0.95);
});

test('Benjamini-Hochberg matches a hand-worked example', () => {
  const p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
  const r = C.benjaminiHochberg(p, 0.05);
  assert.equal(r.k, 2); assert.deepEqual([...r.selected].sort(), [0, 1]);
  assert.equal(C.benjaminiHochberg(p, 0.25).k, 10); // step-up: p(10)=0.216 <= 0.25 even though p(8) > 0.2
});

test('property: conformal p-values are valid, P(p <= t and candidate out of spec) <= t', () => {
  const r2 = C.mulberry32(3); let hits = 0; const T = 4000;
  for (let rep = 0; rep < T; rep++) {
    const n = 200; const calS = [], calBad = [];
    for (let i = 0; i < n; i++) { const s = r2(); calS.push(s); calBad.push(r2() < 0.3); }
    const s = r2(), bad = r2() < 0.3; // candidate exchangeable with the calibration designs
    const p = C.conformalPValues(calS, calBad, [s])[0];
    if (bad && p <= 0.1) hits++;
  }
  assert.ok(hits / T <= 0.1 + 0.01, 'P(p<=0.1, null)=' + hits / T);
});

test('randomized: the spec gate controls FDR on synthetic surrogate data (mean FDP <= q)', () => {
  const r2 = C.mulberry32(11); const q = 0.1; const fdps = [];
  for (let rep = 0; rep < 150; rep++) {
    const mk = (n) => { const mu = [], sd = [], y = []; for (let i = 0; i < n; i++) { const m = 1500 + 120 * r2(); const s = 10 + 25 * r2(); const z = Math.sqrt(-2 * Math.log(r2() || 1e-12)) * Math.cos(2 * Math.PI * r2()); mu.push(m); sd.push(s); y.push(m + s * 0.8 * z + 6); } return { mu, sd, y }; };
    const cal = mk(400), cand = mk(600);
    const g = C.specGate(cal, cand, 1560, q); fdps.push(C.evaluate(g.selected, cand.y, 1560).fdp);
  }
  const mean = fdps.reduce((a, b) => a + b, 0) / fdps.length;
  assert.ok(mean <= q + 0.015, 'mean FDP ' + mean);
});

test('shortlists are nested in q (a looser budget never drops a design)', () => {
  const { train, cal, pool } = D.split;
  const pick = (a, n) => { const ix = [...Array(n).keys()].map(i => i + a); return { mu: ix.map(i => D.mu[i]), sd: ix.map(i => D.sd[i]), y: ix.map(i => D.tmax[i]) }; };
  const c = pick(train, cal), t = pick(train + cal, pool);
  let prev = new Set();
  for (const q of [0.01, 0.02, 0.05, 0.1, 0.2, 0.3]) { const g = C.specGate(c, t, D.limit, q); for (const j of prev) assert.ok(g.selected.has(j)); prev = g.selected; }
});

test('evaluate counts false discoveries and power correctly', () => {
  const e = C.evaluate(new Set([0, 1, 2]), [1500, 1600, 1580, 1570], 1590);
  assert.equal(e.selected, 3); assert.equal(e.falseDiscoveries, 1); assert.ok(Math.abs(e.fdp - 1 / 3) < 1e-12); assert.ok(Math.abs(e.power - 2 / 3) < 1e-12);
});

test('headline numbers in results.json reproduce from the committed data', () => {
  const { train, cal, pool } = D.split; const L = D.limit;
  const ixC = [...Array(cal).keys()].map(i => i + train), ixP = [...Array(pool).keys()].map(i => i + train + cal);
  const pk = (ix) => ({ mu: ix.map(i => D.mu[i]), sd: ix.map(i => D.sd[i]), y: ix.map(i => D.tmax[i]) });
  const g = C.specGate(pk(ixC), pk(ixP), L, 0.1);
  const e = C.evaluate(g.selected, pk(ixP).y, L);
  assert.deepEqual(e, R.headline.defaultSplitQ10);
  // repeated-split means (same seed and procedure as scripts/results.mjs)
  const rest = [...ixC, ...ixP]; const r2 = C.mulberry32(4242); const f = [];
  for (let r = 0; r < 300; r++) {
    const sh = C.shuffle(rest, r2); const ci = sh.slice(0, cal), ti = sh.slice(cal);
    for (const q of [0.02, 0.05, 0.1, 0.2]) { const gg = C.specGate(pk(ci), pk(ti), L, q); if (q === 0.1) f.push(C.evaluate(gg.selected, pk(ti).y, L).fdp); }
  }
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  assert.equal(+(100 * mean).toFixed(1), R.headline.gateMeanFDRPct);
  assert.ok(mean <= 0.1, 'FDR guarantee holds on the real dataset');
});
