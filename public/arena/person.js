import { hash, rng } from './math.js';

/**
 * Q 版小人。一只股票一个，长相由代码决定（同一只票永远长一个样）。
 *
 * 坐标单位：身高 = 1，原点在两脚中间的地面上，y 朝下。画的时候整体缩放到像素。
 * 头大身小：头占三分之一多，远处缩小了也认得出是个人。
 */

const SKIN = ['#f9d9bd', '#f1c6a0', '#e2a983', '#c58b62', '#9a6544', '#f6cfae'];
const HAIR = ['#1d1a1a', '#3b2516', '#6b4226', '#d8b25c', '#8f8f99', '#b4462b', '#efe9df'];

/** 代码 → 长相。shirt 由调用方按板块给 */
export function lookFor(ticker, shirt) {
  const r = rng(hash(ticker));
  return {
    ticker,
    shirt,
    skin: SKIN[Math.floor(r() * SKIN.length)],
    hair: Math.floor(r() * 6),
    hairColor: HAIR[Math.floor(r() * HAIR.length)],
    pants: ['#24304a', '#2f2a3a', '#1f3a3a', '#3a2f28'][Math.floor(r() * 4)],
    glasses: r() < 0.22,
  };
}

const HIP = -0.25, SHOULDER = -0.5, HEAD_Y = -0.75, HEAD_R = 0.215;

/**
 * pose 里的东西都可选：
 *   dir 朝向（1 右 -1 左）· bend 弯腰 0..1 · walk 步态相位 · walkAmp 迈腿幅度
 *   armFront / armBack 两条胳膊的角度（0 自然下垂，π 举过头顶，负数往后抡）
 *   lean 身子前后倾 · lift 离地高度（单位：身高）· spin 整体旋转 · squash 压扁拉长
 *   face 表情 · handprint 屁股上的红手印 0..1 · sign 头顶的牌子 · light 荧光棒 · alpha
 */
export function drawPerson(ctx, look, pose, x, y, s) {
  const p = { dir: 1, bend: 0, walk: 0, walkAmp: 0, armFront: 0, armBack: 0, lean: 0, lift: 0, spin: 0, squash: 1, face: 'neutral', handprint: 0, alpha: 1, ...pose };
  ctx.save();
  ctx.globalAlpha *= p.alpha;

  // 影子贴在地上，人跳得越高影子越小越淡
  const lift = Math.max(0, p.lift);
  ctx.fillStyle = `rgba(0,0,0,${0.32 / (1 + lift * 3)})`;
  ctx.beginPath();
  ctx.ellipse(x, y, s * 0.26 / (1 + lift), s * 0.06 / (1 + lift), 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.translate(x, y - p.lift * s);
  if (p.spin) { ctx.translate(0, -0.45 * s); ctx.rotate(p.spin); ctx.translate(0, 0.45 * s); }
  ctx.scale(s * p.dir / Math.sqrt(p.squash), s * p.squash);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // ── 腿 ──
  const legSwing = Math.sin(p.walk) * p.walkAmp;
  leg(ctx, -0.07, legSwing, look);
  leg(ctx, 0.07, -legSwing, look);

  // ── 屁股（裤子）。弯腰时它是全场焦点，单独画大一点 ──
  ctx.fillStyle = look.pants;
  ctx.beginPath();
  ctx.ellipse(-0.05 * p.bend, HIP - 0.03, 0.16 + 0.05 * p.bend, 0.10 + 0.05 * p.bend, 0, 0, Math.PI * 2);
  ctx.fill();
  if (p.handprint > 0) handprint(ctx, -0.09 * p.bend - 0.01, HIP - 0.05, p.handprint * (1 + 0.4 * p.bend));

  // ── 上半身绕胯部转：弯腰往前倒，站直时可以前后倾 ──
  ctx.save();
  ctx.translate(0, HIP);
  ctx.rotate(p.bend * 1.05 + p.lean);
  ctx.translate(0, -HIP);

  arm(ctx, -0.15, p.armBack - Math.sin(p.walk) * p.walkAmp * 0.8, look, true);
  torso(ctx, look, p.dir);
  head(ctx, look, p.face);
  arm(ctx, 0.15, p.armFront + Math.sin(p.walk) * p.walkAmp * 0.8, look, false);
  ctx.restore();

  ctx.restore();

  if (p.light) drawLight(ctx, x, y, s, p);

  // 牌子不跟着身体转、也不跟着镜像，永远正着朝观众
  if (p.sign) drawSign(ctx, x, y - (p.lift + 1.32) * s, s, p.sign, p.alpha, (p.lift + 0.74) * s - (p.lift + 1.32) * s, 0.16 * s * p.dir);
}

function leg(ctx, hx, angle, look) {
  const len = 0.25;
  const fx = hx + Math.sin(angle) * len, fy = HIP + Math.cos(angle) * len;
  ctx.strokeStyle = look.pants;
  ctx.lineWidth = 0.1;
  ctx.beginPath(); ctx.moveTo(hx, HIP); ctx.lineTo(fx, fy - 0.02); ctx.stroke();
  ctx.fillStyle = '#16161c';
  ctx.beginPath(); ctx.ellipse(fx + 0.03, fy - 0.02, 0.065, 0.035, 0, 0, Math.PI * 2); ctx.fill();
}

function arm(ctx, sx, angle, look, far) {
  const len = 0.24;
  // angle 0 朝下；正数往身前抬（朝向那一侧），π 举过头顶
  const hx = sx + Math.sin(angle) * len, hy = SHOULDER + 0.03 + Math.cos(angle) * len;
  ctx.strokeStyle = far ? shade(look.shirt, -0.25) : look.shirt;
  ctx.lineWidth = 0.085;
  ctx.beginPath(); ctx.moveTo(sx, SHOULDER + 0.03); ctx.lineTo(hx, hy); ctx.stroke();
  ctx.fillStyle = far ? shade(look.skin, -0.15) : look.skin;
  ctx.beginPath(); ctx.arc(hx, hy, 0.05, 0, Math.PI * 2); ctx.fill();
}

function torso(ctx, look, dir) {
  const w = 0.33, top = SHOULDER - 0.02, h = HIP - top + 0.02;
  // 渐变的坐标在单位空间里，跟人站在哪无关，每个人建一次就够——每帧一百个人各建两个太浪费
  look.torsoG ??= (() => {
    const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0, shade(look.shirt, 0.18));
    g.addColorStop(1, shade(look.shirt, -0.18));
    return g;
  })();
  ctx.fillStyle = look.torsoG;
  roundRect(ctx, -w / 2, top, w, h, 0.08);
  ctx.fill();

  // 胸口印代码。镜像回来，字永远是正的。
  // 远处的人字只有几个像素，根本看不清，干脆不画——设字体是画小人最贵的一步
  const t = look.ticker;
  const fs = Math.min(0.11, 0.36 / t.length);
  const m = ctx.getTransform();
  if (fs * Math.hypot(m.a, m.b) < 7) return;
  ctx.save();
  ctx.scale(dir, 1);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.font = `900 ${fs}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(t, 0, (top + HIP) / 2 + 0.01);
  ctx.restore();
}

function head(ctx, look, face) {
  // 后脑勺的长发要在脸后面
  if (look.hair === 5) {
    ctx.fillStyle = look.hairColor;
    ctx.beginPath(); ctx.ellipse(-0.04, HEAD_Y + 0.06, HEAD_R * 1.05, HEAD_R * 1.15, 0, 0, Math.PI * 2); ctx.fill();
  }
  look.headG ??= (() => {
    const g = ctx.createRadialGradient(0.06, HEAD_Y - 0.06, 0.02, 0, HEAD_Y, HEAD_R);
    g.addColorStop(0, shade(look.skin, 0.12));
    g.addColorStop(1, shade(look.skin, -0.08));
    return g;
  })();
  ctx.fillStyle = look.headG;
  ctx.beginPath(); ctx.arc(0, HEAD_Y, HEAD_R, 0, Math.PI * 2); ctx.fill();
  hair(ctx, look);
  drawFace(ctx, face, look);
}

function hair(ctx, look) {
  ctx.fillStyle = look.hairColor;
  const top = HEAD_Y - HEAD_R;
  switch (look.hair) {
    case 0: // 短发
      ctx.beginPath(); ctx.arc(0, HEAD_Y, HEAD_R * 1.02, Math.PI * 1.05, Math.PI * 1.95); ctx.closePath(); ctx.fill();
      break;
    case 1: // 刺头
      ctx.beginPath(); ctx.moveTo(-0.2, HEAD_Y - 0.04);
      for (let i = 0; i <= 5; i++) ctx.lineTo(-0.2 + i * 0.08, top - (i % 2 ? 0.07 : -0.03));
      ctx.lineTo(0.2, HEAD_Y - 0.04); ctx.closePath(); ctx.fill();
      break;
    case 2: // 偏分
      ctx.beginPath(); ctx.ellipse(-0.03, top + 0.07, 0.21, 0.1, -0.15, Math.PI, Math.PI * 2.05); ctx.fill();
      break;
    case 3: // 丸子头
      ctx.beginPath(); ctx.arc(0, HEAD_Y, HEAD_R * 1.02, Math.PI * 1.05, Math.PI * 1.95); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(-0.02, top - 0.03, 0.075, 0, Math.PI * 2); ctx.fill();
      break;
    case 4: // 地中海
      ctx.beginPath(); ctx.ellipse(-0.16, HEAD_Y - 0.02, 0.05, 0.09, 0, 0, Math.PI * 2); ctx.fill();
      break;
    default: // 长发：前面一片刘海
      ctx.beginPath(); ctx.arc(0, HEAD_Y, HEAD_R * 1.03, Math.PI * 1.0, Math.PI * 1.9); ctx.closePath(); ctx.fill();
  }
}

/** 表情。眼睛和嘴都偏向朝向那一侧，侧过来的感觉 */
function drawFace(ctx, face, look) {
  const ex = 0.05, ey = HEAD_Y - 0.01, gap = 0.085;
  const dark = '#2a1d1a';
  ctx.strokeStyle = dark; ctx.fillStyle = dark; ctx.lineWidth = 0.022;
  const eyes = (fn) => { fn(ex - gap / 2); fn(ex + gap / 2); };

  switch (face) {
    case 'happy':
      eyes((x) => { ctx.beginPath(); ctx.arc(x, ey + 0.015, 0.025, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); });
      ctx.fillStyle = '#7a2b2b';
      ctx.beginPath(); ctx.arc(ex + 0.01, HEAD_Y + 0.08, 0.05, 0, Math.PI); ctx.fill();
      blush(ctx, ex, ey);
      break;
    case 'smug':
      eyes((x) => { ctx.beginPath(); ctx.moveTo(x - 0.022, ey); ctx.lineTo(x + 0.022, ey - 0.006); ctx.stroke(); });
      ctx.beginPath(); ctx.moveTo(ex - 0.03, HEAD_Y + 0.085); ctx.quadraticCurveTo(ex + 0.02, HEAD_Y + 0.1, ex + 0.06, HEAD_Y + 0.06); ctx.stroke();
      break;
    case 'sad':
      eyes((x) => { ctx.beginPath(); ctx.arc(x, ey + 0.01, 0.017, 0, Math.PI * 2); ctx.fill(); });
      eyes((x) => { ctx.beginPath(); ctx.moveTo(x - 0.03, ey - 0.06 + (x > ex ? 0.02 : 0)); ctx.lineTo(x + 0.03, ey - 0.06 + (x > ex ? 0 : 0.02)); ctx.stroke(); });
      ctx.beginPath(); ctx.arc(ex + 0.01, HEAD_Y + 0.12, 0.035, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
      // 一滴汗
      ctx.fillStyle = '#7fc8ff';
      ctx.beginPath(); ctx.ellipse(ex - 0.12, ey - 0.06, 0.016, 0.026, 0, 0, Math.PI * 2); ctx.fill();
      break;
    case 'shock':
      eyes((x) => {
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, ey, 0.032, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(x + 0.008, ey, 0.012, 0, Math.PI * 2); ctx.fill();
      });
      ctx.beginPath(); ctx.ellipse(ex + 0.01, HEAD_Y + 0.09, 0.028, 0.038, 0, 0, Math.PI * 2); ctx.fill();
      break;
    case 'pain':
      eyes((x) => {
        const d = x > ex ? -1 : 1;
        ctx.beginPath(); ctx.moveTo(x - 0.025 * d, ey - 0.022); ctx.lineTo(x + 0.02 * d, ey); ctx.lineTo(x - 0.025 * d, ey + 0.022); ctx.stroke();
      });
      ctx.fillStyle = '#7a2b2b';
      ctx.beginPath(); ctx.ellipse(ex + 0.01, HEAD_Y + 0.09, 0.05, 0.04, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillRect(ex - 0.03, HEAD_Y + 0.055, 0.08, 0.014);
      blush(ctx, ex, ey, '#ff5a5a');
      break;
    case 'dizzy':
      eyes((x) => {
        ctx.beginPath(); ctx.moveTo(x - 0.02, ey - 0.02); ctx.lineTo(x + 0.02, ey + 0.02);
        ctx.moveTo(x + 0.02, ey - 0.02); ctx.lineTo(x - 0.02, ey + 0.02); ctx.stroke();
      });
      ctx.beginPath(); ctx.moveTo(ex - 0.04, HEAD_Y + 0.09);
      for (let i = 1; i <= 4; i++) ctx.lineTo(ex - 0.04 + i * 0.022, HEAD_Y + 0.09 + (i % 2 ? -0.012 : 0.012));
      ctx.stroke();
      break;
    default:
      eyes((x) => { ctx.beginPath(); ctx.arc(x, ey, 0.018, 0, Math.PI * 2); ctx.fill(); });
      ctx.beginPath(); ctx.moveTo(ex - 0.025, HEAD_Y + 0.085); ctx.lineTo(ex + 0.035, HEAD_Y + 0.085); ctx.stroke();
  }
  if (look.glasses && face !== 'dizzy' && face !== 'pain') {
    ctx.strokeStyle = '#111'; ctx.lineWidth = 0.014;
    eyes((x) => { ctx.beginPath(); ctx.arc(x, ey, 0.038, 0, Math.PI * 2); ctx.stroke(); });
    ctx.beginPath(); ctx.moveTo(ex - 0.005, ey); ctx.lineTo(ex + 0.005, ey); ctx.stroke();
  }
}

function blush(ctx, ex, ey, color = '#ff8f8f') {
  ctx.fillStyle = color;
  ctx.globalAlpha *= 0.45;
  ctx.beginPath(); ctx.ellipse(ex - 0.08, ey + 0.05, 0.03, 0.017, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(ex + 0.1, ey + 0.05, 0.03, 0.017, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha /= 0.45;
}

/** 红手印：一个掌心加五根手指 */
function handprint(ctx, x, y, a) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.3);
  ctx.fillStyle = `rgba(255,40,40,${0.85 * a})`;
  ctx.shadowColor = `rgba(255,60,60,${a})`;
  ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.ellipse(0, 0.012, 0.045, 0.052, 0, 0, Math.PI * 2); ctx.fill();
  for (const [fx, fy, r] of [[-0.05, -0.04, 0.4], [-0.022, -0.065, 0.15], [0.008, -0.07, 0], [0.036, -0.06, -0.15], [0.06, 0.0, -0.9]]) {
    ctx.beginPath(); ctx.ellipse(fx, fy, 0.014, 0.034, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/** 一团柔光的贴图，按颜色缓存。比每帧每根荧光棒建一个径向渐变快得多 */
const glows = new Map();
export function glowSprite(c) {
  if (!glows.has(c)) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g2 = cv.getContext('2d');
    const g = g2.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, `rgba(${c},1)`);
    g.addColorStop(1, `rgba(${c},0)`);
    g2.fillStyle = g;
    g2.fillRect(0, 0, 64, 64);
    glows.set(c, cv);
  }
  return glows.get(c);
}

/**
 * 荧光棒：举在手里，涨亮绿、跌亮红，涨跌越大越亮。on 从 0 到 1 是点亮的过程。
 * 后排几十根一起亮，就是一片光海——一眼看出今天整体是红是绿。
 */
function drawLight(ctx, x, y, s, p) {
  const { pct, on = 1, sway = 0 } = p.light;
  const hx = x + 0.16 * s * p.dir, hy = y - (p.lift + 0.74) * s;
  const tx = hx + (0.05 * p.dir + sway) * s, ty = hy - 0.42 * s;
  const up = pct >= 0;
  const k = 0.35 + 0.65 * Math.min(1, Math.abs(pct) / 3);
  const c = on > 0 ? (up ? '61,255,154' : '255,77,94') : '200,200,220';
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(${c},${0.35 + 0.65 * on})`;
  ctx.lineWidth = s * 0.07;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
  if (on > 0) {
    ctx.globalCompositeOperation = 'lighter';
    const r = s * (0.32 + 0.25 * k) * on;
    ctx.globalAlpha *= 0.75 * k * on;
    ctx.drawImage(glowSprite(c), tx - r, ty - r, r * 2, r * 2);
  }
  ctx.restore();
}

/**
 * 头顶的牌子。flip 0 → 1 是翻牌：先压扁到一条线，再展开成另一面。
 * 背面只写代码，正面按涨跌上色、写涨跌幅。
 */
function drawSign(ctx, x, y, s, sign, alpha, handY, handX) {
  const w = s * 0.86, h = s * 0.38;
  const f = sign.flip ?? 1;
  const showFront = f >= 0.5;
  const sx = Math.abs(Math.cos(f * Math.PI));
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, y);
  // 杆子
  ctx.strokeStyle = '#6b4a2b'; ctx.lineWidth = Math.max(1, s * 0.03);
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(handX, -handY); ctx.stroke();
  ctx.scale(Math.max(0.02, sx), 1);
  const up = sign.pct >= 0;
  const k = Math.min(1, Math.abs(sign.pct) / 4);
  ctx.fillStyle = showFront
    ? (up ? `rgb(${lerpC([226, 246, 236], [16, 160, 94], k)})` : `rgb(${lerpC([252, 232, 233], [214, 52, 60], k)})`)
    : '#fbfaf6';
  // 阴影用错位的深色底代替 shadowBlur——四十块牌子各做一次模糊，帧数直接掉一半
  const face = ctx.fillStyle;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  roundRect(ctx, -w / 2, -h / 2 + s * 0.025, w, h, h * 0.18);
  ctx.fill();
  ctx.fillStyle = face;
  roundRect(ctx, -w / 2, -h / 2, w, h, h * 0.18);
  ctx.fill();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const dark = showFront && k > 0.45;
  ctx.fillStyle = dark ? '#fff' : '#1b1b22';
  ctx.font = `900 ${h * 0.4}px ${FONT}`;
  ctx.fillText(sign.ticker, 0, showFront ? -h * 0.2 : 0);
  if (showFront) {
    ctx.fillStyle = dark ? '#fff' : up ? '#0b7a45' : '#b3242b';
    ctx.font = `800 ${h * 0.34}px ${FONT}`;
    ctx.fillText(`${up ? '+' : ''}${sign.pct.toFixed(2)}%`, 0, h * 0.22);
  }
  ctx.restore();
}

export const FONT = '"PingFang SC","Noto Sans SC","Microsoft YaHei","WenQuanYi Zen Hei",system-ui,sans-serif';

const lerpC = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',');

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 颜色提亮 / 压暗。amt > 0 变亮 */
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
