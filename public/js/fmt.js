// 格式化。全站共用，视图不要各写一份——涨跌号、小数位不一致最刺眼。

export const fmtPrice = (v) => v == null ? '—' : v.toLocaleString('en-US', {
  minimumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2,
  maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2,
});
export const fmtPct = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
export const fmtChg = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
export const fmtCap = (v) => v >= 1e12 ? `${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : `${(v / 1e6).toFixed(0)}M`;

/** 涨跌 → 配色类名。invert 用于 VIX 这类"涨=市场变差"的标的。 */
export const dirClass = (v, invert) => {
  if (v == null || v === 0) return 'flat';
  return (invert ? -v : v) > 0 ? 'up' : 'down';
};
