import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WATCHLIST, INDICES, SECTORS, HEAT_CLAMP, CACHE_TTL, PORT,
  HOLDINGS_PICK, HOLDINGS_TTL_HOURS,
} from './config.js';
import { getHoldings } from './lib/holdings.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

// ── 数据源：CNBC 公开行情接口。免 key，报价约 15 分钟延迟。 ──────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const QUOTE_API = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol';
const CHART_API = 'https://ts-api.cnbc.com/harmony/app/charts/1D.json';

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.slice(0, 60)}`);
  return res.json();
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,%+$]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** "4.537T" / "512.3B" / "900.1M" → 数字 */
function parseCap(v) {
  const m = /^([\d.,]+)\s*([TBMK]?)$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  const mult = { T: 1e12, B: 1e9, M: 1e6, K: 1e3, '': 1 }[m[2].toUpperCase()];
  return num(m[1]) * mult;
}

function normalizeQuote(q) {
  const last = num(q.last);
  const prev = num(q.previous_day_closing);
  if (last == null) return null;
  const ext = q.ExtendedMktQuote?.last
    ? { last: num(q.ExtendedMktQuote.last), pct: num(q.ExtendedMktQuote.change_pct), type: q.ExtendedMktQuote.type }
    : null;
  return {
    symbol: q.symbol,
    name: q.name ?? q.symbol,
    last,
    prev,
    change: num(q.change),
    pct: num(q.change_pct) ?? (prev ? ((last - prev) / prev) * 100 : 0),
    volume: num(q.volume),
    cap: parseCap(q.mktcapView) ?? (parseCap(q.sharesout) != null ? parseCap(q.sharesout) * last : null),
    status: q.curmktstatus ?? null,
    ext,
  };
}

/** 一次最多 25 个符号，多了接口会截断。 */
async function fetchQuotes(symbols) {
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 25) chunks.push(symbols.slice(i, i + 25));
  const out = {};
  const results = await Promise.all(chunks.map(async (chunk) => {
    const url = `${QUOTE_API}?symbols=${chunk.map(encodeURIComponent).join('%7C')}`
      + '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';
    const json = await getJSON(url);
    const raw = json?.FormattedQuoteResult?.FormattedQuote ?? [];
    return Array.isArray(raw) ? raw : [raw];
  }));
  for (const q of results.flat()) {
    const n = normalizeQuote(q);
    if (n) out[n.symbol] = n;
  }
  return out;
}

/** 当日分时线。接口会带上前一交易日，这里只保留最后一个交易日并抽稀。 */
async function fetchSpark(symbol) {
  const json = await getJSON(`${CHART_API}?symbol=${encodeURIComponent(symbol)}`);
  const bars = json?.barData?.priceBars ?? [];
  if (!bars.length) return [];
  const day = String(bars.at(-1).tradeTime).slice(0, 8);
  const today = bars.filter((b) => String(b.tradeTime).startsWith(day));
  const pts = today.map((b) => num(b.close)).filter((v) => v != null);
  if (pts.length <= 120) return pts;
  const step = pts.length / 120;
  return Array.from({ length: 120 }, (_, i) => pts[Math.floor(i * step)]);
}

// ── 缓存：失败时回退到上一份数据，不把页面打空 ──────────────────────
const cache = new Map();
function cached(key, ttlSec, producer) {
  const hit = cache.get(key);
  if (hit?.value && Date.now() - hit.at < ttlSec * 1000) return Promise.resolve(hit.value);
  if (hit?.inflight) return hit.inflight;
  const inflight = producer().then(
    (value) => { cache.set(key, { value, at: Date.now() }); return value; },
    (err) => {
      if (hit?.value) { cache.set(key, { value: hit.value, at: Date.now() - ttlSec * 500 }); return hit.value; }
      cache.delete(key);
      throw err;
    },
  );
  cache.set(key, { ...hit, inflight });
  return inflight;
}

// ── 组装 ──────────────────────────────────────────────────────────
async function buildQuotes({ force = false } = {}) {
  // 成分股来自 SSGA 官方每日持仓，不再是写死的名单
  const { holdings, meta } = await getHoldings(SECTORS, {
    ttlHours: HOLDINGS_TTL_HOURS,
    pickOpts: HOLDINGS_PICK,
    force,
  });

  const symbols = new Set([...WATCHLIST, ...INDICES.map((i) => i.symbol)]);
  for (const s of SECTORS) {
    symbols.add(s.etf);
    for (const h of holdings[s.etf] ?? []) symbols.add(h.symbol);
  }
  const q = await fetchQuotes([...symbols]);

  // config 里的 name/invert 优先，别被行情源的官方长名覆盖
  const indices = INDICES.map((i) => (q[i.symbol] ? { ...q[i.symbol], ...i } : null)).filter(Boolean);

  const sectors = SECTORS.map((s) => {
    const stocks = (holdings[s.etf] ?? [])
      .map((h) => {
        const x = q[h.symbol];
        return x && x.cap
          ? { symbol: x.symbol, name: x.name, last: x.last, pct: x.pct, cap: x.cap, weight: h.weight, pinned: h.pinned }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.cap - a.cap);
    const cap = stocks.reduce((a, b) => a + b.cap, 0);
    const etf = q[s.etf];
    const pct = etf ? etf.pct : cap ? stocks.reduce((a, b) => a + b.pct * b.cap, 0) / cap : 0;
    return { key: s.key, name: s.name, etf: s.etf, pct, cap, stocks };
  }).filter((s) => s.stocks.length);

  const watchlist = WATCHLIST.map((sym) => q[sym]).filter(Boolean);

  const all = sectors.flatMap((s) => s.stocks);
  const breadth = {
    up: all.filter((s) => s.pct > 0).length,
    down: all.filter((s) => s.pct < 0).length,
    flat: all.filter((s) => s.pct === 0).length,
    total: all.length,
  };

  return { indices, sectors, watchlist, breadth, holdingsMeta: meta, quoteStatus: indices[0]?.status ?? null };
}

async function buildSparks() {
  const entries = await Promise.all(INDICES.map(async (i) => {
    try { return [i.symbol, await fetchSpark(i.symbol)]; } catch { return [i.symbol, []]; }
  }));
  return Object.fromEntries(entries);
}

// ── 美东交易时段（未计入节假日） ──────────────────────────────────
function marketSession(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now).map((x) => [x.type, x.value]),
  );
  const mins = (Number(p.hour) % 24) * 60 + Number(p.minute);
  const at = (h, m) => h * 60 + m;
  const etTime = `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`;
  const base = { etTime, weekday: p.weekday };

  if (p.weekday === 'Sat' || p.weekday === 'Sun') return { ...base, phase: 'closed', label: '休市', note: '周末' };
  if (mins < at(4, 0)) return { ...base, phase: 'closed', label: '休市', note: `距盘前 ${fmtGap(at(4, 0) - mins)}` };
  if (mins < at(9, 30)) return { ...base, phase: 'pre', label: '盘前', note: `距开盘 ${fmtGap(at(9, 30) - mins)}` };
  if (mins < at(16, 0)) return { ...base, phase: 'open', label: '交易中', note: `距收盘 ${fmtGap(at(16, 0) - mins)}` };
  if (mins < at(20, 0)) return { ...base, phase: 'post', label: '盘后', note: `距结束 ${fmtGap(at(20, 0) - mins)}` };
  return { ...base, phase: 'closed', label: '休市', note: '已收盘' };
}
const fmtGap = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

// ── HTTP ─────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/overview') {
    const force = url.searchParams.has('force');
    if (force) cache.clear();
    try {
      const [q, sparks] = await Promise.all([
        cached('quotes', CACHE_TTL.quotes, () => buildQuotes({ force })),
        cached('charts', CACHE_TTL.charts, buildSparks),
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        ...q,
        indices: q.indices.map((i) => ({ ...i, spark: sparks[i.symbol] ?? [] })),
        session: marketSession(),
        heatClamp: HEAT_CLAMP,
        fetchedAt: Date.now(),
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`\n  US Market Pulse  →  http://localhost:${PORT}\n`));
