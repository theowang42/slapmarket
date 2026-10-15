import { fmtPrice, fmtPct, dirClass, dirColor } from '../js/fmt.js';
import { sparkSvg } from '../js/widgets.js';
import { subscribe } from '../js/store.js';
import { toast } from '../js/dom.js';

/**
 * 宏观。自己打 /api/macro，但轮询节奏借总览的 store——
 * store 一更新说明该刷了，不用再造一套定时器。
 */

const SHELL = `<div class="macro" id="macro"></div>`;

/** 收益率按基点显示。"+5.5bp" 才是债券的语言，写成 "+1.18%" 会被读错一个数量级。 */
const fmtBp = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}bp`);

/** 价格小数位跟着量级走：日元 157.57 要两位，欧元 1.1527 要四位。 */
function fmtLevel(v) {
  if (v == null) return '—';
  if (Math.abs(v) < 10) return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return fmtPrice(v);
}

export function macro(host) {
  host.innerHTML = SHELL;
  const $ = (id) => host.querySelector(`#${id}`);
  let alive = true;
  let painted = false;

  function render(d) {
    $('macro').innerHTML = d.groups.map((g) => `
      <section class="panel macro-group">
        <div class="panel-head">
          <h2>${g.name}</h2>
          <span class="hint">${g.bp ? '涨跌按基点' : ''}</span>
        </div>
        <div class="macro-rows">
          ${g.items.map((i, n) => {
            // 收益率涨跌只表示方向，不代表"好"——债券涨跌对股票的含义要看语境，
            // 所以这里只按方向着色，不做 invert 之类的判断
            const cls = dirClass(g.bp ? i.bp : i.pct);
            const chg = g.bp ? fmtBp(i.bp) : fmtPct(i.pct);
            return `
              <div class="macro-row" data-sym="${i.symbol}" title="${i.symbol}">
                <span class="macro-name">${i.name}</span>
                <span class="macro-last num">${fmtLevel(i.last)}${g.bp ? '<em>%</em>' : ''}</span>
                <span class="macro-chg num ${cls}">${chg}</span>
                ${sparkSvg({ pts: i.spark, prev: i.prev, stroke: dirColor(cls), w: 240, h: 34, gid: `m${g.key}${n}`, cls: 'macro-spark' })}
              </div>`;
          }).join('')}
        </div>
      </section>`).join('');
    painted = true;
  }

  async function load() {
    try {
      const res = await fetch('/api/macro');
      const d = await res.json();
      if (!alive) return;
      if (d.error) throw new Error(d.error);
      render(d);
    } catch (e) {
      if (!alive) return;
      toast(`宏观数据获取失败：${e.message}`);
      if (!painted) $('macro').innerHTML = `<div class="cal-empty">加载失败：${e.message}</div>`;
    }
  }

  // 借总览的轮询节奏。首次回调是订阅时的当前快照，那时 load() 已经在路上。
  let first = true;
  const unsubscribe = subscribe(() => {
    if (first) { first = false; return; }
    load();
  }, { live: false });

  load();

  return () => { alive = false; unsubscribe(); };
}
