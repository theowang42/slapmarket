// 数据源自检：npm run check
// 逐项试一遍每家数据源的每个接口，打出通没通、花了多久、拿到了什么。
// 页面上哪块空了，先跑这个看是哪一路断了。

import * as yahoo from '../lib/providers/yahoo.js';
import * as sina from '../lib/providers/sina.js';

const STOCK = 'NVDA', INDEX = '^GSPC';

async function check(label, fn, show) {
  const t = Date.now();
  try {
    const v = await fn();
    console.log(`✅ ${label.padEnd(18)} ${String(Date.now() - t).padStart(5)}ms  ${show(v)}`);
  } catch (e) {
    console.log(`❌ ${label.padEnd(18)} ${String(Date.now() - t).padStart(5)}ms  ${e.message}`);
  }
}

const px = (q) => (q ? `${q.symbol} ${q.last} (${q.pct >= 0 ? '+' : ''}${q.pct?.toFixed(2)}%)` : '没拿到');
const bars = (b) => (b.length ? `${b.length} 根，最后一根 ${b.at(-1).time} 收 ${b.at(-1).c}` : '空的');

console.log('\n新浪（股票和三大指数的报价，K 线备用）');
await check('报价 个股', async () => (await sina.quotes([STOCK]))[STOCK], px);
await check('报价 指数', async () => (await sina.quotes([INDEX]))[INDEX], px);
await check('K 线 当日分时', () => sina.bars(STOCK, '1D'), bars);
await check('K 线 一年日线', () => sina.bars(STOCK, '1Y'), bars);

console.log('\nYahoo（K 线首选，VIX / 罗素这类新浪没有的报价，个股基本面）');
await check('报价 VIX', async () => (await yahoo.quotes(['^VIX']))['^VIX'], px);
await check('K 线 当日分时', () => yahoo.bars(STOCK, '1D'), bars);
await check('K 线 一年日线', () => yahoo.bars(STOCK, '1Y'), bars);
await check('基本面（要 crumb）', () => yahoo.details(STOCK), (d) => `市盈率 ${d.pe ?? '—'}，ROE ${d.roe?.toFixed(1) ?? '—'}%`);

console.log('\n页面需要的是：报价至少一家通，K 线至少一家通。基本面不通只是盘面里几格显示 —。\n');
