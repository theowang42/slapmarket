// 格式化。全站共用，视图不要各写一份——涨跌号、小数位不一致最刺眼。

export const fmtPrice = (v) => v == null ? '—' : v.toLocaleString('en-US', {
  minimumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2,
  maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2,
});
export const fmtPct = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
export const fmtChg = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
export const fmtCap = (v) => v == null ? '—'
  : v >= 1e12 ? `${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : `${(v / 1e6).toFixed(0)}M`;
export const fmtVol = (v) => v == null ? '—'
  : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : String(v);

/** 涨跌 → 配色类名。invert 用于 VIX 这类"涨=市场变差"的标的。 */
export const dirClass = (v, invert) => {
  if (v == null || v === 0) return 'flat';
  return (invert ? -v : v) > 0 ? 'up' : 'down';
};

/** 配色类名 → 线条颜色。SVG 里要的是颜色值，不是类名。 */
export const dirColor = (cls) => (cls === 'up' ? 'var(--up)' : cls === 'down' ? 'var(--down)' : 'var(--text-3)');

/**
 * 美东今天，'YYYY-MM-DD'。日期一律按美东算，不看本机时区——
 * 中国这边入夜之后两边就差一天了，而财报日、交易日都是美东的。
 */
export const etToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

/** 两个 'YYYY-MM-DD' 相差几天。都按 UTC 零点解析，不会被时区和夏令时带偏。 */
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
