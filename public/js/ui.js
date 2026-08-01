// 全局提示条。挂在 index.html 的静态外壳上，不随视图切换消失。

let timer;

export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { t.hidden = true; }, 2200);
}
