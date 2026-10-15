import * as yahoo from './providers/yahoo.js';
import * as sina from './providers/sina.js';

/**
 * 行情的唯一入口。server.js 只认这里，不直接碰任何一家数据源。
 *
 * 两家各有长短，按长处分工、互为备份：
 * - 报价：股票和三大指数先问新浪（一个请求六十只、实时、国内快）；
 *   新浪没有的（VIX、罗素……）和漏掉的，再一只只问 Yahoo 的图表接口
 * - K 线：先问 Yahoo（区间全、分钟级），拿不到再问新浪
 * - 个股基本面：只有 Yahoo 有，拿不到就空着
 *
 * 代码一律用 Yahoo 的写法：指数带 ^（^GSPC），B 股用横杠（BRK-B）。
 * 换成别家的写法是各个 provider 自己的事。
 */

/**
 * 熔断：某一路失败一次，接下来 3 分钟不再问它，直接走另一家。
 * 不这么做的话，被限流时每一轮都要先撞一次墙，越撞越被封，还白等一个超时。
 * 失败原因只在变化时打一行日志，别每分钟刷屏。
 */
const COOLDOWN_MS = 3 * 60_000;
const downUntil = {};
const lastError = {};

async function attempt(route, fn) {
  if (Date.now() < (downUntil[route] ?? 0)) return null;
  try {
    const out = await fn();
    if (lastError[route]) console.warn(`[${route}] 恢复正常`);
    lastError[route] = null;
    return out;
  } catch (e) {
    downUntil[route] = Date.now() + COOLDOWN_MS;
    const msg = String(e?.message ?? e);
    if (msg !== lastError[route]) console.warn(`[${route}] 失败：${msg}（3 分钟内改走另一家）`);
    lastError[route] = msg;
    return null;
  }
}

/** 批量报价 → { [symbol]: quote }，每条带 source 标明来自哪家 */
export async function fetchQuotes(symbols) {
  const out = {};
  const viaSina = symbols.filter(sina.supports);
  if (viaSina.length) {
    for (const [s, q] of Object.entries(await attempt('新浪报价', () => sina.quotes(viaSina)) ?? {})) out[s] = { ...q, source: 'sina' };
  }
  const rest = symbols.filter((s) => !out[s]);
  if (rest.length) {
    for (const [s, q] of Object.entries(await attempt('Yahoo 报价', () => yahoo.quotes(rest)) ?? {})) out[s] = { ...q, source: 'yahoo' };
  }
  if (!Object.keys(out).length && symbols.length) throw new Error('新浪和 Yahoo 都没拿到报价');
  return out;
}

/** 一段 K 线。Yahoo 优先，空的或失败了换新浪；都不行返回空数组，页面显示"暂无" */
export async function fetchBars(symbol, range) {
  const y = await attempt('Yahoo K 线', () => yahoo.bars(symbol, range));
  if (y?.length) return y;
  if (!sina.supports(symbol)) return [];
  return (await attempt('新浪 K 线', () => sina.bars(symbol, range))) ?? [];
}

/** 个股基本面（市盈率、ROE 之类）。只有 Yahoo 有，要 crumb，经常拿不到——拿不到就空着 */
export const fetchDetails = (symbol) => yahoo.details(symbol).catch(() => ({}));

/** 界面上能选的 K 线区间，以及哪些是分钟级 */
export const RANGES = yahoo.RANGES;
