import { fmtPrice, fmtPct, fmtChg, fmtVol, dirClass, etToday } from '../js/fmt.js';
import { drawChart, fmtFullTime } from '../js/chart.js';
import { quoteFlags, extHours, metricRows, divBar } from '../js/widgets.js';
import { onResize } from '../js/dom.js';

/**
 * 首页右侧滑出来的盘面：点了舞台上的人或雕塑就打开，舞台在后面照常动。
 * K 线、分时、关键指标都有；雕塑还会列出板块里涨跌最猛的几只，点了直接换过去。
 */

const RANGES = ['1D', '5D', '1M', '3M', '6M', '1Y', '5Y', 'ALL'];
const LABEL = { '1D': '当日', '5D': '5日', '1M': '1月', '3M': '3月', '6M': '6月', '1Y': '1年', '5Y': '5年', ALL: '全部' };

const SHELL = `
  <header class="dr-head">
    <div class="dr-id">
      <div class="dr-sym" data-f="sym"></div>
      <div class="dr-name" data-f="name"></div>
    </div>
    <button class="dr-close" title="关闭（Esc）">×</button>
  </header>
  <div class="dr-px">
    <span class="dr-last num" data-f="last">—</span>
    <span class="dr-chg num" data-f="chg"></span>
  </div>
  <div class="dr-ext" data-f="ext"></div>
  <div class="dr-flags" data-f="flags"></div>
  <div class="dr-bar">
    <div class="ranges">${RANGES.map((r) => `<button data-range="${r}">${LABEL[r]}</button>`).join('')}</div>
    <span class="hint num dr-readout" data-f="readout"></span>
  </div>
  <div class="dr-chart"><canvas></canvas></div>
  <div class="dr-members" data-f="members"></div>
  <div class="kv" data-f="kv"></div>
  <a class="dr-more" data-f="more">在看盘中打开 →</a>`;

export function createDrawer(root, { onPick }) {
  root.innerHTML = SHELL;
  const $ = (f) => root.querySelector(`[data-f="${f}"]`);
  const canvas = root.querySelector('canvas');

  let target = null;          // { sym, title, members }
  let range = '1D';
  let payload = null;
  let chart = null;
  let hover = null;
  let busy = false;
  let seq = 0;                // 换了只票时，丢掉还在路上的旧请求

  function paint() {
    if (!payload?.bars) return;
    chart = drawChart(canvas, { bars: payload.bars, intraday: payload.intraday, prevClose: payload.quote.prev, hover });
  }
  const stopResize = onResize(canvas, paint);

  function render() {
    const q = payload.quote;
    const cls = dirClass(q.pct);
    $('sym').textContent = target.title ?? q.symbol;
    $('name').textContent = [q.name, q.exchange].filter(Boolean).join(' · ');
    $('last').textContent = fmtPrice(q.last);
    $('chg').className = `dr-chg num ${cls}`;
    $('chg').textContent = `${fmtChg(q.change)}  ${fmtPct(q.pct)}`;
    $('ext').innerHTML = extHours(q);
    $('flags').innerHTML = quoteFlags(q, etToday());
    $('kv').innerHTML = metricRows(q).map(([k, v]) => `<span class="kv-k">${k}</span><b class="kv-v num">${v}</b>`).join('');
    $('more').href = `#/s/${encodeURIComponent(q.symbol)}`;
    paint();
  }

  function renderMembers() {
    const m = target.members;
    if (!m?.length) { $('members').innerHTML = ''; return; }
    const pick = [...m.slice(0, 3), ...m.slice(-3).reverse()].filter((x, i, a) => a.findIndex((y) => y.symbol === x.symbol) === i);
    const max = Math.max(0.5, ...pick.map((x) => Math.abs(x.pct)));
    $('members').innerHTML = `<div class="dr-sub">板块里涨跌最猛的</div>` + pick.map((x) => `
      <div class="peer" data-sym="${x.symbol}">
        <span class="peer-sym">${x.symbol}</span>
        ${divBar(x.pct, max)}
        <span class="peer-pct num ${dirClass(x.pct)}">${fmtPct(x.pct)}</span>
      </div>`).join('');
  }

  async function load() {
    if (!target) return;
    const my = ++seq;
    busy = true;
    try {
      const res = await fetch(`/api/symbol?s=${encodeURIComponent(target.sym)}&range=${range}`);
      const d = await res.json();
      if (my !== seq || !target) return;
      if (d.error) throw new Error(d.error);
      payload = d;
      render();
    } catch (e) {
      if (my === seq) $('name').textContent = `加载失败：${e.message}`;
    } finally {
      if (my === seq) busy = false;
    }
  }

  function markRange() {
    for (const b of root.querySelectorAll('[data-range]')) b.classList.toggle('on', b.dataset.range === range);
  }

  root.addEventListener('click', (e) => {
    const r = e.target.closest('[data-range]');
    if (r && r.dataset.range !== range) { range = r.dataset.range; markRange(); hover = null; load(); return; }
    if (e.target.closest('.dr-close')) { api.close(); return; }
    const peer = e.target.closest('.peer[data-sym]');
    if (peer) onPick(peer.dataset.sym);
  });

  canvas.addEventListener('mousemove', (ev) => {
    if (!chart || !payload?.bars?.length) return;
    const i = chart.hitTest(ev.clientX - canvas.getBoundingClientRect().left);
    if (i === hover) return;
    hover = i;
    paint();
    const b = payload.bars[i];
    const prev = i ? payload.bars[i - 1].c : (payload.intraday ? payload.quote.prev ?? b.c : b.c);
    const chg = prev ? ((b.c - prev) / prev) * 100 : 0;
    $('readout').innerHTML = `${fmtFullTime(b.time, payload.intraday)} <b>${fmtPrice(b.c)}</b> <b class="${dirClass(chg)}">${fmtPct(chg)}</b> 量 ${fmtVol(b.v)}`;
  });
  canvas.addEventListener('mouseleave', () => { hover = null; $('readout').textContent = ''; paint(); });

  const api = {
    get open() { return !!target; },
    get sym() { return target?.sym; },
    /** target: { sym, title?, members? } */
    show(t) {
      const same = target?.sym === t.sym;
      target = t;
      root.classList.add('is-open');
      renderMembers();
      if (!same) {
        payload = null; hover = null;
        $('sym').textContent = t.title ?? t.sym;
        $('name').textContent = '加载中…';
        $('last').textContent = '—'; $('chg').textContent = ''; $('kv').innerHTML = ''; $('flags').innerHTML = ''; $('ext').innerHTML = '';
        canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
        markRange();
        load();
      }
    },
    close() { target = null; seq++; root.classList.remove('is-open'); },
    /** 行情刷新时跟着刷。上一次还没回来就跳过，别堆请求 */
    refresh() { if (target && !busy) load(); },
    destroy() { stopResize(); },
  };
  markRange();
  return api;
}
