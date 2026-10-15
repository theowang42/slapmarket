import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXlsx } from './xlsx.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_FILE = path.join(ROOT, 'data', 'holdings.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const SSGA = (etf) =>
  `https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${etf.toLowerCase()}.xlsx`;

/**
 * SSGA 每日持仓表的列：Name | Ticker | Identifier | SEDOL | Weight | Sector | Shares | Currency
 * 表头前面有几行免责声明，所以按"能解析出权重的行"来认数据行，不认死行号。
 */
/** "ALPHABET INC CL A" → "ALPHABET INC"，用来认出同一家公司的不同股权类别。 */
const companyKey = (name) => String(name).replace(/\s+(CL|CLASS)\s+[A-Z]\b.*$/i, '').trim();

/**
 * 双重股权要合并：ETF 里 GOOGL 和 GOOG 是两条持仓，但行情源给的
 * 市值是**整家公司**的市值。两条都留会让 Alphabet 被算两遍。
 * 处理办法是只留权重最大的那个类别，权重相加。
 */
function dedupeShareClasses(list) {
  const byCompany = new Map();
  for (const h of list) {
    const key = companyKey(h.name);
    const prev = byCompany.get(key);
    if (!prev) byCompany.set(key, { ...h });
    else {
      if (h.weight > prev.weight) { prev.symbol = h.symbol; prev.name = h.name; }
      prev.weight += h.weight;
    }
  }
  return [...byCompany.values()];
}

function parseHoldings(rows) {
  const out = [];
  for (const r of rows) {
    const [name, ticker, , , weight] = r;
    const w = Number(weight);
    // 现金、期货等条目的 ticker 是 "-" 或带下划线，一并排除
    if (!ticker || !/^[A-Z][A-Z.]{0,6}$/.test(ticker)) continue;
    if (!Number.isFinite(w) || w <= 0) continue;
    out.push({ symbol: ticker, name: name || ticker, weight: w });
  }
  return dedupeShareClasses(out).sort((a, b) => b.weight - a.weight);
}

async function fetchHoldings(etf) {
  const res = await fetch(SSGA(etf), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${etf} HTTP ${res.status}`);
  const rows = parseXlsx(Buffer.from(await res.arrayBuffer()));
  const list = parseHoldings(rows);
  if (!list.length) throw new Error(`${etf} 解析出 0 条持仓`);
  return list;
}

/** 全部 ETF 抓一遍。单个失败不影响其它板块。 */
async function fetchAll(sectors) {
  const entries = await Promise.all(sectors.map(async (s) => {
    try {
      return [s.etf, { ok: true, list: await fetchHoldings(s.etf) }];
    } catch (e) {
      return [s.etf, { ok: false, error: String(e.message ?? e) }];
    }
  }));
  return Object.fromEntries(entries);
}

async function readCache() {
  try { return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')); } catch { return null; }
}

async function writeCache(data) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(data, null, 1));
}

/**
 * 新旧两份持仓对比：谁进了标普 500、谁被移出、谁换了板块。
 * 按整个指数比，不按单个 ETF 比——否则一只票换板块（GICS 重新分类）
 * 会被误报成"一进一出"。
 */
export function diffHoldings(before, after) {
  const index = (h) => new Map(Object.entries(h ?? {}).flatMap(([etf, list]) => list.map((x) => [x.symbol, etf])));
  const a = index(before), b = index(after);
  return {
    added: [...b.keys()].filter((s) => !a.has(s)),
    removed: [...a.keys()].filter((s) => !b.has(s)),
    moved: [...b].filter(([s, etf]) => a.has(s) && a.get(s) !== etf).map(([s, etf]) => ({ symbol: s, from: a.get(s), to: etf })),
  };
}

/** 最近的成分股变动，新的在前。 */
export async function recentChanges() {
  return (await readCache())?.changes ?? [];
}

let refreshing = null;
let failedAt = 0;          // 后台刷新失败后冷却 10 分钟，别每个请求都去敲一遍 SSGA
const RETRY_MS = 10 * 60_000;

/**
 * 返回 { [etf]: [{symbol,name,weight}] }，每个 ETF 的完整持仓，外加 config 里 pin 的票。
 * 持仓一天只变一次，所以缓存到磁盘：过期了先返回旧的、后台去刷，
 * 页面永远不会因为等 SSGA 而卡住。抓不到就一直用磁盘上的旧数据。
 */
export async function getHoldings(sectors, { ttlHours = 12, force = false } = {}) {
  let cache = await readCache();
  const age = cache ? (Date.now() - cache.fetchedAt) / 3.6e6 : Infinity;

  const refresh = async () => {
    const raw = await fetchAll(sectors);
    if (!Object.values(raw).some((r) => r.ok)) throw new Error('所有板块 ETF 持仓都没抓到');
    // 只覆盖抓成功的那些，失败的板块保留上一次的持仓
    const holdings = { ...(cache?.holdings ?? {}) };
    for (const [etf, r] of Object.entries(raw)) {
      if (r.ok) holdings[etf] = r.list;
      else console.warn(`[holdings] ${etf} 抓取失败：${r.error}`);
    }
    // 有变动就记一笔，留最近 30 次。第一次跑没有旧数据可比，不记
    const changes = cache?.changes ?? [];
    if (cache?.holdings) {
      const d = diffHoldings(cache.holdings, holdings);
      if (d.added.length || d.removed.length || d.moved.length) {
        changes.unshift({ at: Date.now(), ...d });
        console.log(`[holdings] 标普 500 成分变动：+${d.added.join(',') || '无'} −${d.removed.join(',') || '无'}`);
      }
    }
    cache = { fetchedAt: Date.now(), holdings, changes: changes.slice(0, 30) };
    await writeCache(cache);
    return cache;
  };

  if (force || age > ttlHours) {
    if (!cache) {
      cache = await refresh();               // 第一次跑，没有缓存，只能等
    } else if (!refreshing && Date.now() - failedAt > RETRY_MS) {
      refreshing = refresh()
        .catch((e) => {
          failedAt = Date.now();
          console.warn('[holdings] 后台刷新失败，继续用磁盘缓存，10 分钟后重试：', e.message);
          return cache;
        })
        .finally(() => { refreshing = null; });
    }
  }

  // pin：刚上市、还没进 ETF 的票，手动挂到某个板块下。
  // SSGA 的代码是 BRK.B 写法，统一成行情源用的 BRK-B
  return Object.fromEntries(sectors.map((s) => {
    const list = (cache.holdings[s.etf] ?? []).map((h) => ({ ...h, symbol: h.symbol.replace('.', '-') }));
    const pins = (s.pin ?? [])
      .filter((sym) => !list.some((h) => h.symbol === sym))
      .map((sym) => ({ symbol: sym, name: sym, weight: 0 }));
    return [s.etf, [...list, ...pins]];
  }));
}
