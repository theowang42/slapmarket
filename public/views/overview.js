import { fmtPrice, fmtPct, fmtChg, fmtCap, dirClass } from '../js/fmt.js';
import { heat, heatText } from '../js/heat.js';
import { squarify } from '../js/treemap.js';
import { subscribe, refresh } from '../js/store.js';
import { onResize } from '../js/dom.js';
import { sparkSvg } from '../js/spark.js';
import { toast } from '../js/ui.js';

// ── 热力图排版参数 ────────────────────────────────────────────
const LABEL_H = 17;

/** 代码放得下的最小字号。再小就认不出来了，不如不画这格，把地方让给邻居。 */
const MIN_FONT = 8;
/** 格子的硬性下限。光看字号不够——又细又扁的格子字塞得进去，看着还是噪点。 */
const MIN_W = 30, MIN_H = 15;
/** 每格期望占的面积，决定一个板块框里画几只。调小图更密，调大更疏。 */
const MIN_CELL_AREA = 1400;
/** 每个板块至少画几只。 */
const MIN_CELLS = 2;
/** 字号上限。只有最大的那几只能到这个数。 */
const MAX_FONT = 20;
/** 涨跌幅那行的可读下限。比这还小就干脆不写，写了也看不清，只添乱。 */
const MIN_PCT_FONT = 7.5;

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

// ── 骨架 ──────────────────────────────────────────────────────
const SHELL = `
  <section class="indices" id="indices"></section>

  <main class="main">
    <section class="panel heat-panel">
      <div class="panel-head">
        <h2>板块热力图</h2>
        <div class="legend" id="legend"></div>
      </div>
      <div class="heat" id="heat"></div>
    </section>

    <aside class="side">
      <section class="panel">
        <div class="panel-head"><h2>板块排行</h2><span class="hint">SPDR 行业 ETF</span></div>
        <div class="sectors" id="sectors"></div>
      </section>
      <section class="panel side-panel movers-panel">
        <div class="panel-head"><h2>今日异动</h2><span class="hint">全部成分股</span></div>
        <div class="movers" id="movers"></div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <h2>自选</h2>
          <button class="watch-edit" id="watch-edit" title="增删自选股">编辑</button>
        </div>
        <div class="watch" id="watch"></div>
      </section>
    </aside>
  </main>`;

// ── 视图 ──────────────────────────────────────────────────────
export function overview(host) {
  host.innerHTML = SHELL;
  const $ = (id) => host.querySelector(`#${id}`);
  const tip = document.getElementById('tip');
  let data = null;      // 最近一次快照，resize 重排热力图和 tooltip 查价都要用
  let editing = false;  // 自选面板是否在编辑态

  function renderIndices(d) {
    $('indices').innerHTML = d.indices.map((ix, n) => {
      const cls = dirClass(ix.pct, ix.invert);
      const stroke = cls === 'up' ? 'var(--up)' : cls === 'down' ? 'var(--down)' : 'var(--text-3)';
      return `
        <div class="idx fade-in" data-sym="${ix.symbol}" style="animation-delay:${n * 45}ms">
          <div class="idx-name">${ix.name}</div>
          <div class="idx-row">
            <span class="idx-price num">${fmtPrice(ix.last)}</span>
            <span class="idx-chg num ${cls}">${fmtPct(ix.pct)}</span>
          </div>
          <div class="idx-sub num">${fmtChg(ix.change)}</div>
          ${sparkSvg({ pts: ix.spark, prev: ix.prev, stroke, gid: `g${n}` })}
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
    const rows = d.watchlist.map((q) => {
      const cls = dirClass(q.pct);
      const ext = q.ext && q.ext.pct != null && q.status !== 'REG_MKT'
        ? `<span class="hint" style="margin-left:6px">${q.ext.type === 'PRE_MKT' ? '盘前' : '盘后'} ${fmtPct(q.ext.pct)}</span>` : '';
      return `
        <div class="wrow${editing ? ' is-editing' : ''}" data-sym="${q.symbol}" title="${q.name}">
          ${editing ? `<button class="wrow-del" data-del="${q.symbol}" title="移除 ${q.symbol}">×</button>` : ''}
          <span class="wrow-sym">${q.symbol}${ext}</span>
          <span class="wrow-px num">${fmtPrice(q.last)}</span>
          <span class="wrow-pct num ${cls}">${fmtPct(q.pct)}</span>
        </div>`;
    }).join('');

    // 表单而不是裸 input：回车提交是浏览器自带的，不用自己听键盘
    const adder = editing
      ? `<form class="watch-add" id="watch-add" autocomplete="off">
           <input id="watch-input" placeholder="加代码，回车确认" maxlength="12" spellcheck="false">
         </form>`
      : '';
    // 轮询会重绘整个面板。不把输入框的内容和光标接过去的话，
    // 交易时段每 30 秒就会把用户正在打的代码清空一次。
    const old = $('watch-input');
    const keep = old
      ? { value: old.value, focused: document.activeElement === old, caret: old.selectionStart }
      : null;

    $('watch').innerHTML = rows + adder;

    const box = $('watch-input');
    if (!box) return;
    if (!keep) { box.focus(); return; }       // 刚进编辑态，光标放进去
    box.value = keep.value;
    if (keep.focused) {
      box.focus();
      box.setSelectionRange(keep.caret, keep.caret);
    }
  }

  function renderLegend(clamp) {
    const stops = [-1, -0.6, -0.25, 0, 0.25, 0.6, 1].map((t) => `<i style="background:${heat(t * clamp, clamp)}"></i>`).join('');
    $('legend').innerHTML = `<span>−${clamp}%</span><span class="legend-scale">${stops}</span><span>+${clamp}%</span>`;
  }

  function renderHeat(d) {
    const host2 = $('heat');
    const W = host2.clientWidth, H = host2.clientHeight;
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

    host2.innerHTML = html;
  }

  // ── 悬浮提示 ────────────────────────────────────────────────
  function showTip(sym, ev) {
    const q = data?.sectors.flatMap((s) => s.stocks.map((x) => ({ ...x, sector: s.name }))).find((x) => x.symbol === sym);
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
    tip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.min(ev.clientY + 14, window.innerHeight - r.height - 8)}px`;
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
    host.querySelectorAll('.sector-box').forEach((b) => {
      b.style.opacity = b.dataset.sector === row.dataset.sector ? '1' : '.28';
    });
  });
  $('sectors').addEventListener('mouseleave', () => {
    host.querySelectorAll('.sector-box').forEach((b) => { b.style.opacity = ''; });
  });

  // 异动榜 ⇄ 热力图：悬停某只股票，在热力图里把它框出来
  const outline = (sym, on) => {
    const cell = host.querySelector(`.cell[data-sym="${CSS.escape(sym)}"]`);
    if (!cell) return;
    cell.style.outline = on ? '1.5px solid rgba(255,255,255,.75)' : '';
    cell.style.zIndex = on ? '4' : '';
  };
  $('movers').addEventListener('mouseover', (ev) => {
    const row = ev.target.closest('.mrow');
    if (row) outline(row.dataset.sym, true);
  });
  $('movers').addEventListener('mouseout', (ev) => {
    const row = ev.target.closest('.mrow');
    if (row) outline(row.dataset.sym, false);
  });

  // ── 自选增删 ────────────────────────────────────────────────
  /** 当前列表（从最近一次快照取），改完 POST 回服务端。 */
  const currentSymbols = () => (data?.watchlist ?? []).map((q) => q.symbol);

  /**
   * 存回服务端。ok 提示要**立刻**给——服务端清掉报价缓存后，
   * 下一次 /api/overview 要把两百多只成分股重拉一遍，好几秒才回来。
   * 那几秒里页面一动不动，不吭声的话用户会以为回车没生效，接着再按一次。
   */
  async function save(symbols, ok) {
    try {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols }),
      });
      const d = await res.json();
      if (d.error) { toast(d.error); return false; }
      toast(ok);
      await refresh();     // 服务端已经把 quotes 缓存清了，普通刷新就能拿到新列表
      return true;
    } catch (e) {
      toast(`保存失败：${e.message}`);
      return false;
    }
  }

  $('watch-edit').addEventListener('click', () => {
    editing = !editing;
    $('watch-edit').textContent = editing ? '完成' : '编辑';
    $('watch-edit').classList.toggle('on', editing);
    if (data) renderWatch(data);
  });

  host.addEventListener('submit', async (ev) => {
    if (ev.target.id !== 'watch-add') return;
    ev.preventDefault();
    const input = $('watch-input');
    const sym = input.value.trim().toUpperCase();
    if (!sym) return;
    if (currentSymbols().includes(sym)) { toast(`${sym} 已经在自选里`); input.value = ''; return; }
    input.disabled = true;
    const ok = await save([...currentSymbols(), sym], `已添加 ${sym}`);
    // 失败时把输入留着，让人改一个字母就能重试，不用整个重打
    const box = $('watch-input');
    if (box) { box.disabled = false; if (ok) box.value = ''; box.focus(); }
  });

  // ── 下钻 ────────────────────────────────────────────────────
  // 指数条、热力图方块、异动榜、自选，四处都能点进个股页。事件委托挂在 host 上，
  // 内容重绘多少次都不用重新绑。
  host.addEventListener('click', (ev) => {
    // 删除按钮在 .wrow 里面，得先拦下来，否则会顺手跳进个股页
    const del = ev.target.closest('[data-del]');
    if (del) {
      const sym = del.dataset.del;
      save(currentSymbols().filter((s) => s !== sym), `已移除 ${sym}`);
      return;
    }
    if (editing && ev.target.closest('.wrow')) return;   // 编辑模式下不跳转
    const hit = ev.target.closest('.idx[data-sym], .cell[data-sym], .mrow[data-sym], .wrow[data-sym]');
    if (hit) location.hash = `#/s/${encodeURIComponent(hit.dataset.sym)}`;
  });

  // ── 生命周期 ────────────────────────────────────────────────
  function render(d) {
    data = d;
    renderIndices(d);
    renderLegend(d.heatClamp ?? 3);
    renderSectors(d);
    renderMovers(d);
    renderWatch(d);
    renderHeat(d);
  }

  const stopResize = onResize($('heat'), () => { if (data) renderHeat(data); });
  const unsubscribe = subscribe(render);

  // 视图内的监听随 DOM 一起销毁，但订阅和 observer 必须自己收
  return () => {
    unsubscribe();
    stopResize();
    tip.hidden = true;
  };
}
