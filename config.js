// ─────────────────────────────────────────────────────────────
// 所有可调的东西都在这。改完重启 npm start 生效。
// 代码用 Yahoo 写法：股票直接写 ticker，B 股用横杠（BRK-B），指数带 ^（^GSPC）。
// ─────────────────────────────────────────────────────────────

/** 大盘：中间最大那座雕塑、状态栏里的涨跌都看它 */
export const MARKET = '^GSPC';

/**
 * 板块 = 11 只 SPDR 行业 ETF，合起来就是整个标普 500。
 *
 * 成分股不用写：服务端每天从 SSGA 官网拉这些 ETF 的官方每日持仓，
 * 指数调仓、并购退市都会自动跟上。市值最大的 4 个板块会立雕塑。
 *
 * pin —— 例外通道：这里写的代码一定会算进该板块，不管它在不在 ETF 持仓里。
 *        用来放刚上市、还没被纳入标普 500 的大公司（新股通常要满一年才有资格）。
 */
export const SECTORS = [
  { key: 'tech', name: '科技', etf: 'XLK' },
  { key: 'comm', name: '通信服务', etf: 'XLC' },
  { key: 'disc', name: '可选消费', etf: 'XLY' },
  { key: 'fin', name: '金融', etf: 'XLF' },
  { key: 'health', name: '医疗健康', etf: 'XLV' },
  { key: 'staples', name: '必需消费', etf: 'XLP' },
  { key: 'energy', name: '能源', etf: 'XLE' },
  // SpaceX(SPCX) 市值已过万亿，但还没进标普 500，ETF 持仓里没有，手动固定进来
  { key: 'indu', name: '工业', etf: 'XLI', pin: ['SPCX'] },
  { key: 'mat', name: '材料', etf: 'XLB' },
  { key: 'util', name: '公用事业', etf: 'XLU' },
  { key: 'reit', name: '房地产', etf: 'XLRE' },
];

/** 成分股名单多久刷一次（小时）。持仓一天只变一次，12 小时足够 */
export const HOLDINGS_TTL_HOURS = 12;

/**
 * 一次性休市日。常规节假日不用写——元旦、感恩节、耶稣受难日这些全是规则性的，
 * `lib/market-hours.js` 按规则算，不会过期。
 * 这里只放规则算不出来的：国丧闭市、飓风停市之类，比如 '2025-01-09': '卡特总统国葬'
 */
export const MARKET_CLOSURES = {};

/**
 * 服务端缓存秒数。前端交易时段快刷 30 秒、全量 1 分钟，缓存比它们略短。
 * 数据源问得太勤会被限流，宁可慢一点。
 */
export const CACHE_TTL = { live: 25, quotes: 55, charts: 180, details: 3600 };

export const PORT = process.env.PORT || 5173;

/** 默认只给本机看。要在同一 WiFi 下的手机上看：HOST=0.0.0.0 npm start */
export const HOST = process.env.HOST || '127.0.0.1';
