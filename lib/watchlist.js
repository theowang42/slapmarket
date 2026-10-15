import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 自选股。存服务端而不是浏览器 localStorage——换个浏览器、
 * 或者手机上打开，看到的该是同一份列表。
 *
 * `config.js` 里的 WATCHLIST 退化成"磁盘上还没有文件时"的初始值。
 */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, 'data', 'watchlist.json');

export const MAX = 50;
const VALID = /^[A-Z0-9.\-=^]{1,12}$/;

/** 去空白、转大写、B 股统一成横杠（BRK.B → BRK-B）、去重、剔掉不合法的、封顶。 */
export function normalize(list) {
  const out = [];
  for (const raw of list ?? []) {
    const s = String(raw).trim().toUpperCase().replace(/^([A-Z]+)\.([A-Z])$/, '$1-$2');
    if (!VALID.test(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX) break;
  }
  return out;
}

let cached = null;

export async function getWatchlist(seed) {
  if (cached) return cached;
  try {
    const j = JSON.parse(await fs.readFile(FILE, 'utf8'));
    // 数组存在就用它，哪怕是空的——用户把自选清空了是一种明确的选择，
    // 不能因为"空"就退回去用 config 里的初始值，那样删不掉
    if (Array.isArray(j.symbols)) { cached = normalize(j.symbols); return cached; }
  } catch { /* 没有文件或读坏了，用初始值 */ }
  cached = normalize(seed);
  return cached;
}

export async function setWatchlist(symbols) {
  const list = normalize(symbols);
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ symbols: list, updatedAt: Date.now() }, null, 1));
  cached = list;
  return list;
}
