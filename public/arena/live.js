import { clamp, lerp, seg, ease, wobble } from './math.js';
import { drawPerson, FONT, roundRect } from './person.js';
import { W, SIGN_ROWS } from './cast.js';
import { SETTLED, drawSky, drawStatues, drawGround, drawSpotlights, glowRing, star, vignette } from './backdrop.js';

/**
 * 实时舞台：一直开着看的那个画面。
 *
 * 台前是一张"站着人的柱状图"：左边涨幅前十、右边跌幅前十，柱子高度就是涨跌幅，
 * 两个第一名在正中间对峙。名次一变，人就走着换位置；新上榜的从观众席走上来，
 * 掉榜的走回去。柱子高度跟着平滑变化。
 *
 * 跟大戏不同，这里有状态（谁正在往哪走、柱子现在多高），所以是个类。
 * 画的时候顺手记下每个人、每座雕塑在哪，悬停和点击靠它找人。
 */

const FLOOR = 1022;          // 柱子底边
const GAP = 88;              // 相邻两根柱子的间距
const BAR_MIN = 16, BAR_MAX = 150;

/** 涨幅第 n 名在左边，从中间往外排；跌幅的在右边。第一名稍大一号 */
function slot(side, rank) {
  const i = rank - 1;
  return {
    x: side === 'up' ? 902 - i * GAP : 1018 + i * GAP,
    s: rank === 1 ? 104 : 90,
    w: rank === 1 ? 74 : 64,
  };
}

export class LiveStage {
  constructor() {
    this.cast = null;
    this.roles = new Map();      // 代码 → { side, rank }，不在榜上的没有
    this.walks = new Map();      // 代码 → { from: {x,y,s}, key, t0, dur }，正在走的
    this.drawn = new Map();      // 代码 → 上一帧画在哪 {x,y,s}
    this.bars = new Map();       // 'up3' → 当前显示的高度（平滑过渡用）
    this.flash = new Map();      // 代码 → 涨跌幅上次变化的时刻，名牌闪一下
    this.pct = new Map();
    this.hits = [];
    this.last = null;
  }

  /** 新行情到了：重新排名。位置变了的人从当前位置开始走向新位置 */
  update(cast, now) {
    this.cast = cast;
    const sorted = [...cast.people].sort((a, b) => b.pct - a.pct);
    const up = sorted.slice(0, 10), down = sorted.slice(-10).reverse();
    const roles = new Map();
    up.forEach((p, i) => roles.set(p.sym, { side: 'up', rank: i + 1 }));
    down.forEach((p, i) => { if (!roles.has(p.sym)) roles.set(p.sym, { side: 'down', rank: i + 1 }); });
    this.scale = Math.max(2, Math.abs(up[0]?.pct ?? 0), Math.abs(down[0]?.pct ?? 0));

    for (const p of cast.people) {
      const before = this.roles.get(p.sym), after = roles.get(p.sym);
      const key = (r) => (r ? `${r.side}${r.rank}` : 'home');
      // 第一次进场：上榜的人从观众席依次走上台，不是凭空出现
      if (!this.drawn.size && after) {
        const delay = 0.3 + (after.rank - 1) * 0.12 + (after.side === 'down' ? 0.06 : 0);
        this.walks.set(p.sym, { from: p.home, t0: now + delay, dur: 1.4 });
      }
      const from = this.drawn.get(p.sym);
      if (this.drawn.size && from && key(before) !== key(after)) {
        const to = this.target(p, after);
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        this.walks.set(p.sym, { from, t0: now, dur: clamp(0.7 + dist / 520, 0.8, 2.4) });
      }
      const old = this.pct.get(p.sym);
      if (old != null && old !== p.pct) this.flash.set(p.sym, now);
      this.pct.set(p.sym, p.pct);
    }
    this.roles = roles;
  }

  /** 某人此刻该站的地方：台上就是柱顶，否则回观众席 */
  target(p, role) {
    if (!role) return p.home;
    const sl = slot(role.side, role.rank);
    return { x: sl.x, y: FLOOR - this.barHeight(role), s: sl.s };
  }

  barHeight(role) {
    return this.bars.get(`${role.side}${role.rank}`) ?? BAR_MIN;
  }

  /** hover：{ kind: 'person', sym } 或 { kind: 'statue', index } */
  draw(ctx, now, hover) {
    const cast = this.cast;
    if (!cast) return;
    const dt = this.last == null ? 1 : Math.min(0.2, now - this.last);
    this.last = now;
    this.hits = [];

    // 柱子高度往目标值靠，不跳变
    for (const [sym, role] of this.roles) {
      const p = cast.people.find((x) => x.sym === sym);
      const goal = BAR_MIN + (BAR_MAX - BAR_MIN) * Math.min(1, Math.abs(p.pct) / this.scale);
      const k = `${role.side}${role.rank}`;
      const cur = this.bars.get(k) ?? goal;
      this.bars.set(k, cur + (goal - cur) * (1 - Math.exp(-dt * 5)));
    }

    // ── 布景 ──
    const hoverStatue = hover?.kind === 'statue' ? hover.index : -1;
    drawSky(ctx, cast, SETTLED, now);
    drawStatues(ctx, cast, SETTLED, now, hoverStatue);
    drawGround(ctx, SETTLED);
    drawSpotlights(ctx, SETTLED, now);
    cast.statues.forEach((st, i) => {
      const w = st.h * (st.kind === 'bull' ? 1.5 : 0.95);
      this.hits.push({ kind: 'statue', index: i, x0: st.x - w / 2, y0: st.base - st.h, x1: st.x + w / 2, y1: st.base + 60 });
    });

    // ── 每个人在哪、什么姿势 ──
    const actors = cast.people.map((p) => this.actor(p, now, hover));
    for (const a of actors) this.drawn.set(a.p.sym, { x: a.x, y: a.y, s: a.s });

    // 观众席先画，蒙一层薄雾，再画台上的和正在走的——台上的人才跳得出来
    const crowd = actors.filter((a) => a.where === 'home').sort((a, b) => a.y - b.y);
    const front = actors.filter((a) => a.where !== 'home').sort((a, b) => a.y - b.y);
    for (const a of crowd) this.person(ctx, a, hover);
    ctx.fillStyle = 'rgba(10,6,20,0.32)';
    ctx.fillRect(-400, -400, W + 800, 2000);

    this.drawBars(ctx);
    for (const a of front) this.person(ctx, a, hover);
    this.labels(ctx);
    vignette(ctx);
  }

  actor(p, now, hover) {
    const role = this.roles.get(p.sym);
    const to = this.target(p, role);
    let walk = this.walks.get(p.sym);
    let { x, y, s } = to;
    let moving = false;
    // 还没轮到他出场：先在观众席待着
    const waiting = walk && now < walk.t0;
    if (waiting) ({ x, y, s } = walk.from);
    if (walk && !waiting) {
      const k = ease.inOut(seg(now, walk.t0, walk.t0 + walk.dur));
      if (k >= 1) this.walks.delete(p.sym);
      else {
        moving = true;
        x = lerp(walk.from.x, to.x, k); y = lerp(walk.from.y, to.y, k); s = lerp(walk.from.s, to.s, k);
        // 上台、下台走个弧线，别直直地穿过前排观众的脑袋
        y -= Math.sin(Math.PI * k) * 40;
      }
    }
    const hovered = hover?.kind === 'person' && hover.sym === p.sym;
    const pose = { dir: 1, face: p.pct >= 0 ? 'smug' : 'sad', lift: wobble(now * 0.8, p.seed) * 0.006 };

    if (moving) {
      Object.assign(pose, { dir: Math.sign(to.x - (walk.from.x)) || 1, walk: now * 13, walkAmp: 0.55, armFront: 0.2 });
      return { p, x, y, s, pose, where: 'walking', hovered };
    }
    if (!role || waiting) {
      // 观众：举牌子或者荧光棒，朝着舞台中间
      Object.assign(pose, {
        dir: x < W / 2 ? 1 : -1,
        armFront: Math.PI - 0.05 + wobble(now, p.seed) * 0.08,
        armBack: 0.15,
        ...(p.home.row >= SIGN_ROWS
          ? { sign: { ticker: p.sym, pct: p.pct, flip: 1 } }
          : { light: { pct: p.pct, on: 1, sway: Math.sin(now * 1.5 + p.seed) * 0.05 } }),
      });
      if (hovered) pose.lift += 0.08;
      return { p, x, y, s, pose, where: 'home', hovered };
    }

    if (role.side === 'up') {
      pose.dir = 1;                                   // 面朝中间
      if (role.rank === 1) {
        Object.assign(pose, {
          face: 'happy',
          armFront: 2.8 + Math.sin(now * 5) * 0.25, armBack: 2.6 + Math.sin(now * 5 + 1) * 0.25,
          lift: Math.abs(Math.sin(now * 4)) * 0.06,
        });
      } else {
        // 时不时举个拳头
        const pump = Math.max(0, Math.sin(now * 1.4 + p.seed)) ** 10;
        Object.assign(pose, { armFront: 0.3 + pump * 2.6, face: pump > 0.5 ? 'happy' : 'smug', lift: pump * 0.05 });
      }
    } else {
      pose.dir = -1;
      Object.assign(pose, { face: role.rank === 1 ? 'pain' : 'sad', lean: 0.16, armFront: 0.05, armBack: 0.05 });
      if (role.rank === 1) x += Math.sin(now * 40) * 0.8;   // 第一名在发抖
    }
    if (hovered) pose.lift += 0.06;
    return { p, x, y, s, pose, where: 'stage', role, hovered };
  }

  person(ctx, a, hover) {
    const { p, x, y, s, pose } = a;
    if (a.hovered) glowRing(ctx, x, y, s, p.pct >= 0 ? '#3dffa0' : '#ff4d5e', 1);
    drawPerson(ctx, p.look, pose, x, y, s);
    const top = y - (1.0 + (pose.lift ?? 0)) * s;

    if (a.where === 'stage') {
      if (a.role.side === 'up' && a.role.rank === 1) crown(ctx, x + 0.02 * s, top + 0.02 * s, s, this.last);
      if (a.role.side === 'down' && a.role.rank === 1) rainCloud(ctx, x, top - 0.42 * s, s, this.last);
      tag(ctx, x, top - (a.role.rank === 1 ? 0.3 : 0.08) * s, s, p, a.hovered, this.flashK(p.sym));
      this.hits.push({ kind: 'person', sym: p.sym, x0: x - 0.45 * s, y0: top - 0.5 * s, x1: x + 0.45 * s, y1: FLOOR });
    } else if (a.where === 'home') {
      // 观众的可点区域包括头顶的牌子 / 荧光棒
      this.hits.push({ kind: 'person', sym: p.sym, x0: x - 0.4 * s, y0: y - 1.6 * s, x1: x + 0.4 * s, y1: y });
    }
  }

  flashK(sym) {
    const t0 = this.flash.get(sym);
    return t0 == null ? 0 : 1 - seg(this.last, t0, t0 + 0.8);
  }

  drawBars(ctx) {
    for (const [sym, role] of this.roles) {
      const sl = slot(role.side, role.rank);
      const h = this.barHeight(role);
      const up = role.side === 'up';
      const x0 = sl.x - sl.w / 2, y0 = FLOOR - h;
      const g = ctx.createLinearGradient(0, y0, 0, FLOOR);
      g.addColorStop(0, up ? '#2ee08e' : '#ff6370');
      g.addColorStop(1, up ? '#0a6b40' : '#8e1724');
      ctx.fillStyle = g;
      ctx.fillRect(x0, y0, sl.w, h);
      // 顶面：一条斜着的亮边，看着像个立体台子
      ctx.fillStyle = up ? '#8dffc7' : '#ffb0b7';
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x0 + 10, y0 - 9); ctx.lineTo(x0 + sl.w + 10, y0 - 9); ctx.lineTo(x0 + sl.w, y0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = up ? '#07502f' : '#6a0f19';
      ctx.beginPath();
      ctx.moveTo(x0 + sl.w, y0); ctx.lineTo(x0 + sl.w + 10, y0 - 9); ctx.lineTo(x0 + sl.w + 10, FLOOR - 9); ctx.lineTo(x0 + sl.w, FLOOR);
      ctx.closePath(); ctx.fill();
      if (h > 30) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = `900 ${role.rank === 1 ? 30 : 24}px ${FONT}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(role.rank), sl.x, FLOOR - Math.min(h / 2, 26));
      }
    }
  }

  labels(ctx) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `800 22px ${FONT}`;
    ctx.fillStyle = '#3dff9a'; ctx.fillText('▲ 涨幅前十', 902 - 4.5 * GAP, FLOOR + 32);
    ctx.fillStyle = '#ff5865'; ctx.fillText('▼ 跌幅前十', 1018 + 4.5 * GAP, FLOOR + 32);
    ctx.font = `900 italic 34px ${FONT}`;
    ctx.lineWidth = 6; ctx.strokeStyle = '#120a1e'; ctx.strokeText('VS', 960, FLOOR - 40);
    ctx.fillStyle = '#ffe23d'; ctx.fillText('VS', 960, FLOOR - 40);
  }

  /** 画布逻辑坐标 → 点中的人或雕塑。后画的在上面，所以倒着找 */
  hitTest(x, y) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
    }
    return null;
  }
}

/** 名牌：代码一行、涨跌一行。涨跌刚变过会闪一下 */
function tag(ctx, x, bottom, s, p, hovered, flash) {
  const up = p.pct >= 0;
  const k = 1 + 0.15 * flash + (hovered ? 0.12 : 0);
  const w = s * 0.82 * k, h = s * 0.38 * k;
  ctx.save();
  ctx.fillStyle = up ? `rgba(14,${140 + 80 * flash},86,0.95)` : `rgba(${200 + 55 * flash},44,56,0.95)`;
  ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 8;
  roundRect(ctx, x - w / 2, bottom - h, w, h, h * 0.25);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `900 ${h * 0.4}px ${FONT}`;
  ctx.fillText(p.sym, x, bottom - h * 0.7);
  ctx.font = `800 ${h * 0.36}px ${FONT}`;
  ctx.fillText(`${up ? '+' : ''}${p.pct.toFixed(2)}%`, x, bottom - h * 0.27);
  ctx.restore();
}

/** 涨幅第一的皇冠 */
function crown(ctx, x, y, s, now) {
  const w = s * 0.36, h = s * 0.2, by = y - Math.abs(Math.sin(now * 4)) * s * 0.02;
  ctx.save();
  ctx.translate(x, by);
  ctx.rotate(-0.12);
  ctx.fillStyle = '#ffd23d'; ctx.strokeStyle = '#a8740a'; ctx.lineWidth = s * 0.015;
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0); ctx.lineTo(-w / 2, -h); ctx.lineTo(-w / 4, -h * 0.45); ctx.lineTo(0, -h * 1.15);
  ctx.lineTo(w / 4, -h * 0.45); ctx.lineTo(w / 2, -h); ctx.lineTo(w / 2, 0); ctx.closePath();
  ctx.fill(); ctx.stroke();
  for (const [jx, c] of [[-w / 4, '#ff4d5e'], [0, '#3d9bff'], [w / 4, '#3dff9a']]) {
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(jx, -h * 0.22, s * 0.022, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  star(ctx, x + w * 0.6, by - h * 1.1, s * 0.05 * (0.5 + 0.5 * Math.sin(now * 6)), '#fff6b0', 0.9, now);
  ctx.restore();
}

/** 跌幅第一头顶的乌云，一直在下雨 */
function rainCloud(ctx, x, y, s, now) {
  ctx.save();
  ctx.strokeStyle = 'rgba(150,180,255,0.8)'; ctx.lineWidth = s * 0.018; ctx.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const rx = x + (i - 3) * s * 0.07;
    const ry = y + s * 0.08 + ((now * 1.6 + i * 0.37) % 1) * s * 0.4;
    ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - s * 0.015, ry + s * 0.07); ctx.stroke();
  }
  ctx.fillStyle = '#5b6274';
  for (const [dx, dy, r] of [[-0.14, 0.02, 0.1], [0, -0.04, 0.13], [0.14, 0.01, 0.1], [0.06, 0.05, 0.09], [-0.06, 0.05, 0.09]]) {
    ctx.beginPath(); ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
