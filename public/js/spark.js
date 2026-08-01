/**
 * 迷你分时线。指数条和宏观页共用。
 * 返回 { line, area, Y }——Y 拿来定位前收那条虚线。
 */
export function sparkPath(pts, w, h, pad = 3) {
  if (pts.length < 2) return { line: '', area: '', Y: null };
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const X = (i) => (i / (pts.length - 1)) * w;
  const Y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
  const line = pts.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  return { line, area: `${line}L${w},${h}L0,${h}Z`, Y };
}

/**
 * 一条完整的迷你分时 SVG，带渐变填充和前收虚线。
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
      ${prevY != null && isFinite(prevY) ? `<line x1="0" x2="${w}" y1="${prevY.toFixed(1)}" y2="${prevY.toFixed(1)}" stroke="rgba(255,255,255,.16)" stroke-width="1" stroke-dasharray="2 3"/>` : ''}
      ${line ? `<path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}
    </svg>`;
}
