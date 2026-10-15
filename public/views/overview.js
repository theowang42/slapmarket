import { fmtPrice, fmtPct, fmtChg, fmtVol, dirClass, dirColor, etToday } from '../js/fmt.js';
import { subscribe, refresh } from '../js/store.js';
import { sparkSvg, divBar, rangeBar, quoteFlags, extHours } from '../js/widgets.js';
import { toast } from '../js/dom.js';

// ── 骨架 ──────────────────────────────────────────────────────
// 自选是主角，占主区。板块和异动退到侧栏当背景信息。
const SHELL = `
  <section class="indices" id="indices"></section>

  <main class="main">
    <section class="panel watch-panel">
      <div class="panel-head">
        <h2>自选</h2>
        <span class="hint" id="watch-hint"></span>
        <button class="watch-edit" id="watch-edit" title="增删自选股">编辑</button>
      </div>
      <div class="wgrid" id="watch"></div>
    </section>

    <aside class="side">
      <section class="panel">
        <div class="panel-head"><h2>板块排行</h2><span class="hint">SPDR 行业 ETF</span></div>
        <div class="sectors" id="sectors"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>今日异动</h2><span class="hint">全部成分股</span></div>
        <div class="movers" id="movers"></div>
      </section>
    </aside>
  </main>`;

// ── 视图 ──────────────────────────────────────────────────────
export function overview(host) {
  host.innerHTML = SHELL;
  const $ = (id) => host.querySelector(`#${id}`);
  let data = null;      // 最近一次快照，增删自选时拿当前列表
  let editing = false;  // 自选面板是否在编辑态

  function renderIndices(d) {
    $('indices').innerHTML = d.indices.map((ix, n) => {
      const cls = dirClass(ix.pct, ix.invert);
      return `
        <div class="idx fade-in" data-sym="${ix.symbol}" style="animation-delay:${n * 45}ms">
          <div class="idx-name">${ix.name}</div>
          <div class="idx-row">
            <span class="idx-price num">${fmtPrice(ix.last)}</span>
            <span class="idx-chg num ${cls}">${fmtPct(ix.pct)}</span>
          </div>
          <div class="idx-sub num">${fmtChg(ix.change)}</div>
          ${sparkSvg({ pts: ix.spark, prev: ix.prev, stroke: dirColor(cls), gid: `g${n}` })}
        </div>`;
    }).join('');
  }

  function renderSectors(d) {
    const max = Math.max(0.35, ...d.sectors.map((s) => Math.abs(s.pct)));
    const sorted = [...d.sectors].sort((a, b) => b.pct - a.pct);
    $('sectors').innerHTML = sorted.map((s) => `
      <div class="srow" title="${s.etf}">
        <span class="srow-name">${s.name}</span>
        ${divBar(s.pct, max)}
        <span class="srow-pct num ${dirClass(s.pct)}">${fmtPct(s.pct)}</span>
      </div>`).join('');
  }

  function renderMovers(d) {
    const all = d.sectors.flatMap((s) => s.stocks.map((q) => ({ ...q, sector: s.name })))
      .sort((a, b) => b.pct - a.pct);
    const n = 5;
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

  function watchCard(q, i, today) {
    const cls = dirClass(q.pct);
    const ext = extHours(q);
    // 量比是"到现在为止"的成交量对 10 日均量，盘中会一路涨上去。早盘就过 100% 才值得注意
    const volPct = q.volume != null && q.avgVol ? (q.volume / q.avgVol) * 100 : null;
    // 一行四段：身份 | 价格 | 分时（吃掉剩余宽度）| 区间和成交量
    return `
      <div class="wcard fade-in${editing ? ' is-editing' : ''}" data-sym="${q.symbol}" style="animation-delay:${i * 30}ms">
        ${editing ? `<button class="wc-del" data-del="${q.symbol}" title="移除 ${q.symbol}">×</button>` : ''}
        <div class="wc-id">
          <span class="wc-sym">${q.symbol}</span>
          <span class="wc-name" title="${q.name}">${q.name}</span>
          <span class="wc-flags">${quoteFlags(q, today)}</span>
        </div>
        <div class="wc-px">
          <span class="wc-last num">${fmtPrice(q.last)}</span>
          <span class="wc-chg num ${cls}">${fmtChg(q.change)}&nbsp;&nbsp;${fmtPct(q.pct)}</span>
          ${ext ? `<span class="wc-ext">${ext}</span>` : ''}
        </div>
        ${sparkSvg({ pts: q.spark, prev: q.prev, stroke: dirColor(cls), w: 600, h: 56, gid: `w${i}`, cls: 'wc-spark' })}
        <div class="wc-stats">
          ${rangeBar('日内', q.dayLo, q.dayHi, q.last)}
          ${rangeBar('52 周', q.yrLo, q.yrHi, q.last)}
          <div class="wc-vol num">
            <span>成交 ${fmtVol(q.volume)}</span>
            ${volPct != null ? `<span class="${volPct >= 150 ? 'wc-hot' : ''}">均量 ${volPct.toFixed(0)}%</span>` : ''}
          </div>
        </div>
      </div>`;
  }

  function renderWatch(d) {
    const today = etToday();
    const cards = d.watchlist.map((q, i) => watchCard(q, i, today)).join('');
    $('watch-hint').textContent = `${d.watchlist.length} 只`;

    // 表单而不是裸 input：回车提交是浏览器自带的，不用自己听键盘
    const adder = editing
      ? `<form class="wc-add" id="watch-add" autocomplete="off">
           <input id="watch-input" placeholder="加代码，回车确认" maxlength="12" spellcheck="false">
         </form>`
      : '';
    const empty = !d.watchlist.length && !editing
      ? '<div class="wc-empty">还没有自选。点右上角「编辑」加几只。</div>'
      : '';
    // 轮询会重绘整个面板。不把输入框的内容和光标接过去的话，
    // 交易时段每 30 秒就会把用户正在打的代码清空一次。
    const old = $('watch-input');
    const keep = old
      ? { value: old.value, focused: document.activeElement === old, caret: old.selectionStart }
      : null;

    $('watch').innerHTML = cards + adder + empty;

    const box = $('watch-input');
    if (!box) return;
    if (!keep) { box.focus(); return; }       // 刚进编辑态，光标放进去
    box.value = keep.value;
    if (keep.focused) {
      box.focus();
      box.setSelectionRange(keep.caret, keep.caret);
    }
  }

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
  // 指数条、异动榜、自选卡片都能点进个股页。事件委托挂在 host 上，
  // 内容重绘多少次都不用重新绑。
  host.addEventListener('click', (ev) => {
    // 删除按钮在卡片里面，得先拦下来，否则会顺手跳进个股页
    const del = ev.target.closest('[data-del]');
    if (del) {
      const sym = del.dataset.del;
      save(currentSymbols().filter((s) => s !== sym), `已移除 ${sym}`);
      return;
    }
    if (editing && ev.target.closest('.wcard')) return;   // 编辑模式下不跳转
    const hit = ev.target.closest('.idx[data-sym], .mrow[data-sym], .wcard[data-sym]');
    if (hit) location.hash = `#/s/${encodeURIComponent(hit.dataset.sym)}`;
  });

  // ── 生命周期 ────────────────────────────────────────────────
  function render(d) {
    data = d;
    renderIndices(d);
    renderSectors(d);
    renderMovers(d);
    renderWatch(d);
  }

  const unsubscribe = subscribe(render);
  return () => { unsubscribe(); };
}
