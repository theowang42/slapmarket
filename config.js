// ─────────────────────────────────────────────────────────────
// 唯一需要手改的文件。改完存盘刷新页面即可，不用重启。
// 行情符号用 CNBC 写法：股票直接写 ticker，A/B 股用点号（BRK.B），
// 指数前面带点（.SPX）。
// ─────────────────────────────────────────────────────────────

/** 自选股：想看哪些写哪些，顺序即展示顺序。 */
export const WATCHLIST = [
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO',
];

/** 顶部大盘指数。invert 表示"涨=市场变差"，配色会反过来。 */
export const INDICES = [
  { symbol: '.SPX', name: 'S&P 500' },
  { symbol: '.IXIC', name: 'NASDAQ' },
  { symbol: '.DJI', name: 'DOW' },
  { symbol: '.RUT', name: 'RUSSELL 2000' },
  { symbol: '.VIX', name: 'VIX', invert: true },
];

/**
 * 板块 = 11 只 SPDR 行业 ETF。
 *
 * 成分股不用写：服务端每天从 SSGA 官网拉这些 ETF 的官方每日持仓，
 * 按权重自动选出画进热力图的那些。指数调仓、并购退市都会自动跟上。
 *
 * pin —— 例外通道。这里写的代码一定会画进该板块，不管它在不在 ETF 持仓里。
 *        用来放刚上市、还没被纳入标普 500 的公司（新股通常要满一年才有资格）。
 *        pin 进来的票没有权重，只按市值决定方块大小。
 */
export const SECTORS = [
  { key: 'tech', name: '科技', etf: 'XLK' },
  { key: 'comm', name: '通信服务', etf: 'XLC' },
  { key: 'disc', name: '可选消费', etf: 'XLY' },
  { key: 'fin', name: '金融', etf: 'XLF' },
  { key: 'health', name: '医疗健康', etf: 'XLV' },
  { key: 'staples', name: '必需消费', etf: 'XLP' },
  { key: 'energy', name: '能源', etf: 'XLE' },
  // SpaceX(SPCX) 市值已过万亿，但还没进标普 500，ETF 持仓里没有，只能手动固定进来
  { key: 'indu', name: '工业', etf: 'XLI', pin: ['SPCX'] },
  { key: 'mat', name: '材料', etf: 'XLB' },
  { key: 'util', name: '公用事业', etf: 'XLU' },
  { key: 'reit', name: '房地产', etf: 'XLRE' },
];

/**
 * 每个板块画多少只。按权重从大到小累加，覆盖到 coverage 就停，
 * 再用 min/max 夹住。集中度高的板块自然少画几只，分散的多画几只。
 * 想让图更密就调高 coverage 或 max。
 */
export const HOLDINGS_PICK = { coverage: 0.85, min: 5, max: 18 };

/** 持仓缓存多久刷一次（小时）。持仓一天只变一次，12 小时足够。 */
export const HOLDINGS_TTL_HOURS = 12;

/** 热力图配色的饱和上限（百分比）。±3% 到最深，日内看着对比最舒服。 */
export const HEAT_CLAMP = 3;

/** 服务端行情缓存秒数。数据本身就有延迟，压太低只会白白多打接口。 */
export const CACHE_TTL = { quotes: 60, charts: 180 };

export const PORT = process.env.PORT || 5173;
