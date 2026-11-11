// Seeded dataset: blade-cooling designs, ground-truth peak metal temperature from the conduction solver,
// and GP surrogate predictions (mean, sd) for every design. Run: node scripts/seed.mjs  (~25 s)
import { writeFileSync, mkdirSync } from 'node:fs';
import * as C from '../src/core.js';

const rng = C.mulberry32(20261111);
const N_TRAIN = 250, N_CAL = 750, N_POOL = 3000;
const N = N_TRAIN + N_CAL + N_POOL;
const designs = [], tmax = [], area = [];
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const d = C.sampleDesign(rng);
  const r = C.solve(d);
  designs.push(d.map(v => Math.round(v * 1e5) / 1e5)); tmax.push(Math.round(r.Tmax * 100) / 100); area.push(C.coolantArea(d));
}
// re-solve with the rounded designs so stored geometry and stored truth agree exactly
for (let i = 0; i < N; i++) tmax[i] = Math.round(C.solve(designs[i]).Tmax * 100) / 100;
const gp = C.fitGP(designs.slice(0, N_TRAIN), tmax.slice(0, N_TRAIN));
const pred = designs.map(d => gp.predict(d));
const sorted = tmax.slice(N_TRAIN).sort((a, b) => a - b);
const limit = Math.round(sorted[Math.floor(0.3 * sorted.length)] / 5) * 5; // spec: ~30% of the space is in spec
const baseline = C.canonical([0.16, 0.0, 0.03, 0.36, 0.0, 0.03, 0.56, 0.0, 0.026]);
const b = C.solve(baseline);
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
const data = {
  blade: C.BLADE, limit, split: { train: N_TRAIN, cal: N_CAL, pool: N_POOL }, gp: { ell: gp.ell, n: gp.n },
  baseline: { design: baseline, tmax: Math.round(b.Tmax * 100) / 100, area: C.coolantArea(baseline) },
  ids: designs.map((_, i) => 1000 + i),
  designs, tmax, mu: pred.map(p => Math.round(p.mu * 100) / 100), sd: pred.map(p => Math.round(p.sd * 1000) / 1000),
};
writeFileSync(new URL('../data/designs.json', import.meta.url), JSON.stringify(data));
console.log('designs', N, 'limit', limit, 'gp ell', gp.ell, 'baseline', b.Tmax.toFixed(1), ((Date.now() - t0) / 1000).toFixed(1) + 's');
