# us-market-pulse

美股打屁股大会：市值前 100 的公司变成 100 个小人，每天收盘涨幅前十挨个打跌幅前十的屁股。
后面立着大盘和四大板块的铜牛 / 铜熊，涨是牛、跌是熊。

```bash
npm start   # → http://localhost:5173
```

零依赖，Node ≥ 18。行情来自 Yahoo Finance，新浪财经兜底，基本实时。`npm run check` 自检两个数据源。

- **首页**：打开自动演一遍（25 秒），演完停在待机画面，牌子和荧光棒跟着实时行情变。`空格` 再演一遍，「录视频」直接下载整场
- **看盘**（`#/board`）：自选股一只一行（分时、日内 / 52 周区间、量比），侧栏是板块排行和异动
- **财报 / 宽度 / 宏观**：未来两周财报、涨跌分布、美债商品汇率加密
- 点任意一只票进个股页

快捷键：`1`–`4` 切页 · `R` 强制刷新 · `T` 白天 / 夜间 · `Esc` 返回

自选在总览右上角「编辑」里增删，存在 `data/watchlist.json`。其他配置见 `config.js`。

```
server.js        路由 + 缓存
config.js        所有可改的配置
lib/             market-data 行情入口（providers/ 下 yahoo 主、sina 备）· holdings 标普 500 成分股 ·
                 flock 离群算法 · baselines 离群基线 · market-hours 交易时段 · watchlist 自选 · xlsx
scripts/         check-sources 数据源自检
tests/           npm test
public/js/       store 数据 · router · chrome 顶栏 · chart K 线 · widgets 小部件 · fmt · dom
public/arena/    show 整场戏（时间轴 → 一帧）· person 小人 · statue 低多边形雕塑 · math
public/views/    arena 首页 · overview 看盘 · symbol · earnings · breadth · macro
```
