import { fitCanvas } from './dom.js';

/**
 * 价格图。canvas 而不是 SVG：一屏最多五百多根 K 线加同样多的成交量柱，
 * 走 SVG 就是两千多个节点，切区间会肉眼可见地卡。代价是命中测试要自己算，
 * 好在 bar 是等距的，x 反推下标就是一次除法。
 */


// left 要留出半根蜡烛，否则第一根会被画布左边切掉一半
const PAD = { top: 10, right: 54, bottom: 20, left: 8 };
/** 横轴首尾标签距边缘的安全距离。标签是居中画的，留窄了会被裁字。 */
const LABEL_INSET = 30;
/** 成交量占绘图区的高度比例。再高就喧宾夺主了。 */
const VOL_RATIO = 0.22;
/** 每根 K 线至少这么宽才画蜡烛，否则退回收盘线——太密的蜡烛糊成一片，不如线清楚。 */
const MIN_CANDLE_STEP = 3.5;

const fmtAxisPrice = (v) => v >= 1000 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);

/** 20260731143000 → 按区间给不同粒度的标签 */
function fmtAxisTime(time, intraday) {
  const s = String(time);
  if (intraday) return `${s.slice(8, 10)}:${s.slice(10, 12)}`;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
}
export const fmtFullTime = (time, intraday) => {
  const s = String(time);
  const d = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return intraday ? `${d} ${s.slice(8, 10)}:${s.slice(10, 12)}` : d;
};

/**
 * 画一次。返回一个 { hitTest } —— 交给调用方做十字线。
 * bars: [{t,time,o,h,l,c,v}]，intraday 决定横轴粒度和基准线。
 */
export function drawChart(canvas, { bars, intraday, prevClose, hover = null }) {
  // 颜色从画布自己身上取：同一页面里可能有不同主题的区域（首页舞台永远是暗的）
  const style = getComputedStyle(canvas);
  const css = (name) => style.getPropertyValue(name).trim();
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!bars?.length || w < 60 || h < 60) return null;

  const plot = {
    x: PAD.left,
    y: PAD.top,
    w: w - PAD.left - PAD.right,
    h: h - PAD.top - PAD.bottom,
  };
  const volH = plot.h * VOL_RATIO;
  const priceH = plot.h - volH - 6;

  // 纵轴范围。分时要把前收也框进去，否则那条虚线会跑到图外。
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) {
    lo = Math.min(lo, b.l ?? b.c);
    hi = Math.max(hi, b.h ?? b.c);
  }
  if (intraday && prevClose != null) { lo = Math.min(lo, prevClose); hi = Math.max(hi, prevClose); }
  const span = hi - lo || Math.abs(hi) * 0.02 || 1;
  lo -= span * 0.06; hi += span * 0.06;

  const X = (i) => plot.x + (bars.length === 1 ? plot.w / 2 : (i / (bars.length - 1)) * plot.w);
  const Y = (v) => plot.y + priceH - ((v - lo) / (hi - lo)) * priceH;

  const first = bars[0].c;
  const base = intraday && prevClose != null ? prevClose : first;
  const rising = bars.at(-1).c >= base;
  const upC = css('--up'), downC = css('--down');
  const main = rising ? upC : downC;

  // ── 网格 + 纵轴价格 ──
  ctx.font = `10px ${css('--mono')}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const TICKS = 5;
  for (let i = 0; i <= TICKS; i++) {
    const v = lo + ((hi - lo) * i) / TICKS;
    const y = Y(v);
    ctx.strokeStyle = css('--line');
    ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
    ctx.fillStyle = css('--text-3');
    ctx.fillText(fmtAxisPrice(v), plot.x + plot.w + 7, y);
  }

  // ── 横轴时间 ──
  ctx.textAlign = 'center';
  ctx.fillStyle = css('--text-3');
  const labels = Math.max(2, Math.min(7, Math.floor(plot.w / 90)));
  const seen = new Set();
  for (let i = 0; i < labels; i++) {
    const idx = Math.round((i / (labels - 1)) * (bars.length - 1));
    const text = fmtAxisTime(bars[idx].time, intraday);
    if (seen.has(text)) continue;      // 月线区间相邻标签可能重名，重了就不画
    seen.add(text);
    const x = Math.max(LABEL_INSET, Math.min(w - PAD.right - LABEL_INSET, X(idx)));
    ctx.fillText(text, x, h - PAD.bottom / 2);
  }

  // ── 成交量 ──
  const volTop = plot.y + priceH + 6;
  const maxVol = Math.max(...bars.map((b) => b.v)) || 1;
  const step = plot.w / Math.max(1, bars.length - 1);
  const barW = Math.max(1, Math.min(step * 0.7, 12));
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const bh = (b.v / maxVol) * volH;
    const prev = i ? bars[i - 1].c : base;
    ctx.fillStyle = b.c >= prev ? upC : downC;
    ctx.globalAlpha = 0.28;
    ctx.fillRect(X(i) - barW / 2, volTop + volH - bh, barW, bh);
  }
  ctx.globalAlpha = 1;

  // ── 前收基准线（分时） ──
  if (intraday && prevClose != null) {
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = css('--guide');
    ctx.beginPath(); ctx.moveTo(plot.x, Y(prevClose)); ctx.lineTo(plot.x + plot.w, Y(prevClose)); ctx.stroke();
    ctx.restore();
  }

  // ── 主体：够宽画蜡烛，太密画收盘线 ──
  const candles = !intraday && step >= MIN_CANDLE_STEP;
  if (candles) {
    const cw = Math.max(1, Math.min(step * 0.68, 11));
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const prev = i ? bars[i - 1].c : b.o ?? b.c;
      const c = b.c >= (b.o ?? prev) ? upC : downC;
      const x = X(i);
      ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1;
      // 影线画在半像素上，1px 的线才不会糊成 2px
      const px = Math.round(x) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, Y(b.h)); ctx.lineTo(px, Y(b.l)); ctx.stroke();
      const yo = Y(b.o ?? b.c), yc = Y(b.c);
      ctx.fillRect(x - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yc - yo)));
    }
  } else {
    const grad = ctx.createLinearGradient(0, plot.y, 0, plot.y + priceH);
    grad.addColorStop(0, `${main}38`);
    grad.addColorStop(1, `${main}00`);
    ctx.beginPath();
    bars.forEach((b, i) => (i ? ctx.lineTo(X(i), Y(b.c)) : ctx.moveTo(X(i), Y(b.c))));
    ctx.strokeStyle = main; ctx.lineWidth = 1.4; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(X(bars.length - 1), plot.y + priceH);
    ctx.lineTo(X(0), plot.y + priceH);
    ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
  }

  // ── 十字线 ──
  if (hover != null && hover >= 0 && hover < bars.length) {
    const b = bars[hover];
    const x = X(hover), y = Y(b.c);
    ctx.save();
    ctx.strokeStyle = css('--guide-strong');
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = main;
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = css('--bg'); ctx.lineWidth = 1.5; ctx.stroke();
  }

  return {
    /** 鼠标 x（CSS 像素，相对 canvas 左上角）→ bar 下标 */
    hitTest: (mx) => {
      const i = Math.round(((mx - plot.x) / plot.w) * (bars.length - 1));
      return Math.max(0, Math.min(bars.length - 1, i));
    },
  };
}

