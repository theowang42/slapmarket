import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WATCHLIST, INDICES, SECTORS, MACRO, CACHE_TTL, PORT, HOST,
  HOLDINGS_PICK, HOLDINGS_TTL_HOURS, MARKET_CLOSURES,
} from './config.js';
import { getHoldings } from './lib/holdings.js';
import { lookupDay } from './lib/market-calendar.js';
import { getWatchlist, setWatchlist, normalize as normalizeWatch, MAX as WATCH_MAX } from './lib/watchlist.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

// ── 数据源：CNBC 公开行情接口。免 key，报价约 15 分钟延迟。 ──────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const QUOTE_API = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const CHART_API = (range) => `https://ts-api.cnbc.com/harmony/app/charts/${range}.json`;

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.slice(0, 60)}`);
  return res.json();
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,%+$]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** "4.537T" / "512.3B" / "900.1M" → 数字 */
function parseCap(v) {
  const m = /^([\d.,]+)\s*([TBMK]?)$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  const mult = { T: 1e12, B: 1e9, M: 1e6, K: 1e3, '': 1 }[m[2].toUpperCase()];
  return num(m[1]) * mult;
}

/**
 * 财报日。"10/28/2026(est)" → { date: '2026-10-28', est: true }。
 * 带 (est) 的是交易所还没定档、CNBC 自己推算的，日历上要区分开——
 * 按它安排事情，结果当天没出财报，那比不显示还糟。
 */
function parseEarnings(e) {
  const raw = e?.next_earnings_date;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(raw ?? ''));
  if (!m) return null;
  return {
    date: `${m[3]}-${m[1]}-${m[2]}`,
    est: /\(est\)/i.test(raw),
    when: e.announce_time ?? null,      // A = 盘后，B = 盘前
  };
}

function normalizeQuote(q) {
  const last = num(q.last);
  const prev = num(q.previous_day_closing);
  if (last == null) return null;
  const ext = q.ExtendedMktQuote?.last
    ? { last: num(q.ExtendedMktQuote.last), pct: num(q.ExtendedMktQuote.change_pct), type: q.ExtendedMktQuote.type }
    : null;
  return {
    symbol: q.symbol,
    name: q.name ?? q.symbol,
    last,
    prev,
    change: num(q.change),
    pct: num(q.change_pct) ?? (prev ? ((last - prev) / prev) * 100 : 0),
    volume: num(q.volume),
    cap: parseCap(q.mktcapView) ?? (parseCap(q.sharesout) != null ? parseCap(q.sharesout) * last : null),
    status: q.curmktstatus ?? null,
    ext,
    // 批量报价里本来就带 EventData（URL 上有 events=1），白拿的，
    // 财报日历整页就靠这一个字段，不用额外打接口
    earnings: parseEarnings(q.EventData),
    // 自选卡片要画日内区间和 52 周区间。几个数而已，跟着批量报价一起带上
    dayHi: nz(q.high), dayLo: nz(q.low),
    yrHi: nz(q.yrhiprice), yrLo: nz(q.yrloprice),
    avgVol: parseCap(q.tendayavgvol),
  };
}

/**
 * 个股页要的那些字段。报价接口本来就一起返回了，只是总览用不上，
 * 全塞进总览会让两百多只票的响应白白变大一倍，所以单独取。
 */
const dateStr = (v) => (v && v !== 'N/A' ? String(v) : null);

/**
 * 上游用 0 表示"这项不适用"——指数没有市盈率、ETF 没有毛利率，给的都是 0。
 * 原样透出去，界面上就会显示"市盈率 0.00"，看着像真数据。一律转成缺失。
 * 负数要留：亏损公司的 EPS、净利率本来就是负的。
 */
const nz = (v) => {
  const n = num(v);
  return n === 0 ? null : n;
};

function detailFields(q) {
  const e = q.EventData ?? {};
  return {
    shortName: q.shortName ?? null,
    exchange: q.exchange ?? null,
    open: nz(q.open), high: nz(q.high), low: nz(q.low),
    // 52 周高低带日期——"什么时候到的顶"比"顶在哪"更有信息量
    yrHi: nz(q.yrhiprice), yrHiDate: dateStr(q.yrhidate),
    yrLo: nz(q.yrloprice), yrLoDate: dateStr(q.yrlodate),
    pe: nz(q.pe), fpe: nz(q.fpe), eps: nz(q.eps), feps: nz(q.feps),
    dividend: nz(q.dividend), dividendYield: nz(q.dividendyield), beta: nz(q.beta),
    revenueTTM: parseCap(q.revenuettm), psales: nz(q.psales),
    roe: nz(q.ROETTM), netMargin: nz(q.NETPROFTTM), grossMargin: nz(q.GROSMGNTTM),
    debtToEquity: nz(q.DEBTEQTYQ),
    sharesOut: parseCap(q.sharesout),
    avgVol10d: parseCap(q.tendayavgvol),
    events: {
      earningsDate: dateStr(e.next_earnings_date),
      earningsWhen: e.announce_time ?? null,      // A = 盘后公布，B = 盘前
      exDivDate: dateStr(e.div_ex_date),
      divAmount: num(e.div_amount),
      halted: e.is_halted === 'Y',
      atYrHi: e.yrhiind === 'Y',
      atYrLo: e.yrloind === 'Y',
    },
  };
}

/** 一次最多 25 个符号，多了接口会截断。 */
async function fetchQuotes(symbols) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 25) chunks.push(symbols.slice(i, i + 25));
  const out = {};
  const results = await Promise.all(chunks.map(async (chunk) => {
    const url = `${QUOTE_API}?symbols=${chunk.map(encodeURIComponent).join('%7C')}`
      + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';
    const json = await getJSON(url);
    const raw = json?.FormattedQuoteResult?.FormattedQuote ?? [];
    return Array.isArray(raw) ? raw : [raw];
  }));
  for (const q of results.flat()) {
    const n = normalizeQuote(q);
    if (n) out[n.symbol] = n;
  }
  return out;
}

/** 取一段 OHLCV。tradeTime 形如 20260731000000。 */
async function fetchBars(symbol, src) {
  const json = await getJSON(`${CHART_API(src)}?symbol=${encodeURIComponent(symbol)}`);
  const bars = json?.barData?.priceBars ?? [];
  return bars.map((b) => ({
    t: Number(b.tradeTimeinMills),
    time: String(b.tradeTime),
    o: num(b.open), h: num(b.high), l: num(b.low), c: num(b.close),
    v: Number(b.volume) || 0,
  })).filter((b) => b.c != null);
}

/** 只保留最后一个交易日的 bar。分时接口会把前一交易日也带上。 */
const lastSessionOnly = (bars) => {
  if (!bars.length) return bars;
  const day = bars.at(-1).time.slice(0, 8);
  return bars.filter((b) => b.time.startsWith(day));
};

/** 顶部指数的当日分时线，抽稀到 120 点。 */
async function fetchSpark(symbol) {
  const pts = lastSessionOnly(await fetchBars(symbol, '1D')).map((b) => b.c);
  if (pts.length <= 120) return pts;
  const step = pts.length / 120;
  return Array.from({ length: 120 }, (_, i) => pts[Math.floor(i * step)]);
}

/**
 * 界面上的区间 → 上游档位 + 截取。
 *
 * 上游这套档位名字跟实际给的东西对不上：`1M` 给的是约 1 年的日线，
 * `5Y` 给的是 10 年的周线，`ALL` 是 1999 年起的月线。所以四个中短区间
 * 都从同一份日线里切，既少打接口，切区间时还能直接命中缓存。
 */
const RANGES = {
  '1D':  { src: '1D', todayOnly: true, intraday: true },
  '5D':  { src: '5D', intraday: true },
  '1M':  { src: '1M', tail: 22 },
  '3M':  { src: '1M', tail: 65 },
  '6M':  { src: '1M', tail: 126 },
  '1Y':  { src: '1M' },
  '5Y':  { src: '5Y', tail: 261 },
  'ALL': { src: 'ALL' },
};

async function fetchQuoteDetail(symbol) {
  const url = `${QUOTE_API}?symbols=${encodeURIComponent(symbol)}`
    + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';
  const json = await getJSON(url);
  const raw = json?.FormattedQuoteResult?.FormattedQuote ?? [];
  const one = Array.isArray(raw) ? raw[0] : raw;
  const base = one ? normalizeQuote(one) : null;
  // 符号不存在时上游不报错，回一份 last=0 的占位记录。照单全收的话
  // 页面会渲染出一屏 0.00 冒充行情，所以在这里就判死。
  if (!base || !base.last) throw new Error(`找不到 ${symbol}`);
  return { ...base, ...detailFields(one) };
}

async function buildSymbol(symbol, range) {
  const cfg = RANGES[range];
  // 报价和 K 线分开缓存：报价 60 秒该刷，几年的日线不必跟着刷
  const [quote, raw] = await Promise.all([
    cached(`q:${symbol}`, CACHE_TTL.quotes, () => fetchQuoteDetail(symbol)),
    cached(`b:${symbol}:${cfg.src}`, CACHE_TTL.charts, () => fetchBars(symbol, cfg.src)).catch(() => []),
  ]);
  let bars = cfg.todayOnly ? lastSessionOnly(raw) : raw;
  if (cfg.tail) bars = bars.slice(-cfg.tail);
  return { quote, bars, range, intraday: !!cfg.intraday, ranges: Object.keys(RANGES) };
}

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

// ── 组装 ──────────────────────────────────────────────────────────
async function buildQuotes({ force = false } = {}) {
  // 成分股来自 SSGA 官方每日持仓，不再是写死的名单
  const { holdings, meta } = await getHoldings(SECTORS, {
    ttlHours: HOLDINGS_TTL_HOURS,
    pickOpts: HOLDINGS_PICK,
    force,
  });

  // 自选以磁盘上那份为准，config 里的 WATCHLIST 只是初始值
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
      .map((h) => {
        const x = q[h.symbol];
        return x && x.cap
          ? { symbol: x.symbol, name: x.name, last: x.last, pct: x.pct, cap: x.cap, weight: h.weight, pinned: h.pinned, earnings: x.earnings }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.cap - a.cap);
    const cap = stocks.reduce((a, b) => a + b.cap, 0);
    const etf = q[s.etf];
    const pct = etf ? etf.pct : cap ? stocks.reduce((a, b) => a + b.pct * b.cap, 0) / cap : 0;
    return { key: s.key, name: s.name, etf: s.etf, pct, cap, stocks };
  }).filter((s) => s.stocks.length);

  const watchlist = watch.map((sym) => q[sym]).filter(Boolean);

  const all = sectors.flatMap((s) => s.stocks);
  const breadth = {
    up: all.filter((s) => s.pct > 0).length,
    down: all.filter((s) => s.pct < 0).length,
    flat: all.filter((s) => s.pct === 0).length,
    total: all.length,
  };

  return { indices, sectors, watchlist, breadth, holdingsMeta: meta, quoteStatus: indices[0]?.status ?? null };
}

/**
 * 宏观页。跟总览走同一个报价接口，只是分组不同。
 *
 * 收益率那组要额外给 bp：接口的 change_pct 是"收益率这个数字涨了百分之多少"，
 * 4.660 → 4.718 会显示成 +1.18%，但债券的涨跌单位是基点，实际是 +5.8bp。
 * 直接把百分比摆出去会让人读错一个数量级。
 */
async function buildMacro() {
  const symbols = MACRO.flatMap((g) => g.items.map((i) => i.symbol));
  const q = await fetchQuotes(symbols);

  const groups = MACRO.map((g) => ({
    key: g.key,
    name: g.name,
    bp: !!g.bp,
    items: g.items.map((i) => {
      const x = q[i.symbol];
      if (!x) return null;
      // 收益率用 last - prev 直接算 bp，比拿 change 字段稳（有的品种 change 是空的）
      const bp = g.bp && x.last != null && x.prev != null
        ? (x.last - x.prev) * 100
        : null;
      return { ...x, name: i.name, symbol: i.symbol, bp };
    }).filter(Boolean),
  })).filter((g) => g.items.length);

  return { groups };
}

async function buildMacroSparks() {
  const symbols = MACRO.flatMap((g) => g.items.map((i) => i.symbol));
  const entries = await Promise.all(symbols.map(async (s) => {
    try { return [s, await fetchSpark(s)]; } catch { return [s, []]; }
  }));
  return Object.fromEntries(entries);
}

/** 指数条 + 自选卡片的当日分时。自选一改，'charts' 缓存要跟着清。 */
async function buildSparks() {
  const watch = await getWatchlist(WATCHLIST);
  const symbols = [...new Set([...INDICES.map((i) => i.symbol), ...watch])];
  const entries = await Promise.all(symbols.map(async (s) => {
    try { return [s, await fetchSpark(s)]; } catch { return [s, []]; }
  }));
  return Object.fromEntries(entries);
}

// ── 美东交易时段 ─────────────────────────────────────────────────
function marketSession(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  const mins = (Number(p.hour) % 24) * 60 + Number(p.minute);
  const at = (h, m) => h * 60 + m;
  const etTime = `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`;
  const etDate = `${p.year}-${p.month}-${p.day}`;
  const base = { etTime, etDate, weekday: p.weekday };

  if (p.weekday === 'Sat' || p.weekday === 'Sun') {
    return { ...base, phase: 'closed', label: '休市', note: '周末' };
  }

  const special = lookupDay(etDate, MARKET_CLOSURES);
  if (special?.type === 'closed') {
    return { ...base, phase: 'closed', label: '休市', note: special.name, holiday: special.name };
  }

  // 提前收盘日：13:00 收盘，盘后也跟着提前到 17:00 结束
  const half = special?.type === 'half';
  const close = half ? at(13, 0) : at(16, 0);
  const postEnd = half ? at(17, 0) : at(20, 0);
  const tail = half ? ` · ${special.name}提前收盘` : '';
  const flags = half ? { half: true, holiday: special.name } : {};

  if (mins < at(4, 0)) return { ...base, ...flags, phase: 'closed', label: '休市', note: `距盘前 ${fmtGap(at(4, 0) - mins)}${tail}` };
  if (mins < at(9, 30)) return { ...base, ...flags, phase: 'pre', label: '盘前', note: `距开盘 ${fmtGap(at(9, 30) - mins)}${tail}` };
  if (mins < close) return { ...base, ...flags, phase: 'open', label: '交易中', note: `距收盘 ${fmtGap(close - mins)}${tail}` };
  if (mins < postEnd) return { ...base, ...flags, phase: 'post', label: '盘后', note: `距结束 ${fmtGap(postEnd - mins)}${tail}` };
  return { ...base, ...flags, phase: 'closed', label: '休市', note: `已收盘${tail}` };
}
const fmtGap = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

// ── HTTP ─────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

/** 读请求体。封个上限，别让一个畸形请求把内存吃光。 */
async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/overview') {
    const force = url.searchParams.has('force');
    if (force) cache.clear();
    try {
      const [q, sparks] = await Promise.all([
        cached('quotes', CACHE_TTL.quotes, () => buildQuotes({ force })),
        cached('charts', CACHE_TTL.charts, buildSparks),
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        ...q,
        indices: q.indices.map((i) => ({ ...i, spark: sparks[i.symbol] ?? [] })),
        watchlist: q.watchlist.map((w) => ({ ...w, spark: sparks[w.symbol] ?? [] })),
        session: marketSession(),
        fetchedAt: Date.now(),
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  }

  if (url.pathname === '/api/watchlist') {
    const json = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') return json(405, { error: '只接受 POST' });
    try {
      const body = await readJson(req);
      if (!Array.isArray(body.symbols)) return json(400, { error: 'symbols 必须是数组' });
      if (body.symbols.length > WATCH_MAX) return json(400, { error: `最多 ${WATCH_MAX} 只` });

      const wanted = normalizeWatch(body.symbols);
      const current = await getWatchlist(WATCHLIST);
      // 只验新加的。加一个查不到的代码，结果只会是列表里凭空少一行，
      // 用户以为没保存上——不如当场说清楚。
      const added = wanted.filter((s) => !current.includes(s));
      if (added.length) {
        const q = await fetchQuotes(added);
        const bad = added.filter((s) => !q[s]?.last);
        if (bad.length) return json(400, { error: `查不到 ${bad.join('、')}` });
      }

      const list = await setWatchlist(wanted);
      cache.delete('quotes');           // 让下一次 /api/overview 立刻带上新列表
      cache.delete('charts');           // 新加的票也要有分时
      return json(200, { symbols: list });
    } catch (e) {
      return json(400, { error: String(e?.message ?? e) });
    }
  }

  if (url.pathname === '/api/macro') {
    if (url.searchParams.has('force')) { cache.delete('macro'); cache.delete('macroCharts'); }
    try {
      const [m, sparks] = await Promise.all([
        cached('macro', CACHE_TTL.quotes, buildMacro),
        cached('macroCharts', CACHE_TTL.charts, buildMacroSparks),
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        groups: m.groups.map((g) => ({
          ...g,
          items: g.items.map((i) => ({ ...i, spark: sparks[i.symbol] ?? [] })),
        })),
        session: marketSession(),
        fetchedAt: Date.now(),
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  }

  if (url.pathname === '/api/symbol') {
    const sym = (url.searchParams.get('s') ?? '').trim().toUpperCase();
    const range = (url.searchParams.get('range') ?? '1D').toUpperCase();
    // 符号直接进上游 URL，限死字符集和长度。CNBC 的写法里有 . = @（.SPX、BRK.B）
    if (!/^[A-Z0-9.\-=@]{1,12}$/.test(sym)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: '符号不合法' }));
    }
    if (!RANGES[range]) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: `不支持的区间 ${range}` }));
    }
    try {
      const data = await buildSymbol(sym, range);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ...data, session: marketSession(), fetchedAt: Date.now() }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      // 不发缓存头的话浏览器会按启发式规则自己缓存 js/css，改完存盘刷新页面看不到变化，
      // 得手动强刷才行。本来就是本机看盘用的，省这点带宽不值当。
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

server.listen(PORT, HOST, () => {
  console.log(`\n  US Market Pulse  →  http://localhost:${PORT}`);
  // 暴露到局域网是个有后果的选择（自选是可写的），得让人看见自己选了什么
  if (!LOOPBACK.includes(HOST)) {
    console.log(`  ⚠️  正在监听 ${HOST}——局域网内任何人都能访问，且能修改自选\n`);
  } else {
    console.log('');
  }
});
