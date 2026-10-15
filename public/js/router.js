/**
 * 极简 hash 路由。
 *
 * 视图就是个函数：`view(host, params)`，往 host 里画，可选返回一个清理函数。
 * 切换时**先清理旧视图再挂新的**——resize、订阅这类东西挂在视图之外（window、store），
 * 漏掉一次清理就会有两个视图同时在刷，而且看不出来。
 */

/** '/s/:sym' → 正则 + 参数名。 */
function compile(pattern) {
  const keys = [];
  const src = pattern.replace(/:([A-Za-z]\w*)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp(`^${src}$`), keys };
}

export function createRouter({ host, routes, fallback = '/' }) {
  const table = Object.entries(routes).map(([pattern, view]) => ({ ...compile(pattern), view }));
  let cleanup = null;
  let currentPath = null;

  const match = (path) => {
    for (const r of table) {
      const m = r.re.exec(path);
      if (m) {
        return { view: r.view, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      }
    }
    return null;
  };

  function apply() {
    const path = location.hash.slice(1) || fallback;
    const hit = match(path) ?? match(fallback);
    if (!hit || path === currentPath) return;
    currentPath = path;
    cleanup?.();
    host.replaceChildren();
    cleanup = hit.view(host, hit.params) ?? null;
  }

  window.addEventListener('hashchange', apply);
  apply();
}
