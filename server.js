import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WATCHLIST, INDICES, SECTORS, MACRO, CACHE_TTL, PORT, HOST, HOLDINGS_TTL_HOURS, MARKET_CLOSURES,
} from './config.js';
import { fetchQuotes, fetchDetails, fetchBars, fetchSpark, RANGES } from './lib/market-data.js';
import { getHoldings, recentChanges } from './lib/holdings.js';
import { getBaselines } from './lib/baselines.js';
import { score } from './lib/flock.js';
import { marketSession } from './lib/market-hours.js';
import { getWatchlist, setWatchlist, normalize as normalizeWatch, MAX as WATCH_MAX } from './lib/watchlist.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

// ── 缓存：失败时回退到上一份数据，不把页面打空 ──────────────────────
const cache = new Map();

function cached(key, ttlSec, producer) {
  const hit = cache.get(key);
  if (hit?.value && Date.now() - hit.at < ttlSec * 1000) return Promise.resolve(hit.value);
  if (hit?.inflight) return hit.inflight;
  const inflight = producer().then(
    (value) => { cache.set(key, { value, at: Date.now() }); return value; },
    (err) => {
      if (hit?.value) { cache.set(key, { value: hit.value, at: Date.now() - ttlSec * 500 }); return hit.value; }
      cache.delete(key);
      throw err;
    },
  );
  cache.set(key, { ...hit, inflight });
  return inflight;
}

/** 一批符号的当日分时。单只失败给空数组，不拖累整批。 */
async function sparksFor(symbols) {
  const entries = await Promise.all(symbols.map(async (s) => [s, await fetchSpark(s).catch(() => [])]));
  return Object.fromEntries(entries);
}

// ── 总览：指数、板块成分股、自选。财报 / 宽度页也从这份数据算 ─────────
async function buildQuotes({ force = false } = {}) {
  // 成分股 = 11 只行业 ETF 的官方每日持仓，合起来就是整个标普 500
  const holdings = await getHoldings(SECTORS, { ttlHours: HOLDINGS_TTL_HOURS, force });
  const watch = await getWatchlist(WATCHLIST);

  const symbols = new Set([...watch, ...INDICES.map((i) => i.symbol)]);
  for (const s of SECTORS) {
    symbols.add(s.etf);
    for (const h of holdings[s.etf] ?? []) symbols.add(h.symbol);
  }
  const q = await fetchQuotes([...symbols]);

  // config 里的 name/invert 优先，别被行情源的官方长名覆盖
  const indices = INDICES.map((i) => (q[i.symbol] ? { ...q[i.symbol], ...i } : null)).filter(Boolean);

  const sectors = SECTORS.map((s) => {
    const stocks = (holdings[s.etf] ?? [])
      .map((h) => q[h.symbol])
      .filter((x) => x?.cap)
      .map(({ symbol, name, last, pct, cap, earnings }) => ({ symbol, name, last, pct, cap, earnings }));
    return { key: s.key, name: s.name, etf: s.etf, pct: q[s.etf]?.pct ?? 0, stocks };
  }).filter((s) => s.stocks.length);

  const sources = {};
  for (const x of Object.values(q)) sources[x.source] = (sources[x.source] ?? 0) + 1;
  return { indices, sectors, watchlist: watch.map((sym) => q[sym]).filter(Boolean), sources };
}

/**
 * 快刷：指数、自选、市值前 100（首页台上那 20 个人就从这 100 里选）。
 * 一百多只票，Yahoo 三个请求拿完。前端交易时段 5 秒问一次。
 * 市值前 100 是谁，看上一轮全量报价；全量还没回来时先不带。
 */
const LIVE_TOP = 100;

async function buildLive() {
  const watch = await getWatchlist(WATCHLIST);
  const full = cache.get('quotes')?.value;
  const top = full
    ? full.sectors.flatMap((s) => s.stocks).sort((a, b) => b.cap - a.cap).slice(0, LIVE_TOP).map((x) => x.symbol)
    : [];
  const q = await fetchQuotes([...new Set([...INDICES.map((i) => i.symbol), ...watch, ...top])]);
  const brief = ({ last, prev, change, pct, volume }) => ({ last, prev, change, pct, volume });
  return {
    indices: INDICES.map((i) => (q[i.symbol] ? { ...q[i.symbol], ...i } : null)).filter(Boolean),
    watchlist: watch.map((sym) => q[sym]).filter(Boolean),
    stocks: Object.fromEntries(top.filter((s) => q[s]).map((s) => [s, brief(q[s])])),
  };
}

/** 指数条 + 自选的当日分时。自选一改，'sparks' 缓存要跟着清。 */
async function buildSparks() {
  const watch = await getWatchlist(WATCHLIST);
  return sparksFor([...new Set([...INDICES.map((i) => i.symbol), ...watch])]);
}

async function overview({ force }) {
  const [q, sparks] = await Promise.all([
    cached('quotes', CACHE_TTL.quotes, () => buildQuotes({ force })),
    cached('sparks', CACHE_TTL.charts, buildSparks),
  ]);
  const withSpark = (x) => ({ ...x, spark: sparks[x.symbol] ?? [] });
  return { ...q, indices: q.indices.map(withSpark), watchlist: q.watchlist.map(withSpark) };
}

// ── 离群：标普 500 里今天谁有"自己的事" ───────────────────────────
/**
 * 两层：板块相对大盘、个股相对自己的板块。今天的涨跌直接用总览那份报价
 * （同一个缓存），不多打上游；只有基线是额外算的，一天一次。
 */
async function buildFlock() {
  const holdings = await getHoldings(SECTORS, { ttlHours: HOLDINGS_TTL_HOURS });
  const { baseline, progress } = await getBaselines(holdings);
  // 第一次还在算 → 给进度；算失败了在冷却 → 说清楚，别让前端一直转圈
  if (!baseline) return progress ? { status: 'warming', progress } : { status: 'unavailable' };

  const q = await cached('quotes', CACHE_TTL.quotes, buildQuotes);
  const market = q.indices.find((i) => i.symbol === '^GSPC')?.pct ?? null;

  const sectors = q.sectors.map((s) => ({
    key: s.key, name: s.name, etf: s.etf, pct: s.pct,
    ...score(s.pct, market, baseline.sectors[s.etf]),
  }));
  const sectorPct = Object.fromEntries(q.sectors.map((s) => [s.etf, s.pct]));

  const stocks = q.sectors.flatMap((s) => s.stocks.map((x) => ({
    symbol: x.symbol, name: x.name, sector: s.key, pct: x.pct, cap: x.cap,
    ...score(x.pct, sectorPct[s.etf], baseline.stocks[x.symbol]),
  })))
    .filter((x) => x.z != null)                      // 新进来、还没有基线的票先不算
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  return {
    status: 'ready',
    baselineAt: baseline.computedAt,
    market,
    sectors,
    stocks,
    changes: (await recentChanges()).slice(0, 5),
    refreshing: progress,                            // 基线过期在后台重算时不为空
  };
}

// ── 宏观 ──────────────────────────────────────────────────────────
/**
 * 收益率那组要额外给 bp：接口的 change_pct 是"收益率这个数字涨了百分之多少"，
 * 4.660 → 4.718 会显示成 +1.18%，但债券的涨跌单位是基点，实际是 +5.8bp。
 */
async function buildMacro() {
  const symbols = MACRO.flatMap((g) => g.items.map((i) => i.symbol));
  const [q, sparks] = await Promise.all([fetchQuotes(symbols), sparksFor(symbols)]);
  return MACRO.map((g) => ({
    key: g.key,
    name: g.name,
    bp: !!g.bp,
    items: g.items.filter((i) => q[i.symbol]).map((i) => {
      const x = q[i.symbol];
      // 用 last - prev 直接算 bp，比拿 change 字段稳（有的品种 change 是空的）
      const bp = g.bp && x.prev != null ? (x.last - x.prev) * 100 : null;
      return { ...x, name: i.name, bp, spark: sparks[i.symbol] };
    }),
  })).filter((g) => g.items.length);
}

// ── 个股 ──────────────────────────────────────────────────────────
async function buildSymbol(symbol, range) {
  // 三样东西分开缓存：报价几秒一刷，K 线一两分钟，基本面一天都不怎么变
  const [q, details, bars] = await Promise.all([
    cached(`q:${symbol}`, CACHE_TTL.live, () => fetchQuotes([symbol])),
    // 基本面拿不到就空着，不缓存失败，下次再试
    cached(`d:${symbol}`, CACHE_TTL.details, () => fetchDetails(symbol)).catch(() => ({})),
    cached(`b:${symbol}:${range}`, CACHE_TTL.charts, () => fetchBars(symbol, range)).catch(() => []),
  ]);
  if (!q[symbol]) throw new Error(`找不到 ${symbol}`);
  return { quote: { ...q[symbol], ...details }, bars, range, intraday: !!RANGES[range].intraday };
}

// ── 自选 ──────────────────────────────────────────────────────────
async function saveWatchlist(body) {
  if (!Array.isArray(body.symbols)) throw new BadRequest('symbols 必须是数组');
  if (body.symbols.length > WATCH_MAX) throw new BadRequest(`最多 ${WATCH_MAX} 只`);

  const wanted = normalizeWatch(body.symbols);
  const current = await getWatchlist(WATCHLIST);
  // 只验新加的。加一个查不到的代码，结果只会是列表里凭空少一行，
  // 用户以为没保存上——不如当场说清楚。
  const added = wanted.filter((s) => !current.includes(s));
  if (added.length) {
    const q = await fetchQuotes(added);
    const bad = added.filter((s) => !q[s]?.last);
    if (bad.length) throw new BadRequest(`查不到 ${bad.join('、')}`);
  }

  const symbols = await setWatchlist(wanted);
  // 让下一次请求立刻带上新列表，新加的票也要有分时
  for (const k of ['quotes', 'live', 'sparks']) cache.delete(k);
  return { symbols };
}

// ── HTTP ─────────────────────────────────────────────────────────
class BadRequest extends Error {}

/** 读请求体。封个上限，别让一个畸形请求把内存吃光。 */
async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new BadRequest('请求体过大');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new BadRequest('请求体不是合法 JSON'); }
}

/** 每个接口返回一个对象，交易时段和时间戳统一在外面补上。 */
const API = {
  'GET /api/overview': (url) => {
    const force = url.searchParams.has('force');
    if (force) cache.clear();
    return overview({ force });
  },
  'GET /api/live': () => cached('live', CACHE_TTL.live, buildLive),
  'GET /api/flock': buildFlock,
  'GET /api/macro': async (url) => {
    if (url.searchParams.has('force')) cache.delete('macro');
    return { groups: await cached('macro', CACHE_TTL.quotes, buildMacro) };
  },
  'GET /api/symbol': (url) => {
    const sym = (url.searchParams.get('s') ?? '').trim().toUpperCase();
    const range = (url.searchParams.get('range') ?? '1D').toUpperCase();
    // 符号直接进上游 URL，限死字符集和长度。Yahoo 的写法里有 ^ = - .（^GSPC、CL=F、BTC-USD）
    if (!/^[A-Z0-9.\-=^]{1,12}$/.test(sym)) throw new BadRequest('符号不合法');
    if (!RANGES[range]) throw new BadRequest(`不支持的区间 ${range}`);
    return buildSymbol(sym, range);
  },
  'POST /api/watchlist': async (url, req) => saveWatchlist(await readJson(req)),
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, code, body, type = 'application/json') {
  // 一律不缓存。本机看盘用的，省这点带宽不值当；发了缓存头，
  // 改完 js/css 存盘刷新会看不到变化。
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const handler = API[`${req.method} ${url.pathname}`];
    if (!handler) return send(res, 404, { error: '没有这个接口' });
    try {
      const body = await handler(url, req);
      return send(res, 200, { ...body, session: marketSession(MARKET_CLOSURES), fetchedAt: Date.now() });
    } catch (e) {
      return send(res, e instanceof BadRequest ? 400 : 502, { error: String(e?.message ?? e) });
    }
  }

  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(PUBLIC)) return send(res, 403, '', 'text/plain');
  try {
    send(res, 200, await fs.readFile(file), MIME[path.extname(file)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  us-market-pulse  →  http://localhost:${PORT}\n`);
  // 暴露到局域网是个有后果的选择（自选是可写的），得让人看见自己选了什么
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    console.log(`  ⚠️  正在监听 ${HOST}——局域网内任何人都能访问，且能修改自选\n`);
  }
});
