import { hash, rng } from './math.js';
import { lookFor } from './person.js';

/**
 * 选角和站位。大戏和实时舞台共用：同一只票在两边是同一个人、站在同一个位置。
 * 画布逻辑尺寸固定 1920×1080，显示时整体缩放。
 */

export const W = 1920, H = 1080;

const SECTOR_COLOR = {
  tech: '#3d7bd9', comm: '#9b59d0', disc: '#e0603c', fin: '#c9a227', health: '#25a88f', staples: '#6fae3a',
  energy: '#8a6242', indu: '#5f7d8e', mat: '#d4884a', util: '#26a6c9', reit: '#c2577a',
};

const ROWS = [
  { y: 590, s: 50 }, { y: 640, s: 60 }, { y: 698, s: 71 }, { y: 764, s: 86 }, { y: 840, s: 102 },
];
/** 前两排（市值最大的 40 家）举牌子写代码，后面三排举荧光棒 */
export const SIGN_ROWS = 3;

// ── 选角 ──────────────────────────────────────────────────────────
/**
 * /api/overview 的快照 → 演员表。
 * 市值前 100 进场；涨幅前十、跌幅前十上台；大盘和最大的 4 个板块立雕塑。
 */
export function buildCast(data) {
  const all = data.sectors.flatMap((s) => s.stocks.map((x) => ({ ...x, sector: s.key, sectorName: s.name })));
  const top = all.filter((x) => x.cap && x.pct != null).sort((a, b) => b.cap - a.cap).slice(0, 100);

  // 市值越大越靠前排、越靠中间
  const order = [];
  for (let k = 0; k < 20; k++) order.push(10 + (k % 2 ? -Math.ceil(k / 2) : k / 2));
  const people = top.map((x, i) => {
    const row = 4 - Math.floor(i / 20);
    const r = rng(hash(x.symbol));
    const slot = order[i % 20];
    const { y, s } = ROWS[row];
    return {
      sym: x.symbol, name: x.name, last: x.last, pct: x.pct, cap: x.cap, sector: x.sector, sectorName: x.sectorName,
      look: lookFor(x.symbol, SECTOR_COLOR[x.sector] ?? '#777'),
      seed: r() * 100,
      home: { x: 70 + slot * (1780 / 19) + (row % 2 ? 40 : -10) + (r() - 0.5) * 24, y: y + (r() - 0.5) * 10, s: s * (0.94 + r() * 0.12), row },
    };
  });

  const byPct = [...people].sort((a, b) => b.pct - a.pct);
  const gainers = byPct.slice(0, 10);
  const losers = byPct.slice(-10).reverse();      // 最惨的排第一
  gainers.forEach((p, i) => { p.role = 'gainer'; p.rank = i + 1; });
  losers.forEach((p, i) => { if (!p.role) { p.role = 'loser'; p.rank = i + 1; } });

  const market = data.indices.find((i) => i.symbol === '^GSPC');
  const capOf = (s) => s.stocks.reduce((a, x) => a + (x.cap ?? 0), 0);
  const big = [...data.sectors].sort((a, b) => capOf(b) - capOf(a)).slice(0, 4);
  const statues = [
    { label: '标普 500', sym: '^GSPC', pct: market?.pct ?? 0, x: 960, base: 468, h: 370, main: true },
    ...big.map((s, i) => ({
      label: s.name, sym: s.etf, pct: s.pct, x: [530, 1390, 160, 1760][i], base: 472, h: 225,
      // 悬停时列出板块里涨得最多、跌得最多的几只
      members: [...s.stocks].sort((a, b) => b.pct - a.pct).map(({ symbol, pct }) => ({ symbol, pct })),
    })),
  ].map((st) => ({ ...st, kind: st.pct >= 0 ? 'bull' : 'bear' }));

  const r = rng(7);
  const skyline = Array.from({ length: 34 }, (_, i) => ({ x: i * 60 - 30 + r() * 30, w: 50 + r() * 70, h: 90 + r() * 230, seed: r() }));

  return {
    people, statues, skyline,
    gainers: gainers.filter((p) => p.role === 'gainer'),
    losers: losers.filter((p) => p.role === 'loser'),
    market: market?.pct ?? 0,
    date: data.session?.etDate ?? '',
    tape: [...people].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 40),
  };
}
