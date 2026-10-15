import { subscribe, refresh } from '../js/store.js';
import { toast } from '../js/dom.js';
import { fmtPrice, fmtPct, fmtCap, fmtVol, dirClass, dirColor } from '../js/fmt.js';
import { sparkSvg, rangeBar } from '../js/widgets.js';
import { W, H, buildCast } from './cast.js';
import { drawFrame, DURATION, cues } from './show.js';
import { sound } from './sound.js';
import { LiveStage } from './live.js';
import { createDrawer } from './drawer.js';

/**
 * 整个网站就这一页。平时是实时舞台：台前站着涨跌幅前十，跟着行情走；悬停看详情，点了右边滑出盘面。
 * 「收盘大戏」随时可以演，页面开着时美股一收盘也会自动演一遍。
 */

const SHELL = `
  <div class="arena">
    <canvas id="stage"></canvas>
    <div class="arena-hud" id="hud"></div>
    <div class="arena-tip" id="tip" hidden></div>
    <aside class="arena-drawer" id="drawer"></aside>
    <div class="arena-ui">
      <button id="sound" title="声音开关"></button>
      <button id="replay" title="空格">▶ 收盘大戏</button>
      <button id="record" title="录下整场大戏，下载成视频">⏺ 录视频</button>
    </div>
    <div class="arena-wait" id="wait">等行情…</div>
  </div>`;

const WEEKDAY = { Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六', Sun: '周日' };

export function mountArena(host) {
  host.innerHTML = SHELL;
  const $ = (id) => host.querySelector(`#${id}`);
  const root = host.querySelector('.arena');
  const canvas = $('stage');
  const ctx = canvas.getContext('2d');
  const stage = new LiveStage();
  const drawer = createDrawer($('drawer'), { onPick: (sym) => openSym(sym) });

  let data = null;
  let cast = null;           // 实时的演员表，每次行情更新都重建
  let showCast = null;       // 大戏开演那一刻冻住的演员表
  let playing = null;        // { start, cues, lastT }
  let recorder = null;
  let fixedT = null;         // 逐帧导出
  let hover = null;          // 鼠标下面是谁
  let lastPhase = null;
  let fadeFrom = 0;
  let raf = 0;
  let alive = true;

  // ── 画布尺寸：按 16:9 留黑边。录视频时固定 1920×1080 ───────────
  let view;
  /**
   * 渲染分辨率倍率。高分屏（Mac Retina）像素是普通屏的四倍，机器带不动就自动降一点，
   * 顺了再升回去。画面稍微软一点，换来流畅——动画卡成幻灯片比糊一点难看得多。
   */
  let quality = 1;
  function fit() {
    const dpr = recorder ? 1 : Math.min(2, window.devicePixelRatio || 1) * quality;
    const cw = recorder ? W : canvas.clientWidth, ch = recorder ? H : canvas.clientHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    const k = Math.min(canvas.width / W, canvas.height / H);
    view = { k, ox: (canvas.width - W * k) / 2, oy: (canvas.height - H * k) / 2 };
  }
  fit();
  window.addEventListener('resize', fit);

  /** 屏幕坐标 → 舞台逻辑坐标 */
  function toStage(ev) {
    const r = canvas.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (canvas.width / r.width), py = (ev.clientY - r.top) * (canvas.height / r.height);
    return { x: (px - view.ox) / view.k, y: (py - view.oy) / view.k };
  }

  /**
   * 每秒看一次这一秒的平均帧耗时，决定要不要调画质。
   * - 低于 30 帧才降，最多降到 75%——再低字就糊了，比卡还难受
   * - 高于 50 帧连续 3 秒就升回去。注意普通屏幕刷新率是 60Hz，每帧最快也要 16.7ms，
   *   门槛定得比这还严的话（之前是 15ms）画质降了就永远回不来
   * - 刚打开的头 3 秒不算：那时在生成雕塑、天空这些缓存，本来就慢
   */
  const perf = { last: 0, sum: 0, n: 0, since: 0, good: 0, born: performance.now() };
  function tune(nowMs) {
    if (perf.last) { perf.sum += nowMs - perf.last; perf.n++; }
    perf.last = nowMs;
    if (nowMs - perf.since < 1000 || recorder) return;
    const avg = perf.sum / Math.max(1, perf.n);
    perf.sum = 0; perf.n = 0; perf.since = nowMs;
    if (document.hidden || nowMs - perf.born < 3000) return;
    if (avg > 33 && quality > 0.75) { quality = Math.max(0.75, quality * 0.85); perf.good = 0; fit(); }
    else if (avg < 20 && quality < 1 && ++perf.good >= 3) { quality = Math.min(1, quality / 0.85); perf.good = 0; fit(); }
  }

  // ── 每帧 ────────────────────────────────────────────────────────
  function frame(nowMs) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (!cast || fixedT != null) return;
    tune(nowMs);
    const now = nowMs / 1000;
    begin();
    if (playing) {
      const t = (nowMs - playing.start) / 1000;
      for (const c of playing.cues) if (c[0] > playing.lastT && c[0] <= t) sound.play(c[1], ...c.slice(2));
      playing.lastT = t;
      if (t >= DURATION) { playing = null; fadeFrom = nowMs; finishRecording(); root.classList.remove('is-playing'); }
      else drawFrame(ctx, showCast, t, t);
    }
    if (!playing) stage.draw(ctx, now, hover);
    end();
    const fade = 1 - (nowMs - fadeFrom) / 700;
    if (fadeFrom && fade > 0) { ctx.fillStyle = `rgba(0,0,0,${fade})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  }
  function begin() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.k, 0, 0, view.k, view.ox, view.oy);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  }
  function end() { ctx.restore(); ctx.setTransform(1, 0, 0, 1, 0, 0); }

  // ── 大戏 ────────────────────────────────────────────────────────
  function play() {
    if (!cast) return;
    showCast = cast;
    playing = { start: performance.now(), cues: cues(cast), lastT: -1 };
    hover = null; hideTip(); drawer.close();
    root.classList.add('is-playing');
  }

  function record() {
    if (!cast || recorder) return;
    if (!window.MediaRecorder || !canvas.captureStream) { toast('这个浏览器不支持录制，换 Chrome 试试'); return; }
    const type = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/mp4;codecs=avc1', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported(m));
    // 画面 + 声音合成一路。没开声音就只录画面
    const audio = sound.ready && !sound.muted ? sound.stream()?.getAudioTracks() ?? [] : [];
    const stream = new MediaStream([...canvas.captureStream(60).getVideoTracks(), ...audio]);
    recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(chunks, { type }));
      a.download = `slapmarket-${cast.date || 'today'}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      recorder = null;
      fit();
    };
    fit();
    recorder.start();
    play();
    toast('录制中，演完自动下载');
  }
  function finishRecording() { if (recorder?.state === 'recording') recorder.stop(); }

  // ── 悬停：小卡片 ────────────────────────────────────────────────
  const detail = new Map();      // 代码 → { at, d }：悬停卡片要的分时和细节，20 秒内不重复拉
  async function details(sym) {
    const hit = detail.get(sym);
    if (hit && Date.now() - hit.at < 20_000) return hit.d;
    const d = await (await fetch(`/api/symbol?s=${encodeURIComponent(sym)}&range=1D`)).json();
    if (d.error) throw new Error(d.error);
    detail.set(sym, { at: Date.now(), d });
    return d;
  }

  const tip = $('tip');
  function hideTip() { tip.hidden = true; }

  function placeTip(ev) {
    const r = root.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = ev.clientX - r.left + 18, y = ev.clientY - r.top + 18;
    if (x + tw > r.width - 8) x = ev.clientX - r.left - tw - 18;
    if (y + th > r.height - 8) y = Math.max(8, r.height - th - 8);
    tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  function personTip(sym) {
    const p = cast.people.find((x) => x.sym === sym);
    if (!p) return null;
    const role = stage.roles.get(sym);
    const capRank = cast.people.indexOf(p) + 1;
    const badge = role
      ? `<span class="tip-badge ${role.side}">${role.side === 'up' ? '涨幅' : '跌幅'}第 ${role.rank}</span>`
      : '';
    return {
      sym,
      head: `<b>${sym}</b><span>${p.name ?? ''}</span>`,
      sub: `${p.sectorName ?? ''} · 市值第 ${capRank} ${badge}`,
      pct: p.pct, last: p.last,
    };
  }

  function statueTip(i) {
    const st = cast.statues[i];
    const m = st.members;
    const list = m?.length
      ? `<div class="tip-list">${[...m.slice(0, 3), ...m.slice(-3).reverse()].map((x) =>
          `<span>${x.symbol}</span><b class="num ${dirClass(x.pct)}">${fmtPct(x.pct)}</b>`).join('')}</div>`
      : '';
    return {
      sym: st.sym,
      head: `<b>${st.label}</b><span>${st.sym}</span>`,
      sub: `${st.kind === 'bull' ? '今天是牛' : '今天是熊'}${m ? ` · ${m.length} 只成分股` : ''}`,
      pct: st.pct, last: null, extra: list,
    };
  }

  let tipFor = null;
  let lastEv = null;
  async function showTip(h, ev) {
    const info = h.kind === 'person' ? personTip(h.sym) : statueTip(h.index);
    if (!info) return hideTip();
    const key = `${h.kind}:${h.sym ?? h.index}`;
    tipFor = key;
    // d：undefined = 还在拉，null = 拉失败了，对象 = 拉到了
    const body = (d) => {
      const q = d?.quote;
      const pct = q?.pct ?? info.pct, last = q?.last ?? info.last;
      const cls = dirClass(pct);
      const spark = d?.bars?.length
        ? sparkSvg({ pts: d.bars.map((b) => b.c), prev: q.prev, stroke: dirColor(cls), w: 260, h: 46, gid: 'tipg', cls: 'tip-spark' })
        : `<div class="tip-spark tip-loading">${d === undefined ? '分时加载中…' : '暂时拿不到分时'}</div>`;
      const volPct = q?.volume && q?.avgVol ? `${((q.volume / q.avgVol) * 100).toFixed(0)}%` : '—';
      return `
        <div class="tip-head">${info.head}</div>
        <div class="tip-sub">${info.sub}</div>
        <div class="tip-px"><span class="num">${fmtPrice(last)}</span><span class="num ${cls}">${fmtPct(pct)}</span></div>
        ${spark}
        ${q ? rangeBar('日内', q.dayLo, q.dayHi, q.last) + rangeBar('52 周', q.yrLo, q.yrHi, q.last) : ''}
        ${q ? `<div class="tip-kv"><span>成交 ${fmtVol(q.volume)}</span><span>均量 ${volPct}</span>${q.cap ? `<span>市值 ${fmtCap(q.cap)}</span>` : ''}</div>` : ''}
        ${info.extra ?? ''}
        <div class="tip-hint">点击看实时盘面</div>`;
    };
    tip.innerHTML = body(detail.get(info.sym)?.d);
    tip.hidden = false;
    placeTip(ev);
    // 拉不到就明说，别一直挂着"加载中"。内容变高了要重新摆一下，别被屏幕底边切掉
    const d = await details(info.sym).catch(() => null);
    if (tipFor === key && !tip.hidden) { tip.innerHTML = body(d); placeTip(lastEv ?? ev); }
  }

  canvas.addEventListener('mousemove', (ev) => {
    if (playing || !cast) return;
    const { x, y } = toStage(ev);
    const h = stage.hitTest(x, y);
    const key = h && `${h.kind}:${h.sym ?? h.index}`;
    canvas.style.cursor = h ? 'pointer' : '';
    lastEv = ev;
    if (key !== (hover && `${hover.kind}:${hover.sym ?? hover.index}`)) {
      if (h) sound.play('tick');
      hover = h;
      if (h) showTip(h, ev); else { hideTip(); tipFor = null; }
    } else if (h) placeTip(ev);
  });
  canvas.addEventListener('mouseleave', () => { hover = null; hideTip(); tipFor = null; });

  // ── 点击：右边滑出盘面 ──────────────────────────────────────────
  function openSym(sym) {
    const st = cast?.statues.find((s) => s.sym === sym);
    drawer.show(st ? { sym, title: st.label, members: st.members } : { sym });
    root.classList.add('drawer-open');
  }
  canvas.addEventListener('click', (ev) => {
    if (playing) return;
    const h = stage.hitTest(...Object.values(toStage(ev)));
    if (!h) { if (drawer.open) closeDrawer(); return; }
    hideTip();
    sound.play('pop');
    sound.play('whoosh', true, 0.35, 0.12);
    if (h.kind === 'person') openSym(h.sym);
    else { const st = cast.statues[h.index]; drawer.show({ sym: st.sym, title: st.label, members: st.members }); root.classList.add('drawer-open'); }
  });
  function closeDrawer() { drawer.close(); root.classList.remove('drawer-open'); }

  // ── 状态栏 ──────────────────────────────────────────────────────
  function renderHud(d) {
    const s = d.session ?? {};
    const spx = d.market;
    const all = d.sectors.flatMap((x) => x.stocks);
    const up = all.filter((x) => x.pct > 0).length, down = all.filter((x) => x.pct < 0).length;
    const [, m, dd] = (s.etDate ?? '').split('-');
    $('hud').innerHTML = `
      <b class="hud-title">美股打屁股大会</b>
      <span class="hud-pill" data-phase="${s.phase ?? ''}"><i></i>${s.label ?? ''}${s.note ? ` · ${s.note}` : ''}</span>
      <span class="hud-dim num">ET ${m ? `${Number(m)}/${Number(dd)} ${WEEKDAY[s.weekday] ?? ''} ` : ''}${s.etTime ?? ''}</span>
      ${spx ? `<span class="num ${dirClass(spx.pct)}">标普 ${fmtPct(spx.pct)}</span>` : ''}
      <span class="hud-dim num"><b class="up">${up}</b> 涨 · <b class="down">${down}</b> 跌</span>`;
  }

  // ── 按键 ────────────────────────────────────────────────────────
  const onKey = (e) => {
    if (e.target.closest?.('input')) return;
    wake();
    if (e.code === 'Space') { e.preventDefault(); play(); }
    if (e.key === 'r' || e.key === 'R') { toast('强制刷新中…'); refresh({ force: true }); }
    if (e.key === 'Escape' && drawer.open) closeDrawer();
  };
  window.addEventListener('keydown', onKey);
  // ── 声音 ────────────────────────────────────────────────────────
  // 浏览器要求先有一次点击 / 按键才能出声。没解锁前按钮写"开声音"
  const soundBtn = $('sound');
  function paintSound() {
    soundBtn.textContent = !sound.ready ? '🔈 开声音' : sound.muted ? '🔇 静音' : '🔊 声音';
  }
  function wake() {
    if (sound.ready) return;
    sound.unlock();
    setTimeout(paintSound, 50);
  }
  soundBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!sound.ready) { sound.unlock(); sound.setMuted(false); }
    else sound.setMuted(!sound.muted);
    setTimeout(paintSound, 50);
  });
  root.addEventListener('pointerdown', wake);
  paintSound();

  $('replay').addEventListener('click', play);
  $('record').addEventListener('click', record);

  // 逐帧导出：window.__arena.seek(t) 画大戏第 t 秒那一帧
  window.__arena = {
    duration: DURATION,
    ready: () => !!cast,
    seek(t) { fixedT = t; showCast ??= cast; root.classList.add('is-playing'); begin(); drawFrame(ctx, showCast, t, t); end(); },
    /** 整场大戏的配音，WAV，和 seek 出来的画面一一对应 */
    async soundtrack() {
      showCast ??= cast;
      const buf = await sound.renderWav(cues(showCast), DURATION);
      let s = '';
      const b = new Uint8Array(buf);
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return btoa(s);
    },
  };

  // ── 行情 ────────────────────────────────────────────────────────
  const unsubscribe = subscribe((d, kind) => {
    data = d;
    cast = buildCast(d);
    const events = stage.update(cast, performance.now() / 1000);
    if (!playing) {
      if (events.includes('first')) sound.play('cheer', 0.3, 1.8);
      if (events.includes('newTop')) sound.play('fanfare');
      if (events.includes('newBottom')) sound.play('sadTrombone');
      if (events.includes('enter')) { sound.play('whoosh', true, 0.3, 0.3); sound.play('cheer', 0.25, 0.8); }
      // 每次行情刷新轻轻响一声，开着页面就知道"又更新了"：大盘涨大调、跌小调
      else if (!events.length && kind === 'live') {
        sound.play('chime', (d.market?.pct ?? 0) >= 0);
      }
    }
    $('wait').hidden = true;
    renderHud(d);
    if (drawer.open && kind === 'live') drawer.refresh();
    // 页面开着、刚好收盘：自动演一遍
    const phase = d.session?.phase;
    if (lastPhase === 'open' && phase && phase !== 'open') play();
    lastPhase = phase;
  });

  raf = requestAnimationFrame(frame);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    unsubscribe();
    finishRecording();
    drawer.destroy();
    window.removeEventListener('resize', fit);
    window.removeEventListener('keydown', onKey);
    delete window.__arena;
  };
}
