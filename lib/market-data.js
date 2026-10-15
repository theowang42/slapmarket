import * as yahoo from './providers/yahoo.js';
import * as sina from './providers/sina.js';

/**
 * 行情的唯一入口。server.js 只认这里，不直接碰任何一家数据源。
 *
 * 报价是双保险：先问 Yahoo，没拿到的（Yahoo 整个挂了、或个别代码缺失）再问新浪。
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

async function tryFetch(source, fn) {
  try {
    const out = await fn();
    report(source, null);
    return out;
  } catch (e) {
    report(source, e);
    return {};
  }
}

/** 批量报价 → { [symbol]: quote }，每条带 source 标明来自哪家。 */
export async function fetchQuotes(symbols) {
  const out = {};
  for (const [s, q] of Object.entries(await tryFetch('yahoo', () => yahoo.quotes(symbols)))) out[s] = { ...q, source: 'yahoo' };
  const missing = symbols.filter((s) => !out[s]);
  if (missing.length) {
    for (const [s, q] of Object.entries(await tryFetch('sina', () => sina.quotes(missing)))) out[s] = { ...q, source: 'sina' };
  }
  if (!Object.keys(out).length && symbols.length) throw new Error('Yahoo 和新浪都没拿到报价');
  return out;
}

/** 单只报价 + 基本面。基本面只有 Yahoo 有，拿不到就只显示报价。 */
export async function fetchQuoteDetail(symbol) {
  const base = (await fetchQuotes([symbol]))[symbol];
  if (!base) throw new Error(`找不到 ${symbol}`);
  const extra = await yahoo.details(symbol).catch(() => ({}));
  return { ...base, ...extra };
}

export const fetchBars = (symbol, range) => yahoo.bars(symbol, range);
export const fetchSpark = (symbol) => yahoo.spark(symbol);
