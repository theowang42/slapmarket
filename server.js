import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKET, SECTORS, CACHE_TTL, PORT, HOST, HOLDINGS_TTL_HOURS, MARKET_CLOSURES } from './config.js';
import { fetchQuotes, fetchDetails, fetchBars, RANGES } from './lib/market-data.js';
import { getHoldings } from './lib/holdings.js';
import { marketSession } from './lib/market-hours.js';

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

// ── 全量：大盘 + 标普 500 全部成分股，按 11 个板块分好 ────────────────
async function buildMarket({ force = false } = {}) {
  // 成分股 = 11 只行业 ETF 的官方每日持仓，合起来就是整个标普 500
  const holdings = await getHoldings(SECTORS, { ttlHours: HOLDINGS_TTL_HOURS, force });
  const symbols = new Set([MARKET]);
  for (const s of SECTORS) {
    symbols.add(s.etf);
    for (const h of holdings[s.etf] ?? []) symbols.add(h.symbol);
  }
  const q = await fetchQuotes([...symbols]);

  const sectors = SECTORS.map((s) => ({
    key: s.key, name: s.name, etf: s.etf, pct: q[s.etf]?.pct ?? 0,
    stocks: (holdings[s.etf] ?? [])
      .map((h) => q[h.symbol])
      .filter((x) => x?.cap)
      .map(({ symbol, name, last, pct, cap }) => ({ symbol, name, last, pct, cap })),
  })).filter((s) => s.stocks.length);

  const sources = {};
  for (const x of Object.values(q)) sources[x.source] = (sources[x.source] ?? 0) + 1;
  return { market: q[MARKET] ?? null, sectors, sources };
}

/**
 * 快刷：大盘 + 市值前 100（台上那 20 个人就从这 100 里选）。
 * 市值前 100 是谁，看上一轮全量；全量还没回来时只带大盘。
 */
const TOP = 100;

async function buildLive() {
  const full = cache.get('market')?.value;
  const top = full
    ? full.sectors.flatMap((s) => s.stocks).sort((a, b) => b.cap - a.cap).slice(0, TOP).map((x) => x.symbol)
    : [];
  const q = await fetchQuotes([MARKET, ...top]);
  return {
    market: q[MARKET] ?? null,
    stocks: Object.fromEntries(top.filter((s) => q[s]).map((s) => [s, { last: q[s].last, pct: q[s].pct }])),
  };
}

/** 侧边盘面和悬停卡片：报价 + 基本面 + 一段 K 线，三样分开缓存 */
async function buildSymbol(symbol, range) {
  const [q, details, bars] = await Promise.all([
    cached(`q:${symbol}`, CACHE_TTL.live, () => fetchQuotes([symbol])),
    cached(`d:${symbol}`, CACHE_TTL.details, () => fetchDetails(symbol)),
    cached(`b:${symbol}:${range}`, CACHE_TTL.charts, () => fetchBars(symbol, range)),
  ]);
  if (!q[symbol]) throw new Error(`找不到 ${symbol}`);
  return { quote: { ...q[symbol], ...details }, bars, range, intraday: !!RANGES[range].intraday };
}

// ── HTTP ─────────────────────────────────────────────────────────
class BadRequest extends Error {}

/** 每个接口返回一个对象，交易时段和时间戳统一在外面补上 */
const API = {
  '/api/market': (url) => {
    const force = url.searchParams.has('force');
    if (force) cache.clear();
    return cached('market', CACHE_TTL.quotes, () => buildMarket({ force }));
  },
  '/api/live': () => cached('live', CACHE_TTL.live, buildLive),
  '/api/symbol': (url) => {
    const sym = (url.searchParams.get('s') ?? '').trim().toUpperCase();
    const range = (url.searchParams.get('range') ?? '1D').toUpperCase();
    // 代码直接进上游 URL，限死字符集和长度。Yahoo 的写法里有 ^ = - .（^GSPC、CL=F、BRK-B）
    if (!/^[A-Z0-9.\-=^]{1,12}$/.test(sym)) throw new BadRequest('代码不合法');
    if (!RANGES[range]) throw new BadRequest(`不支持的区间 ${range}`);
    return buildSymbol(sym, range);
  },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, code, body, type = 'application/json') {
  // 一律不缓存：本机用的，改完 js/css 存盘一刷新就该看到
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    const handler = req.method === 'GET' && API[url.pathname];
    if (!handler) return send(res, 404, { error: '没有这个接口' });
    try {
      const body = await handler(url);
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

server.listen(PORT, HOST, () => console.log(`\n  slapmarket  →  http://localhost:${PORT}\n`));
