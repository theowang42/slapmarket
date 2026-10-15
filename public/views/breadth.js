import { fmtPct, fmtCap, dirClass } from '../js/fmt.js';
import { subscribe } from '../js/store.js';

/**
 * 市场宽度。整页不打任何新接口——`/api/overview` 早就把两百来只成分股的
 * 涨跌幅、市值、板块全传下来了，之前只用来数了个涨跌家数，浪费得厉害。
 */

/** 直方图分桶：±5% 以内每 0.5% 一格，超出的塞进两端。 */
const BUCKET = 0.5;
const EDGE = 5;

const SHELL = `
  <section class="panel bd-top">
    <div class="bd-stats" id="bd-stats"></div>
  </section>
  <div class="bd-main">
    <section class="panel">
      <div class="panel-head"><h2>涨跌幅分布</h2><span class="hint" id="hist-hint"></span></div>
      <div class="hist" id="hist"></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>板块内部离散度</h2><span class="hint">最低 · 中位 · 最高</span></div>
      <div class="disp" id="disp"></div>
    </section>
  </div>`;

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function breadth(host) {
  host.innerHTML = SHELL;
  const $ = (id) => host.querySelector(`#${id}`);

  function render(d) {
    const all = d.sectors.flatMap((s) => s.stocks.map((q) => ({ ...q, sector: s.name, key: s.key })));
    if (!all.length) return;

    const up = all.filter((q) => q.pct > 0).length;
    const down = all.filter((q) => q.pct < 0).length;

    // 等权 vs 市值加权。指数是市值加权的，两者一背离就说明
    // 今天的涨跌是被少数几只大票带的，而不是普遍现象。
    const equal = all.reduce((a, q) => a + q.pct, 0) / all.length;
    const capSum = all.reduce((a, q) => a + (q.cap ?? 0), 0);
    const weighted = capSum ? all.reduce((a, q) => a + q.pct * (q.cap ?? 0), 0) / capSum : 0;
    const gap = equal - weighted;

    const spx = d.indices.find((i) => i.symbol === '^GSPC');
    const gapNote = Math.abs(gap) < 0.15
      ? '涨跌普遍，指数没有被少数股票带偏'
      : gap < 0
        ? '大票跑赢小票，指数被少数几只撑着'
        : '小票跑赢大票，指数低估了普涨的程度';

    $('bd-stats').innerHTML = `
      <div class="bd-stat">
        <span class="bd-k">上涨 / 下跌</span>
        <b class="bd-v"><span class="up">${up}</span> <i>/</i> <span class="down">${down}</span></b>
        <span class="bd-sub">共 ${all.length} 只</span>
      </div>
      <div class="bd-stat">
        <span class="bd-k">等权涨跌</span>
        <b class="bd-v num ${dirClass(equal)}">${fmtPct(equal)}</b>
        <span class="bd-sub">每只票权重相同</span>
      </div>
      <div class="bd-stat">
        <span class="bd-k">市值加权</span>
        <b class="bd-v num ${dirClass(weighted)}">${fmtPct(weighted)}</b>
        <span class="bd-sub">${spx ? `标普 ${fmtPct(spx.pct)}` : '指数口径'}</span>
      </div>
      <div class="bd-stat bd-gap">
        <span class="bd-k">背离</span>
        <b class="bd-v num ${dirClass(gap)}">${fmtPct(gap)}</b>
        <span class="bd-sub">${gapNote}</span>
      </div>`;

    // ── 直方图 ──
    const n = Math.round((EDGE * 2) / BUCKET);
    const buckets = Array.from({ length: n }, () => []);
    const idxOf = (pct) => {
      const clamped = Math.max(-EDGE, Math.min(EDGE - 1e-9, pct));
      return Math.min(n - 1, Math.floor((clamped + EDGE) / BUCKET));
    };
    for (const q of all) buckets[idxOf(q.pct)].push(q);
    const peak = Math.max(1, ...buckets.map((b) => b.length));
    const outLo = all.filter((q) => q.pct < -EDGE).length;
    const outHi = all.filter((q) => q.pct > EDGE).length;
    $('hist-hint').textContent = outLo || outHi
      ? `两端含 ${outLo} 只跌超 ${EDGE}%、${outHi} 只涨超 ${EDGE}%`
      : `每格 ${BUCKET}%`;

    $('hist').innerHTML = `
      <div class="hist-bars">
        ${buckets.map((b, i) => {
          const lo = -EDGE + i * BUCKET;
          const cls = lo >= 0 ? 'up' : 'down';
          const names = b.sort((a, x) => (x.cap ?? 0) - (a.cap ?? 0)).slice(0, 12).map((q) => q.symbol).join(' ');
          return `<i class="hist-bar ${cls}" style="height:${((b.length / peak) * 100).toFixed(1)}%"
            title="${lo.toFixed(1)}% ~ ${(lo + BUCKET).toFixed(1)}%：${b.length} 只${names ? `\n${names}` : ''}"></i>`;
        }).join('')}
      </div>
      <div class="hist-axis">
        <span>−${EDGE}%</span><span>−2.5%</span><span class="hist-zero">0</span><span>+2.5%</span><span>+${EDGE}%</span>
      </div>`;

    // ── 板块离散度 ──
    // 板块排行只给一个数，看不出"整体在涨"还是"被一两只拉起来"。这里画全距。
    const rows = d.sectors.map((s) => {
      const pcts = s.stocks.map((q) => q.pct);
      return {
        name: s.name, etf: s.etf, pct: s.pct, n: pcts.length,
        min: Math.min(...pcts), max: Math.max(...pcts), mid: median(pcts),
        up: pcts.filter((p) => p > 0).length,
      };
    }).sort((a, b) => b.mid - a.mid);

    const lim = Math.max(1.5, ...rows.map((r) => Math.max(Math.abs(r.min), Math.abs(r.max))));
    const pos = (v) => ((v + lim) / (lim * 2)) * 100;

    $('disp').innerHTML = rows.map((r) => `
      <div class="disp-row" title="${r.etf} · ${r.n} 只 · ${r.up} 涨 ${r.n - r.up} 跌">
        <span class="disp-name">${r.name}</span>
        <span class="disp-track">
          <i class="disp-zero"></i>
          <i class="disp-span" style="left:${pos(r.min).toFixed(1)}%;width:${(pos(r.max) - pos(r.min)).toFixed(1)}%"></i>
          <i class="disp-mid ${dirClass(r.mid)}" style="left:${pos(r.mid).toFixed(1)}%"></i>
        </span>
        <span class="disp-mid-v num ${dirClass(r.mid)}">${fmtPct(r.mid)}</span>
        <span class="disp-n num">${r.up}/${r.n}</span>
      </div>`).join('');
  }

  const unsubscribe = subscribe(render);
  return () => unsubscribe();
}
