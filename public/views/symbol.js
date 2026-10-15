import { fmtPrice, fmtPct, fmtChg, fmtCap, dirClass } from '../js/fmt.js';
import { subscribe, snapshot } from '../js/store.js';
import { onResize } from '../js/dom.js';
import { drawChart, fmtFullTime, fmtVol } from '../js/chart.js';
import { toast } from '../js/ui.js';

const RANGES = ['1D', '5D', '1M', '3M', '6M', '1Y', '5Y', 'ALL'];
const RANGE_LABEL = { '1D': '当日', '5D': '5日', '1M': '1月', '3M': '3月', '6M': '6月', '1Y': '1年', '5Y': '5年', ALL: '全部' };

const SHELL = `
  <div class="sym-head panel">
    <button class="sym-back" title="返回总览（Esc）">←</button>
    <div class="sym-id">
      <div class="sym-code" id="sym-code">—</div>
      <div class="sym-name" id="sym-name"></div>
    </div>
    <div class="sym-px">
      <span class="sym-last num" id="sym-last">—</span>
      <span class="sym-chg num" id="sym-chg"></span>
      <span class="sym-ext" id="sym-ext"></span>
    </div>
    <div class="sym-flags" id="sym-flags"></div>
  </div>

  <div class="sym-main">
    <section class="panel chart-panel">
      <div class="panel-head">
        <div class="ranges" id="ranges">${RANGES.map((r) => `<button data-range="${r}">${RANGE_LABEL[r]}</button>`).join('')}</div>
        <span class="hint num" id="readout"></span>
      </div>
      <div class="chart-wrap"><canvas id="chart"></canvas></div>
    </section>

    <aside class="sym-side">
      <section class="panel">
        <div class="panel-head"><h2>关键指标</h2><span class="hint">TTM</span></div>
        <div class="kv" id="kv"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>52 周区间</h2><span class="hint" id="r52-hint"></span></div>
        <div class="r52" id="r52"></div>
      </section>
      <section class="panel peers-panel">
        <div class="panel-head"><h2>同板块</h2><span class="hint" id="peer-hint"></span></div>
        <div class="peers" id="peers"></div>
      </section>
    </aside>
  </div>`;

/** 指标格子。null 一律显示 —，不要显示 0 或 NaN 冒充有数据。 */
function metricRows(q) {
  const n = (v, digits = 2, suffix = '') => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits) + suffix);
  const cap = (v) => (v == null ? '—' : fmtCap(v));
  return [
    ['市盈率', n(q.pe)], ['远期市盈率', n(q.fpe)],
    ['每股收益', n(q.eps)], ['预期 EPS', n(q.feps)],
    ['市销率', n(q.psales)], ['股息率', n(q.dividendYield, 2, '%')],
    ['Beta', n(q.beta)], ['ROE', n(q.roe, 1, '%')],
    ['毛利率', n(q.grossMargin, 1, '%')], ['净利率', n(q.netMargin, 1, '%')],
    ['负债/权益', n(q.debtToEquity, 1, '%')], ['营收 TTM', cap(q.revenueTTM)],
    ['市值', cap(q.cap)], ['10 日均量', q.avgVol10d ? fmtVol(q.avgVol10d) : '—'],
    ['今开', fmtPrice(q.open)], ['最高', fmtPrice(q.high)],
    // 指数不报成交量，给的是 0——同样别拿 0 冒充数据
    ['最低', fmtPrice(q.low)], ['成交量', q.volume ? fmtVol(q.volume) : '—'],
  ];
}

export function symbol(host, { sym }) {
  host.innerHTML = SHELL;
  const $ = (id) => host.querySelector(`#${id}`);
  const canvas = $('chart');

  let range = sessionStorage.getItem('ump:range') || '1D';
  if (!RANGES.includes(range)) range = '1D';
  let payload = null;      // 最近一次 /api/symbol 响应
  let chart = null;        // drawChart 返回的命中测试
  let hover = null;
  let alive = true;

  // ── 绘制 ────────────────────────────────────────────────────
  function paint() {
    if (!payload?.bars) return;
    chart = drawChart(canvas, {
      bars: payload.bars,
      intraday: payload.intraday,
      prevClose: payload.quote.prev,
      hover,
    });
  }

  function renderHead(q) {
    $('sym-code').innerHTML = `${q.symbol}${q.exchange ? `<span class="sym-ex">${q.exchange}</span>` : ''}`;
    const sec = peerSector();
    $('sym-name').textContent = [q.name, sec?.name].filter(Boolean).join(' · ');

    const cls = dirClass(q.pct);
    $('sym-last').textContent = fmtPrice(q.last);
    $('sym-chg').className = `sym-chg num ${cls}`;
    $('sym-chg').textContent = `${fmtChg(q.change)} (${fmtPct(q.pct)})`;

    const ext = q.ext && q.ext.pct != null && q.status !== 'REG_MKT'
      ? `${q.ext.type === 'PRE_MKT' ? '盘前' : '盘后'} ${fmtPrice(q.ext.last)} <b class="${dirClass(q.ext.pct)}">${fmtPct(q.ext.pct)}</b>` : '';
    $('sym-ext').innerHTML = ext;

    const e = q.events ?? {};
    const flags = [];
    if (e.halted) flags.push('<span class="flag warn">停牌</span>');
    if (e.atYrHi) flags.push('<span class="flag up">创 52 周新高</span>');
    if (e.atYrLo) flags.push('<span class="flag down">创 52 周新低</span>');
    if (e.earningsDate) {
      const when = e.earningsWhen === 'A' ? '盘后' : e.earningsWhen === 'B' ? '盘前' : '';
      flags.push(`<span class="flag">财报 ${e.earningsDate}${when ? ` ${when}` : ''}</span>`);
    }
    if (e.exDivDate && e.divAmount) flags.push(`<span class="flag">除息 ${e.exDivDate} $${e.divAmount}</span>`);
    $('sym-flags').innerHTML = flags.join('');
  }

  function renderMetrics(q) {
    $('kv').innerHTML = metricRows(q)
      .map(([k, v]) => `<span class="kv-k">${k}</span><b class="kv-v num">${v}</b>`).join('');
  }

  function render52(q) {
    const { yrLo: lo, yrHi: hi, last } = q;
    if (lo == null || hi == null || hi <= lo) { $('r52').innerHTML = '<span class="hint">暂无数据</span>'; return; }
    const pos = Math.max(0, Math.min(1, (last - lo) / (hi - lo)));
    const fromHi = ((last - hi) / hi) * 100;
    $('r52-hint').textContent = `距高点 ${fromHi.toFixed(1)}%`;
    $('r52').innerHTML = `
      <div class="r52-track"><i class="r52-mark" style="left:${(pos * 100).toFixed(1)}%"></i></div>
      <div class="r52-ends">
        <span><b class="num">${fmtPrice(lo)}</b><em>${q.yrLoDate ?? ''}</em></span>
        <span class="r52-right"><b class="num">${fmtPrice(hi)}</b><em>${q.yrHiDate ?? ''}</em></span>
      </div>`;
  }

  /** 当前这只属于哪个板块——直接问总览的 store，不用再打接口。 */
  function peerSector() {
    return snapshot()?.sectors?.find((s) => s.stocks.some((x) => x.symbol === sym));
  }

  function renderPeers() {
    const s = peerSector();
    if (!s) {
      $('peers').innerHTML = '<span class="hint">不在热力图成分股里</span>';
      $('peer-hint').textContent = '';
      return;
    }
    $('peer-hint').textContent = `${s.name} ${fmtPct(s.pct)}`;
    const rows = [...s.stocks].sort((a, b) => b.pct - a.pct);
    const max = Math.max(0.35, ...rows.map((x) => Math.abs(x.pct)));
    // 这里补上了热力图的失真：板块里画不下的那些，在这张表里都在
    $('peers').innerHTML = rows.map((x) => {
      const cls = dirClass(x.pct);
      const w = (Math.abs(x.pct) / max) * 50;
      const left = x.pct >= 0 ? 50 : 50 - w;
      const color = cls === 'up' ? 'var(--up)' : cls === 'down' ? 'var(--down)' : 'var(--text-3)';
      return `<div class="peer${x.symbol === sym ? ' is-self' : ''}" data-sym="${x.symbol}">
        <span class="peer-sym">${x.symbol}</span>
        <span class="srow-track"><i class="srow-fill" style="left:${left}%;width:${w}%;background:${color};opacity:.85"></i></span>
        <span class="peer-pct num ${cls}">${fmtPct(x.pct)}</span>
      </div>`;
    }).join('');
  }

  function renderAll() {
    if (!payload) return;
    const q = payload.quote;
    renderHead(q);
    renderMetrics(q);
    render52(q);
    renderPeers();
    paint();
  }

  // ── 取数 ────────────────────────────────────────────────────
  async function load() {
    try {
      const res = await fetch(`/api/symbol?s=${encodeURIComponent(sym)}&range=${range}`);
      const d = await res.json();
      if (!alive) return;                       // 请求飞在路上时用户已经切走了
      if (d.error) throw new Error(d.error);
      payload = d;
      hover = null;
      $('readout').textContent = '';
      renderAll();
    } catch (e) {
      if (!alive) return;
      toast(`${sym} 加载失败：${e.message}`);
      if (!payload) $('sym-name').textContent = `加载失败：${e.message}`;
    }
  }

  // ── 交互 ────────────────────────────────────────────────────
  function markRange() {
    for (const b of $('ranges').querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.range === range);
    }
  }
  markRange();

  $('ranges').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-range]');
    if (!b || b.dataset.range === range) return;
    range = b.dataset.range;
    sessionStorage.setItem('ump:range', range);   // 换只股票时沿用上次看的区间
    markRange();
    load();
  });

  const readout = (i) => {
    const b = payload.bars[i];
    const prev = i ? payload.bars[i - 1].c : (payload.intraday ? payload.quote.prev ?? b.c : b.c);
    const chg = prev ? ((b.c - prev) / prev) * 100 : 0;
    const ohlc = payload.intraday ? '' : ` 开${fmtPrice(b.o)} 高${fmtPrice(b.h)} 低${fmtPrice(b.l)}`;
    $('readout').innerHTML = `${fmtFullTime(b.time, payload.intraday)}　收<b>${fmtPrice(b.c)}</b>${ohlc}`
      + `　<b class="${dirClass(chg)}">${fmtPct(chg)}</b>　量 ${fmtVol(b.v)}`;
  };

  canvas.addEventListener('mousemove', (ev) => {
    if (!chart || !payload?.bars?.length) return;
    const i = chart.hitTest(ev.clientX - canvas.getBoundingClientRect().left);
    if (i === hover) return;
    hover = i;
    paint();
    readout(i);
  });
  canvas.addEventListener('mouseleave', () => {
    if (hover == null) return;
    hover = null; paint(); $('readout').textContent = '';
  });

  const back = () => { location.hash = '#/'; };
  host.querySelector('.sym-back').addEventListener('click', back);
  const onKey = (ev) => { if (ev.key === 'Escape') back(); };
  window.addEventListener('keydown', onKey);
  // canvas 的颜色是画的时候读的，切白天/夜间不会自己变，得重画
  window.addEventListener('themechange', paint);

  // 同板块列表里点别的票，直接换页
  $('peers').addEventListener('click', (ev) => {
    const p = ev.target.closest('.peer[data-sym]');
    if (p && p.dataset.sym !== sym) location.hash = `#/s/${encodeURIComponent(p.dataset.sym)}`;
  });

  // ── 生命周期 ────────────────────────────────────────────────
  const stopResize = onResize(canvas, paint);

  // 借总览的轮询节奏：store 一更新说明该刷了，顺手把这只也刷一遍。
  // 首次回调是订阅时的当前快照，那时 load() 已经在路上，别重复打。
  let first = true;
  const unsubscribe = subscribe(() => {
    if (first) { first = false; renderPeers(); return; }
    load();
  });

  load();

  return () => {
    alive = false;
    unsubscribe();
    stopResize();
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('themechange', paint);
  };
}
