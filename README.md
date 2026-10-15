# slapmarket

美股打屁股大会：市值前 100 的公司变成 100 个小人，每天收盘涨幅前十挨个打跌幅前十的屁股。
后面立着大盘和四大板块的铜牛 / 铜熊，涨是牛、跌是熊。

```bash
npm start   # → http://localhost:5173
```

零依赖，Node ≥ 18。行情来自 Yahoo Finance，新浪财经兜底，基本实时。`npm run check` 自检两个数据源。

- **首页（实时舞台）**：台前是"站着人的柱状图"——左边涨幅前十、右边跌幅前十，柱子高度就是涨跌幅，30 秒一刷，名次变了人会走着换位置。
  鼠标悬停任何一个小人或雕塑看详情，点了右边滑出实时盘面（K 线、分时、指标；板块雕塑还列出板块里涨跌最猛的几只）
- **收盘大戏**：25 秒的打屁股动画。`空格` 或右下角按钮随时演，页面开着时美股一收盘自动演一遍；「录视频」直接下载整场
- **看盘**（`#/board`）：自选股一只一行（分时、日内 / 52 周区间、量比），侧栏是板块排行和异动
- **财报 / 宽度 / 宏观**：未来两周财报、涨跌分布、美债商品汇率加密
- 点任意一只票进个股页

全程有音效（浏览器里现场合成，没有音频文件）：巴掌声、欢呼、鼓点、长号……平时开着也有很轻的人群声，
有人上榜、换第一名会响。右下角「声音」开关，录视频时声音一起录进去。

快捷键：`空格` 收盘大戏 · `1`–`4` 切页 · `R` 强制刷新 · `T` 白天 / 夜间 · `Esc` 关闭 / 返回

自选在总览右上角「编辑」里增删，存在 `data/watchlist.json`。其他配置见 `config.js`。

```
server.js        路由 + 缓存
config.js        所有可改的配置
lib/             market-data 行情入口（providers/ 下 yahoo 主、sina 备）· holdings 标普 500 成分股 ·
                 flock 离群算法 · baselines 离群基线 · market-hours 交易时段 · watchlist 自选 · xlsx
scripts/         check-sources 数据源自检
tests/           npm test
public/js/       store 数据 · router · chrome 顶栏 · chart K 线 · widgets 小部件 · fmt · dom
public/arena/    live 实时舞台 · show 收盘大戏（时间轴 → 一帧）· sound 合成音效 · drawer 侧边盘面 · cast 选角站位 ·
                 backdrop 布景 · person 小人 · statue 低多边形雕塑 · math
public/views/    arena 首页 · overview 看盘 · symbol · earnings · breadth · macro
```
