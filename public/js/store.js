import { toast } from './dom.js';

/**
 * 行情的单一数据源，两条节奏：
 *
 * - 全量（/api/market）：大盘 + 标普 500 全部成分股。交易时段 1 分钟一次。
 * - 快刷（/api/live）：大盘 + 市值前 100（台上的人从这里选）。交易时段 30 秒一次，
 *   拿回来合并进全量快照里。
 *
 * 再快就会被数据源限流。页面只订阅，不自己 fetch。
 */
let data = null;
const subs = new Set();

/** 订阅更新，返回退订函数。回调拿到 (data, kind)，kind 是 'full' 或 'live' */
export function subscribe(fn) {
  subs.add(fn);
  if (data) fn(data, 'full');
  return () => subs.delete(fn);
}

function publish(kind) {
  for (const fn of subs) fn(data, kind);
}

export async function refresh({ force = false } = {}) {
  try {
    const d = await (await fetch(`/api/market${force ? '?force=1' : ''}`)).json();
    if (d.error) throw new Error(d.error);
    data = d;
    publish('full');
  } catch (e) {
    toast(`行情获取失败：${e.message}`);
  }
}

async function refreshLive() {
  try {
    const d = await (await fetch('/api/live')).json();
    if (d.error || !data) return;           // 快刷失败不弹提示，全量那条会报
    // 成分股只更新价格，市值之类的留着全量那份
    const fresh = d.stocks ?? {};
    data = {
      ...data,
      market: d.market ?? data.market,
      sectors: data.sectors.map((s) => ({
        ...s,
        stocks: s.stocks.map((x) => (fresh[x.symbol] ? { ...x, ...fresh[x.symbol] } : x)),
      })),
      session: d.session,
      fetchedAt: d.fetchedAt,
    };
    publish('live');
  } catch { /* 同上 */ }
}

const phase = () => data?.session?.phase;
/** 全量：交易时段 1 分钟，盘前盘后 2 分钟，休市 5 分钟 */
const fullDelay = () => (phase() === 'open' ? 60_000 : phase() === 'pre' || phase() === 'post' ? 120_000 : 300_000);
/** 快刷：交易时段 30 秒，盘前盘后 1 分钟，休市不刷（价格不动） */
const liveDelay = () => (phase() === 'open' ? 30_000 : phase() === 'pre' || phase() === 'post' ? 60_000 : null);

let started = false;

export function start() {
  if (started) return;
  started = true;

  // 等这一轮回来再定下一轮的间隔，不然首轮还不知道时段，会按休市的节奏排
  const full = async () => {
    await refresh();
    setTimeout(full, fullDelay());
  };
  const live = async () => {
    const wait = liveDelay();
    if (wait && !document.hidden) await refreshLive();
    setTimeout(live, wait ?? 30_000);
  };
  full();
  setTimeout(live, 30_000);

  // 切回标签页时补一次，别让人对着一屏几分钟前的价格看
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && data && Date.now() - data.fetchedAt > 60_000) refresh();
  });
}
