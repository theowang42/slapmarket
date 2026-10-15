/**
 * 音效。全部用 Web Audio 现场合成，没有音频文件、不用下载任何东西。
 *
 * 浏览器规定页面得先被点一下才能出声，所以第一次点击 / 按键时才真正建 AudioContext。
 * 静音状态记在本地，下次打开还是那样。录视频时把声音一起录进去（stream()）。
 */

const KEY = 'slapmarket:sound';
let ac = null, master = null, recDest = null, noiseBuf = null, murmur = null;
let muted = (() => { try { return localStorage.getItem(KEY) === 'off'; } catch { return false; } })();

const GAIN = 0.7;

/** 压限：巴掌声的瞬态很尖，默认的压缩器反应太慢，峰值会顶破 0 dB */
function limiter(c) {
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 6;
  comp.ratio.value = 16;
  comp.attack.value = 0.001;
  comp.release.value = 0.15;
  return comp;
}

function ensure() {
  if (ac) return ac;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ac = new AC();
  const comp = limiter(ac);                         // 好几个声音叠在一起时别爆音
  master = ac.createGain();
  master.gain.value = muted ? 0 : GAIN;
  master.connect(comp);
  comp.connect(ac.destination);
  recDest = ac.createMediaStreamDestination();
  comp.connect(recDest);
  noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ac;
}

// ── 积木 ──────────────────────────────────────────────────────────
const now = () => ac.currentTime;

/** 包络：从静音冲到 peak，再衰减回静音 */
function env(t, attack, peak, decay) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(master);
  return g;
}
function noise(t, dur) {
  const s = ac.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  return s;
}
function filter(type, freq, Q = 1) {
  const f = ac.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = Q;
  return f;
}
function tone(type, f0, f1, t, dur) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  o.start(t); o.stop(t + dur + 0.05);
  return o;
}
/** 噪声 → 一串滤波器 → 包络 */
function burst(t, filters, attack, peak, decay) {
  let node = noise(t, attack + decay);
  for (const f of filters) { node.connect(f); node = f; }
  node.connect(env(t, attack, peak, decay));
}

// ── 音效 ──────────────────────────────────────────────────────────
const fx = {
  /** 一巴掌：清脆的皮肤声 + 中频的拍击 + 低频的闷响。k 越大越响 */
  slap(k = 1, t = now()) {
    burst(t, [filter('highpass', 2600)], 0.001, 0.9 * k, 0.06);
    burst(t, [filter('bandpass', 950, 1.1)], 0.002, 0.8 * k, 0.15);
    tone('sine', 160, 55, t, 0.14).connect(env(t, 0.002, 0.7 * k, 0.16));
  },
  /** 第一名那一巴掌：大一号，再带个回声 */
  bigSlap(t = now()) {
    fx.slap(1.6, t);
    fx.slap(0.45, t + 0.11);
    fx.boom(1, t);
  },
  boom(k = 1, t = now()) {
    tone('sine', 95, 32, t, 0.8).connect(env(t, 0.005, 0.9 * k, 0.85));
    burst(t, [filter('lowpass', 220)], 0.01, 0.5 * k, 0.5);
  },
  /** 呼——up 是由低到高 */
  whoosh(up = true, dur = 0.55, k = 0.35, t = now()) {
    const f = filter('bandpass', up ? 350 : 2600, 1.8);
    f.frequency.exponentialRampToValueAtTime(up ? 2600 : 300, t + dur);
    burst(t, [f], dur * 0.45, k, dur * 0.55);
  },
  ding(t = now()) {
    for (const [f, a] of [[1568, 0.3], [2349, 0.15], [3136, 0.06]]) tone('sine', f, f, t, 1.5).connect(env(t, 0.002, a, 1.4));
  },
  /** 叮叮叮往上走，变成星星那一下 */
  twinkle(t = now()) {
    [1568, 2093, 2637, 3136].forEach((f, i) => tone('sine', f, f, t + i * 0.07, 0.9).connect(env(t + i * 0.07, 0.002, 0.22, 0.8)));
  },
  drumroll(dur = 2, t = now()) {
    const n = Math.floor(dur * 22);
    for (let i = 0; i < n; i++) burst(t + i / 22, [filter('bandpass', 2200, 0.8)], 0.001, 0.08 + 0.4 * (i / n), 0.045);
  },
  /** 人群欢呼：两段带通噪声做底，叠几个"喔——"的人声 */
  cheer(k = 0.5, dur = 2, t = now()) {
    for (const [fq, q] of [[1100, 0.6], [2400, 0.9]]) {
      const n = noise(t, dur + 0.6);
      const f = filter('bandpass', fq, q);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35 * k, t + 0.3);
      g.gain.setValueAtTime(0.35 * k, t + dur);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.6);
      n.connect(f); f.connect(g); g.connect(master);
    }
    for (let i = 0; i < 6; i++) {
      const s = t + Math.random() * dur * 0.5, f0 = 260 + Math.random() * 260;
      const o = tone('triangle', f0, f0 * 1.6, s, 0.7);
      const lp = filter('lowpass', 1400);
      o.connect(lp); lp.connect(env(s, 0.08, 0.05 * k, 0.6));
    }
  },
  fanfare(t = now()) {
    [392, 523, 659, 784].forEach((f, i) => {
      const o = tone('sawtooth', f, f, t + i * 0.09, 0.6);
      const lp = filter('lowpass', 2400);
      o.connect(lp); lp.connect(env(t + i * 0.09, 0.02, 0.12, 0.55));
    });
    const o = tone('sawtooth', 1047, 1047, t + 0.4, 1.1);
    const lp = filter('lowpass', 2800);
    o.connect(lp); lp.connect(env(t + 0.4, 0.03, 0.14, 1.0));
  },
  /** 悲伤长号：哇——哇——哇——哇———— */
  sadTrombone(t = now()) {
    [[196, 0.38], [185, 0.38], [175, 0.38], [165, 1.1]].reduce((s, [f, d]) => {
      const o = tone('sawtooth', f, f * 0.985, s, d);
      if (d > 1) {            // 最后一个音抖一抖
        const lfo = ac.createOscillator(), lg = ac.createGain();
        lfo.frequency.value = 6; lg.gain.value = 4;
        lfo.connect(lg); lg.connect(o.frequency); lfo.start(s); lfo.stop(s + d);
      }
      const lp = filter('lowpass', 900);
      o.connect(lp); lp.connect(env(s, 0.04, 0.2, d));
      return s + d * 0.95;
    }, t);
  },
  rumble(dur = 1.6, t = now()) { burst(t, [filter('lowpass', 130)], 0.25, 0.7, dur); },
  coins(dur = 3, t = now()) {
    for (let s = 0; s < dur; s += 0.05 + Math.random() * 0.08) {
      const f = 2600 + Math.random() * 1800;
      tone('sine', f, f, t + s, 0.2).connect(env(t + s, 0.001, 0.07, 0.15));
      tone('sine', f * 1.5, f * 1.5, t + s, 0.15).connect(env(t + s, 0.001, 0.03, 0.1));
    }
  },
  rain(dur = 4, t = now()) {
    const n = noise(t, dur + 1);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.6);
    g.gain.setValueAtTime(0.16, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 1);
    const hp = filter('highpass', 1400), lp = filter('lowpass', 7000);
    n.connect(hp); hp.connect(lp); lp.connect(g); g.connect(master);
  },
  /** 雕塑的反应：牛喷两下鼻息，熊低吼 */
  roar(kind, t = now()) {
    if (kind === 'bull') {
      burst(t, [filter('bandpass', 420, 0.7)], 0.04, 0.6, 0.45);
      burst(t + 0.55, [filter('bandpass', 380, 0.7)], 0.04, 0.5, 0.5);
    } else {
      const o = tone('sawtooth', 95, 70, t, 1.2);
      const lp = filter('lowpass', 520);
      const trem = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain();
      lfo.frequency.value = 24; lg.gain.value = 0.5;
      lfo.connect(lg); lg.connect(trem.gain); lfo.start(t); lfo.stop(t + 1.3);
      o.connect(lp); lp.connect(trem); trem.connect(env(t, 0.12, 0.55, 1.1));
      burst(t, [filter('bandpass', 300, 0.8)], 0.1, 0.25, 1.0);
    }
  },
  tick(t = now()) { tone('sine', 1900, 1900, t, 0.04).connect(env(t, 0.001, 0.04, 0.03)); },
  pop(t = now()) { tone('sine', 480, 920, t, 0.07).connect(env(t, 0.002, 0.22, 0.09)); },
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

  /** 常驻的人群低语：很轻，开着页面才有"现场"的感觉 */
  ambient(on) {
    if (!ac) return;
    if (on && !murmur) {
      const n = ac.createBufferSource();
      n.buffer = noiseBuf; n.loop = true;
      const bp = filter('bandpass', 520, 0.8), lp = filter('lowpass', 1300);
      const g = ac.createGain(); g.gain.value = 0.03;
      const lfo = ac.createOscillator(), lg = ac.createGain();
      lfo.frequency.value = 0.27; lg.gain.value = 0.012;
      lfo.connect(lg); lg.connect(g.gain);
      n.connect(bp); bp.connect(lp); lp.connect(g); g.connect(master);
      n.start(); lfo.start();
      murmur = { n, lfo, g };
    } else if (!on && murmur) {
      murmur.g.gain.setTargetAtTime(0, ac.currentTime, 0.2);
      const m = murmur; murmur = null;
      setTimeout(() => { try { m.n.stop(); m.lfo.stop(); } catch { /* 已经停了 */ } }, 800);
    }
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
      const comp = limiter(off);
      master = off.createGain();
      master.gain.value = GAIN;
      master.connect(comp); comp.connect(off.destination);
      noiseBuf = off.createBuffer(1, sr * 2, sr);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
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
