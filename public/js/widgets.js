import { fmtPrice, fmtPct, dirClass, dirColor, daysBetween } from './fmt.js';

// 小部件：输入数据、返回一段 HTML 字符串的纯函数。多个视图共用的才放这里。

function sparkPath(pts, w, h, pad = 3) {
  if (pts.length < 2) return { line: '', area: '', Y: null };
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const X = (i) => (i / (pts.length - 1)) * w;
  const Y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  return { line, area: `${line}L${w},${h}L0,${h}Z`, Y };
}

/**
 * 迷你分时线，带渐变填充和前收虚线。
 * cls 由调用方给——指数卡那个要出血到卡片边缘，表格行里的不能，样式不通用。
 */
export function sparkSvg({ pts, prev, stroke, w = 300, h = 34, gid, cls = 'idx-spark' }) {
  const { line, area, Y } = sparkPath(pts ?? [], w, h);
  const prevY = Y && prev != null ? Y(prev) : null;
  return `
    <svg class="${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="${stroke}" stop-opacity=".22"/>
        <stop offset="1" stop-color="${stroke}" stop-opacity="0"/>
      </linearGradient></defs>
      ${area ? `<path d="${area}" fill="url(#${gid})"/>` : ''}
      ${prevY != null && isFinite(prevY) ? `<line x1="0" x2="${w}" y1="${prevY.toFixed(1)}" y2="${prevY.toFixed(1)}" style="stroke:var(--guide)" stroke-width="1" stroke-dasharray="2 3"/>` : ''}
      ${line ? `<path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}
    </svg>`;
}

/** 以零轴为中心的涨跌条。max 是这一组里绝对值最大的那个，用来定比例。 */
export function divBar(pct, max) {
  const w = (Math.abs(pct) / max) * 50;
  const left = pct >= 0 ? 50 : 50 - w;
  return `<span class="srow-track"><i class="srow-fill" style="left:${left}%;width:${w}%;background:${dirColor(dirClass(pct))}"></i></span>`;
}

/**
 * 区间条：左端低、右端高，竖线是现价。
 * 高低缺一个就不画——画一条没有端点的条只会误导。
 */
export function rangeBar(label, lo, hi, last) {
  if (lo == null || hi == null || hi <= lo || last == null) return '';
  const pos = Math.max(0, Math.min(100, ((last - lo) / (hi - lo)) * 100));
  return `
    <div class="wc-range">
      <span class="wc-range-k">${label}</span>
      <span class="wc-range-lo num">${fmtPrice(lo)}</span>
      <span class="wc-track"><i style="left:${pos.toFixed(1)}%"></i></span>
      <span class="wc-range-hi num">${fmtPrice(hi)}</span>
    </div>`;
}

/** 两周内的财报、贴着 52 周高低。自选卡片和个股页共用。 */
export function quoteFlags(q, today) {
  const out = [];
  const e = q.earnings;
  if (e?.date) {
    const n = daysBetween(today, e.date);
    if (n >= 0 && n <= 14) {
      const when = e.when === 'B' ? '盘前' : e.when === 'A' ? '盘后' : '';
      const day = n === 0 ? '今天' : n === 1 ? '明天' : `${Number(e.date.slice(5, 7))}/${Number(e.date.slice(8))}`;
      out.push(`<span class="flag warn"${e.est ? ' title="日期为预估，未经公司确认"' : ''}>财报 ${day}${when}${e.est ? '?' : ''}</span>`);
    }
  }
  if (q.yrHi != null && q.last >= q.yrHi) out.push('<span class="flag up">52 周新高</span>');
  else if (q.yrLo != null && q.last <= q.yrLo) out.push('<span class="flag down">52 周新低</span>');
  return out.join('');
}

/** 盘前 / 盘后价。正常交易时段返回空串。 */
export function extHours(q) {
  if (!q.ext || q.ext.pct == null || q.status === 'REG_MKT') return '';
  return `${q.ext.type === 'PRE_MKT' ? '盘前' : '盘后'} <b class="num">${fmtPrice(q.ext.last)}</b> <b class="num ${dirClass(q.ext.pct)}">${fmtPct(q.ext.pct)}</b>`;
}
