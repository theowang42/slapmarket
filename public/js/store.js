import { toast } from './dom.js';

/**
 * 行情的单一数据源，两条节奏：
 *
 * - 全量（/api/overview）：指数、自选、标普 500 全部成分股。交易时段 30 秒一次。
 * - 快刷（/api/live）：指数、自选、市值前 100。交易时段 5 秒一次，
 *   拿回来合并进全量快照里。人最盯着看的就是这几只，让它们先快起来。
 *
 * 视图不各自去 fetch，只订阅。订阅时可以声明不要快刷——财报、宽度页
 * 只看成分股，5 秒一次的指数变动跟它们无关，没必要跟着重画。
 */
let data = null;
const subs = new Set();

/** 当前快照，可能是 null（首次还没回来）。 */
export const snapshot = () => data;

/**
 * 订阅更新，返回退订函数。回调拿到 (data, kind)，kind 是 'full' 或 'live'。
 * 已有数据时立刻回调一次，晚挂载的视图不用空等一轮。
 */
export function subscribe(fn, { live = true } = {}) {
  const sub = { fn, live };
  subs.add(sub);
  if (data) fn(data, 'full');
  return () => subs.delete(sub);
}

function publish(kind) {
  for (const s of subs) if (kind === 'full' || s.live) s.fn(data, kind);
}

export async function refresh({ force = false } = {}) {
  try {
    const res = await fetch(`/api/overview${force ? '?force=1' : ''}`);
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    data = d;
    publish('full');
  } catch (e) {
    toast(`行情获取失败：${e.message}`);
  }
}

/** 新报价覆盖旧的，但分时线留着——快刷不带分时，那是 2 分钟才更新一次的东西。 */
const mergeQuotes = (old, fresh) => {
  const bySym = new Map(fresh.map((q) => [q.symbol, q]));
  return old.map((q) => (bySym.has(q.symbol) ? { ...bySym.get(q.symbol), spark: q.spark } : q));
};

async function refreshLive() {
  try {
    const res = await fetch('/api/live');
    const d = await res.json();
    if (d.error || !data) return;           // 快刷失败不弹提示，5 秒后还会再来；全量那条会报错
    // 成分股只更新价格，其余字段（市值、财报日）留着全量那份
    const fresh = d.stocks ?? {};
    const sectors = data.sectors.map((s) => ({
      ...s,
      stocks: s.stocks.map((x) => (fresh[x.symbol] ? { ...x, last: fresh[x.symbol].last, pct: fresh[x.symbol].pct } : x)),
    }));
    data = {
      ...data,
      sectors,
      indices: mergeQuotes(data.indices, d.indices),
      watchlist: mergeQuotes(data.watchlist, d.watchlist),
      session: d.session,
      fetchedAt: d.fetchedAt,
    };
    publish('live');
  } catch { /* 同上 */ }
}

const phase = () => data?.session?.phase;

/** 全量：交易时段 30 秒，盘前盘后 60 秒，休市 5 分钟。 */
const fullDelay = () => (phase() === 'open' ? 30_000 : phase() === 'pre' || phase() === 'post' ? 60_000 : 300_000);

/** 快刷：交易时段 5 秒，盘前盘后 15 秒，休市不快刷（价格不动，没意义）。 */
const liveDelay = () => (phase() === 'open' ? 5_000 : phase() === 'pre' || phase() === 'post' ? 15_000 : null);

let started = false;

export function start() {
  if (started) return;
  started = true;

  // 先等这一轮回来再定下一轮的间隔。不等的话首轮 phase 还是 undefined，
  // 会按休市的节奏排下一次——开盘时第二次刷新要等五分钟才来。
  const full = async () => {
    await refresh();
    setTimeout(full, fullDelay());
  };
  // 快刷每次都重新看一眼时段：收盘了就退到 30 秒空转一次，等下一个开盘
  const live = async () => {
    const wait = liveDelay();
    if (wait && !document.hidden) await refreshLive();
    setTimeout(live, wait ?? 30_000);
  };
  full();
  setTimeout(live, 5_000);

  // 切回标签页时补一次，别让人对着一屏几分钟前的价格看
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && data && Date.now() - data.fetchedAt > 30_000) refresh();
  });
}
