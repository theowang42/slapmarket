import { clamp, lerp, seg, ease, hash, rng } from './math.js';
import { FONT, roundRect } from './person.js';
import { renderStatue } from './statue.js';
import { W, H } from './cast.js';

/**
 * 布景：天空、城市、跑马灯、雕塑、地面、灯光。大戏和实时舞台共用。
 *
 * 布景自己有一条时间线（灯亮、雕塑升起、金光扫过、谢幕时眼睛发光），
 * 实时舞台传一个"大戏早就演完了"的时间进来，看到的就是全部就位的样子。
 */

export const LIGHTS = [0.2, 1.6];
export const FINALE = 19.2;
/** 实时舞台用的布景时间：灯全亮、雕塑立着、眼睛亮着 */
export const SETTLED = 30;

const statueCache = new Map();
function statueImg(kind, h) {
  const k = `${kind}:${h}`;
  if (!statueCache.has(k)) statueCache.set(k, renderStatue(kind, h, 2));
  return statueCache.get(k);
}

// ── 天空、城市、跑马灯 ──────────────────────────────────────────────
export function drawSky(ctx, cast, t, now) {
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
export function drawStatues(ctx, cast, t, now, hover = -1) {
  cast.statues.forEach((st, i) => {
    const order = st.main ? 0 : i;
    const rise = ease.out(seg(t, 0.5 + order * 0.2, 1.9 + order * 0.2));
    const img = statueImg(st.kind, st.h);
    const up = st.pct >= 0;
    const color = up ? '61,255,154' : '255,77,94';

    // 背后的光晕，谢幕时变亮
    const glowK = (0.35 + 0.65 * ease.inOut(seg(t, FINALE, FINALE + 1)) * (0.75 + 0.25 * Math.sin(now * 3))) * (i === hover ? 2.2 : 1);
    const gr = ctx.createRadialGradient(st.x, st.base - st.h * 0.45, 10, st.x, st.base - st.h * 0.45, st.h * 1.1);
    gr.addColorStop(0, `rgba(${color},${0.32 * glowK * rise})`);
    gr.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = gr;
    ctx.fillRect(st.x - st.h * 1.2, st.base - st.h * 1.6, st.h * 2.4, st.h * 1.8);

    // 从底座里升起来：画在底座顶面以上的部分才看得见
    ctx.save();
    ctx.beginPath(); ctx.rect(st.x - 600, -500, 1200, st.base + 500); ctx.clip();
    const flip = st.x > W / 2 + 10 ? -1 : 1;               // 两边的都朝向中间
    const roar = st.main ? Math.sin(Math.PI * seg(t, FINALE, FINALE + 0.6)) * 0.04 : 0;
    ctx.translate(st.x, st.base + (1 - rise) * (st.h + 20));
    ctx.scale(flip * (1 + roar), 1 + roar);
    const w = img.width, h = img.height;
    ctx.drawImage(img.canvas, -w / 2, -h + img.pad, w, h);
    const shine = seg(t, 2.0 + order * 0.25, 2.9 + order * 0.25);
    if (shine > 0 && shine < 1) glint(ctx, img, -w / 2, -h + img.pad, w, h, shine);
    // 谢幕：眼睛亮起来
    const eyeK = seg(t, FINALE + 0.2, FINALE + 0.8);
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
export function drawGround(ctx, t) {
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

export function drawSpotlights(ctx, t, now) {
  const on = seg(t, ...LIGHTS);
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

export function glowRing(ctx, x, y, s, color, a) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y - s * 0.5, 0, x, y - s * 0.5, s * 0.9);
  g.addColorStop(0, color + Math.round(a * 120).toString(16).padStart(2, '0'));
  g.addColorStop(1, color + '00');
  ctx.fillStyle = g;
  ctx.fillRect(x - s, y - s * 1.5, s * 2, s * 2);
  ctx.restore();
}

export function nameTag(ctx, x, y, s, tag) {
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

export function star(ctx, x, y, size, color, a, rot) {
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

/** extra：额外压暗四角，大戏推特写时用 */
export function vignette(ctx, extra = 0) {
  const hero = extra;
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${0.55 + 0.3 * hero})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}
