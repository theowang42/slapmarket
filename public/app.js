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
/** 每格期望占的面积，决定一个板块框里画几只。调小图更密，调大更疏。 */
const MIN_CELL_AREA = 1400;
/** 每个板块至少画几只。 */
const MIN_CELLS = 2;

// 字宽用 canvas 实测，不用系数估。按字数 × 系数算会低估 M、W 这类宽字母，
// AMGN、SCHW 就会顶出格子被裁掉。
const measureCtx = document.createElement('canvas').getContext('2d');
const widthCache = new Map();

/** 文字在 100px 字号下实际有多宽。量一次存起来。代码用无衬线，涨跌幅用等宽。 */
function width100(text, mono = false) {
  const key = (mono ? 'm:' : 's:') + text;
  let w = widthCache.get(key);
  if (w == null) {
    const css = getComputedStyle(document.body);
    measureCtx.font = mono
      ? `100px ${css.getPropertyValue('--mono')}`
      : `600 100px ${css.fontFamily}`;
    w = measureCtx.measureText(text).width;
    widthCache.set(key, w);
  }
  return w;
}

/** 字号上限。只有最大的那几只能到这个数。 */
const MAX_FONT = 20;
/** 涨跌幅那行的可读下限。比这还小就干脆不写，写了也看不清，只添乱。 */
const MIN_PCT_FONT = 7.5;

/**
 * 这个格子"该"用多大的字——按面积开一个缓和的幂次。
 *
 * 只用"放得下"来定字号是不行的：小格子横向也放得下 17px，
 * 于是 AMGN 和 LLY 字一样大，图上就没有层次了。
 * 面积每翻一倍，字号只涨约 13%，所以大格子明显大、小格子明显小，又不会悬殊。
 */
const targetFontSize = (cw, ch) => Math.min(MAX_FONT, 2.7 * (cw * ch) ** 0.18);

/** 在给定格子里代码实际能用的字号；放不下返回 0。 */
function symbolFontSize(symbol, cw, ch) {
  if (cw < MIN_W || ch < MIN_H) return 0;
  const fs = Math.min(
    targetFontSize(cw, ch),                      // 该多大
    ((cw - 5) * 100) / width100(symbol),         // 横向放得下多大
    (ch - 3) / 1.15,                             // 纵向放得下多大
  );
  return fs >= MIN_FONT ? fs : 0;
}

/**
 * 排一个板块内部的格子，只留写得下代码的。
 * 返回 { cells, drawn }——drawn 交给外层重算这个板块该占多大。
 */
function fitSector(stocks, inner) {
  const room = Math.max(MIN_CELLS, Math.floor((inner.w * inner.h) / MIN_CELL_AREA));
  let keep = stocks.slice(0, room);
  let cells = squarify(keep.map((q) => ({ value: q.cap, q })), inner);

  // 按面积预筛还不够：squarified 排出来的格子可能又细又长，面积够但宽度不足。
  // 剔掉写不下的重排，剩下的就变宽了。轮次卡死防止抖动。
  for (let iter = 0; iter < 5 && keep.length > 1; iter++) {
    const bad = cells.filter((c) => !symbolFontSize(c.item.q.symbol, c.w - 1, c.h - 1));
    if (!bad.length) break;
    const drop = new Set(bad.map((c) => c.item.q.symbol));
    keep = keep.filter((q) => !drop.has(q.symbol));
    if (!keep.length) keep = stocks.slice(0, 1);
    cells = squarify(keep.map((q) => ({ value: q.cap, q })), inner);
  }
  return { cells, drawn: keep };
}

function renderHeat(d) {
  const host = $('heat');
  const W = host.clientWidth, H = host.clientHeight;
  if (W < 40 || H < 40) return;

  const clamp = d.heatClamp ?? 3;
  const pad = 1.5;

  // 板块框按板块的**完整市值**定大小——这是全图最该保真的一层比例：
  // 哪个板块占大头、今天是什么颜色，一眼就得看对。
  //
  // 板块内部只画得下前几只，剩下的不画。它们的面积由画出来的分掉，
  // 所以板块内部是"前 N 大之间的相对大小"，不是占整个板块的份额。
  // （试过让板块框跟着画出来的缩，结果小板块一缩就崩：房地产的前两只只占
  //  板块两成半市值，框缩到四分之一后连一格都放不下。）
  const boxes = squarify(d.sectors.map((s) => ({ value: s.cap, sector: s })), { x: 0, y: 0, w: W, h: H });

  const laid = boxes.map((b) => {
    const s = b.item.sector;
    const bw = b.w - pad * 2, bh = b.h - pad * 2;
    const showLabel = bh > 40 && bw > 46;
    const inner = { x: 0, y: showLabel ? LABEL_H : 0, w: bw, h: bh - (showLabel ? LABEL_H : 0) };
    const fit = (bw < MIN_W || inner.h < MIN_H) ? { cells: [] } : fitSector(s.stocks, inner);
    return { b, s, bw, bh, showLabel, cells: fit.cells };
  });

  let html = '';
  for (const { b, s, bw, bh, showLabel, cells } of laid) {
    if (bw < 8 || bh < 8) continue;

    const cellHtml = cells.map(({ item: { q }, x, y, w, h }) => {
      const cw = w - 1, ch = h - 1;
      const fs = symbolFontSize(q.symbol, cw, ch) || MIN_FONT;
      // 涨跌幅要两行放得开、而且它自己也得横向放得下（"-15.32%" 比代码还长）
      const pct = fmtPct(q.pct);
      const pctFs = fs * 0.68;
      const showPct = pctFs >= MIN_PCT_FONT
        && ch >= fs * 2.3
        && cw - 5 >= (width100(pct, true) * pctFs) / 100;
      return `<div class="cell${cw < 44 ? ' tiny' : ''}" data-sym="${q.symbol}"
        style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${cw.toFixed(1)}px;height:${ch.toFixed(1)}px;
        background:${heat(q.pct, clamp)};color:${heatText(q.pct, clamp)}"
        ><b style="font-size:${fs.toFixed(1)}px">${q.symbol}</b>${
        showPct ? `<i style="font-size:${pctFs.toFixed(1)}px">${pct}</i>` : ''}</div>`;
    }).join('');

    // 板块名放不下就只留名字不写涨跌，别让它折行
    const cls = dirClass(s.pct);
    const label = showLabel
      ? `<div class="sector-label"><b>${s.name}</b>${bw > 92 ? `<span class="${cls}">${fmtPct(s.pct)}</span>` : ''}</div>`
      : '';

    html += `<div class="sector-box" data-sector="${s.key}"
      style="left:${(b.x + pad).toFixed(1)}px;top:${(b.y + pad).toFixed(1)}px;width:${bw.toFixed(1)}px;height:${bh.toFixed(1)}px">
      ${label}${cellHtml}
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
    </div>`;
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
  if (cell) showTip(cell.dataset.sym, ev); else tip.hidden = true;
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
