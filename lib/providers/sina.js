/**
 * 新浪财经美股行情。备用数据源：只管报价，Yahoo 拿不到的票才来这里问。
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
