/**
 * "离群"算法。纯函数，不碰网络和磁盘。
 *
 * 一只股票今天涨跌，大部分是被它所在的群带着走的（个股跟板块，板块跟大盘）。
 * 我们要的是扣掉群之后剩下的那部分，再按它自己平时的幅度换算：
 *
 *   超额 = 今天涨跌 − β × 群今天涨跌
 *   离群程度 z = 超额 / 平时一天超额的标准差
 *
 * β 和标准差用过去几十个交易日的日收益算（基线），一天算一次。
 * z = 3 的意思是：今天这只票"自己的事"有它平时的 3 倍大。
 * 特斯拉多涨 3% 可能只是 z = 1，伯克希尔多涨 1% 就可能是 z = 3——这正是要的。
 */

/** 少于这么多个交易日就不算基线，样本太少标准差不可信 */
export const MIN_DAYS = 20;

/** 日线 → Map(日期 → 当日收益 %)。日期取 bar.time 的前 8 位（YYYYMMDD）。 */
export function dailyReturns(bars) {
  const out = new Map();
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].c, cur = bars[i].c;
    if (prev > 0 && cur > 0) out.set(bars[i].time.slice(0, 8), (cur / prev - 1) * 100);
  }
  return out;
}

/**
 * 基线：个股收益对群收益做回归，得出 β 和残差的标准差。
 * 两边都按日期对齐，只用两边都有数据的日子（停牌、新上市的票会少几天）。
 * 样本不够返回 null。
 */
export function fitBaseline(own, bench) {
  const xs = [], ys = [];
  for (const [d, y] of own) {
    const x = bench.get(d);
    if (x != null) { xs.push(x); ys.push(y); }
  }
  const n = xs.length;
  if (n < MIN_DAYS) return null;

  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xs), my = mean(ys);
  let cov = 0, varx = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varx += (xs[i] - mx) ** 2;
  }
  const beta = varx ? cov / varx : 0;
  const resid = ys.map((y, i) => y - beta * xs[i]);
  const mr = mean(resid);
  const sigma = Math.sqrt(resid.reduce((s, r) => s + (r - mr) ** 2, 0) / (n - 1));
  return sigma > 0 ? { beta, sigma, n } : null;
}

/** 今天的离群程度。pct、benchPct 是今天的涨跌 %。 */
export function score(pct, benchPct, base) {
  if (pct == null || benchPct == null || !base) return null;
  const excess = pct - base.beta * benchPct;
  return { excess, z: excess / base.sigma };
}
