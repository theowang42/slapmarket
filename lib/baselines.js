import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBars } from './market-data.js';
import { dailyReturns, fitBaseline } from './flock.js';

/**
 * 离群算法的基线：标普 500 每只股票相对所在板块、每个板块相对大盘的 β 和平时幅度。
 *
 * 要拉 500 多只票各 3 个月的日线，一次大约几十秒，所以：
 * - 一天只算一次，结果存 data/baselines.json，重启也不用重算
 * - 后台算，不阻塞接口；第一次还没算完时接口返回进度
 * - 并发压在 6 个以内，别一口气 500 个请求把 Yahoo 惹毛
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, 'data', 'baselines.json');
const MARKET = '^GSPC';
const CONCURRENCY = 6;

let memo = null;                         // 磁盘上那份读进来之后留在内存里
let job = null;                          // 正在跑的计算 { progress, promise }
let failedAt = 0;                        // 上次失败的时间。失败后冷却 10 分钟再试，别每个请求都重拉 500 只
const RETRY_MS = 10 * 60_000;

/** 并发受限的 map。单个失败给 null，不拖累整批。 */
async function pool(items, limit, fn, onEach) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
      onEach?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function compute(holdings, progress) {
  // 要哪些票：大盘、11 只板块 ETF、全部成分股
  const pairs = Object.entries(holdings).flatMap(([etf, list]) => list.map((h) => [h.symbol, etf]));
  const symbols = [MARKET, ...Object.keys(holdings), ...pairs.map(([s]) => s)];
  progress.total = symbols.length;

  const series = await pool(symbols, CONCURRENCY, async (s) => dailyReturns(await fetchBars(s, '3M')), () => { progress.done++; });
  const ret = Object.fromEntries(symbols.map((s, i) => [s, series[i]]));
  if (!ret[MARKET]?.size) throw new Error('大盘日线没拿到，基线算不了');

  const sectors = {};
  for (const etf of Object.keys(holdings)) {
    const b = ret[etf] && fitBaseline(ret[etf], ret[MARKET]);
    if (b) sectors[etf] = b;
  }
  const stocks = {};
  for (const [sym, etf] of pairs) {
    const b = ret[sym] && ret[etf] && fitBaseline(ret[sym], ret[etf]);
    if (b) stocks[sym] = { ...b, etf };
  }
  return { computedAt: Date.now(), sectors, stocks };
}

/**
 * 返回 { baseline, progress }。baseline 为 null 说明第一次还在算，
 * progress 是 { done, total }。过期了照样先返回旧的，后台去刷。
 */
export async function getBaselines(holdings, { ttlHours = 12 } = {}) {
  if (!memo) {
    try { memo = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { /* 还没算过 */ }
  }
  const stale = !memo || (Date.now() - memo.computedAt) / 3.6e6 > ttlHours;

  if (stale && !job && Date.now() - failedAt > RETRY_MS) {
    const progress = { done: 0, total: 0 };
    job = {
      progress,
      promise: compute(holdings, progress)
        .then(async (b) => {
          memo = b;
          await fs.mkdir(path.dirname(FILE), { recursive: true });
          await fs.writeFile(FILE, JSON.stringify(b));
          console.log(`[baselines] 完成：${Object.keys(b.stocks).length} 只个股、${Object.keys(b.sectors).length} 个板块`);
        })
        .catch((e) => { failedAt = Date.now(); console.warn('[baselines] 计算失败，10 分钟后重试：', e.message); })
        .finally(() => { job = null; }),
    };
  }
  return { baseline: memo, progress: job?.progress ?? null };
}
