/**
 * Yahoo Finance。主数据源：报价接近实时，K 线全区间都有。
 *
 * 不是公开 API。批量报价和个股详情要先拿一对 cookie + crumb
 * （跟 yfinance 一样的做法），K 线接口不用。crumb 失效就重拿一次。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const Q1 = 'https://query1.finance.yahoo.com';
const Q2 = 'https://query2.finance.yahoo.com';

// ── cookie + crumb ────────────────────────────────────────────────
let auth = null;          // { cookie, crumb }
let authing = null;

async function login() {
  // fc.yahoo.com 回 404，但会顺带种下 A3 cookie，这就够了
  const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const cookies = r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
  const cookie = cookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) throw new Error('Yahoo 没给 cookie');
  const c = await fetch(`${Q2}/v1/test/getcrumb`, { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await c.text()).trim();
  if (!c.ok || !crumb || crumb.includes('<')) throw new Error(`Yahoo crumb 获取失败 HTTP ${c.status}`);
  return { cookie, crumb };
}

/** 带 crumb 的请求。401/403 说明 crumb 过期，重新登录再试一次。 */
async function getAuthed(url, retry = true) {
  auth ??= await (authing ??= login().finally(() => { authing = null; }));
  const res = await fetch(`${url}&crumb=${encodeURIComponent(auth.crumb)}`, {
    headers: { 'User-Agent': UA, Cookie: auth.cookie },
  });
  if ((res.status === 401 || res.status === 403) && retry) {
    auth = null;
    return getAuthed(url, false);
  }
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  return res.json();
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  return res.json();
}

// ── 报价 ──────────────────────────────────────────────────────────
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const raw = (v) => n(v?.raw ?? v);
/** Yahoo 拿 0 表示"不适用"（指数的市盈率之类），转成缺失 */
const nz = (v) => { const x = raw(v); return x === 0 ? null : x; };

/** unix 秒 → 美东的 { date: 'YYYY-MM-DD', hour } */
function etParts(sec) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

/** 财报日。Yahoo 给的是时间戳，按美东钟点推断盘前（B）/ 盘后（A）。 */
function earnings(q) {
  const ts = q.earningsTimestamp ?? q.earningsTimestampStart;
  if (!ts || ts * 1000 < Date.now() - 86_400_000) return null;
  const { date, hour } = etParts(ts);
  return { date, est: !!q.isEarningsDateEstimate, when: hour < 12 ? 'B' : hour >= 16 ? 'A' : null };
}

/** 盘前盘后。只在那两个时段给，盘中和休市都是 null。 */
function extended(q) {
  const s = q.marketState;
  if ((s === 'PRE' || s === 'PREPRE') && n(q.preMarketPrice)) {
    return { last: q.preMarketPrice, pct: n(q.preMarketChangePercent), type: 'PRE' };
  }
  if ((s === 'POST' || s === 'POSTPOST') && n(q.postMarketPrice)) {
    return { last: q.postMarketPrice, pct: n(q.postMarketChangePercent), type: 'POST' };
  }
  return null;
}

function normalize(q) {
  const last = n(q.regularMarketPrice);
  if (last == null) return null;
  return {
    symbol: q.symbol,
    name: q.shortName ?? q.longName ?? q.symbol,
    exchange: q.fullExchangeName ?? null,
    last,
    prev: n(q.regularMarketPreviousClose),
    change: n(q.regularMarketChange),
    pct: n(q.regularMarketChangePercent),
    volume: n(q.regularMarketVolume),
    avgVol: n(q.averageDailyVolume10Day),
    cap: n(q.marketCap),
    dayHi: nz(q.regularMarketDayHigh), dayLo: nz(q.regularMarketDayLow),
    yrHi: nz(q.fiftyTwoWeekHigh), yrLo: nz(q.fiftyTwoWeekLow),
    ext: extended(q),
    earnings: earnings(q),
    time: n(q.regularMarketTime),
  };
}

/** 批量报价 → { [symbol]: quote }。一次 50 个，多了 URL 太长。 */
export async function quotes(symbols) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 50) chunks.push(symbols.slice(i, i + 50));
  const out = {};
  await Promise.all(chunks.map(async (chunk) => {
    const j = await getAuthed(`${Q2}/v7/finance/quote?symbols=${chunk.map(encodeURIComponent).join(',')}`);
    for (const q of j?.quoteResponse?.result ?? []) {
      const x = normalize(q);
      if (x) out[x.symbol] = x;
    }
  }));
  return out;
}

/** 个股页的基本面。拿不到就只有报价，不报错。 */
export async function details(symbol) {
  const modules = 'summaryDetail,defaultKeyStatistics,financialData';
  const j = await getAuthed(`${Q2}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`);
  const r = j?.quoteSummary?.result?.[0];
  if (!r) return {};
  const sd = r.summaryDetail ?? {}, ks = r.defaultKeyStatistics ?? {}, fd = r.financialData ?? {};
  const pct = (v) => (raw(v) == null ? null : raw(v) * 100);   // Yahoo 给小数，界面要百分数
  const exDiv = raw(sd.exDividendDate);
  return {
    open: nz(sd.open),
    pe: nz(sd.trailingPE), fpe: nz(sd.forwardPE ?? ks.forwardPE),
    eps: nz(ks.trailingEps), feps: nz(ks.forwardEps),
    psales: nz(sd.priceToSalesTrailing12Months), beta: nz(sd.beta ?? ks.beta),
    dividendYield: pct(sd.dividendYield),
    roe: pct(fd.returnOnEquity), netMargin: pct(fd.profitMargins), grossMargin: pct(fd.grossMargins),
    debtToEquity: nz(fd.debtToEquity), revenueTTM: nz(fd.totalRevenue),
    exDivDate: exDiv ? etParts(exDiv).date : null,
    divAmount: nz(sd.dividendRate),
  };
}

// ── K 线 ──────────────────────────────────────────────────────────
/** 界面上的区间 → Yahoo 的 range + interval */
export const RANGES = {
  '1D':  { range: '1d', interval: '1m', intraday: true },
  '5D':  { range: '5d', interval: '5m', intraday: true },
  '1M':  { range: '1mo', interval: '1d' },
  '3M':  { range: '3mo', interval: '1d' },
  '6M':  { range: '6mo', interval: '1d' },
  '1Y':  { range: '1y', interval: '1d' },
  '5Y':  { range: '5y', interval: '1wk' },
  'ALL': { range: 'max', interval: '1mo' },
};

/** unix 秒 + 交易所时差 → 'YYYYMMDDHHmmss'（交易所当地时间，前端按它画横轴） */
const stamp = (sec, offset) => new Date((sec + offset) * 1000).toISOString().replace(/\D/g, '').slice(0, 14);

/** 一段 OHLCV。Yahoo 的数组里会夹着 null（停牌、没成交的那一分钟），过滤掉。 */
export async function bars(symbol, rangeKey) {
  const { range, interval } = RANGES[rangeKey];
  const j = await getJSON(`${Q1}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`);
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp) return [];
  const q = r.indicators?.quote?.[0] ?? {};
  const off = r.meta?.gmtoffset ?? 0;
  return r.timestamp.map((t, i) => ({
    t: t * 1000,
    time: stamp(t, off),
    o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i],
    v: q.volume?.[i] ?? 0,
  })).filter((b) => n(b.c) != null);
}

/** 当日分时收盘价，5 分钟一个点就够画迷你图了 */
export async function spark(symbol) {
  const j = await getJSON(`${Q1}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m&includePrePost=false`);
  return (j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []).filter((v) => n(v) != null);
}
