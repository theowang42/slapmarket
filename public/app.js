// ── 格式化 ────────────────────────────────────────────────────
const fmtPrice = (v) => v == null ? '—' : v.toLocaleString('en-US', {
  minimumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2,
  maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2,
});
const fmtPct = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
const fmtChg = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
const fmtCap = (v) => v >= 1e12 ? `${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : `${(v / 1e6).toFixed(0)}M`;
const dirClass = (v, invert) => {
  if (v == null || v === 0) return 'flat';
  return (invert ? -v : v) > 0 ? 'up' : 'down';
};

/**
 * 涨跌 → 颜色。0 附近落在中性深灰上，越极端越饱和越亮。
 * 上限由服务端的 HEAT_CLAMP 决定（默认 ±3%）。
 */
function heat(pct, clamp) {
  const t = Math.max(-1, Math.min(1, (pct ?? 0) / clamp));
  const a = Math.abs(t) ** 1.15; // 稍微压一压小涨小跌，别让整屏都在发光
  const hue = t >= 0 ? 154 : 355;
  return `hsl(${hue} ${(5 + 45 * a).toFixed(1)}% ${(13 + 17 * a).toFixed(1)}%)`;
}
const heatText = (pct, clamp) => `rgba(255,255,255,${(0.5 + 0.45 * Math.min(1, Math.abs((pct ?? 0) / clamp))).toFixed(2)})`;

// ── Squarified treemap ───────────────────────────────────────
function worst(row, short) {
  const sum = row.reduce((a, b) => a + b, 0);
  if (!sum) return Infinity;
  const max = Math.max(...row), min = Math.min(...row);
  return Math.max((short * short * max) / (sum * sum), (sum * sum) / (short * short * min));
}

/** items: [{value, ...}] → [{item, x, y, w, h}]，方块尽量接近正方形。 */
function squarify(items, rect) {
  const nodes = items.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const total = nodes.reduce((s, d) => s + d.value, 0);
  const out = [];
  if (!total || rect.w <= 0 || rect.h <= 0) return out;

  let { x, y, w, h } = rect;
  const areas = nodes.map((d) => (d.value / total) * rect.w * rect.h);
  let i = 0;

  while (i < areas.length && w > 0.5 && h > 0.5) {
    const short = Math.min(w, h);
    const row = [areas[i]];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], short) <= worst(row, short)) {
      row.push(areas[j]); j++;
    }
    const rowSum = row.reduce((a, b) => a + b, 0);
    const thick = Math.min(rowSum / short, w >= h ? w : h);
    let off = 0;
    for (let k = 0; k < row.length; k++) {
      const len = thick > 0 ? row[k] / thick : 0;
      out.push(w >= h
        ? { item: nodes[i + k], x, y: y + off, w: thick, h: len }
        : { item: nodes[i + k], x: x + off, y, w: len, h: thick });
      off += len;
    }
    if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    i = j;
  }
  return out;
}

// ── 渲染 ──────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
let state = null;

function renderHeader(d) {
  const s = d.session;
  const pill = $('session');
  pill.dataset.phase = s.phase;
  pill.querySelector('.pill-label').textContent = s.note ? `${s.label} · ${s.note}` : s.label;
  $('et').textContent = `ET ${s.etTime}`;

  const b = d.breadth;
  const t = Math.max(1, b.up + b.down + b.flat);
  $('breadth').innerHTML = `
    <span class="up">${b.up}</span>
    <span class="breadth-bar">
      <i style="width:${(b.up / t * 100).toFixed(1)}%;background:var(--up)"></i>
      <i style="width:${(b.flat / t * 100).toFixed(1)}%;background:var(--text-3)"></i>
      <i style="width:${(b.down / t * 100).toFixed(1)}%;background:var(--down)"></i>
    </span>
    <span class="down">${b.down}</span>`;

  const at = new Date(d.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false });
  $('meta').textContent = `更新 ${at} · 延迟约 15 分钟 · R 刷新`;
}

function sparkPath(pts, w, h, pad = 3) {
  if (pts.length < 2) return { line: '', area: '', baseY: h / 2 };
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const X = (i) => (i / (pts.length - 1)) * w;
  const Y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  return { line, area: `${line}L${w},${h}L0,${h}Z`, Y };
}

function renderIndices(d) {
  $('indices').innerHTML = d.indices.map((ix, n) => {
    const cls = dirClass(ix.pct, ix.invert);
    const stroke = cls === 'up' ? 'var(--up)' : cls === 'down' ? 'var(--down)' : 'var(--text-3)';
    const W = 300, H = 34;
    const { line, area, Y } = sparkPath(ix.spark ?? [], W, H);
    const prevY = Y && ix.prev != null ? Y(ix.prev) : null;
    const gid = `g${n}`;
    return `
      <div class="idx fade-in" style="animation-delay:${n * 45}ms">
        <div class="idx-name">${ix.name}</div>
        <div class="idx-row">
          <span class="idx-price num">${fmtPrice(ix.last)}</span>
          <span class="idx-chg num ${cls}">${fmtPct(ix.pct)}</span>
        </div>
        <div class="idx-sub num">${fmtChg(ix.change)}</div>
        <svg class="idx-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stop-color="${stroke}" stop-opacity=".22"/>
            <stop offset="1" stop-color="${stroke}" stop-opacity="0"/>
          </linearGradient></defs>
          ${area ? `<path d="${area}" fill="url(#${gid})"/>` : ''}
          ${prevY != null && isFinite(prevY) ? `<line x1="0" x2="${W}" y1="${prevY.toFixed(1)}" y2="${prevY.toFixed(1)}" stroke="rgba(255,255,255,.16)" stroke-width="1" stroke-dasharray="2 3"/>` : ''}
          ${line ? `<path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}
        </svg>
      </div>`;
  }).join('');
}

function renderSectors(d) {
  const max = Math.max(0.35, ...d.sectors.map((s) => Math.abs(s.pct)));
  const sorted = [...d.sectors].sort((a, b) => b.pct - a.pct);
  $('sectors').innerHTML = sorted.map((s) => {
    const cls = dirClass(s.pct);
    const wPct = (Math.abs(s.pct) / max) * 50;
    const left = s.pct >= 0 ? 50 : 50 - wPct;
    const color = cls === 'up' ? 'var(--up)' : cls === 'down' ? 'var(--down)' : 'var(--text-3)';
    return `
      <div class="srow" data-sector="${s.key}" title="${s.etf} · 市值 ${fmtCap(s.cap)}">
        <span class="srow-name">${s.name}</span>
        <span class="srow-track"><i class="srow-fill" style="left:${left}%;width:${wPct}%;background:${color};opacity:.85"></i></span>
        <span class="srow-pct num ${cls}">${fmtPct(s.pct)}</span>
      </div>`;
  }).join('');
}

function renderMovers(d) {
  const all = d.sectors.flatMap((s) => s.stocks.map((q) => ({ ...q, sector: s.name })))
    .sort((a, b) => b.pct - a.pct);
  const n = 4;
  const row = (q) => `
    <div class="mrow" data-sym="${q.symbol}">
      <span class="mrow-sym">${q.symbol}</span>
      <span class="mrow-sec">${q.sector}</span>
      <span class="mrow-pct num ${dirClass(q.pct)}">${fmtPct(q.pct)}</span>
    </div>`;
  $('movers').innerHTML =
    `<div class="movers-split">领涨</div>${all.slice(0, n).map(row).join('')}`
    + `<div class="movers-split">领跌</div>${all.slice(-n).reverse().map(row).join('')}`;
}

function renderWatch(d) {
  $('watch').innerHTML = d.watchlist.map((q) => {
    const cls = dirClass(q.pct);
    const ext = q.ext && q.ext.pct != null && q.status !== 'REG_MKT'
      ? `<span class="hint" style="margin-left:6px">${q.ext.type === 'PRE_MKT' ? '盘前' : '盘后'} ${fmtPct(q.ext.pct)}</span>` : '';
    return `
      <div class="wrow" title="${q.name}">
        <span class="wrow-sym">${q.symbol}${ext}</span>
        <span class="wrow-px num">${fmtPrice(q.last)}</span>
        <span class="wrow-pct num ${cls}">${fmtPct(q.pct)}</span>
      </div>`;
  }).join('');
}

function renderLegend(clamp) {
  const stops = [-1, -0.6, -0.25, 0, 0.25, 0.6, 1].map((t) => `<i style="background:${heat(t * clamp, clamp)}"></i>`).join('');
  $('legend').innerHTML = `<span>−${clamp}%</span><span class="legend-scale">${stops}</span><span>+${clamp}%</span>`;
}

// ── 热力图 ────────────────────────────────────────────────────
const LABEL_H = 17;

/** 代码放得下的最小字号。再小就认不出来了，不如不画这格，把地方让给邻居。 */
const MIN_FONT = 8;
/** 格子的硬性下限。光看字号不够——又细又扁的格子字塞得进去，看着还是噪点。 */
const MIN_W = 30, MIN_H = 15;
/** 等宽字体的字宽约为字号的 0.62 倍，用来估算代码要占多宽。 */
const CHAR_W = 0.62;
/** 每格期望占的面积，决定一个板块框里画几只。调小图更密，调大更疏。 */
const MIN_CELL_AREA = 1400;
/** 每个板块至少画几只，再小的板块也不至于只剩一格。 */
const MIN_CELLS = 2;

/** 在给定格子里代码能用的字号；放不下返回 0。 */
function symbolFontSize(symbol, cw, ch) {
  if (cw < MIN_W || ch < MIN_H) return 0;
  const fs = Math.min(17, (cw - 4) / (symbol.length * CHAR_W), (ch - 2) / 1.15);
  return fs >= MIN_FONT ? fs : 0;
}

/**
 * 排布一个板块内部的格子，保证**画出来的每一格都放得下代码**。
 *
 * 只按面积预筛不够：squarified 排出来的格子可能又细又长，面积够但宽度不足。
 * 所以先排一次，把放不下名字的剔掉，用剩下的重排，反复几轮直到全部合格。
 *
 * 剔掉的不能凭空消失——它们的市值汇成一个"其他"格子一起参与排布。
 * 否则留下的格子会把空出来的面积吃掉，图上就会出现"林德 = 整个材料板块"这种假象。
 */
function layoutCells(stocks, inner) {
  // 第一步：按板块框的面积决定画几只。这一步必须先做——
  // 如果直接靠"排完再剔"收敛，剔掉的市值会喂大"其他"格，"其他"又把邻居挤小、
  // 于是剔掉更多，一路缩到只剩一两只。先按面积定量就不会进这个循环。
  const room = Math.max(MIN_CELLS, Math.floor((inner.w * inner.h) / MIN_CELL_AREA));
  let keep = stocks.slice(0, room);

  // "其他"格的大小在这里一次定死，后面不再变。
  // 如果让形状修正剔掉的票也并进来，这一格每轮都会变大、把邻居挤得更小，
  // 于是剔掉更多——一路缩到只剩一两只。
  const cut = stocks.slice(room);
  const rest = cut.length ? { value: cut.reduce((a, b) => a + b.cap, 0), rest: cut.length } : null;

  // 第二步：有限轮次的形状修正。面积够但又细又长的格子照样写不下名字，
  // 剔掉重排。这一步剔掉的面积由邻居分掉，数量很少，失真可以忽略。
  const layout = () => squarify([...keep.map((q) => ({ value: q.cap, q })), ...(rest ? [rest] : [])], inner);

  for (let iter = 0; iter < 4; iter++) {
    const cells = layout();
    const bad = cells.filter((c) => c.item.q && !symbolFontSize(c.item.q.symbol, c.w - 1, c.h - 1));
    if (!bad.length) return cells;

    const drop = new Set(bad.map((c) => c.item.q.symbol));
    const survivors = keep.filter((q) => !drop.has(q.symbol));
    // 剪到头了就按市值取前几只收手，别把带坏格子的布局原样返回
    if (survivors.length < MIN_CELLS) { keep = keep.slice(0, MIN_CELLS); break; }
    keep = survivors;
  }

  // 收尾兜底：上面按 MIN_CELLS 收手时，留下的可能仍有写不下名字的。
  // 窄窗口下就会这样。再剪一次，最少留最大的那一只。
  let cells = layout();
  const stillBad = cells.filter((c) => c.item.q && !symbolFontSize(c.item.q.symbol, c.w - 1, c.h - 1));
  if (stillBad.length && keep.length > 1) {
    const drop = new Set(stillBad.map((c) => c.item.q.symbol));
    keep = keep.filter((q) => !drop.has(q.symbol));
    if (!keep.length) keep = stocks.slice(0, 1);
    cells = layout();
  }
  return cells;
}

function renderHeat(d) {
  const host = $('heat');
  const W = host.clientWidth, H = host.clientHeight;
  if (W < 40 || H < 40) return;

  const clamp = d.heatClamp ?? 3;
  const boxes = squarify(d.sectors.map((s) => ({ value: s.cap, sector: s })), { x: 0, y: 0, w: W, h: H });
  const pad = 1.5;
  let html = '';

  for (const b of boxes) {
    const s = b.item.sector;
    const bw = b.w - pad * 2, bh = b.h - pad * 2;
    if (bw < 8 || bh < 8) continue;
    const showLabel = bh > 40 && bw > 52;
    const inner = { x: 0, y: showLabel ? LABEL_H : 0, w: bw, h: bh - (showLabel ? LABEL_H : 0) };

    const cells = layoutCells(s.stocks, inner);
    // 标在"其他"格上的数字要等于真正没画出来的只数：
    // 除了按面积裁掉的，还有形状修正剔掉的那几只。
    const hidden = s.stocks.length - cells.filter((c) => c.item.q).length;

    const cellHtml = cells.map(({ item, x, y, w, h }) => {
      const cw = w - 1, ch = h - 1;
      const pos = `left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${cw.toFixed(1)}px;height:${ch.toFixed(1)}px`;

      // 没画出来的那些汇成一格中性灰，只标还剩多少只
      if (item.rest) {
        const label = cw > 24 && ch > 12
          ? `<i style="font-size:${Math.min(11, ch / 2.2).toFixed(1)}px">+${hidden}</i>` : '';
        return `<div class="cell rest" data-rest="${s.key}" style="${pos}">${label}</div>`;
      }

      const q = item.q;
      const fs = symbolFontSize(q.symbol, cw, ch);
      const showPct = fs && cw > 44 && ch >= fs * 2.1;
      // fs 为 0 说明这格实在放不下名字（只会出现在极窄的板块框里）。
      // 那就干脆别写——0px 的文字在 DOM 里存在却看不见，比留白更难查。
      const body = (fs ? `<b style="font-size:${fs.toFixed(1)}px">${q.symbol}</b>` : '')
        + (showPct ? `<i style="font-size:${(fs * 0.68).toFixed(1)}px">${fmtPct(q.pct)}</i>` : '');
      return `<div class="cell${cw < 44 ? ' tiny' : ''}" data-sym="${q.symbol}"
        style="${pos};background:${heat(q.pct, clamp)};color:${heatText(q.pct, clamp)}">${body}</div>`;
    }).join('');

    const cls = dirClass(s.pct);
    html += `<div class="sector-box" data-sector="${s.key}"
      style="left:${(b.x + pad).toFixed(1)}px;top:${(b.y + pad).toFixed(1)}px;width:${bw.toFixed(1)}px;height:${bh.toFixed(1)}px">
      ${showLabel ? `<div class="sector-label"><b>${s.name}</b><span class="${cls}">${fmtPct(s.pct)}</span></div>` : ''}
      ${cellHtml}
    </div>`;
  }

  host.innerHTML = html;
}

// ── 悬浮提示 ──────────────────────────────────────────────────
const tip = $('tip');
function showTip(sym, ev) {
  const q = state?.sectors.flatMap((s) => s.stocks.map((x) => ({ ...x, sector: s.name }))).find((x) => x.symbol === sym);
  if (!q) return;
  const cls = dirClass(q.pct);
  tip.innerHTML = `
    <div class="tip-sym">${q.symbol}</div>
    <div class="tip-name">${q.name ?? ''}</div>
    <div class="tip-grid">
      <span>现价</span><b>${fmtPrice(q.last)}</b>
      <span>涨跌</span><b class="${cls}">${fmtPct(q.pct)}</b>
      <span>市值</span><b>${fmtCap(q.cap)}</b>
      <span>板块</span><b>${q.sector}</b>
      <span>来源</span><b>${q.pinned ? 'config 固定' : 'ETF 持仓'}</b>
    </div>`;
  tip.hidden = false;
  moveTip(ev);
}
/** "其他"格子的提示：列出被折叠的是哪些票，别让人以为那是块空白。 */
function showRestTip(sectorKey, ev) {
  const s = state?.sectors.find((x) => x.key === sectorKey);
  if (!s) return;
  const drawn = new Set([...document.querySelectorAll(`.sector-box[data-sector="${sectorKey}"] .cell[data-sym]`)]
    .map((c) => c.dataset.sym));
  const rest = s.stocks.filter((q) => !drawn.has(q.symbol));
  const cap = rest.reduce((a, b) => a + b.cap, 0);
  tip.innerHTML = `
    <div class="tip-sym">未画出 ${rest.length} 只</div>
    <div class="tip-name">${s.name} · 位置不够写名字。拉大窗口会多显示几只</div>
    <div class="tip-grid">
      <span>合计市值</span><b>${fmtCap(cap)}</b>
      <span>占板块</span><b>${((cap / s.cap) * 100).toFixed(1)}%</b>
    </div>
    <div class="tip-name" style="margin-top:4px">灰格只代表其中一部分，其余面积被已画出的格子分掉了</div>
    <div class="tip-name" style="margin-top:5px">${rest.slice(0, 12).map((q) => q.symbol).join(' ')}${rest.length > 12 ? ' …' : ''}</div>`;
  tip.hidden = false;
  moveTip(ev);
}

function moveTip(ev) {
  const r = tip.getBoundingClientRect();
  const x = Math.min(ev.clientX + 14, window.innerWidth - r.width - 8);
  const y = Math.min(ev.clientY + 14, window.innerHeight - r.height - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

$('heat').addEventListener('mousemove', (ev) => {
  const cell = ev.target.closest('.cell');
  if (!cell) { tip.hidden = true; return; }
  if (cell.dataset.rest) showRestTip(cell.dataset.rest, ev);
  else showTip(cell.dataset.sym, ev);
});
$('heat').addEventListener('mouseleave', () => { tip.hidden = true; });

// 板块排行 ⇄ 热力图联动：悬停某个板块，热力图里其它板块暗下去
$('sectors').addEventListener('mouseover', (ev) => {
  const row = ev.target.closest('.srow');
  if (!row) return;
  document.querySelectorAll('.sector-box').forEach((b) => {
    b.style.opacity = b.dataset.sector === row.dataset.sector ? '1' : '.28';
  });
});
$('sectors').addEventListener('mouseleave', () => {
  document.querySelectorAll('.sector-box').forEach((b) => { b.style.opacity = ''; });
});

// 异动榜 ⇄ 热力图：悬停某只股票，在热力图里把它框出来
$('movers').addEventListener('mouseover', (ev) => {
  const row = ev.target.closest('.mrow');
  if (!row) return;
  const cell = document.querySelector(`.cell[data-sym="${CSS.escape(row.dataset.sym)}"]`);
  if (cell) { cell.style.outline = '1.5px solid rgba(255,255,255,.75)'; cell.style.zIndex = '4'; }
});
$('movers').addEventListener('mouseout', (ev) => {
  const row = ev.target.closest('.mrow');
  if (!row) return;
  const cell = document.querySelector(`.cell[data-sym="${CSS.escape(row.dataset.sym)}"]`);
  if (cell) { cell.style.outline = ''; cell.style.zIndex = ''; }
});

// ── 数据获取 ──────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

async function load({ force = false } = {}) {
  try {
    const res = await fetch(`/api/overview${force ? '?force=1' : ''}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state = data;
    renderHeader(data);
    renderIndices(data);
    renderLegend(data.heatClamp ?? 3);
    renderSectors(data);
    renderMovers(data);
    renderWatch(data);
    renderHeat(data);
  } catch (e) {
    toast(`行情获取失败：${e.message}`);
  }
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state) renderHeat(state); }, 120);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') { toast('强制刷新中…'); load({ force: true }); }
});

// 交易时段 30 秒一刷，收盘后放慢到 5 分钟；切回标签页立刻补一次。
function tick() {
  const phase = state?.session?.phase;
  load();
  const next = phase === 'open' ? 30_000 : phase === 'pre' || phase === 'post' ? 60_000 : 300_000;
  setTimeout(tick, next);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state && Date.now() - state.fetchedAt > 30_000) load();
});

tick();
