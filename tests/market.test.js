import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupDay, marketSession } from '../lib/market-hours.js';
import { diffHoldings } from '../lib/holdings.js';
import { parseKline } from '../lib/providers/sina.js';

test('交易日历：规则算出来的节假日', () => {
  assert.equal(lookupDay('2026-11-26')?.name, '感恩节');
  assert.equal(lookupDay('2026-11-27')?.type, 'half');            // 感恩节次日提前收盘
  assert.equal(lookupDay('2026-04-03')?.name, '耶稣受难日');        // 复活节前两天
  assert.equal(lookupDay('2026-07-03')?.name, '独立日');            // 7/4 是周六，提前到周五
  assert.equal(lookupDay('2027-12-31'), null);                      // 元旦落在周六时，前一天照常交易
  assert.equal(lookupDay('2026-10-15'), null);
  assert.equal(lookupDay('2026-10-16', { '2026-10-16': '临时停市' })?.name, '临时停市');
});

test('交易时段：按美东时间判断', () => {
  const at = (iso) => marketSession({}, new Date(iso)).phase;
  assert.equal(at('2026-10-15T12:00:00Z'), 'pre');     // 美东 08:00
  assert.equal(at('2026-10-15T14:00:00Z'), 'open');    // 美东 10:00
  assert.equal(at('2026-10-15T21:00:00Z'), 'post');    // 美东 17:00
  assert.equal(at('2026-10-17T15:00:00Z'), 'closed');  // 周六
  assert.equal(at('2026-11-27T19:00:00Z'), 'post');    // 感恩节次日 13:00 就收盘了
});

test('成分股变动：分清进出和换板块', () => {
  const before = { XLK: [{ symbol: 'AAPL' }, { symbol: 'OLD' }], XLC: [{ symbol: 'GOOGL' }] };
  const after = { XLK: [{ symbol: 'AAPL' }, { symbol: 'GOOGL' }], XLC: [{ symbol: 'NEW' }] };
  assert.deepEqual(diffHoldings(before, after), {
    added: ['NEW'], removed: ['OLD'], moved: [{ symbol: 'GOOGL', from: 'XLC', to: 'XLK' }],
  });
});

test('新浪 K 线：键名带不带引号都能解析', () => {
  const quoted = 'var _k=([{"d":"2026-10-14","o":"10","h":"12","l":"9","c":"11","v":"100"}]);';
  const bare = 'var _k=([{d:"2026-10-15 09:35:00",o:"11",h:"13",l:"10",c:"12.5",v:"200"}]);';
  assert.deepEqual(parseKline(quoted)[0], { t: Date.parse('2026-10-14'), time: '20261014000000', o: 10, h: 12, l: 9, c: 11, v: 100 });
  const b = parseKline(bare)[0];
  assert.equal(b.time, '20261015093500');
  assert.equal(b.c, 12.5);
  assert.throws(() => parseKline('<html>blocked</html>'));
});
