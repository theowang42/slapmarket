import { toast } from './dom.js';

/**
 * /api/overview 的单一数据源。
 *
 * 视图不各自去 fetch：这份数据是全市场的（时段、涨跌家数、板块），
 * 每个视图都要用，而且轮询节奏要跟着盘口走——放在视图里会随着切页丢掉重来。
 * 所以拉取和节奏都收在这里，视图只订阅。
 */
let data = null;
let timer = null;
const subs = new Set();

/** 当前快照，可能是 null（首次还没回来）。 */
export const snapshot = () => data;

/** 订阅更新，返回退订函数。已有数据时立刻回调一次，晚挂载的视图不用空等一轮。 */
export function subscribe(fn) {
  subs.add(fn);
  if (data) fn(data);
  return () => subs.delete(fn);
}

export async function refresh({ force = false } = {}) {
  try {
    const res = await fetch(`/api/overview${force ? '?force=1' : ''}`);
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    data = d;
    for (const fn of subs) fn(d);
  } catch (e) {
    toast(`行情获取失败：${e.message}`);
  }
}

/** 交易时段 30 秒一刷，盘前盘后 60 秒，休市放慢到 5 分钟。 */
const nextDelay = () => {
  const phase = data?.session?.phase;
  return phase === 'open' ? 30_000 : phase === 'pre' || phase === 'post' ? 60_000 : 300_000;
};

export function start() {
  if (timer) return;
  // 先等这一轮回来再定下一轮的间隔。不等的话首轮 phase 还是 undefined，
  // 会按休市的 5 分钟排下一次——开盘时第二次刷新要等五分钟才来。
  const tick = async () => {
    await refresh();
    timer = setTimeout(tick, nextDelay());
  };
  tick();

  // 切回标签页时补一次，别让人对着一屏几分钟前的价格看
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && data && Date.now() - data.fetchedAt > 30_000) refresh();
  });
}
