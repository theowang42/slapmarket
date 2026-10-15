import * as yahoo from './providers/yahoo.js';
import * as sina from './providers/sina.js';

/**
 * 行情的唯一入口。server.js 只认这里，不直接碰任何一家数据源。
 *
 * 报价是双保险：股票先问新浪，新浪没有的或者漏掉的再问 Yahoo。
 * K 线只有 Yahoo 一家——新浪的 K 线接口不稳定，接进来只会多一个出错的地方。
 *
 * 代码一律用 Yahoo 的写法：指数带 ^（^GSPC），B 股用横杠（BRK-B），
 * 期货 =F，汇率 =X，加密 -USD。换成别家的写法是各个 provider 自己的事。
 */

export const RANGES = yahoo.RANGES;

/** 每家数据源最近一次的错误。只在状态变化时打日志，别每分钟刷屏。 */
const lastError = {};
function report(source, err) {
  const msg = err ? String(err.message ?? err) : null;
  if (msg === (lastError[source] ?? null)) return;
  lastError[source] = msg;
  console.warn(msg ? `[${source}] 失败：${msg}` : `[${source}] 恢复正常`);
}

/**
 * 熔断：某家失败一次，接下来 3 分钟不再问它，直接走下一家。
 * 不这么做的话，Yahoo 被限流时每一轮还要先撞一次墙（连带重新登录拿 crumb，请求翻倍），
 * 越撞越被封，而且每轮都白白多等一个超时。
 */
const COOLDOWN_MS = 3 * 60_000;
const downUntil = {};

async function tryFetch(source, fn) {
  if (Date.now() < (downUntil[source] ?? 0)) return {};
  try {
    const out = await fn();
    report(source, null);
    return out;
  } catch (e) {
    downUntil[source] = Date.now() + COOLDOWN_MS;
    report(source, new Error(`${e.message ?? e}（3 分钟内改走备用源）`));
    return {};
  }
}

/**
 * 批量报价 → { [symbol]: quote }，每条带 source 标明来自哪家。
 *
 * 股票和三大指数先问新浪：一个请求六十只，五百只成分股九个请求搞定。
 * 新浪没有的（VIX、罗素、期货、汇率、加密）和新浪漏掉的，再一只只问 Yahoo 的图表接口。
 * 反过来不行：Yahoo 的批量报价接口要 crumb，经常被拦；图表接口一只一个请求，扛不住五百只。
 */
export async function fetchQuotes(symbols) {
  const out = {};
  const viaSina = symbols.filter(sina.supports);
  if (viaSina.length) {
    for (const [s, q] of Object.entries(await tryFetch('sina', () => sina.quotes(viaSina)))) out[s] = { ...q, source: 'sina' };
  }
  const rest = symbols.filter((s) => !out[s]);
  if (rest.length) {
    for (const [s, q] of Object.entries(await tryFetch('yahoo', () => yahoo.quotes(rest)))) out[s] = { ...q, source: 'yahoo' };
  }
  if (!Object.keys(out).length && symbols.length) throw new Error('新浪和 Yahoo 都没拿到报价');
  return out;
}

/** 个股基本面（市盈率、ROE 之类）。只有 Yahoo 有。 */
export const fetchDetails = (symbol) => yahoo.details(symbol);

export const fetchBars = (symbol, range) => yahoo.bars(symbol, range);
export const fetchSpark = (symbol) => yahoo.spark(symbol);
