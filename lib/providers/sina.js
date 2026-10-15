/**
 * 新浪财经美股行情。股票和三大指数的报价以它为主：一个请求六十只，实时，国内也快。
 *
 * 返回的是一段 GBK 编码的 JS：
 *   var hq_str_gb_nvda="英伟达,182.30,1.80,2026-10-16 01:40:00,3.22,180.00,184.49,179.57,...";
 * 必须带新浪的 Referer，否则 403。
 */

const URL_BASE = 'https://hq.sinajs.cn/list=';
const HEADERS = { Referer: 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' };

/** 指数在新浪的代码。表里没有的（VIX、罗素、宏观品种）新浪不提供，直接跳过。 */
const INDEX = { '^GSPC': 'gb_$inx', '^DJI': 'gb_$dji', '^IXIC': 'gb_ixic' };
const BACK = Object.fromEntries(Object.entries(INDEX).map(([k, v]) => [v, k]));

/** 新浪有没有这个品种。上层用它决定先问谁 */
export const supports = (sym) => toSina(sym) != null;

/** 我们的代码 → 新浪代码。股票：小写，B 股用点（BRK-B → gb_brk.b） */
function toSina(sym) {
  if (INDEX[sym]) return INDEX[sym];
  if (!/^[A-Z]+(-[A-Z])?$/.test(sym)) return null;     // 只认股票；期货、汇率、加密新浪这里没有
  return `gb_${sym.toLowerCase().replace('-', '.')}`;
}
const fromSina = (code) => BACK[code] ?? code.slice(3).toUpperCase().replace('.', '-');

const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) && x !== 0 ? x : null;
};

/**
 * 字段位置（新浪没有文档，按页面反推，位置跟着他们的前端走）：
 *  0 名称  1 现价  2 涨跌幅%  3 时间  4 涨跌额  5 开盘  6 最高  7 最低
 *  8 52 周高  9 52 周低  10 成交量  11 10 日均量  12 市值  13 EPS  14 市盈率
 *  21 盘前/盘后价  22 盘前/盘后涨跌幅%  26 昨收
 */
function parse(code, f) {
  const last = num(f[1]);
  if (last == null) return null;
  const prev = num(f[26]) ?? (num(f[4]) != null ? last - Number(f[4]) : null);
  const extLast = num(f[21]);
  return {
    symbol: fromSina(code),
    name: f[0] || fromSina(code),
    last,
    prev,
    change: Number(f[4]) || 0,
    pct: Number(f[2]) || 0,
    volume: num(f[10]),
    avgVol: num(f[11]),
    cap: num(f[12]),
    dayHi: num(f[6]), dayLo: num(f[7]),
    yrHi: num(f[8]), yrLo: num(f[9]),
    // 新浪不分盘前盘后，只给一个"延长时段"价；有就显示，标成盘后
    ext: extLast && extLast !== last ? { last: extLast, pct: Number(f[22]) || 0, type: 'POST' } : null,
    earnings: null,
    pe: num(f[14]), eps: num(f[13]),
  };
}

/** 批量报价 → { [symbol]: quote }。新浪不认识的代码直接略过。 */
export async function quotes(symbols) {
  const codes = symbols.map(toSina).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < codes.length; i += 60) chunks.push(codes.slice(i, i + 60));
  const out = {};
  await Promise.all(chunks.map(async (chunk) => {
    const res = await fetch(URL_BASE + chunk.join(','), { headers: HEADERS });
    if (!res.ok) throw new Error(`新浪 HTTP ${res.status}`);
    const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
    for (const m of text.matchAll(/hq_str_(\S+?)="([^"]*)"/g)) {
      const q = m[2] && parse(m[1], m[2].split(','));
      if (q) out[q.symbol] = q;
    }
  }));
  return out;
}

// ── K 线 ──────────────────────────────────────────────────────────
// Yahoo 的图表接口拿不到时的备用。返回格式跟 Yahoo 那边一致：[{t, time, o, h, l, c, v}]

const KLINE = 'https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20_k=/US_MinKService';
/** K 线接口里指数用点开头的写法 */
const KSYM = { '^GSPC': '.INX', '^DJI': '.DJI', '^IXIC': '.IXIC' };
const kSymbol = (sym) => KSYM[sym] ?? (/^[A-Z]+(-[A-Z])?$/.test(sym) ? sym.replace('-', '.') : null);

async function kline(method, sym, query = '') {
  const code = kSymbol(sym);
  if (!code) throw new Error(`新浪 K 线没有 ${sym}`);
  const res = await fetch(`${KLINE}.${method}?symbol=${encodeURIComponent(code)}${query}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`新浪 K 线 HTTP ${res.status}`);
  return parseKline(await res.text());
}

/** 新浪 K 线的 JSONP → bars。有时键名不带引号，取出方括号里那段，补上引号再解析 */
export function parseKline(text) {
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a < 0 || b < a) throw new Error('新浪 K 线格式不认识');
  const body = text.slice(a, b + 1);
  let rows;
  try { rows = JSON.parse(body); } catch { rows = JSON.parse(body.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')); }
  return rows.map((r) => {
    const d = String(r.d ?? r.day ?? '');
    return {
      t: Date.parse(d.replace(' ', 'T')),
      time: (d.replace(/\D/g, '') + '000000').slice(0, 14),
      o: Number(r.o ?? r.open), h: Number(r.h ?? r.high), l: Number(r.l ?? r.low), c: Number(r.c ?? r.close),
      v: Number(r.v ?? r.volume) || 0,
    };
  }).filter((x) => x.c > 0 && x.time.length === 14);
}

/** 日线并成周线 / 月线：key 决定按什么分组 */
function merge(bars, key) {
  const out = [];
  for (const b of bars) {
    const last = out.at(-1);
    if (last && key(last) === key(b)) {
      last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v;
    } else out.push({ ...b });
  }
  return out;
}
const week = (b) => Math.floor((b.t / 86_400_000 + 3) / 7);          // 1970-01-01 是周四，+3 让周一开新的一组
const month = (b) => b.time.slice(0, 6);

/** 只留最后 n 个交易日 */
const lastDays = (bars, n) => {
  const days = [...new Set(bars.map((b) => b.time.slice(0, 8)))].slice(-n);
  return bars.filter((b) => days.includes(b.time.slice(0, 8)));
};

/** 区间跟 Yahoo 那边同一套：1D 5D 1M 3M 6M 1Y 5Y ALL */
export async function bars(sym, range) {
  switch (range) {
    case '1D': return lastDays(await kline('getMinK', sym, '&type=5'), 1);
    case '5D': return lastDays(await kline('getMinK', sym, '&type=30'), 5);
    case '1M': return (await kline('getDailyK', sym)).slice(-22);
    case '3M': return (await kline('getDailyK', sym)).slice(-65);
    case '6M': return (await kline('getDailyK', sym)).slice(-126);
    case '1Y': return (await kline('getDailyK', sym)).slice(-252);
    case '5Y': return merge(await kline('getDailyK', sym), week).slice(-261);
    default: return merge(await kline('getDailyK', sym), month);
  }
}
