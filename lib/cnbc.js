/**
 * 行情上游：CNBC 网页自己用的两个接口。免 key，报价约 15 分钟延迟。
 * 只管"取回来、洗干净"，不管缓存——缓存在 server.js 里统一做。
 *
 * 上游字段是给网页渲染用的字符串（"127,585,441"、"4.858T"、"0.50%"），
 * 还会拿 0 表示"这项不适用"。这里全部转成数字或 null。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const QUOTE_API = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const CHART_API = (range) => `https://ts-api.cnbc.com/harmony/app/charts/${range}.json`;

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.slice(0, 60)}`);
  return res.json();
}

// ── 清洗 ──────────────────────────────────────────────────────────
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,%+$]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * 上游用 0 表示"这项不适用"——指数没有市盈率、ETF 没有毛利率，给的都是 0。
 * 原样透出去，界面上就会显示"市盈率 0.00"，看着像真数据。一律转成缺失。
 * 负数要留：亏损公司的 EPS、净利率本来就是负的。
 */
const nz = (v) => {
  const n = num(v);
  return n === 0 ? null : n;
};

const dateStr = (v) => (v && v !== 'N/A' ? String(v) : null);

/** "4.537T" / "512.3B" / "900.1M" → 数字 */
function parseCap(v) {
  const m = /^([\d.,]+)\s*([TBMK]?)$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  const mult = { T: 1e12, B: 1e9, M: 1e6, K: 1e3, '': 1 }[m[2].toUpperCase()];
  return num(m[1]) * mult;
}

/**
 * 财报日。"10/28/2026(est)" → { date: '2026-10-28', est: true }。
 * 带 (est) 的是交易所还没定档、CNBC 自己推算的，日历上要区分开。
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

/** 所有页面都要的报价字段。 */
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
    avgVol: parseCap(q.tendayavgvol),
    cap: parseCap(q.mktcapView) ?? (parseCap(q.sharesout) != null ? parseCap(q.sharesout) * last : null),
    status: q.curmktstatus ?? null,
    ext,
    earnings: parseEarnings(q.EventData),
    dayHi: nz(q.high), dayLo: nz(q.low),
    yrHi: nz(q.yrhiprice), yrLo: nz(q.yrloprice),
  };
}

/**
 * 个股页额外要的字段。报价接口本来就一起返回了，但总览五百多只票用不上，
 * 全带上会让响应白白变大好几倍，所以只在单只查询时附上。
 */
function detailFields(q) {
  const e = q.EventData ?? {};
  return {
    exchange: q.exchange ?? null,
    open: nz(q.open),
    // 52 周高低带日期——"什么时候到的顶"比"顶在哪"更有信息量
    yrHiDate: dateStr(q.yrhidate), yrLoDate: dateStr(q.yrlodate),
    pe: nz(q.pe), fpe: nz(q.fpe), eps: nz(q.eps), feps: nz(q.feps),
    dividendYield: nz(q.dividendyield), beta: nz(q.beta),
    revenueTTM: parseCap(q.revenuettm), psales: nz(q.psales),
    roe: nz(q.ROETTM), netMargin: nz(q.NETPROFTTM), grossMargin: nz(q.GROSMGNTTM),
    debtToEquity: nz(q.DEBTEQTYQ),
    events: {
      exDivDate: dateStr(e.div_ex_date),
      divAmount: num(e.div_amount),
      halted: e.is_halted === 'Y',
    },
  };
}

// ── 报价 ──────────────────────────────────────────────────────────
/** 原始报价。一次最多 25 个符号，多了接口会截断，所以分批并发。 */
async function fetchRaw(symbols) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 25) chunks.push(symbols.slice(i, i + 25));
  const results = await Promise.all(chunks.map(async (chunk) => {
    const url = `${QUOTE_API}?symbols=${chunk.map(encodeURIComponent).join('%7C')}`
      + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';
    const raw = (await getJSON(url))?.FormattedQuoteResult?.FormattedQuote ?? [];
    return Array.isArray(raw) ? raw : [raw];
  }));
  return results.flat();
}

/** 批量报价 → { [symbol]: quote } */
export async function fetchQuotes(symbols) {
  const out = {};
  for (const q of await fetchRaw(symbols)) {
    const n = normalizeQuote(q);
    if (n) out[n.symbol] = n;
  }
  return out;
}

/** 单只报价，带个股页的全部字段。 */
export async function fetchQuoteDetail(symbol) {
  const [one] = await fetchRaw([symbol]);
  const base = one ? normalizeQuote(one) : null;
  // 符号不存在时上游不报错，回一份 last=0 的占位记录。照单全收的话
  // 页面会渲染出一屏 0.00 冒充行情，所以在这里就判死。
  if (!base || !base.last) throw new Error(`找不到 ${symbol}`);
  return { ...base, ...detailFields(one) };
}

// ── K 线 ──────────────────────────────────────────────────────────
/** 取一段 OHLCV。tradeTime 形如 20260731000000。 */
export async function fetchBars(symbol, src) {
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
export const lastSessionOnly = (bars) => {
  if (!bars.length) return bars;
  const day = bars.at(-1).time.slice(0, 8);
  return bars.filter((b) => b.time.startsWith(day));
};

/** 当日分时收盘价，抽稀到 120 点。迷你分时线用。 */
export async function fetchSpark(symbol) {
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
export const RANGES = {
  '1D':  { src: '1D', todayOnly: true, intraday: true },
  '5D':  { src: '5D', intraday: true },
  '1M':  { src: '1M', tail: 22 },
  '3M':  { src: '1M', tail: 65 },
  '6M':  { src: '1M', tail: 126 },
  '1Y':  { src: '1M' },
  '5Y':  { src: '5Y', tail: 261 },
  'ALL': { src: 'ALL' },
};
