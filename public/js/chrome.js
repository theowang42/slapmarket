import { subscribe, refresh } from './store.js';
import { toast } from './dom.js';

/**
 * 顶栏。交易时段、美东时间、全市场涨跌家数——都是跟视图无关的全市场信息，
 * 所以它不属于任何视图，常驻在静态外壳里，直接订阅 store。
 */
const $ = (id) => document.getElementById(id);

const WEEKDAY = { Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六', Sun: '周日' };

/**
 * 导航。只列**已经做出来的**页面——放一个点不开的入口比不放更糟。
 * 个股页不在这里：它是从总览点进去的下钻页，不是并列的标签，
 * 停在它上面时导航不高亮任何一项。
 */
const NAV = [
  { hash: '#/', label: '总览' },
  { hash: '#/earnings', label: '财报' },
  { hash: '#/breadth', label: '宽度' },
  { hash: '#/macro', label: '宏观' },
];

function renderNav() {
  const here = location.hash || '#/';
  $('nav').innerHTML = NAV.map((n, i) => `
    <a href="${n.hash}" class="${here === n.hash ? 'on' : ''}" title="快捷键 ${i + 1}">${n.label}</a>`).join('');
}

function render(d) {
  const s = d.session;
  const pill = $('session');
  pill.dataset.phase = s.phase;
  pill.querySelector('.pill-label').textContent = s.note ? `${s.label} · ${s.note}` : s.label;
  // 日期必须是**美东**那一天，不是本机那一天——中国这边入夜之后两者就差一天了，
  // 而这一屏所有东西（时段、财报日、K 线）都是按美东日期算的
  const [y, m, dd] = (s.etDate ?? '').split('-');
  const date = y ? `${Number(m)}/${Number(dd)} ${WEEKDAY[s.weekday] ?? ''} ` : '';
  $('et').textContent = `ET ${date}${s.etTime}`;
  $('et').title = y ? `美东时间 ${y} 年 ${Number(m)} 月 ${Number(dd)} 日` : '';

  // 全部成分股的涨跌家数。比指数诚实——指数被几只大票拉起来的时候，这里会露馅
  const all = d.sectors.flatMap((s) => s.stocks);
  const b = {
    up: all.filter((q) => q.pct > 0).length,
    down: all.filter((q) => q.pct < 0).length,
    flat: all.filter((q) => q.pct === 0).length,
  };
  const t = Math.max(1, all.length);
  $('breadth').innerHTML = `
    <span class="up">${b.up}</span>
    <span class="breadth-bar">
      <i style="width:${(b.up / t * 100).toFixed(1)}%;background:var(--up)"></i>
      <i style="width:${(b.flat / t * 100).toFixed(1)}%;background:var(--text-3)"></i>
      <i style="width:${(b.down / t * 100).toFixed(1)}%;background:var(--down)"></i>
    </span>
    <span class="down">${b.down}</span>`;

  const at = new Date(d.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false });
  // 数据来自哪家。正常全是 Yahoo；出现新浪说明 Yahoo 有票没拿到，值得让人知道
  const { yahoo = 0, sina = 0 } = d.sources ?? {};
  const src = sina ? (yahoo ? `Yahoo + 新浪 ${sina} 只` : '新浪（Yahoo 不可用）') : 'Yahoo';
  $('meta').textContent = `更新 ${at} · ${src} · R 刷新`;
}

// ── 白天 / 夜间。默认白天，选了夜间就记住。 ──────────────────
const isDark = () => document.documentElement.dataset.theme === 'dark';

function paintThemeBtn() {
  $('theme').textContent = isDark() ? '白天' : '夜间';
}

function toggleTheme() {
  const dark = !isDark();
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('ump:theme', dark ? 'dark' : 'light'); } catch {}
  paintThemeBtn();
  window.dispatchEvent(new Event('themechange'));
}

export function mountChrome() {
  paintThemeBtn();
  $('theme').addEventListener('click', toggleTheme);
  subscribe(render);
  renderNav();
  window.addEventListener('hashchange', renderNav);

  window.addEventListener('keydown', (e) => {
    // 输入框里按键不该触发全局快捷键（后面会有搜索框）。
    // 事件目标不一定是元素（window / document 上派发时就不是），先认类型再问 closest。
    if (e.target instanceof Element && e.target.closest('input, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;      // 别抢 Cmd+R 这类浏览器快捷键
    if (e.key === 'r' || e.key === 'R') { toast('强制刷新中…'); refresh({ force: true }); return; }
    if (e.key === 't' || e.key === 'T') { toggleTheme(); return; }
    const n = Number(e.key);
    if (n >= 1 && n <= NAV.length) location.hash = NAV[n - 1].hash;
  });
}
