import { subscribe } from '../js/store.js';
import { toast } from '../js/dom.js';
import { buildCast, drawFrame, W, H, DURATION, IDLE_T } from '../arena/show.js';

/**
 * 首页：打屁股大会。全屏画布 + 角落里三个按钮。
 *
 * 第一次拿到数据自动演一遍，演完停在"灯亮着、大家举着牌子"的待机画面，
 * 牌子上的涨跌跟着行情实时变。点"再演一遍"或者录视频随时重来。
 */

const SHELL = `
  <div class="arena">
    <canvas id="stage"></canvas>
    <div class="arena-ui">
      <button id="replay" title="空格">▶ 再演一遍</button>
      <button id="record" title="录下整场表演，下载成视频">⏺ 录视频</button>
      <a href="#/board">看盘 →</a>
    </div>
    <div class="arena-wait" id="wait">等行情…</div>
  </div>`;

export function arena(host) {
  host.innerHTML = SHELL;
  document.body.classList.add('arena-mode');
  const canvas = host.querySelector('#stage');
  const ctx = canvas.getContext('2d');

  let cast = null;
  let playing = null;        // { start }：正在演，start 是开演那一刻的 performance.now()
  let recorder = null;
  let fixedT = null;         // 逐帧导出时由外部指定时间
  let raf = 0;
  let alive = true;
  let fadeFrom = 0;          // 演完切回待机时淡入

  /** 画布跟着窗口走，按 16:9 留黑边。录视频时固定 1920×1080 */
  function fit() {
    const dpr = recorder ? 1 : Math.min(2, window.devicePixelRatio || 1);
    const cw = recorder ? W : canvas.clientWidth, ch = recorder ? H : canvas.clientHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    const k = Math.min(canvas.width / W, canvas.height / H);
    return { k, ox: (canvas.width - W * k) / 2, oy: (canvas.height - H * k) / 2 };
  }
  let view = fit();
  const onResize = () => { view = fit(); };
  window.addEventListener('resize', onResize);

  function frame(now) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (!cast || fixedT != null) return;
    const sec = now / 1000;
    let t = IDLE_T;
    if (playing) {
      t = (now - playing.start) / 1000;
      if (t >= DURATION) { playing = null; fadeFrom = now; t = IDLE_T; finishRecording(); }
    }
    paint(Math.min(t, DURATION), playing ? t : sec);
    // 演完回到待机画面时，从黑里淡出来
    const fade = 1 - (now - fadeFrom) / 600;
    if (fade > 0 && fadeFrom) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = `rgba(0,0,0,${fade})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  }

  function paint(t, now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.k, 0, 0, view.k, view.ox, view.oy);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    drawFrame(ctx, cast, t, now);
    ctx.restore();
  }

  function play() {
    if (!cast) return;
    playing = { start: performance.now() };
  }

  // ── 录视频：直接录画布，浏览器自带，不用装任何东西 ──────────────
  function record() {
    if (!cast || recorder) return;
    if (!window.MediaRecorder || !canvas.captureStream) { toast('这个浏览器不支持录制，换 Chrome 试试'); return; }
    const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(canvas.captureStream(60), { mimeType: type, videoBitsPerSecond: 12_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `us-market-pulse-${cast.date || 'today'}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      recorder = null;
      view = fit();
      host.querySelector('.arena').classList.remove('is-recording');
    };
    view = fit();
    host.querySelector('.arena').classList.add('is-recording');
    recorder.start();
    play();
    toast('录制中，演完自动下载');
  }
  function finishRecording() { if (recorder?.state === 'recording') recorder.stop(); }

  host.querySelector('#replay').addEventListener('click', play);
  host.querySelector('#record').addEventListener('click', record);
  const onKey = (e) => { if (e.code === 'Space' && !e.target.closest?.('input')) { e.preventDefault(); play(); } };
  window.addEventListener('keydown', onKey);

  // 给逐帧导出用：window.__arena.seek(t) 画出第 t 秒那一帧
  window.__arena = {
    duration: DURATION,
    ready: () => !!cast,
    seek(t) { fixedT = t; paint(t, t); },
  };

  // 演的时候演员表冻住，不然中途行情一变，台上的人会换掉
  let first = true;
  const unsubscribe = subscribe((d) => {
    if (playing) return;
    cast = buildCast(d);
    host.querySelector('#wait').hidden = true;
    if (first) { first = false; play(); }
  }, { live: false });

  raf = requestAnimationFrame(frame);

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    unsubscribe();
    finishRecording();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey);
    document.body.classList.remove('arena-mode');
    delete window.__arena;
  };
}
