import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyReturns, fitBaseline, score, MIN_DAYS } from '../lib/flock.js';
import { diffHoldings } from '../lib/holdings.js';

/** 可复现的随机数（mulberry32）+ 正态分布 */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
const day = (i) => `2026${String(1 + Math.floor(i / 28)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}`;

test('dailyReturns：按日期给出百分比收益', () => {
  const bars = [{ time: '20261001000000', c: 100 }, { time: '20261002000000', c: 110 }, { time: '20261005000000', c: 99 }];
  assert.deepEqual([...dailyReturns(bars)], [['20261002', 10.000000000000009], ['20261005', -9.999999999999998]]);
});

test('fitBaseline：从模拟数据里认出 β 和平时幅度', () => {
  const r = rng(42);
  const bench = new Map(), own = new Map();
  for (let i = 0; i < 2000; i++) {
    const x = normal(r) * 1.2;                     // 板块每天 ±1.2%
    bench.set(day(i), x);
    own.set(day(i), 1.5 * x + normal(r) * 0.8);    // 个股 β = 1.5，自己的事 ±0.8%
  }
  const b = fitBaseline(own, bench);
  assert.ok(Math.abs(b.beta - 1.5) < 0.05, `beta ${b.beta}`);
  assert.ok(Math.abs(b.sigma - 0.8) < 0.05, `sigma ${b.sigma}`);
});

test('fitBaseline：只用两边都有的日子，样本不够返回 null', () => {
  const bench = new Map(), own = new Map();
  for (let i = 0; i < MIN_DAYS + 5; i++) bench.set(day(i), i % 3);
  for (let i = 0; i < MIN_DAYS - 1; i++) own.set(day(i), i % 2);
  assert.equal(fitBaseline(own, bench), null);
});

test('score：同样多涨，平时稳的票离群程度更高', () => {
  const tsla = { beta: 1.8, sigma: 3.0 }, brk = { beta: 0.6, sigma: 0.7 };
  // 板块今天 +1%，两只都比"该涨的"多涨了 2 个点
  const t = score(1.8 + 2, 1, tsla), k = score(0.6 + 2, 1, brk);
  assert.ok(Math.abs(t.excess - 2) < 1e-9 && Math.abs(k.excess - 2) < 1e-9);
  assert.ok(k.z > 2.5 && t.z < 1, `tsla z=${t.z} brk z=${k.z}`);
});

test('score：缺数据返回 null', () => {
  assert.equal(score(null, 1, { beta: 1, sigma: 1 }), null);
  assert.equal(score(1, 1, null), null);
});

test('diffHoldings：分清进出和换板块', () => {
  const before = { XLK: [{ symbol: 'AAPL' }, { symbol: 'OLD' }], XLC: [{ symbol: 'GOOGL' }] };
  const after = { XLK: [{ symbol: 'AAPL' }, { symbol: 'GOOGL' }], XLC: [{ symbol: 'NEW' }] };
  assert.deepEqual(diffHoldings(before, after), {
    added: ['NEW'], removed: ['OLD'], moved: [{ symbol: 'GOOGL', from: 'XLC', to: 'XLK' }],
  });
});
