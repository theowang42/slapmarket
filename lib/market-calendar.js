/**
 * 美股交易日历。
 *
 * 不写死日期表——那种表每年都要人去续，忘了续就悄悄失效，而且失效的方式
 * 恰恰是"看起来一切正常"。休市日除了国丧之外全是规则性的，按规则算就永远不过期。
 *
 * 规则来自 NYSE Rule 7.2。
 */

/** 复活节（公历算法）。耶稣受难日 = 复活节前两天，是唯一一个要算的浮动假日。 */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const key = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/** 某月的第 n 个星期几（weekday: 0=周日）。 */
function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + shift + (n - 1) * 7));
}

/** 某月最后一个星期几。 */
function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return addDays(last, -shift);
}

/**
 * 固定日期假日的"观察日"：落在周六提前到周五，落在周日顺延到周一。
 *
 * 元旦是例外——1 月 1 日是周六时，交易所**不会**把前一年的 12 月 31 日也关掉
 * （那天照常交易）。这条不写进去的话，每隔几年会凭空多关一天。
 */
function observed(date, { isNewYear = false } = {}) {
  const day = date.getUTCDay();
  if (day === 6) return isNewYear ? null : addDays(date, -1);
  if (day === 0) return addDays(date, 1);
  return date;
}

/** 某一年的全天休市日：{ 'YYYY-MM-DD': 名称 }。 */
export function holidays(year) {
  const out = {};
  const put = (d, name) => { if (d) out[key(d)] = name; };

  put(observed(new Date(Date.UTC(year, 0, 1)), { isNewYear: true }), '元旦');
  put(nthWeekday(year, 0, 1, 3), '马丁·路德·金日');
  put(nthWeekday(year, 1, 1, 3), '总统日');
  put(addDays(easterSunday(year), -2), '耶稣受难日');
  put(lastWeekday(year, 4, 1), '阵亡将士纪念日');
  if (year >= 2022) put(observed(new Date(Date.UTC(year, 5, 19))), '六月节');
  put(observed(new Date(Date.UTC(year, 6, 4))), '独立日');
  put(nthWeekday(year, 8, 1, 1), '劳动节');
  put(nthWeekday(year, 10, 4, 4), '感恩节');
  put(observed(new Date(Date.UTC(year, 11, 25))), '圣诞节');
  return out;
}

/**
 * 提前收盘日（美东 13:00 收盘）：{ 'YYYY-MM-DD': 名称 }。
 * 这三天照常开盘，但下午一点就收——不标出来的话，页面会在收盘后
 * 继续显示"交易中 · 距收盘 3h"，比不显示还误导人。
 */
export function halfDays(year) {
  const full = holidays(year);
  const out = {};
  const put = (d, name) => {
    const k = key(d);
    const wd = d.getUTCDay();
    // 本身就是全天休市、或落在周末的，不算提前收盘
    if (full[k] || wd === 0 || wd === 6) return;
    out[k] = name;
  };

  put(new Date(Date.UTC(year, 6, 3)), '独立日前一天');
  put(addDays(nthWeekday(year, 10, 4, 4), 1), '感恩节次日');
  put(new Date(Date.UTC(year, 11, 24)), '平安夜');
  return out;
}

/**
 * 查某个美东日期。extra 是配置里的一次性休市（国丧之类，规则算不出来）。
 * 返回 null 表示是正常交易日。
 */
export function lookupDay(dateKey, extra = {}) {
  if (extra[dateKey]) return { type: 'closed', name: extra[dateKey] };
  const year = Number(dateKey.slice(0, 4));
  const h = holidays(year);
  if (h[dateKey]) return { type: 'closed', name: h[dateKey] };
  const half = halfDays(year);
  if (half[dateKey]) return { type: 'half', name: half[dateKey] };
  return null;
}
