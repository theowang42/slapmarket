/**
 * 元素尺寸变化时重画，去抖。返回清理函数。
 *
 * 用 ResizeObserver 而不是 window 的 resize：窗口没变但元素变了的情况是真实存在的——
 * 面板折叠又展开、路由切换后容器才拿到高度、侧栏收起。只听 window 的话，
 * 画布会一直空着，直到下一轮数据到达才自愈（休市时要等 5 分钟）。
 *
 * 顺带解决首屏时序：ResizeObserver 在 observe 时就会回调一次，
 * 于是"容器刚拿到尺寸"这件事本身就会触发第一次绘制，不用在别处补。
 */
export function onResize(el, fn, delay = 120) {
  let timer;
  const ro = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
  });
  ro.observe(el);
  return () => { ro.disconnect(); clearTimeout(timer); };
}

/** 画布按 DPR 缩放，返回 CSS 像素下的宽高。不做的话高分屏上线是糊的。 */
export function fitCanvas(canvas) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/** 全局提示条。挂在 index.html 的静态外壳上，不随视图切换消失。 */
let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}
