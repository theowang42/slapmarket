// 数据源自检：npm run check
// 分别问 Yahoo 和新浪同几只票，把关键字段并排打出来。两边对不上，说明某家改了格式。

import * as yahoo from '../lib/providers/yahoo.js';
import * as sina from '../lib/providers/sina.js';

const SYMBOLS = ['NVDA', 'BRK-B', '^GSPC'];
const FIELDS = ['name', 'last', 'prev', 'pct', 'dayHi', 'dayLo', 'yrHi', 'yrLo', 'volume', 'avgVol', 'cap'];

async function timed(label, fn) {
  const t = Date.now();
  try {
    const v = await fn();
    console.log(`✅ ${label}  ${Date.now() - t}ms`);
    return v;
  } catch (e) {
    console.log(`❌ ${label}  ${e.message}`);
    return null;
  }
}

const y = await timed('Yahoo 报价', () => yahoo.quotes(SYMBOLS)) ?? {};
const s = await timed('新浪报价', () => sina.quotes(SYMBOLS)) ?? {};
const d = await timed('Yahoo 基本面 NVDA', () => yahoo.details('NVDA'));
const b = await timed('Yahoo 当日分时 NVDA', () => yahoo.bars('NVDA', '1D'));
const k = await timed('Yahoo 日线 NVDA', () => yahoo.bars('NVDA', '1Y'));

for (const sym of SYMBOLS) {
  console.log(`\n── ${sym}`);
  const rows = FIELDS.map((f) => {
    const a = y[sym]?.[f], c = s[sym]?.[f];
    // 两边都是数字且差超过 2%，标出来——多半是新浪的字段位置挪了
    const off = typeof a === 'number' && typeof c === 'number' && Math.abs(a - c) / Math.abs(a || 1) > 0.02;
    return { 字段: f, Yahoo: a ?? '—', 新浪: c ?? '—', '': off ? '⚠️ 差异大' : '' };
  });
  console.table(rows);
}

if (d) console.log('\n基本面 NVDA：', d);
if (b?.length) console.log(`\n当日分时 ${b.length} 根，最后一根：`, b.at(-1));
if (k?.length) console.log(`日线 ${k.length} 根，最后一根：`, k.at(-1));
