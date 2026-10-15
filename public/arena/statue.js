import { rng } from './math.js';

/**
 * 低多边形青铜雕塑。
 *
 * 只手写一圈剪影轮廓，剩下的自动生成：轮廓内撒点 → Delaunay 三角剖分 →
 * 用"离轮廓越远越高"造一个鼓起来的曲面 → 每个三角面按朝向打光。
 * 出来就是一块块切面、明暗分明的金属雕塑。生成一次画到离屏画布上，之后每帧直接贴图。
 *
 * 坐标：x、y 都是 0..1，y 朝下，y = 1 是地面，动物面朝右。aspect 是实际宽高比。
 */

const SHAPES = {
  bull: {
    aspect: 1.5,
    // 华尔街铜牛的姿势：低头冲锋、肩峰隆起、前腿蹬出去、尾巴甩起来
    outline: [
      [0.10, 0.22], [0.28, 0.20], [0.45, 0.16], [0.58, 0.09], [0.66, 0.13], [0.72, 0.25],
      [0.78, 0.33], [0.80, 0.31], [0.83, 0.21], [0.88, 0.13], [0.935, 0.11], [0.91, 0.16],
      [0.875, 0.25], [0.88, 0.39], [0.95, 0.61], [0.975, 0.70], [0.93, 0.755], [0.85, 0.70],
      [0.78, 0.62], [0.74, 0.66], [0.80, 0.80], [0.865, 0.97], [0.80, 0.99], [0.72, 0.84],
      [0.68, 0.76], [0.645, 0.84], [0.625, 0.99], [0.56, 0.99], [0.57, 0.79], [0.48, 0.70],
      [0.36, 0.70], [0.33, 0.78], [0.36, 0.99], [0.30, 0.99], [0.25, 0.80], [0.21, 0.82],
      [0.12, 0.99], [0.055, 0.99], [0.11, 0.76], [0.05, 0.58], [0.04, 0.40], [0.06, 0.28],
    ],
    tail: [[0.06, 0.27], [-0.02, 0.18], [0.03, 0.04]],
    horn2: [[0.80, 0.33], [0.79, 0.20], [0.85, 0.10]],     // 远侧那只角，画在后面
    eye: [0.85, 0.42],
    nose: [0.965, 0.70],
    palette: { dark: [60, 34, 12], mid: [176, 118, 44], light: [255, 222, 140], spec: [255, 248, 220] },
  },
  bear: {
    aspect: 0.95,
    // 人立起来、张嘴咆哮、两只爪子张开
    outline: [
      [0.40, 0.16], [0.40, 0.08], [0.45, 0.04], [0.49, 0.08], [0.55, 0.07], [0.61, 0.03],
      [0.66, 0.06], [0.70, 0.11], [0.80, 0.14], [0.88, 0.16], [0.905, 0.19], [0.86, 0.22],
      [0.74, 0.225], [0.84, 0.27], [0.80, 0.30], [0.70, 0.30], [0.66, 0.34], [0.80, 0.36],
      [0.94, 0.30], [0.99, 0.265], [0.975, 0.30], [0.995, 0.31], [0.975, 0.335], [0.99, 0.35],
      [0.95, 0.37], [0.82, 0.46], [0.69, 0.50], [0.71, 0.62], [0.69, 0.76], [0.73, 0.88],
      [0.765, 0.985], [0.60, 0.99], [0.58, 0.88], [0.52, 0.84], [0.46, 0.90], [0.44, 0.99],
      [0.30, 0.99], [0.33, 0.86], [0.28, 0.72], [0.26, 0.56], [0.29, 0.42], [0.21, 0.35],
      [0.12, 0.25], [0.07, 0.205], [0.10, 0.185], [0.055, 0.165], [0.10, 0.155], [0.08, 0.13],
      [0.15, 0.16], [0.26, 0.25], [0.34, 0.26], [0.38, 0.20],
    ],
    eye: [0.71, 0.155],
    nose: [0.895, 0.185],
    palette: { dark: [22, 23, 29], mid: [82, 86, 100], light: [186, 196, 214], spec: [240, 246, 255] },
  },
};

// ── 几何 ──────────────────────────────────────────────────────────
function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function edgeDistance(poly, x, y) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/** Bowyer–Watson 三角剖分。几百个点，O(n²) 足够快，而且只在启动时跑一次 */
function delaunay(pts) {
  const big = 1e4;
  const all = [...pts, [-big, -big], [big, -big], [0, big]];
  const n = pts.length;
  const circum = (a, b, c) => {
    const [ax, ay] = all[a], [bx, by] = all[b], [cx, cy] = all[c];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    return { a, b, c, x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris = [circum(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const [px, py] = all[i];
    const bad = [], keep = [];
    for (const t of tris) ((px - t.x) ** 2 + (py - t.y) ** 2 < t.r2 ? bad : keep).push(t);
    // 坏三角形的边里，只出现一次的就是空洞的边界
    const edges = new Map();
    for (const t of bad) {
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
        const k = u < v ? `${u},${v}` : `${v},${u}`;
        edges.set(k, edges.has(k) ? null : [u, v]);
      }
    }
    for (const e of edges.values()) if (e) keep.push(circum(e[0], e[1], i));
    tris = keep;
  }
  return tris.filter((t) => t.a < n && t.b < n && t.c < n).map((t) => [t.a, t.b, t.c]);
}

// ── 生成 ──────────────────────────────────────────────────────────
/** 撒点、剖分、算每个面的明暗。结果和尺寸无关，按种类缓存 */
const meshes = {};
function mesh(kind) {
  if (meshes[kind]) return meshes[kind];
  const shape = SHAPES[kind];
  const A = shape.aspect;
  const poly = shape.outline.map(([x, y]) => [x * A, y]);
  const rand = rng(kind === 'bull' ? 7 : 11);

  // 轮廓上加密，内部抖动网格
  const pts = [];
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.045));
    for (let s = 0; s < steps; s++) pts.push([ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps]);
  }
  const step = 0.055;
  for (let y = 0; y < 1; y += step) {
    for (let x = 0; x < A; x += step) {
      const px = x + (rand() - 0.5) * step * 0.8, py = y + (rand() - 0.5) * step * 0.8;
      if (inside(poly, px, py) && edgeDistance(poly, px, py) > 0.02) pts.push([px, py]);
    }
  }

  // 高度：离轮廓越远越鼓，再加一点随机起伏，切面才有变化
  const dmax = Math.max(...pts.map(([x, y]) => edgeDistance(poly, x, y)));
  const h = pts.map(([x, y]) => Math.sqrt(edgeDistance(poly, x, y) / dmax) * 0.32 + (rand() - 0.5) * 0.025);

  // 光从左上前方来
  const L = norm([-0.5, -0.75, 0.55]);
  const tris = delaunay(pts)
    .filter(([a, b, c]) => inside(poly, (pts[a][0] + pts[b][0] + pts[c][0]) / 3, (pts[a][1] + pts[b][1] + pts[c][1]) / 3))
    .map(([a, b, c]) => {
      const p = [a, b, c].map((i) => [pts[i][0], pts[i][1], h[i]]);
      let n = norm(cross(sub(p[1], p[0]), sub(p[2], p[0])));
      if (n[2] < 0) n = n.map((v) => -v);
      const diffuse = 0.18 + 0.82 * Math.max(0, dot(n, L));   // 留一点环境光，背光面不至于全黑
      // 镜面高光：反射方向朝着观众的那些面会很亮
      const r = sub(n.map((v) => v * 2 * dot(n, L)), L);
      const spec = Math.max(0, r[2]) ** 14;
      return { pts: p.map(([x, y]) => [x, y]), diffuse, spec };
    });
  return (meshes[kind] = { tris, poly, A });
}

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/**
 * 画成一张离屏图。height 是像素高度。
 * 返回 { canvas, width, height, eye, nose }——眼睛和鼻孔的像素位置留给特效用（发光、喷气）。
 */
export function renderStatue(kind, height, dpr = 1) {
  const shape = SHAPES[kind];
  const { tris, A } = mesh(kind);
  const width = height * A;
  const pad = height * 0.04;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((width + pad * 2) * dpr);
  canvas.height = Math.ceil((height + pad * 2) * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr * height, 0, 0, dpr * height, pad * dpr, pad * dpr);

  const P = shape.palette;
  for (const t of tris) {
    const base = t.diffuse < 0.5 ? mix(P.dark, P.mid, t.diffuse / 0.5) : mix(P.mid, P.light, (t.diffuse - 0.5) / 0.5);
    const [r, g, b] = mix(base, P.spec, Math.min(1, t.spec * 0.9));
    ctx.fillStyle = ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = 1.2 / height;            // 同色描边，盖住相邻面之间的细缝
    ctx.beginPath();
    ctx.moveTo(...t.pts[0]); ctx.lineTo(...t.pts[1]); ctx.lineTo(...t.pts[2]); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }

  if (shape.horn2) {
    const [a, b, c] = shape.horn2.map(([x, y]) => [x * A, y]);
    ctx.globalCompositeOperation = 'destination-over';
    ctx.strokeStyle = `rgb(${P.mid})`;
    ctx.lineWidth = 0.035; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(...a); ctx.quadraticCurveTo(...b, ...c); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  if (shape.tail) {
    const [a, b, c] = shape.tail.map(([x, y]) => [x * A, y]);
    ctx.strokeStyle = `rgb(${P.mid})`;
    ctx.lineWidth = 0.022; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(...a); ctx.quadraticCurveTo(...b, ...c); ctx.stroke();
    ctx.fillStyle = `rgb(${P.dark})`;
    ctx.beginPath(); ctx.ellipse(c[0], c[1] + 0.02, 0.022, 0.04, 0, 0, Math.PI * 2); ctx.fill();
  }

  const at = ([x, y]) => [pad + x * A * height, pad + y * height];
  return { canvas, width: canvas.width / dpr, height: canvas.height / dpr, pad, eye: at(shape.eye), nose: at(shape.nose) };
}
