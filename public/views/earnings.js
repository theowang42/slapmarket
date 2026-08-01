import { fmtPct, fmtCap, fmtPrice, dirClass } from '../js/fmt.js';
import { subscribe } from '../js/store.js';

/** 往后看多少天。两周够安排事情了，再长就成噪音。 */
const DAYS = 14;

const SHELL = `
  <section class="panel cal-panel">
    <div class="panel-head">
      <h2>财报日历</h2>
      <span class="hint" id="cal-hint"></span>
    </div>
    <div class="cal" id="cal"></div>
  </section>`;

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 'YYYY-MM-DD' → 本地 Date（当天零点）。别用 new Date(str)，那个按 UTC 解析会差一天。 */
function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const todayStart = () => {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
};

function dayLabel(date, offset) {
  if (offset === 0) return '今天';
  if (offset === 1) return '明天';
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${md} ${WEEKDAY[date.getDay()]}`;
}

export function earnings(host) {
  host.innerHTML = SHELL;
  const $ = (id) => host.querySelector(`#${id}`);

  function render(d) {
    // 成分股 + 自选，同一只可能两边都有，按代码去重
    const seen = new Map();
    for (const s of d.sectors) {
      for (const q of s.stocks) if (!seen.has(q.symbol)) seen.set(q.symbol, { ...q, sector: s.name });
    }
    for (const q of d.watchlist) if (!seen.has(q.symbol)) seen.set(q.symbol, { ...q, sector: '自选' });

    const t0 = todayStart();
    const end = new Date(t0);
    end.setDate(end.getDate() + DAYS);

    const byDay = new Map();
    for (const q of seen.values()) {
      if (!q.earnings?.date) continue;
      const day = parseDay(q.earnings.date);
      if (day < t0 || day >= end) continue;
      if (!byDay.has(q.earnings.date)) byDay.set(q.earnings.date, []);
      byDay.get(q.earnings.date).push(q);
    }

    const days = [...byDay.keys()].sort();
    const total = [...byDay.values()].reduce((a, b) => a + b.length, 0);
    $('cal-hint').textContent = total
      ? `未来 ${DAYS} 天 · ${total} 家`
      : `未来 ${DAYS} 天没有成分股出财报`;

    if (!days.length) { $('cal').innerHTML = '<div class="cal-empty">未来两周没有成分股公布财报。</div>'; return; }

    $('cal').innerHTML = days.map((key) => {
      const date = parseDay(key);
      const offset = Math.round((date - t0) / 86400000);
      // 大票排前面——同一天出财报，市值大的那家才是能带动指数的
      const rows = byDay.get(key).sort((a, b) => (b.cap ?? 0) - (a.cap ?? 0));
      return `
        <div class="cal-day">
          <div class="cal-date${offset === 0 ? ' is-today' : ''}">
            <b>${dayLabel(date, offset)}</b><span>${rows.length} 家</span>
          </div>
          ${rows.map((q) => {
            const when = q.earnings.when === 'A' ? '盘后' : q.earnings.when === 'B' ? '盘前' : '';
            return `<div class="cal-row" data-sym="${q.symbol}">
              <span class="cal-sym">${q.symbol}</span>
              <span class="cal-name">${q.name ?? ''}</span>
              <span class="cal-sec">${q.sector}</span>
              <span class="cal-when">${when}${q.earnings.est ? '<i class="cal-est" title="交易所未定档，CNBC 推算">预估</i>' : ''}</span>
              <span class="cal-cap num">${q.cap ? fmtCap(q.cap) : '—'}</span>
              <span class="cal-px num">${fmtPrice(q.last)}</span>
              <span class="cal-pct num ${dirClass(q.pct)}">${fmtPct(q.pct)}</span>
            </div>`;
          }).join('')}
        </div>`;
    }).join('');
  }

  host.addEventListener('click', (ev) => {
    const row = ev.target.closest('.cal-row[data-sym]');
    if (row) location.hash = `#/s/${encodeURIComponent(row.dataset.sym)}`;
  });

  const unsubscribe = subscribe(render);
  return () => unsubscribe();
}
