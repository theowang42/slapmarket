/**
 * 涨跌 → 颜色。0 附近落在中性深灰上，越极端越饱和越亮。
 * 上限由服务端的 HEAT_CLAMP 决定（默认 ±3%）。
 */
export function heat(pct, clamp) {
  const t = Math.max(-1, Math.min(1, (pct ?? 0) / clamp));
  const a = Math.abs(t) ** 1.15; // 稍微压一压小涨小跌，别让整屏都在发光
  const hue = t >= 0 ? 154 : 355;
  return `hsl(${hue} ${(5 + 45 * a).toFixed(1)}% ${(13 + 17 * a).toFixed(1)}%)`;
}

export const heatText = (pct, clamp) =>
  `rgba(255,255,255,${(0.5 + 0.45 * Math.min(1, Math.abs((pct ?? 0) / clamp))).toFixed(2)})`;
