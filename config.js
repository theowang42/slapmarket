// ─────────────────────────────────────────────────────────────
// 唯一需要手改的文件。改完存盘，刷新页面即可（服务端缓存最多 3 分钟，
// 想立刻生效就在页面上按 R）。
// 代码用的是 CNBC 的行情符号：普通股票直接写 ticker，
// A/B 股用点号（BRK.B），指数前面带点（.SPX）。
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
 * 板块与成分股。
 * etf —— 该板块的 SPDR ETF，板块涨跌幅直接取它（比成分股加权更贴近真实板块表现）
 * stocks —— 热力图里这个板块下画哪些方块，方块大小 = 实时市值（服务端自动取，不用维护）
 */
export const SECTORS = [
  {
    key: 'tech', name: '科技', etf: 'XLK',
    stocks: ['NVDA', 'AAPL', 'MSFT', 'AVGO', 'ORCL', 'PLTR', 'CSCO', 'AMD', 'CRM',
      'QCOM', 'TXN', 'IBM', 'MU', 'INTC', 'AMAT', 'NOW', 'INTU', 'ADBE', 'ANET',
      'PANW', 'LRCX', 'KLAC'],
  },
  {
    key: 'comm', name: '通信服务', etf: 'XLC',
    stocks: ['GOOGL', 'META', 'NFLX', 'TMUS', 'DIS', 'CMCSA', 'VZ', 'T', 'EA', 'WBD'],
  },
  {
    key: 'disc', name: '可选消费', etf: 'XLY',
    stocks: ['AMZN', 'TSLA', 'HD', 'MCD', 'BKNG', 'LOW', 'TJX', 'NKE', 'SBUX',
      'ABNB', 'GM', 'F'],
  },
  {
    key: 'fin', name: '金融', etf: 'XLF',
    stocks: ['BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'MS', 'GS', 'AXP', 'SPGI',
      'BLK', 'C', 'SCHW', 'PGR'],
  },
  {
    key: 'health', name: '医疗健康', etf: 'XLV',
    stocks: ['LLY', 'JNJ', 'ABBV', 'UNH', 'MRK', 'TMO', 'ABT', 'AMGN', 'PFE',
      'DHR', 'ISRG', 'BMY', 'GILD', 'VRTX'],
  },
  {
    key: 'staples', name: '必需消费', etf: 'XLP',
    stocks: ['WMT', 'COST', 'PG', 'KO', 'PEP', 'PM', 'MO', 'MDLZ', 'CL'],
  },
  {
    key: 'energy', name: '能源', etf: 'XLE',
    stocks: ['XOM', 'CVX', 'COP', 'EOG', 'SLB', 'MPC', 'PSX', 'WMB'],
  },
  {
    key: 'indu', name: '工业', etf: 'XLI',
    stocks: ['GE', 'CAT', 'RTX', 'UNP', 'HON', 'BA', 'ETN', 'DE', 'LMT', 'UPS', 'ADP'],
  },
  {
    key: 'mat', name: '材料', etf: 'XLB',
    stocks: ['LIN', 'SHW', 'APD', 'ECL', 'FCX', 'NEM'],
  },
  {
    key: 'util', name: '公用事业', etf: 'XLU',
    stocks: ['NEE', 'SO', 'DUK', 'CEG', 'AEP'],
  },
  {
    key: 'reit', name: '房地产', etf: 'XLRE',
    stocks: ['PLD', 'AMT', 'WELL', 'EQIX', 'SPG'],
  },
];

/** 热力图配色的饱和上限（百分比）。±3% 就到最深，日内看着对比最舒服。 */
export const HEAT_CLAMP = 3;

/** 服务端缓存秒数。数据本身就有延迟，压太低只会白白多打接口。 */
export const CACHE_TTL = { quotes: 60, charts: 180 };

export const PORT = process.env.PORT || 5173;
