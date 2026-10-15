import { clamp, lerp, seg, ease, hash, rng, wobble } from './math.js';
import { drawPerson, lookFor, FONT, roundRect } from './person.js';
import { renderStatue } from './statue.js';

/**
 * 打屁股大会。整场戏是一个关于时间 t 的纯函数：给一个 t，画出那一帧。
 * 不存任何"上一帧"的状态——所以能随时暂停、拖动、逐帧导出成视频。
 *
 * 画布逻辑尺寸固定 1920×1080，显示时整体缩放。
 */

export const W = 1920, H = 1080;
export const DURATION = 25;
/** 不演的时候停在这一刻：灯亮着、雕塑立着、牌子已经翻过来 */
export const IDLE_T = 5.0;

// ── 场景时间表（秒）──────────────────────────────────────────────
const T = {
  lights: [0.2, 1.6],
  wave: [2.6, 4.4],          // 人浪翻牌，从左到右
  banner: 5.2,               // "涨幅前十 VS 跌幅前十" 砸下来
  walk: [5.7, 7.5],          // 二十个人出列
  bend: [7.5, 8.1],          // 挨打的转身弯腰
  slaps: 8.4,                // 第 10 名先打
  slapGap: 0.62,
  hero: 14.3,                // 第一名对最后一名，镜头推进
  heroImpact: 17.25,
  finale: 19.2,
  card: 20.0,
};

const SECTOR_COLOR = {
  tech: '#3d7bd9', comm: '#9b59d0', disc: '#e0603c', fin: '#c9a227', health: '#25a88f', staples: '#6fae3a',
  energy: '#8a6242', indu: '#5f7d8e', mat: '#d4884a', util: '#26a6c9', reit: '#c2577a',
};

const ROWS = [
  { y: 590, s: 50 }, { y: 640, s: 60 }, { y: 698, s: 71 }, { y: 764, s: 86 }, { y: 840, s: 102 },
];
/** 前两排（市值最大的 40 家）举牌子写代码，后面三排举荧光棒 */
const SIGN_ROWS = 3;

// ── 选角 ──────────────────────────────────────────────────────────
/**
 * /api/overview 的快照 → 演员表。
 * 市值前 100 进场；涨幅前十、跌幅前十上台；大盘和最大的 4 个板块立雕塑。
 */
export function buildCast(data) {
  const all = data.sectors.flatMap((s) => s.stocks.map((x) => ({ ...x, sector: s.key })));
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
      sym: x.symbol, pct: x.pct, cap: x.cap, sector: x.sector,
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
    { label: '标普 500', pct: market?.pct ?? 0, x: 960, base: 468, h: 370, main: true },
    ...big.map((s, i) => ({ label: s.name, pct: s.pct, x: [530, 1390, 160, 1760][i], base: 472, h: 225 })),
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

// ── 台上的站位 ────────────────────────────────────────────────────
/** 第 n 名在哪条道。第一名居中，偶数名往左排，奇数名往右排 */
function lane(rank) {
  if (rank === 1) return { x: 960, y: 1015, s: 140 };
  // 中间给第一名留足地方，其余每 165px 一对往两边排
  const off = 235 + 165 * (Math.floor(rank / 2) - 1);
  return { x: rank % 2 ? 960 + off : 960 - off, y: 985, s: 106 };
}
/** 打的顺序按站位从左到右扫过去，镜头跟着平移，不来回甩。第一名压轴 */
const ORDER = [10, 8, 6, 4, 2, 3, 5, 7, 9];
const slapAt = (rank) => (rank === 1 ? T.heroImpact - 0.42 : T.slaps + ORDER.indexOf(rank) * T.slapGap);
const IMPACT = 0.42;     // 抡手开始后多久打到

// ── 每个人在 t 时刻的样子 ────────────────────────────────────────
function crowdPose(p, t, now) {
  const { x, y, s } = p.home;
  const flipAt = lerp(T.wave[0], T.wave[1], x / W) + p.home.row * 0.04;
  const flip = seg(t, flipAt, flipAt + 0.35);
  const hop = Math.sin(Math.PI * seg(t, flipAt, flipAt + 0.4)) * 0.14;
  // 打完以后和谢幕时，观众跟着起哄
  const hype = Math.max(seg(t, T.slaps, T.slaps + 1) * 0.5, seg(t, T.heroImpact, T.heroImpact + 0.4));
  const jump = Math.max(0, Math.sin(now * 7 + p.seed)) ** 6 * 0.16 * hype;
  return {
    x, y, s,
    pose: {
      dir: x < W / 2 ? 1 : -1,
      lift: hop + jump + wobble(now * 0.8, p.seed) * 0.006,
      armFront: Math.PI - 0.05 + wobble(now, p.seed) * 0.08,
      armBack: hype > 0.3 ? 2.4 + Math.sin(now * 6 + p.seed) * 0.4 : 0.15,
      face: hype > 0.3 ? (p.pct >= 0 ? 'happy' : 'shock') : t > flipAt ? (p.pct >= 0 ? 'smug' : 'sad') : 'neutral',
      ...(p.home.row >= SIGN_ROWS
        ? { sign: { ticker: p.sym, pct: p.pct, flip } }
        : { light: { pct: p.pct, on: flip, sway: Math.sin(now * 3 + p.seed) * 0.08 * (0.3 + hype) } }),
    },
  };
}

function stagePose(p, t, now) {
  const L = lane(p.rank);
  const gainer = p.role === 'gainer';
  const target = { x: L.x + (gainer ? -L.s * 0.42 : L.s * 0.36), y: L.y, s: L.s };
  const start = T.walk[0] + p.rank * 0.05 + (gainer ? 0 : 0.12);
  const k = ease.inOut(seg(t, start, start + (T.walk[1] - T.walk[0])));
  let x = lerp(p.home.x, target.x, k), y = lerp(p.home.y, target.y, k), s = lerp(p.home.s, target.s, k);
  const moving = k > 0 && k < 1;
  const pose = {
    dir: moving ? Math.sign(target.x - p.home.x) || 1 : 1,
    walk: now * 13, walkAmp: moving ? 0.55 : 0,
    face: gainer ? 'smug' : 'sad',
    armFront: 0.25, armBack: 0.1,
  };
  if (moving && gainer) pose.lift = Math.abs(Math.sin(now * 9)) * 0.12;      // 赢家一路蹦着走
  if (!gainer) pose.lean = 0.12 * k;                                           // 输家耷拉着

  // 出列前头顶一圈光，告诉观众"就是他"
  const callout = seg(t, T.banner + 0.1, T.banner + 0.5) * (1 - seg(t, start + 0.4, start + 0.8));

  const u = t - slapAt(p.rank);
  const hero = p.rank === 1;
  if (gainer) {
    if (hero) heroGainer(pose, t, (dx) => { x += dx; });
    else if (u >= 0) {
      if (u < 0.35) {                                   // 蓄力：往后抡
        const a = ease.out(u / 0.35);
        pose.armFront = lerp(0.25, -2.5, a); pose.lean = -0.22 * a; x -= 10 * a;
      } else if (u < IMPACT + 0.05) {                   // 出手
        const a = ease.in(seg(u, 0.35, IMPACT));
        pose.armFront = lerp(-2.5, 1.7, a); pose.lean = lerp(-0.22, 0.28, a); x += lerp(-10, 14, a);
      } else {                                          // 得意
        const a = seg(u, IMPACT + 0.05, IMPACT + 0.5);
        pose.armFront = lerp(1.7, 2.95, ease.back(a)); pose.armBack = lerp(0.1, 2.6, ease.back(a));
        pose.face = 'happy'; pose.lift = Math.abs(Math.sin((u - 0.5) * 9)) * 0.1 * clamp(u - 0.5, 0, 1);
      }
    }
  } else if (k >= 1) {
    const b = ease.out(seg(t, T.bend[0], T.bend[1]));
    pose.bend = b; pose.armFront = -0.7 * b; pose.armBack = -0.7 * b; pose.lean = 0;
    if (u > -0.35 && u < IMPACT) pose.face = 'shock';                    // 听到风声了
    if (u >= IMPACT) {
      const hit = u - IMPACT;
      pose.handprint = clamp(hit / 0.06);
      pose.face = hit < 0.5 ? 'pain' : 'dizzy';
      pose.squash = 1 - 0.18 * Math.max(0, 1 - hit / 0.12);
      if (hero) heroLoser(pose, t, (dx, dy, ds) => { x += dx; y += dy; s *= ds; });
      else {
        // 被拍得往前扑，脸着地
        const fly = seg(hit, 0, 0.45);
        x += ease.out(fly) * (40 + Math.min(10, Math.abs(p.pct)) * 6);
        pose.spin = ease.out(fly) * 1.5;
        pose.lift = Math.sin(Math.PI * fly) * 0.3 - 0.31 * ease.in(fly);
        pose.bend = b * (1 - fly);
      }
    }
  }

  // 台上的人头顶一个小名牌：名次 + 涨跌
  // 名牌：刚站好时全亮；开打以后只亮正在挨打的这一对，别的收起来，画面才不乱
  const myHit = slapAt(p.rank) + IMPACT;
  const active = 1 - seg(Math.abs(t - myHit), 0.7, 1.0);
  const lineup = 1 - seg(t, T.slaps - 0.3, T.slaps);
  let tagA = seg(t, start + 1.2, start + 1.6) * Math.max(lineup, active, hero && t < T.slaps ? 1 : 0);
  if (hero) tagA = Math.max(tagA, seg(t, T.hero, T.hero + 0.5)) * (gainer ? 1 : 1 - seg(t, T.heroImpact, T.heroImpact + 0.1));
  return { x, y, s, pose, callout, tag: tagA > 0 && { a: tagA, text: `#${p.rank}`, pct: p.pct, low: !gainer } };
}

/** 第一名：后撤助跑 → 冲刺 → 起跳 → 慢动作抡下去 */
function heroGainer(pose, t, move) {
  const back = ease.inOut(seg(t, 15.0, 15.5));
  const charge = ease.in(seg(t, 15.5, 16.0));
  move(-110 * back + 120 * charge);
  if (t > 15.0 && t < 16.0) { pose.walk = t * 22; pose.walkAmp = 0.7; pose.lean = 0.25 * charge; pose.dir = t < 15.5 ? -1 : 1; }
  if (t >= 16.0) {
    const jump = seg(t, 16.0, T.heroImpact + 0.3);
    pose.lift = Math.sin(Math.PI * jump) * 0.38;
    const wind = ease.out(seg(t, 16.0, 16.25));
    const strike = ease.in(seg(t, 16.25, T.heroImpact));        // 这一段是慢放
    pose.armFront = lerp(lerp(0.25, -2.9, wind), 1.9, strike);
    pose.lean = lerp(-0.3 * wind, 0.35, strike);
    pose.face = t < T.heroImpact ? 'smug' : 'happy';
    if (t > T.heroImpact + 0.4) { pose.armFront = 3.0; pose.armBack = 2.7; pose.lift += Math.abs(Math.sin(t * 8)) * 0.08; }
  }
}

/** 最后一名：被拍飞，转着圈飞向天边，变成一颗星 */
function heroLoser(pose, t, move) {
  const f = seg(t, T.heroImpact + 0.05, T.heroImpact + 1.15);
  const e = ease.in(f);
  move(lerp(0, 700, ease.out(f)), lerp(0, -820, ease.out(f)) + 300 * e * e, lerp(1, 0.08, e));
  pose.spin = f * 14;
  pose.bend = 1 - f;
  pose.face = 'pain';
  pose.alpha = 1 - seg(f, 0.85, 1);
}

// ── 画 ────────────────────────────────────────────────────────────
const statueCache = new Map();
function statueImg(kind, h) {
  const k = `${kind}:${h}`;
  if (!statueCache.has(k)) statueCache.set(k, renderStatue(kind, h, 2));
  return statueCache.get(k);
}

/** t：剧情时间。now：自由流动的时间，只管呼吸、晃动这些不影响剧情的小动作 */
export function drawFrame(ctx, cast, t, now = t) {
  ctx.save();
  const cam = camera(t);
  const sh = shake(t, cast);
  ctx.translate(W / 2 + sh.x, H / 2 + sh.y);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  drawSky(ctx, cast, t, now);
  drawStatues(ctx, cast, t, now);
  drawGround(ctx, t);
  drawSpotlights(ctx, t, now);

  // 所有人按脚的位置从远到近画，走到台前的自然盖住后排
  const actors = cast.people.map((p) => {
    const st = p.role && t >= T.walk[0] ? stagePose(p, t, now) : crowdPose(p, t, now);
    return { p, ...st };
  }).sort((a, b) => a.y - b.y);

  const focus = ease.inOut(seg(t, T.hero, T.hero + 0.9)) * (1 - ease.inOut(seg(t, 18.4, 19.4)));
  const isHero = (a) => a.p.rank === 1 && a.p.role;
  const actor = (a) => {
    if (a.callout > 0) glowRing(ctx, a.x, a.y, a.s, a.p.role === 'gainer' ? '#3dffa0' : '#ff4d5e', a.callout);
    drawPerson(ctx, a.p.look, a.pose, a.x, a.y, a.s);
    if (a.tag) nameTag(ctx, a.x, a.y - a.s * ((a.tag.low ? 0.95 : 1.12) + (a.pose.lift ?? 0)), a.s, a.tag);
  };
  // 镜头推近时，后面的观众蒙一层雾，台上的人才跳得出来
  const haze = Math.max(
    ease.inOut(seg(t, T.slaps - 0.5, T.slaps + 0.1)) * (1 - ease.inOut(seg(t, 18.4, 19.4))),
    0,
  ) * 0.45;
  const onStage = (a) => a.p.role && t >= T.walk[1];
  let hazed = false;
  for (const a of actors) {
    if (focus > 0 && isHero(a)) continue;
    if (haze > 0 && !hazed && onStage(a)) {
      ctx.fillStyle = `rgba(10,6,20,${haze})`;
      ctx.fillRect(-400, -400, W + 800, H + 800);
      hazed = true;
    }
    actor(a);
  }
  drawImpacts(ctx, cast, t, (g) => g.rank !== 1);
  if (focus > 0) {
    // 只留一束光打在两位主角身上，其余压暗
    const g = ctx.createRadialGradient(960, 920, 90, 960, 920, 380);
    g.addColorStop(0, 'rgba(4,2,10,0)');
    g.addColorStop(1, `rgba(4,2,10,${0.78 * focus})`);
    ctx.fillStyle = g;
    ctx.fillRect(-400, -400, W + 800, H + 800);
    for (const a of actors) if (isHero(a)) actor(a);
  }
  drawImpacts(ctx, cast, t, (g) => g.rank === 1);
  drawDizzy(ctx, cast, t, now);
  drawWeather(ctx, cast, t);
  ctx.restore();

  // 以下是贴在镜头上的，不跟着推拉
  drawSpeedLines(ctx, t);
  drawHeroFlash(ctx, t);
  drawTexts(ctx, cast, t);
  drawCard(ctx, cast, t);
  vignette(ctx, t);
  const dark = 1 - ease.out(seg(t, ...T.lights));
  if (dark > 0) { ctx.fillStyle = `rgba(0,0,0,${dark})`; ctx.fillRect(0, 0, W, H); }
}

// ── 镜头 ──────────────────────────────────────────────────────────
function camera(t) {
  // 开场缓缓推进
  const intro = lerp(1.08, 1, ease.inOut(seg(t, 0, 3)));

  // 打屁股那段：推近到台前，跟着一对一对从左扫到右
  const slapIn = ease.inOut(seg(t, T.slaps - 0.5, T.slaps + 0.1)) * (1 - ease.inOut(seg(t, T.hero - 0.3, T.hero + 0.4)));
  const i = clamp((t - T.slaps - IMPACT + 0.3) / T.slapGap, 0, ORDER.length - 1);
  const a = Math.floor(i), f = ease.inOut(i - a);
  const laneX = lerp(lane(ORDER[a]).x, lane(ORDER[Math.min(a + 1, ORDER.length - 1)]).x, f);

  // 第一名那段推到正中间；打中那一下猛地一冲
  const heroIn = ease.inOut(seg(t, T.hero, T.hero + 0.9)) * (1 - ease.inOut(seg(t, 18.4, 19.4)));
  const punch = Math.sin(Math.PI * seg(t, T.heroImpact, T.heroImpact + 0.25)) * 0.12;

  const zoom = intro * lerp(lerp(1, 1.65, slapIn), 1.75, heroIn) + punch;
  // 镜头中心不能让画面露出世界边缘
  const half = W / 2 / zoom;
  const x = clamp(lerp(lerp(W / 2, laneX, slapIn), 960, heroIn), half, W - half);
  const y = clamp(lerp(lerp(H / 2, 860, slapIn), 840, heroIn), H / 2 / zoom, H - H / 2 / zoom);
  return { zoom, x, y };
}

function shake(t, cast) {
  let x = 0, y = 0;
  const hit = (t0, amp) => {
    const d = t - t0;
    if (d < 0 || d > 0.7) return;
    const a = amp * Math.exp(-d * 9);
    x += Math.sin(d * 75) * a; y += Math.cos(d * 63) * a;
  };
  for (const p of cast.gainers) hit(slapAt(p.rank) + IMPACT, p.rank === 1 ? 28 : 6 + Math.min(8, Math.abs(p.pct)));
  hit(T.banner + 0.3, 10);
  return { x, y };
}

// ── 天空、城市、跑马灯 ──────────────────────────────────────────────
function drawSky(ctx, cast, t, now) {
  const g = ctx.createLinearGradient(0, 0, 0, 560);
  g.addColorStop(0, '#060818'); g.addColorStop(0.55, '#171338'); g.addColorStop(1, '#3d2453');
  ctx.fillStyle = g;
  ctx.fillRect(-400, -400, W + 800, 960);

  // 星星
  const r = rng(3);
  for (let i = 0; i < 90; i++) {
    const x = r() * W, y = r() * 330, tw = 0.4 + 0.6 * Math.abs(Math.sin(now * (0.5 + r()) + i));
    ctx.fillStyle = `rgba(255,255,255,${0.5 * tw * r()})`;
    ctx.fillRect(x, y, 1.6, 1.6);
  }

  // 城市剪影，带亮着的窗户
  for (const b of cast.skyline) {
    const top = 470 - b.h;
    ctx.fillStyle = '#0c0d1e';
    ctx.fillRect(b.x, top, b.w, b.h + 60);
    const wr = rng(Math.floor(b.seed * 1e6));
    ctx.fillStyle = 'rgba(255,214,140,0.55)';
    for (let wy = top + 10; wy < 450; wy += 14) {
      for (let wx = b.x + 6; wx < b.x + b.w - 8; wx += 11) if (wr() < 0.22) ctx.fillRect(wx, wy, 5, 7);
    }
  }

  // 跑马灯：当天波动最大的 40 只滚过去
  const y = 372, h = 34;
  ctx.fillStyle = '#05060c';
  ctx.fillRect(-400, y, W + 800, h);
  ctx.save();
  ctx.beginPath(); ctx.rect(-400, y, W + 800, h); ctx.clip();
  ctx.font = `700 22px ${FONT}`;
  ctx.textBaseline = 'middle';
  let x = -((now * 90) % 4000);
  for (let loop = 0; loop < 3; loop++) {
    for (const p of cast.tape) {
      const txt = `${p.sym} ${p.pct >= 0 ? '▲' : '▼'}${Math.abs(p.pct).toFixed(2)}%`;
      ctx.fillStyle = p.pct >= 0 ? '#3dff9a' : '#ff5865';
      ctx.fillText(txt, x, y + h / 2 + 1);
      x += ctx.measureText(txt).width + 46;
      if (x > W + 400) break;
    }
  }
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(-400, y, W + 800, 2);
}

// ── 雕塑 ──────────────────────────────────────────────────────────
function drawStatues(ctx, cast, t, now) {
  cast.statues.forEach((st, i) => {
    const order = st.main ? 0 : i;
    const rise = ease.out(seg(t, 0.5 + order * 0.2, 1.9 + order * 0.2));
    const img = statueImg(st.kind, st.h);
    const up = st.pct >= 0;
    const color = up ? '61,255,154' : '255,77,94';

    // 背后的光晕，谢幕时变亮
    const glowK = 0.35 + 0.65 * ease.inOut(seg(t, T.finale, T.finale + 1)) * (0.75 + 0.25 * Math.sin(now * 3));
    const gr = ctx.createRadialGradient(st.x, st.base - st.h * 0.45, 10, st.x, st.base - st.h * 0.45, st.h * 1.1);
    gr.addColorStop(0, `rgba(${color},${0.32 * glowK * rise})`);
    gr.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = gr;
    ctx.fillRect(st.x - st.h * 1.2, st.base - st.h * 1.6, st.h * 2.4, st.h * 1.8);

    // 从底座里升起来：画在底座顶面以上的部分才看得见
    ctx.save();
    ctx.beginPath(); ctx.rect(st.x - 600, -500, 1200, st.base + 500); ctx.clip();
    const flip = st.x > W / 2 + 10 ? -1 : 1;               // 两边的都朝向中间
    const roar = st.main ? Math.sin(Math.PI * seg(t, T.finale, T.finale + 0.6)) * 0.04 : 0;
    ctx.translate(st.x, st.base + (1 - rise) * (st.h + 20));
    ctx.scale(flip * (1 + roar), 1 + roar);
    const w = img.width, h = img.height;
    ctx.drawImage(img.canvas, -w / 2, -h + img.pad, w, h);
    const shine = seg(t, 2.0 + order * 0.25, 2.9 + order * 0.25);
    if (shine > 0 && shine < 1) glint(ctx, img, -w / 2, -h + img.pad, w, h, shine);
    // 谢幕：眼睛亮起来
    const eyeK = seg(t, T.finale + 0.2, T.finale + 0.8);
    if (eyeK > 0) {
      const ex = img.eye[0] - w / 2, ey = img.eye[1] - h + img.pad;
      const eg = ctx.createRadialGradient(ex, ey, 0, ex, ey, st.h * 0.12);
      eg.addColorStop(0, `rgba(255,255,255,${eyeK})`);
      eg.addColorStop(0.25, `rgba(${color},${eyeK})`);
      eg.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = eg;
      ctx.beginPath(); ctx.arc(ex, ey, st.h * 0.12, 0, Math.PI * 2); ctx.fill();
      // 牛：鼻孔喷气
      if (st.kind === 'bull') {
        for (let j = 0; j < 6; j++) {
          const life = ((now * 1.3 + j / 6) % 1);
          const nx = img.nose[0] - w / 2 + life * st.h * 0.35, ny = img.nose[1] - h + img.pad + life * st.h * 0.05 - life * life * st.h * 0.1;
          ctx.fillStyle = `rgba(230,236,255,${0.45 * (1 - life) * eyeK})`;
          ctx.beginPath(); ctx.arc(nx, ny, st.h * (0.02 + life * 0.06), 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    ctx.restore();

    // 尘土
    const dust = seg(t, 0.5 + order * 0.2, 2.2 + order * 0.2);
    if (dust > 0 && dust < 1) {
      const r = rng(hash(st.label));
      for (let j = 0; j < 18; j++) {
        const a = r() * Math.PI, sp = 40 + r() * 120;
        const dx = Math.cos(a) * sp * dust * (r() < 0.5 ? -1 : 1), dy = -Math.sin(a) * sp * 0.4 * dust;
        ctx.fillStyle = `rgba(200,180,160,${0.35 * (1 - dust)})`;
        ctx.beginPath(); ctx.arc(st.x + dx * 2, st.base + dy, 6 + dust * 22 * r(), 0, Math.PI * 2); ctx.fill();
      }
    }

    plinth(ctx, st, rise, color);
  });
}

/** 一道斜光扫过雕塑表面。只亮在雕塑本身上，不亮背景 */
let glintBuf = null;
function glint(ctx, img, x, y, w, h, k) {
  glintBuf ??= document.createElement('canvas');
  const c = glintBuf;
  c.width = img.canvas.width; c.height = img.canvas.height;
  const g2 = c.getContext('2d');
  g2.drawImage(img.canvas, 0, 0);
  g2.globalCompositeOperation = 'source-atop';
  const bx = (k * 1.6 - 0.3) * c.width;
  const g = g2.createLinearGradient(bx - c.width * 0.18, 0, bx + c.width * 0.18, c.height * 0.4);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,240,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  g2.fillStyle = g;
  g2.fillRect(0, 0, c.width, c.height);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(c, x, y, w, h);
  ctx.restore();
}

function plinth(ctx, st, rise, color) {
  const w = st.main ? 330 : 230, h = st.main ? 74 : 56, top = st.base;
  const g = ctx.createLinearGradient(0, top, 0, top + h);
  g.addColorStop(0, '#5d5468'); g.addColorStop(1, '#2a2433');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(st.x - w / 2, top); ctx.lineTo(st.x + w / 2, top);
  ctx.lineTo(st.x + w / 2 + 14, top + h); ctx.lineTo(st.x - w / 2 - 14, top + h); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(st.x - w / 2, top, w, 3);
  // 刻字
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `800 ${st.main ? 24 : 18}px ${FONT}`;
  ctx.fillStyle = '#d9d2e6';
  ctx.fillText(st.label, st.x - (st.main ? 62 : 44), top + h / 2);
  ctx.font = `900 ${st.main ? 28 : 21}px ${FONT}`;
  ctx.fillStyle = `rgba(${color},${0.4 + 0.6 * rise})`;
  ctx.fillText(`${st.pct >= 0 ? '+' : ''}${st.pct.toFixed(2)}%`, st.x + (st.main ? 70 : 52), top + h / 2);
}

// ── 地面和灯 ──────────────────────────────────────────────────────
function drawGround(ctx, t) {
  const g = ctx.createLinearGradient(0, 520, 0, H);
  g.addColorStop(0, '#2b2238'); g.addColorStop(0.45, '#1b1625'); g.addColorStop(1, '#0d0a12');
  ctx.fillStyle = g;
  ctx.fillRect(-400, 520, W + 800, H);
  // 舞台：一块亮一点的地板，带透视线
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = -12; i <= 12; i++) {
    ctx.beginPath(); ctx.moveTo(960 + i * 40, 860); ctx.lineTo(960 + i * 180, H + 40); ctx.stroke();
  }
  for (const yy of [880, 920, 970, 1030]) { ctx.beginPath(); ctx.moveTo(-400, yy); ctx.lineTo(W + 400, yy); ctx.stroke(); }
  ctx.restore();
  // 台前一圈暖光
  const pool = ctx.createRadialGradient(960, 990, 40, 960, 990, 900);
  pool.addColorStop(0, `rgba(255,214,150,${0.16 * seg(t, 5, 7)})`);
  pool.addColorStop(1, 'rgba(255,214,150,0)');
  ctx.fillStyle = pool;
  ctx.fillRect(-400, 700, W + 800, 500);
}

function drawSpotlights(ctx, t, now) {
  const on = seg(t, ...T.lights);
  if (!on) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const beams = [
    { x: 260, color: '120,170,255' }, { x: 960, color: '255,230,170' }, { x: 1660, color: '255,140,200' },
  ];
  beams.forEach((b, i) => {
    // 开场扫来扫去，之后对准台前
    const sweep = Math.sin(now * 0.9 + i * 2) * 0.35 * (1 - seg(t, 4, 6)) + (960 - b.x) / 2400 * seg(t, 4, 6);
    const len = 1250, spread = 0.2;
    ctx.save();
    ctx.translate(b.x, -60);
    ctx.rotate(sweep);
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, `rgba(${b.color},${0.22 * on})`);
    g.addColorStop(1, `rgba(${b.color},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(14, 0); ctx.lineTo(len * spread, len); ctx.lineTo(-len * spread, len); ctx.closePath();
    ctx.fill();
    ctx.restore();
  });
  // 光里的浮尘
  const r = rng(11);
  for (let i = 0; i < 70; i++) {
    const x = (r() * W + now * (6 + r() * 10)) % W, y = 80 + ((r() * 800 + now * (3 + r() * 6)) % 800);
    ctx.fillStyle = `rgba(255,240,220,${0.18 * on * r()})`;
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.restore();
}

function glowRing(ctx, x, y, s, color, a) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y - s * 0.5, 0, x, y - s * 0.5, s * 0.9);
  g.addColorStop(0, color + Math.round(a * 120).toString(16).padStart(2, '0'));
  g.addColorStop(1, color + '00');
  ctx.fillStyle = g;
  ctx.fillRect(x - s, y - s * 1.5, s * 2, s * 2);
  ctx.restore();
}

function nameTag(ctx, x, y, s, tag) {
  const up = tag.pct >= 0;
  const w = s * 0.9, h = s * 0.22;
  ctx.save();
  ctx.globalAlpha = tag.a;
  ctx.fillStyle = up ? 'rgba(16,150,90,0.92)' : 'rgba(205,45,55,0.92)';
  roundRect(ctx, x - w / 2, y - h, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `800 ${h * 0.55}px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`${tag.text} ${up ? '+' : ''}${tag.pct.toFixed(2)}%`, x, y - h / 2 + 1);
  ctx.restore();
}

// ── 打击特效 ──────────────────────────────────────────────────────
function drawImpacts(ctx, cast, t, which) {
  for (const g of cast.gainers.filter(which)) {
    const t0 = slapAt(g.rank) + IMPACT;
    const d = t - t0;
    if (d < 0 || d > 1.1) continue;
    const L = lane(g.rank);
    const hero = g.rank === 1;
    const x = L.x + (hero ? -10 : 0), y = L.y - L.s * 0.3;
    const big = hero ? 2.2 : 1 + Math.min(1, Math.abs(g.pct) / 8) * 0.5;

    // 冲击波
    if (d < 0.5) {
      ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - d / 0.5)})`;
      ctx.lineWidth = 6 * big * (1 - d / 0.5);
      ctx.beginPath(); ctx.arc(x, y, 20 + d * 420 * big, 0, Math.PI * 2); ctx.stroke();
    }
    // 迸出来的星星
    const r = rng(hash(g.sym));
    const n = hero ? 34 : 12;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, v = (180 + r() * 380) * big;
      const px = x + Math.cos(a) * v * d, py = y + Math.sin(a) * v * d + 600 * d * d;
      star(ctx, px, py, (6 + r() * 8) * big * (1 - d / 1.1), r() < 0.5 ? '#fff6b0' : '#ffd23d', 1 - d / 1.1, a + d * 8);
    }
    // "啪！"
    if (d < 0.85) {
      const pop = ease.back(seg(d, 0, 0.18));
      const fade = 1 - seg(d, 0.6, 0.85);
      comic(ctx, x + (hero ? 150 : L.s * 0.3), y - L.s * (hero ? 1.25 : 1.0), (hero ? 0.95 : 0.45 + 0.2 * big) * pop, hero ? '啪！！！' : '啪！', fade, r() - 0.5);
    }
  }
}

function star(ctx, x, y, size, color, a, rot) {
  if (size <= 0 || a <= 0) return;
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.globalAlpha = a;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const rr = i % 2 ? size * 0.38 : size;
    ctx.lineTo(Math.cos((i * Math.PI) / 4) * rr, Math.sin((i * Math.PI) / 4) * rr);
  }
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

/** 漫画拟声字：锯齿爆炸框 + 粗描边黄字 */
function comic(ctx, x, y, k, text, a, tilt) {
  if (k <= 0 || a <= 0) return;
  ctx.save();
  ctx.translate(x, y); ctx.rotate(tilt * 0.35); ctx.scale(k, k);
  ctx.globalAlpha = a;
  ctx.fillStyle = '#ff3b4e';
  ctx.beginPath();
  for (let i = 0; i < 24; i++) {
    const rr = i % 2 ? 62 : 96 + (i % 4) * 6;
    ctx.lineTo(Math.cos((i * Math.PI) / 12) * rr * 1.35, Math.sin((i * Math.PI) / 12) * rr);
  }
  ctx.closePath(); ctx.fill();
  ctx.lineWidth = 6; ctx.strokeStyle = '#1a0f12'; ctx.stroke();
  ctx.font = `900 64px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 12; ctx.strokeStyle = '#1a0f12'; ctx.strokeText(text, 0, 4);
  ctx.fillStyle = '#ffe23d'; ctx.fillText(text, 0, 4);
  ctx.restore();
}

/** 趴在地上的人头顶转圈的小星星 */
function drawDizzy(ctx, cast, t, now) {
  for (const l of cast.losers) {
    if (l.rank === 1) continue;
    const d = t - (slapAt(l.rank) + IMPACT + 0.5);
    if (d < 0) continue;
    const L = lane(l.rank);
    const x = L.x + L.s * 0.36 + 40 + Math.min(10, Math.abs(l.pct)) * 6 + L.s * 0.55, y = L.y - L.s * 0.18;
    for (let i = 0; i < 3; i++) {
      const a = now * 4 + (i * Math.PI * 2) / 3;
      star(ctx, x + Math.cos(a) * L.s * 0.18, y + Math.sin(a) * L.s * 0.06, L.s * 0.05, '#ffe23d', seg(d, 0, 0.3), a);
    }
  }
}

// ── 第一名那段的电影感 ────────────────────────────────────────────
/** 慢动作时四周的集中线（漫画里的"动线"） */
function drawSpeedLines(ctx, t) {
  const k = seg(t, 16.1, 16.4) * (1 - seg(t, T.heroImpact + 0.3, T.heroImpact + 0.8));
  if (k <= 0) return;
  const r = rng(Math.floor(t * 14));
  ctx.save();
  ctx.fillStyle = `rgba(255,255,255,${0.55 * k})`;
  const cx = W / 2, cy = H * 0.62;
  for (let i = 0; i < 90; i++) {
    const a = r() * Math.PI * 2, w = 0.004 + r() * 0.01;
    const inner = 380 + r() * 260, outer = 1400;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a - w) * outer, cy + Math.sin(a - w) * outer);
    ctx.lineTo(cx + Math.cos(a + w) * outer, cy + Math.sin(a + w) * outer);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawHeroFlash(ctx, t) {
  const d = t - T.heroImpact;
  if (d >= 0 && d < 0.25) {
    ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - d / 0.25)})`;
    ctx.fillRect(0, 0, W, H);
  }
  // 被打飞的那位在天边"叮"一下变成星星
  const tw = seg(t, 18.35, 19.3);
  if (tw > 0 && tw < 1) {
    const s = Math.sin(Math.PI * tw) * 46;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    star(ctx, 1640, 150, s, '#ffffff', 1, tw * 3);
    star(ctx, 1640, 150, s * 0.6, '#ffe9a0', 1, -tw * 2);
    ctx.restore();
  }
}

// ── 天气：大盘涨下金币，跌下雨 ──────────────────────────────────────
function drawWeather(ctx, cast, t) {
  const k = seg(t, T.finale + 0.2, T.finale + 1.2);
  if (k <= 0) return;
  const r = rng(99);
  const d = t - T.finale - 0.2;
  if (cast.market >= 0) {
    for (let i = 0; i < 140; i++) {
      const x = r() * W, delay = r() * 3, v = 380 + r() * 300;
      const y = -60 + (d - delay) * v;
      if (y < -60 || y > H + 40) continue;
      const spin = Math.cos((d - delay) * (5 + r() * 5) + i);
      ctx.fillStyle = Math.abs(spin) > 0.3 ? '#ffcf3a' : '#fff1a8';
      ctx.strokeStyle = '#b8860b'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(x, y, 13 * Math.abs(spin) + 2, 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  } else {
    ctx.strokeStyle = `rgba(170,190,255,${0.45 * k})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < 260; i++) {
      const x = r() * (W + 300) - 150, v = 1100 + r() * 500;
      const y = ((r() * H + d * v) % (H + 100)) - 50;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 8, y + 28); ctx.stroke();
    }
    ctx.fillStyle = `rgba(20,30,60,${0.25 * k})`;
    ctx.fillRect(-400, -400, W + 800, H + 800);
  }
}

// ── 文字 ──────────────────────────────────────────────────────────
function drawTexts(ctx, cast, t) {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

  // 开场标题
  const title = seg(t, 1.2, 1.9) * (1 - seg(t, 4.0, 4.6));
  if (title > 0) {
    ctx.save();
    ctx.globalAlpha = title;
    ctx.translate(W / 2, 930 - 20 * (1 - ease.out(seg(t, 1.2, 2))));
    ctx.font = `900 78px ${FONT}`;
    ctx.lineWidth = 10; ctx.strokeStyle = '#120a1e'; ctx.strokeText('美股打屁股大会', 0, 0);
    ctx.fillStyle = '#fff4d6'; ctx.fillText('美股打屁股大会', 0, 0);
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = '#c9bfe0';
    ctx.fillText(`${cast.date}  ·  市值前 100 · 涨的打跌的`, 0, 62);
    ctx.restore();
  }

  // 涨幅前十 VS 跌幅前十
  const b = seg(t, T.banner, T.banner + 0.35);
  const bOut = seg(t, 8.0, 8.4);
  if (b > 0 && bOut < 1) {
    ctx.save();
    ctx.globalAlpha = 1 - bOut;
    ctx.translate(W / 2, 190);
    const k = lerp(2.6, 1, ease.back(b));
    ctx.scale(k, k);
    ctx.font = `900 72px ${FONT}`;
    ctx.lineWidth = 12; ctx.strokeStyle = '#120a1e';
    ctx.strokeText('涨幅前十', -300, 0); ctx.strokeText('跌幅前十', 300, 0);
    ctx.fillStyle = '#3dff9a'; ctx.fillText('涨幅前十', -300, 0);
    ctx.fillStyle = '#ff5865'; ctx.fillText('跌幅前十', 300, 0);
    ctx.font = `900 italic 96px ${FONT}`;
    ctx.strokeText('VS', 0, 4); ctx.fillStyle = '#ffe23d'; ctx.fillText('VS', 0, 4);
    ctx.restore();
  }

  // 第一名对决的字幕
  const g = cast.gainers[0], l = cast.losers[0];
  const hk = seg(t, T.hero + 0.3, T.hero + 0.8) * (1 - seg(t, 18.6, 19.2));
  if (hk > 0 && g && l) {
    ctx.save();
    ctx.globalAlpha = hk;
    ctx.font = `900 54px ${FONT}`;
    ctx.lineWidth = 10; ctx.strokeStyle = '#120a1e';
    const line = (txt, x, color) => { ctx.strokeText(txt, x, 120); ctx.fillStyle = color; ctx.fillText(txt, x, 120); };
    line(`今日最强 ${g.sym} ${fmt(g.pct)}`, W / 2 - 420, '#3dff9a');
    line(`今日最惨 ${l.sym} ${fmt(l.pct)}`, W / 2 + 420, '#ff5865');
    ctx.font = `900 italic 64px ${FONT}`;
    ctx.strokeText('VS', W / 2, 122); ctx.fillStyle = '#ffe23d'; ctx.fillText('VS', W / 2, 122);
    ctx.restore();
  }
}

/** 谢幕的总结卡 */
function drawCard(ctx, cast, t) {
  const k = ease.back(seg(t, T.card, T.card + 0.5));
  if (k <= 0) return;
  const g = cast.gainers[0], l = cast.losers[0];
  const w = 1180, h = 150, x = (W - w) / 2, y = H - 40 - h * k;
  ctx.save();
  ctx.fillStyle = 'rgba(14,10,24,0.88)';
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 2;
  roundRect(ctx, x, y, w, h, 24); ctx.fill(); ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const col = (cx, label, value, color) => {
    ctx.fillStyle = '#a99fc0'; ctx.font = `700 24px ${FONT}`; ctx.fillText(label, cx, y + 42);
    ctx.fillStyle = color; ctx.font = `900 44px ${FONT}`; ctx.fillText(value, cx, y + 92);
  };
  if (g) col(x + w / 6, '今日最强', `${g.sym} ${fmt(g.pct)}`, '#3dff9a');
  col(x + w / 2, '标普 500', fmt(cast.market), cast.market >= 0 ? '#3dff9a' : '#ff5865');
  if (l) col(x + (w * 5) / 6, '今日最惨', `${l.sym} ${fmt(l.pct)}`, '#ff5865');
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText('us-market-pulse', x + w / 2, y + h - 18);
  ctx.restore();
}

function vignette(ctx, t) {
  const hero = ease.inOut(seg(t, T.hero, T.hero + 0.9)) * (1 - seg(t, 18.4, 19.4));
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${0.55 + 0.3 * hero})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

const fmt = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
