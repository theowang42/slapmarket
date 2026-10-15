// ─────────────────────────────────────────────────────────────
// 唯一需要手改的文件。改完存盘刷新页面即可，不用重启。
// 行情符号用 CNBC 写法：股票直接写 ticker，A/B 股用点号（BRK.B），
// 指数前面带点（.SPX）。
// ─────────────────────────────────────────────────────────────

/**
 * 自选股的**初始值**。
 *
 * 平时不用改这里——页面上自选面板右上角点「编辑」就能增删，改动存在
 * `data/watchlist.json`。这份名单只在那个文件还不存在时用一次。
 * 想推倒重来：删掉 data/watchlist.json，重启即回到这里的名单。
 */
// 美股市值前十，按 2026-10 中旬的市值排序
export const WATCHLIST = [
  'NVDA', 'AAPL', 'GOOGL', 'MSFT', 'AMZN',
  'SPCX', 'META', 'AVGO', 'TSLA', 'BRK.B',
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
 * 按权重自动选出成分股（异动榜、财报、宽度页都用它）。指数调仓、并购退市都会自动跟上。
 *
 * pin —— 例外通道。这里写的代码一定会算进该板块，不管它在不在 ETF 持仓里。
 *        用来放刚上市、还没被纳入标普 500 的公司（新股通常要满一年才有资格）。
 *        pin 进来的票没有权重。
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
 * 宏观页。分组显示，走的还是同一个报价接口。
 *
 * bp: true —— 这一组是**收益率**，涨跌要按基点（bp）算，不能按百分比。
 *     10 年期从 4.660 涨到 4.718，接口给的 change_pct 是 +1.18%，
 *     但看债的人只认 "+5.8bp"。显示成百分比是错的。
 */
export const MACRO = [
  {
    key: 'rates', name: '美债收益率', bp: true, items: [
      { symbol: 'US2Y', name: '2 年' },
      { symbol: 'US5Y', name: '5 年' },
      { symbol: 'US10Y', name: '10 年' },
      { symbol: 'US30Y', name: '30 年' },
    ],
  },
  {
    key: 'commodity', name: '商品', items: [
      { symbol: '@CL.1', name: 'WTI 原油' },
      { symbol: '@GC.1', name: '黄金' },
      { symbol: '@SI.1', name: '白银' },
      { symbol: '@NG.1', name: '天然气' },
    ],
  },
  {
    key: 'fx', name: '美元 / 汇率', items: [
      { symbol: '.DXY', name: '美元指数' },
      { symbol: 'EUR=', name: '欧元 / 美元' },
      { symbol: 'JPY=', name: '美元 / 日元' },
    ],
  },
  {
    key: 'crypto', name: '加密', items: [
      { symbol: 'BTC=', name: '比特币' },
      { symbol: 'ETH=', name: '以太坊' },
    ],
  },
];

/**
 * 每个板块取多少只。按权重从大到小累加，覆盖到 coverage 就停，
 * 再用 min/max 夹住。集中度高的板块自然少取几只，分散的多取几只。
 */
export const HOLDINGS_PICK = { coverage: 0.85, min: 5, max: 18 };

/** 持仓缓存多久刷一次（小时）。持仓一天只变一次，12 小时足够。 */
export const HOLDINGS_TTL_HOURS = 12;

/**
 * 一次性休市日。**常规节假日不用写这里**——元旦、感恩节、耶稣受难日这些
 * 全是规则性的，`lib/market-calendar.js` 按规则算，不会过期。
 *
 * 这里只放规则算不出来的：国丧闭市、飓风停市之类。比如卡特总统葬礼那天：
 *   '2025-01-09': '卡特总统国葬'
 */
export const MARKET_CLOSURES = {};

/** 服务端行情缓存秒数。数据本身就有延迟，压太低只会白白多打接口。 */
export const CACHE_TTL = { quotes: 60, charts: 180 };

export const PORT = process.env.PORT || 5173;

/**
 * 监听地址。默认只绑本机回环，同一个 WiFi 下的其他人连不上。
 *
 * 这不是洁癖：`POST /api/watchlist` 是个**没有鉴权的写接口**，
 * 绑到 0.0.0.0 就等于把"改我的自选"这个操作开放给整个局域网。
 *
 * 确实要在手机上看，就 `HOST=0.0.0.0 npm start`——但只在你信得过的网络里这么做。
 */
export const HOST = process.env.HOST || '127.0.0.1';
