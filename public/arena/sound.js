/**
 * 音效。全部用 Web Audio 现场合成，没有音频文件、不用下载任何东西。
 *
 * 风格是卡通游戏：短促的打击 + 有音高的木琴、铜管、滑哨。
 * 刻意不用持续的白噪声——噪声一长就是电视雪花声（第一版就是这么难听的）。
 * 噪声只出现在几毫秒的巴掌瞬态里。最后过一层小混响，听着像在场馆里，不是贴着耳朵。
 *
 * 浏览器规定页面得先被点一下才能出声，所以第一次点击 / 按键时才建 AudioContext。
 * 静音状态记在本地。录视频时把声音一起录进去（stream()）。
 */

const KEY = 'slapmarket:sound';
const GAIN = 0.7;
let ac = null, master = null, recDest = null, noiseBuf = null;
let muted = (() => { try { return localStorage.getItem(KEY) === 'off'; } catch { return false; } })();

/** 压限：巴掌的瞬态很尖，默认的压缩器反应太慢，峰值会顶破 0 dB */
function limiter(c) {
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -12; comp.knee.value = 6; comp.ratio.value = 16;
  comp.attack.value = 0.001; comp.release.value = 0.15;
  return comp;
}

/** 混响：用一段指数衰减的随机脉冲做卷积，1.6 秒的小厅 */
function reverb(c) {
  const len = Math.floor(c.sampleRate * 1.6);
  const ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  }
  const conv = c.createConvolver();
  conv.buffer = ir;
  return conv;
}

/** 搭好一条信号链：各音效 → master →（干声 + 混响）→ 压限 → 输出 */
function wire(c) {
  const comp = limiter(c);
  const m = c.createGain();
  m.gain.value = muted && c === ac ? 0 : GAIN;
  const wet = c.createGain(); wet.gain.value = 0.22;
  const rv = reverb(c);
  m.connect(comp); m.connect(rv); rv.connect(wet); wet.connect(comp);
  comp.connect(c.destination);
  const nb = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const d = nb.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return { m, comp, nb };
}

function ensure() {
  if (ac) return ac;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ac = new AC();
  const w = wire(ac);
  master = w.m; noiseBuf = w.nb;
  recDest = ac.createMediaStreamDestination();
  w.comp.connect(recDest);
  return ac;
}

// ── 积木 ──────────────────────────────────────────────────────────
const now = () => ac.currentTime;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** 包络：从静音冲到 peak，再衰减回静音 */
function env(t, attack, peak, decay, to = master) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(to);
  return g;
}
function tone(type, f0, f1, t, dur) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  o.start(t); o.stop(t + dur + 0.05);
  return o;
}
function filter(type, freq, Q = 1) {
  const f = ac.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = Q;
  return f;
}
/** 极短的一下噪声（几毫秒），只用在巴掌的瞬态上 */
function snap(t, freq, peak, decay) {
  const s = ac.createBufferSource();
  s.buffer = noiseBuf;
  s.start(t, Math.random() * 0.5); s.stop(t + decay + 0.02);
  const f = filter('bandpass', freq, 1.4);
  s.connect(f); f.connect(env(t, 0.0008, peak, decay));
}
/** 木琴：基音 + 一个很快消失的高泛音，敲击感就出来了 */
function mallet(midi, t, k = 1, dur = 0.5) {
  const f = hz(midi);
  tone('sine', f, f, t, dur).connect(env(t, 0.002, 0.22 * k, dur));
  tone('sine', f * 4, f * 4, t, 0.1).connect(env(t, 0.001, 0.07 * k, 0.07));
}
/** 铜管：锯齿波过低通，起音稍慢 */
function brass(midi, t, k = 1, dur = 0.5, cutoff = 2400) {
  const f = hz(midi);
  const o = tone('sawtooth', f, f, t, dur);
  const lp = filter('lowpass', cutoff);
  o.connect(lp); lp.connect(env(t, 0.03, 0.11 * k, dur));
}

const PENTA = [0, 2, 4, 7, 9];                       // 五声音阶，怎么叠都不难听
const scale = (root, i) => root + PENTA[((i % 5) + 5) % 5] + 12 * Math.floor(i / 5);

// ── 音效 ──────────────────────────────────────────────────────────
const fx = {
  /** 一巴掌：鼓机拍手那种三连瞬态 + 皮肉的一下 + 低频闷响。k 越大越响 */
  slap(k = 1, t = now()) {
    for (let i = 0; i < 3; i++) snap(t + i * 0.011, 1300, 0.7 * k, 0.012);
    snap(t + 0.033, 1100, 0.55 * k, 0.07);
    tone('sine', 260, 120, t, 0.06).connect(env(t, 0.001, 0.35 * k, 0.06));
    tone('sine', 120, 48, t, 0.14).connect(env(t, 0.002, 0.6 * k, 0.15));
  },
  /** 第一名那一巴掌：大一号 + 管弦乐齐奏"当！" */
  bigSlap(t = now()) {
    fx.slap(1.5, t);
    fx.boom(1, t);
    for (const m of [36, 43, 48, 52, 55, 60]) brass(m, t, 1.4, 0.7, 3200);
  },
  boom(k = 1, t = now()) {
    tone('sine', 100, 34, t, 0.8).connect(env(t, 0.004, 0.9 * k, 0.85));
    tone('triangle', 70, 40, t, 0.4).connect(env(t, 0.004, 0.3 * k, 0.4));
  },
  /** 嗖：一个很快的音高滑动，代替噪声风声 */
  whoosh(up = true, dur = 0.25, k = 0.3, t = now()) {
    tone('triangle', up ? 300 : 1100, up ? 1100 : 300, t, dur).connect(env(t, 0.01, 0.25 * k, dur));
  },
  /** 卡通滑哨：被打飞的那个"咻——" */
  slide(t = now()) {
    const o = tone('sine', 500, 1900, t, 1.1);
    const lfo = ac.createOscillator(), lg = ac.createGain();
    lfo.frequency.value = 7; lg.gain.value = 25;
    lfo.connect(lg); lg.connect(o.frequency); lfo.start(t); lfo.stop(t + 1.15);
    o.connect(env(t, 0.04, 0.22, 1.05));
  },
  ding(t = now()) {
    for (const [f, a] of [[1568, 0.25], [2349, 0.12], [3136, 0.05]]) tone('sine', f, f, t, 1.5).connect(env(t, 0.002, a, 1.4));
  },
  /** 叮叮叮往上走 */
  twinkle(t = now()) {
    [79, 84, 88, 91, 96].forEach((m, i) => mallet(m, t + i * 0.06, 0.8, 0.6));
  },
  /** 定音鼓滚奏，越来越响 */
  drumroll(dur = 2, t = now()) {
    const n = Math.floor(dur * 16);
    for (let i = 0; i < n; i++) {
      const s = t + i / 16, k = 0.15 + 0.6 * (i / n);
      tone('sine', 98, 92, s, 0.12).connect(env(s, 0.002, 0.5 * k, 0.11));
      tone('sine', 147, 140, s, 0.08).connect(env(s, 0.002, 0.18 * k, 0.07));
    }
  },
  /** 欢呼：一串往上走的木琴琶音，k 大就更长更响 */
  cheer(k = 0.5, dur = 1, t = now()) {
    const n = Math.round(4 + k * 6);
    for (let i = 0; i < n; i++) mallet(scale(72, i), t + i * Math.min(0.08, dur / n), 0.6 + k * 0.6, 0.45);
  },
  /** 人浪：两秒里从低到高扫过一整串音 */
  wave(dur = 2, t = now()) {
    const n = 18;
    for (let i = 0; i < n; i++) mallet(scale(60, i), t + (i / n) * dur, 0.55, 0.5);
  },
  fanfare(t = now()) {
    [[67, 0], [72, 0.12], [76, 0.24], [79, 0.36]].forEach(([m, d]) => brass(m, t + d, 1, 0.3));
    for (const m of [72, 76, 79, 84]) brass(m, t + 0.5, 1, 1.1);
  },
  /** 悲伤长号：哇——哇——哇——哇———— */
  sadTrombone(t = now()) {
    [[55, 0.38], [54, 0.38], [53, 0.38], [52, 1.2]].reduce((s, [m, d]) => {
      const f = hz(m);
      const o = tone('sawtooth', f, f * 0.985, s, d);
      if (d > 1) {
        const lfo = ac.createOscillator(), lg = ac.createGain();
        lfo.frequency.value = 6; lg.gain.value = 4;
        lfo.connect(lg); lg.connect(o.frequency); lfo.start(s); lfo.stop(s + d);
      }
      const lp = filter('lowpass', 900);
      o.connect(lp); lp.connect(env(s, 0.04, 0.2, d));
      return s + d * 0.95;
    }, t);
  },
  /** 雕塑升起：低沉的和声慢慢涌上来 */
  rumble(dur = 1.8, t = now()) {
    for (const [f, a] of [[55, 0.35], [82.4, 0.2], [110, 0.1]]) {
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(a, t + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      g.connect(master);
      tone('triangle', f, f, t, dur).connect(g);
    }
  },
  coins(dur = 3, t = now()) {
    for (let s = 0; s < dur; s += 0.06 + Math.random() * 0.09) {
      const f = 2600 + Math.random() * 1600;
      tone('sine', f, f, t + s, 0.2).connect(env(t + s, 0.001, 0.06, 0.15));
      tone('sine', f * 1.5, f * 1.5, t + s, 0.15).connect(env(t + s, 0.001, 0.025, 0.1));
    }
  },
  /** 下雨：稀稀拉拉往下掉的拨弦小调音 */
  rain(dur = 3.5, t = now()) {
    const minor = [0, 3, 5, 7, 10];
    for (let s = 0; s < dur; s += 0.12 + Math.random() * 0.18) {
      const m = 69 + minor[Math.floor(Math.random() * 5)] + 12 * Math.floor(Math.random() * 2);
      mallet(m, t + s, 0.3, 0.25);
    }
  },
  /** 雕塑的反应：牛哞两声（铜管滑音），熊低吼（锯齿波颤音） */
  roar(kind, t = now()) {
    if (kind === 'bull') {
      for (const s of [0, 0.6]) {
        const o = tone('sawtooth', 140, 98, t + s, 0.55);
        const lp = filter('lowpass', 700);
        o.connect(lp); lp.connect(env(t + s, 0.06, 0.28, 0.5));
      }
    } else {
      const o = tone('sawtooth', 92, 68, t, 1.2);
      const lp = filter('lowpass', 520);
      const trem = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain();
      lfo.frequency.value = 22; lg.gain.value = 0.5;
      lfo.connect(lg); lg.connect(trem.gain); lfo.start(t); lfo.stop(t + 1.3);
      o.connect(lp); lp.connect(trem); trem.connect(env(t, 0.12, 0.5, 1.1));
    }
  },
  /** 行情刷新时轻轻一声：大盘涨是大三度，跌是小三度 */
  chime(up = true, t = now()) {
    mallet(84, t, 0.35, 0.6);
    mallet(up ? 88 : 87, t + 0.1, 0.35, 0.8);
  },
  tick(t = now()) { tone('sine', 1900, 1900, t, 0.03).connect(env(t, 0.001, 0.035, 0.025)); },
  pop(t = now()) { tone('sine', 480, 920, t, 0.07).connect(env(t, 0.002, 0.2, 0.08)); },
};

// ── 对外 ──────────────────────────────────────────────────────────
export const sound = {
  get ready() { return !!ac && ac.state === 'running'; },
  get muted() { return muted; },

  /** 在用户点击 / 按键的回调里调用：浏览器只认这种时机 */
  unlock() {
    if (!ensure()) return;
    if (ac.state === 'suspended') ac.resume();
  },

  setMuted(m) {
    muted = m;
    try { localStorage.setItem(KEY, m ? 'off' : 'on'); } catch { /* 存不了就算了 */ }
    if (master) master.gain.setTargetAtTime(m ? 0 : GAIN, ac.currentTime, 0.05);
  },

  /** 播一个音效。没解锁或者静音时什么都不做 */
  play(name, ...args) {
    if (!ac || muted || ac.state !== 'running') return;
    try { fx[name]?.(...args); } catch { /* 音效出错不能影响画面 */ }
  },

  /** 给录视频用的音轨 */
  stream() { return recDest?.stream ?? null; },

  /**
   * 离线把一整条音效时间表渲染成 WAV，逐帧导出视频时配音用（画面和声音严格对齐）。
   * list 跟 show.js 的 cues() 一样：[[秒, 音效名, ...参数], ...]
   */
  async renderWav(list, duration) {
    const sr = 44100;
    const off = new OfflineAudioContext(2, Math.ceil(sr * duration), sr);
    const saved = [ac, master, noiseBuf];
    try {
      ac = off;
      const w = wire(off);
      master = w.m; noiseBuf = w.nb;
      for (const [t, name, ...args] of list) fx[name](...args, t);
    } finally {
      [ac, master, noiseBuf] = saved;
    }
    return wav(await off.startRendering());
  },
};

/** AudioBuffer → 16 位 PCM 的 WAV */
function wav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, bytes = 44 + n * ch * 2;
  const v = new DataView(new ArrayBuffer(bytes));
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) { v.setInt16(o, Math.max(-1, Math.min(1, data[c][i])) * 0x7fff, true); o += 2; }
  }
  return v.buffer;
}
