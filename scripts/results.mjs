// Computes data/results.json from data/designs.json (every number in the README/email comes from here).
import { readFileSync, writeFileSync } from 'node:fs';
import * as C from '../src/core.js';
const D = JSON.parse(readFileSync(new URL('../data/designs.json', import.meta.url)));
const { train, cal, pool } = D.split; const L = D.limit;
const idxCal = [...Array(cal).keys()].map(i => i + train), idxPool = [...Array(pool).keys()].map(i => i + train + cal);
const pick = (ix) => ({ mu: ix.map(i => D.mu[i]), sd: ix.map(i => D.sd[i]), y: ix.map(i => D.tmax[i]) });
function rules(ci, ti, q) {
  const c = pick(ci), t = pick(ti);
  const g = C.specGate(c, t, L, q);
  const s = C.sigmaScale(c.mu, c.sd, c.y, 0.95, 1.96);
  const naive = new Set(), uq = new Set();
  t.mu.forEach((m, i) => { if (m <= L) naive.add(i); if (m + 1.645 * s * t.sd[i] <= L) uq.add(i); });
  return { gate: C.evaluate(g.selected, t.y, L), naive: C.evaluate(naive, t.y, L), uq: C.evaluate(uq, t.y, L), scale: s, k: g.k };
}
const qs = [0.02, 0.05, 0.1, 0.2];
const defaultSplit = Object.fromEntries(qs.map(q => [q, rules(idxCal, idxPool, q)]));
// repeated random calibration/candidate splits of the 3,750 non-training designs
const rest = [...idxCal, ...idxPool]; const R = 300; const rng = C.mulberry32(4242);
const rep = Object.fromEntries(qs.map(q => [q, { fdp: [], power: [], sel: [], uqFdp: [], uqPower: [], naiveFdp: [], naivePower: [] }]));
for (let r = 0; r < R; r++) {
  const sh = C.shuffle(rest, rng); const ci = sh.slice(0, cal), ti = sh.slice(cal);
  for (const q of qs) {
    const o = rules(ci, ti, q); const a = rep[q];
    a.fdp.push(o.gate.fdp); a.power.push(o.gate.power); a.sel.push(o.gate.selected); a.uqFdp.push(o.uq.fdp); a.uqPower.push(o.uq.power); a.naiveFdp.push(o.naive.fdp); a.naivePower.push(o.naive.power);
  }
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const repeated = Object.fromEntries(qs.map(q => { const a = rep[q]; return [q, { splits: R, meanFDR: mean(a.fdp), pFdpAboveQ: a.fdp.filter(f => f > q).length / R, meanPower: mean(a.power), meanSelected: mean(a.sel), uqMeanFDR: mean(a.uqFdp), uqMeanPower: mean(a.uqPower), naiveMeanFDR: mean(a.naiveFdp), naiveMeanPower: mean(a.naivePower) }]; }));
const r10 = repeated[0.1], r02 = repeated[0.02];
const headline = {
  candidates: pool, calibration: cal, limitK: L, inSpecInPool: defaultSplit[0.1].gate.inSpecTotal,
  q: 0.1, gateMeanFDRPct: +(100 * r10.meanFDR).toFixed(1), gatePowerPct: +(100 * r10.meanPower).toFixed(0),
  naiveMeanFDRPct: +(100 * r10.naiveMeanFDR).toFixed(1), naivePowerPct: +(100 * r10.naiveMeanPower).toFixed(0),
  uqGateMeanFDRPct: +(100 * r10.uqMeanFDR).toFixed(1), uqGatePowerPct: +(100 * r10.uqMeanPower).toFixed(0),
  equalErrorQ: 0.02, gatePowerAtEqualErrorPct: +(100 * r02.meanPower).toFixed(0), gateFDRAtEqualErrorPct: +(100 * r02.meanFDR).toFixed(1),
  defaultSplitQ10: defaultSplit[0.1].gate,
};
writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify({ generated: 'scripts/results.mjs', limit: L, defaultSplit, repeated, headline }, null, 1));
console.log(JSON.stringify(headline, null, 1));
for (const q of qs) console.log(q, JSON.stringify(repeated[q]));
