/**
 * STARHERD — W-audio / src/audio/sfx.ts
 *
 * 音效层：
 *   1) 素材播放：`AssetStore.audioBuffer(name)` 拿解码好的 AudioBuffer；
 *      缺失/异常时**绝不抛错**，改用本文件内的程序化兜底音（语义相近），并 console.warn 一次。
 *   2) 循环音管理：`loop(name, key, on)` —— AudioBufferSourceNode(loop=true)，0.15 s 淡出停止，
 *      同 key 幂等；支持外部调制回调（推进器跟随引力井推力实时变速变响）。
 *
 * 兜底合成全部在采样域用纯数学完成（确定性 PRNG），不依赖 ctx 节点图，
 * 因此可以在 Node 里做离线复现，也不会因为解码失败而卡住游戏。
 */

import type { AssetStore } from '../sim/types';
import {
  OnePoleLP,
  OnceWarn,
  SVF,
  VoiceBudget,
  clamp,
  foldLoop,
  hashSeed,
  mulberry32,
  safeDisconnect,
  samplesToBuffer,
  schroederReverb,
} from './synth';

/* ------------------------------------------------------------------ 音效名表（INTERFACES §4 必需素材） */

export const SFX_NAMES = [
  'ui_hover', 'ui_click', 'ui_back',
  'pulse_attract', 'pulse_repel', 'thruster_loop',
  'dock_success', 'dock_fail', 'tidal_tear',
  'impact_rock', 'impact_hull', 'wind_warning',
  'chapter_fanfare', 'blackhole_rumble', 'countdown',
  'ignition', 'launch',
] as const;

export type SfxName = (typeof SFX_NAMES)[number];

/* ------------------------------------------------------------------ 采样域兜底合成 */

type Wave = 'sine' | 'square' | 'saw' | 'triangle';

function waveValue(wave: Wave, ph: number): number {
  const f = ph / (2 * Math.PI);
  const x = f - Math.floor(f);
  switch (wave) {
    case 'sine':
      return Math.sin(ph);
    case 'square':
      return x < 0.5 ? 1 : -1;
    case 'saw':
      return 2 * x - 1;
    case 'triangle':
      return 4 * Math.abs(x - 0.5) - 1;
    default:
      return Math.sin(ph);
  }
}

/** 起音 + 指数衰减包络 */
function edecay(t: number, attack: number, decay: number): number {
  return Math.min(1, t / Math.max(1e-5, attack)) * Math.exp(-t / Math.max(1e-4, decay));
}

/** 起音 + 释放窗口包络（用于固定时长片段） */
function windowEnv(t: number, dur: number, attack: number, release: number): number {
  return Math.min(1, t / Math.max(1e-5, attack)) * Math.min(1, Math.max(0, dur - t) / Math.max(1e-4, release));
}

function normalize(data: Float32Array, peak: number): Float32Array {
  let mx = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > mx) mx = a;
  }
  if (mx > 1e-6) {
    const g = peak / mx;
    for (let i = 0; i < data.length; i++) data[i] *= g;
  }
  return data;
}

/** 采样缓冲构造器：tone/noise 都是"瞬时相位积分"，扫频与 FM 都正确 */
class Buf {
  readonly data: Float32Array;

  constructor(readonly sr: number, seconds: number) {
    this.data = new Float32Array(Math.max(1, Math.round(seconds * sr)));
  }

  get n(): number {
    return this.data.length;
  }

  private add(i: number, v: number): void {
    if (i >= 0 && i < this.data.length) this.data[i] += v;
  }

  /** 振荡器叠加：freq/amp 都是 t 的函数；wave 支持 sine/square/saw/triangle */
  tone(freq: (t: number) => number, amp: (t: number) => number, wave: Wave = 'sine', phase0 = 0): this {
    let ph = phase0;
    const dt = 1 / this.sr;
    for (let i = 0; i < this.data.length; i++) {
      const t = i * dt;
      ph += 2 * Math.PI * freq(t) * dt;
      const a = amp(t);
      if (a !== 0) this.add(i, waveValue(wave, ph) * a);
    }
    return this;
  }

  /** 噪声叠加：可传入采样域滤波器 (x, t) => y（OnePoleLP / SVF 的 process 闭包） */
  noise(amp: (t: number) => number, filt: ((x: number, t: number) => number) | null, rnd: () => number): this {
    const dt = 1 / this.sr;
    for (let i = 0; i < this.data.length; i++) {
      const t = i * dt;
      const a = amp(t);
      if (a === 0) continue;
      const x = rnd() * 2 - 1;
      this.add(i, (filt ? filt(x, t) : x) * a);
    }
    return this;
  }

  /** 阻尼正弦簇（撞击/钟声） */
  cluster(partials: Array<{ f: number; a: number; d: number }>, when: number, gain = 1): this {
    const dt = 1 / this.sr;
    for (const p of partials) {
      let ph = 0;
      for (let i = 0; i < this.data.length; i++) {
        const t = i * dt - when;
        if (t < 0) continue;
        ph += 2 * Math.PI * p.f * dt;
        this.add(i, Math.sin(ph) * p.a * gain * Math.exp(-t / Math.max(1e-3, p.d)));
      }
    }
    return this;
  }

  reverb(mix: number, room = 0.84): this {
    schroederReverb(this.data, this.sr, mix, room);
    return this;
  }

  /** 一次性音收尾：归一化 + 首尾极短淡入淡出防爆音 */
  done(peak = 0.9, fadeSec = 0.002): Float32Array {
    const out = normalize(this.data, peak);
    const n = Math.min(Math.round(fadeSec * this.sr), Math.floor(out.length / 4));
    for (let i = 0; i < n; i++) {
      const w = i / n;
      out[i] *= w;
      out[out.length - 1 - i] *= w;
    }
    return out;
  }

  /** 可循环音收尾：折叠循环点，保证 loop 无缝 */
  doneLoop(loopSeconds: number, fadeSec: number, peak = 0.85): Float32Array {
    const loopLen = Math.max(1, Math.round(loopSeconds * this.sr));
    return normalize(foldLoop(this.data, loopLen, Math.round(fadeSec * this.sr)), peak);
  }
}

/**
 * 生成语义相近的兜底音（纯数学，确定性）。
 * 名字与 DESIGN §6.1 的合成方式一一对应；未知名字退化为"噪声爆 + 正弦 ping"。
 */
export function renderFallbackSamples(name: string, sr: number): Float32Array {
  const rnd = mulberry32(hashSeed('sfx:' + name));

  switch (name) {
    /* ---- UI ---- */
    case 'ui_hover': {
      const b = new Buf(sr, 0.09);
      b.tone(() => 1180, (t) => edecay(t, 0.004, 0.03));
      return b.done(0.34);
    }
    case 'ui_click': {
      const b = new Buf(sr, 0.12);
      b.tone((t) => 980 - 300 * Math.min(1, t / 0.05), (t) => edecay(t, 0.002, 0.045));
      b.noise((t) => 0.5 * edecay(t, 0.0008, 0.01), null, rnd);
      return b.done(0.72);
    }
    case 'ui_back': {
      const b = new Buf(sr, 0.16);
      b.tone((t) => 640 - 260 * Math.min(1, t / 0.12), (t) => edecay(t, 0.005, 0.07), 'triangle');
      return b.done(0.5);
    }

    /* ---- 引力井脉冲：低频正弦扫频 + FM ---- */
    case 'pulse_attract': {
      const b = new Buf(sr, 0.52);
      const fm = (t: number): number => 42 * Math.sin(2 * Math.PI * 6.5 * t) * Math.exp(-t / 0.16);
      b.tone((t) => 68 + 150 * Math.min(1, t / 0.34) + fm(t), (t) => edecay(t, 0.012, 0.26));
      const lp = new OnePoleLP(sr, 420);
      b.noise((t) => 0.18 * edecay(t, 0.02, 0.2), (x) => lp.process(x), rnd);
      return b.done(0.86);
    }
    case 'pulse_repel': {
      const b = new Buf(sr, 0.52);
      const fm = (t: number): number => 36 * Math.sin(2 * Math.PI * 5.0 * t) * Math.exp(-t / 0.14);
      b.tone((t) => 218 - 150 * Math.min(1, t / 0.3) + fm(t), (t) => edecay(t, 0.008, 0.24));
      b.tone((t) => 110 - 40 * Math.min(1, t / 0.3), (t) => 0.3 * edecay(t, 0.01, 0.18), 'square');
      return b.done(0.9);
    }

    /* ---- 推进器循环：白噪 + 单极低通 + 带通共振（可无缝循环） ---- */
    case 'thruster_loop': {
      const loopSec = 1.5;
      const b = new Buf(sr, loopSec + 0.08);
      const lp = new OnePoleLP(sr, 720);
      const svf = new SVF(sr, 235, 3.4);
      const wob = new OnePoleLP(sr, 6);
      b.noise(
        (t) => {
          const w = 0.72 + 0.28 * wob.process(rnd() * 2 - 1) * 3;
          return 0.34 * clamp(w, 0.35, 1.2) + 0.12 * Math.sin(2 * Math.PI * 0.7 * t) * 0.5;
        },
        (x) => {
          const low = lp.process(x);
          svf.process(x - low * 0.5);
          return low + svf.bp * 1.6;
        },
        rnd,
      );
      b.tone(() => 62, () => 0.16); // 低频体感
      b.tone(() => 1680, () => 0.012); // 高频嘶声压低，避免推进器盖过配乐
      return b.doneLoop(loopSec, 0.08, 0.72);
    }

    /* ---- 对接成功：加法合成钟声（非谐泛音列）+ 混响尾 ---- */
    case 'dock_success': {
      const b = new Buf(sr, 1.9);
      const f0 = 523.25;
      b.cluster(
        [
          { f: f0 * 1.0, a: 1.0, d: 1.1 },
          { f: f0 * 2.76, a: 0.5, d: 0.7 },
          { f: f0 * 5.4, a: 0.28, d: 0.42 },
          { f: f0 * 8.93, a: 0.14, d: 0.26 },
        ],
        0,
      );
      b.reverb(0.26);
      return b.done(0.82);
    }
    /* ---- 对接失败：下扫方波 + 软失真 ---- */
    case 'dock_fail': {
      const b = new Buf(sr, 0.85);
      b.tone((t) => 330 - 245 * Math.min(1, t / 0.55), (t) => edecay(t, 0.006, 0.3), 'square');
      b.tone((t) => 165 - 100 * Math.min(1, t / 0.5), (t) => 0.5 * edecay(t, 0.006, 0.26), 'saw');
      for (let i = 0; i < b.n; i++) b.data[i] = Math.tanh(b.data[i] * 1.8) * 0.72;
      return b.done(0.9);
    }
    /* ---- 潮汐撕裂：噪声爆发 + 下扫 + 颗粒化 ---- */
    case 'tidal_tear': {
      const b = new Buf(sr, 1.25);
      const svf = new SVF(sr, 2200, 1.6);
      let gate = 1;
      let gatePh = 0;
      b.noise(
        (t) => 0.55 * edecay(t, 0.01, 0.42),
        (x, t) => {
          gatePh += 68 / sr;
          if (gatePh >= 1) {
            gatePh -= 1;
            gate = rnd() < 0.62 ? 1 : 0.12;
          }
          svf.setCutoff(2400 * Math.exp(-1.9 * t) + 160); // 带通中心下扫
          svf.process(x);
          return svf.lp * gate;
        },
        rnd,
      );
      b.tone((t) => 420 * Math.exp(-2.2 * t) + 55, (t) => 0.4 * edecay(t, 0.008, 0.3), 'saw');
      return b.done(0.95);
    }

    /* ---- 撞击 ---- */
    case 'impact_rock': {
      const b = new Buf(sr, 0.6);
      const lp = new OnePoleLP(sr, 720);
      b.noise((t) => 0.7 * edecay(t, 0.001, 0.09), (x) => lp.process(x), rnd);
      b.cluster(
        [
          { f: 108, a: 0.9, d: 0.2 },
          { f: 167, a: 0.55, d: 0.13 },
          { f: 243, a: 0.3, d: 0.08 },
        ],
        0,
      );
      return b.done(0.95);
    }
    case 'impact_hull': {
      const b = new Buf(sr, 0.85);
      const lp = new OnePoleLP(sr, 2600);
      b.noise((t) => 0.5 * edecay(t, 0.001, 0.07), (x) => x - lp.process(x), rnd);
      b.cluster(
        [
          { f: 322, a: 0.9, d: 0.32 },
          { f: 587, a: 0.6, d: 0.24 },
          { f: 941, a: 0.38, d: 0.16 },
          { f: 1397, a: 0.22, d: 0.1 },
        ],
        0,
      );
      return b.done(0.92);
    }

    /* ---- 星风警报：三连警笛（时长比 3:5:3） ---- */
    case 'wind_warning': {
      const b = new Buf(sr, 0.95);
      const unit = 0.04; // 3:5:3 → 0.12 / 0.20 / 0.12 s
      const seq: Array<{ at: number; dur: number }> = [
        { at: 0.0, dur: 3 * unit },
        { at: 0.19, dur: 5 * unit },
        { at: 0.46, dur: 3 * unit },
      ];
      for (const s of seq) {
        b.tone(
          (t) => {
            const u = t - s.at;
            if (u < 0 || u > s.dur) return 0;
            return 760 * (1 + 0.05 * Math.sin(2 * Math.PI * 9 * u));
          },
          (t) => {
            const u = t - s.at;
            if (u < 0 || u > s.dur) return 0;
            return 0.55 * windowEnv(u, s.dur, 0.008, 0.03);
          },
          'triangle',
        );
      }
      return b.done(0.85);
    }

    /* ---- 章节号角：大三和弦琶音 + Schroeder 混响尾 ---- */
    case 'chapter_fanfare': {
      const b = new Buf(sr, 2.6);
      const seq = [523.25, 659.25, 783.99, 1046.5];
      seq.forEach((f, i) => {
        b.cluster(
          [
            { f, a: 1.0, d: 1.0 },
            { f: f * 2, a: 0.4, d: 0.6 },
            { f: f * 3, a: 0.18, d: 0.35 },
          ],
          i * 0.14,
          0.7,
        );
      });
      b.cluster([{ f: 130.81, a: 1.0, d: 1.4 }], 0.56, 0.8); // 低音铺底
      b.reverb(0.3);
      return b.done(0.9);
    }

    /* ---- 黑洞低鸣：次低频 + 缓慢相位漂移（可循环，整数周期避免接缝） ---- */
    case 'blackhole_rumble': {
      const loopSec = 3.0;
      const b = new Buf(sr, loopSec + 0.1);
      // 28 / 35 / 42 Hz 在 3.0 s 内正好是 84 / 105 / 126 个整周期
      b.tone((t) => 28 * (1 + 0.004 * Math.sin(2 * Math.PI * t / 3)), () => 1.0);
      b.tone((t) => 35 * (1 + 0.006 * Math.cos(2 * Math.PI * t / 1.5)), () => 0.62);
      b.tone(() => 42, (t) => 0.4 * (0.8 + 0.2 * Math.sin((2 * Math.PI * t) / 3)));
      const lp = new OnePoleLP(sr, 62);
      b.noise(() => 0.3, (x) => lp.process(x), rnd);
      return b.doneLoop(loopSec, 0.1, 0.9);
    }

    /* ---- 倒计时 / 点火 / 发射 ---- */
    case 'countdown': {
      const b = new Buf(sr, 1.0);
      for (const at of [0, 0.3, 0.6]) {
        b.tone((t) => (t < at ? 0 : 1250), (t) => (t < at ? 0 : 0.5 * edecay(t - at, 0.001, 0.035)), 'square');
        b.tone((t) => (t < at ? 0 : 120), (t) => (t < at ? 0 : 0.35 * edecay(t - at, 0.002, 0.09)));
      }
      return b.done(0.85);
    }
    case 'ignition': {
      const b = new Buf(sr, 1.7);
      const lp = new OnePoleLP(sr, 180);
      b.noise(
        (t) => 0.5 * Math.min(1, t / 1.05) * windowEnv(t, 1.25, 0.02, 0.25),
        (x, t) => {
          lp.setCutoff(180 * Math.pow(28, Math.min(1, t / 1.05))); // 低通缓慢打开 = 上升感
          return lp.process(x);
        },
        rnd,
      );
      b.cluster([{ f: 92, a: 1.0, d: 0.45 }], 1.05, 0.9);
      b.tone(
        (t) => (t < 1.05 ? 0 : 92 - 48 * Math.min(1, (t - 1.05) / 0.4)),
        (t) => (t < 1.05 ? 0 : edecay(t - 1.05, 0.004, 0.3)),
      );
      return b.done(0.92);
    }
    case 'launch': {
      const b = new Buf(sr, 2.7);
      const lp = new OnePoleLP(sr, 200);
      b.noise(
        (t) => 0.45 * Math.min(1, t / 1.6) * windowEnv(t, 2.4, 0.05, 0.5),
        (x, t) => {
          lp.setCutoff(200 * Math.pow(30, Math.min(1, t / 1.8)));
          return lp.process(x);
        },
        rnd,
      );
      b.tone((t) => 40 + 34 * Math.min(1, t / 1.8), (t) => 0.75 * Math.min(1, t / 1.4) * windowEnv(t, 2.5, 0.1, 0.6));
      b.cluster([{ f: 70, a: 1.0, d: 0.7 }], 1.85, 0.9);
      b.tone(
        (t) => (t < 1.85 ? 0 : 70 - 34 * Math.min(1, (t - 1.85) / 0.5)),
        (t) => (t < 1.85 ? 0 : edecay(t - 1.85, 0.004, 0.45)),
      );
      return b.done(0.95);
    }

    /* ---- 未知名字：噪声爆 + 正弦 ping ---- */
    default: {
      const b = new Buf(sr, 0.4);
      const lp = new OnePoleLP(sr, 1600);
      b.noise((t) => 0.4 * edecay(t, 0.001, 0.05), (x) => lp.process(x), rnd);
      b.tone(() => 880, (t) => 0.5 * edecay(t, 0.004, 0.16));
      return b.done(0.8);
    }
  }
}

/* ------------------------------------------------------------------ 播放器 */

export interface PlayOptions {
  gain?: number;
  rate?: number;
  pan?: number;
  detune?: number;
}

export interface LoopOptions {
  gain?: number;
  rate?: number;
}

/** 循环音调制系数：由引擎按实时参数（wellThrust/wellMass）提供 */
export interface LoopModulation {
  gainScale: number;
  rateScale: number;
}

interface LoopVoice {
  name: string;
  key: string;
  src: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  baseGain: number;
  baseRate: number;
  lease: number;
  stopping: boolean;
}

const LOOP_FADE = 0.15; // 循环音关闭淡出（契约值）

export class SfxPlayer {
  private readonly fallbacks = new Map<string, AudioBuffer>();
  private readonly loops = new Map<string, LoopVoice>();
  private disposed = false;

  /** 因预算耗尽被丢弃的一次性音数（诊断用） */
  dropped = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly dest: AudioNode,
    private readonly budget: VoiceBudget,
    private readonly assets: AssetStore,
    private readonly warn: OnceWarn,
    private readonly modulate?: (name: string) => LoopModulation | null,
  ) {}

  get loopCount(): number {
    return this.loops.size;
  }

  /** 取素材缓冲；缺失则程序化兜底（每个名字只警告一次） */
  bufferFor(name: string): AudioBuffer | null {
    if (this.disposed) return null;
    let buf: AudioBuffer | undefined;
    try {
      buf = this.assets.audioBuffer(name);
    } catch {
      buf = undefined;
    }
    if (buf && buf.length > 0) return buf;

    const cached = this.fallbacks.get(name);
    if (cached) return cached;

    this.warn.fire(
      'sfx-missing:' + name,
      `[audio] 素材缺失或未解码："${name}"，改用内置程序化兜底音（游戏不中断）`,
    );
    try {
      const data = renderFallbackSamples(name, this.ctx.sampleRate);
      const made = samplesToBuffer(this.ctx, data);
      if (this.fallbacks.size > 32) this.fallbacks.clear();
      this.fallbacks.set(name, made);
      return made;
    } catch (err) {
      this.warn.fire('sfx-fallback-fail', `[audio] 兜底音合成失败：${String(err)}`);
      return null;
    }
  }

  /** 一次性音效 */
  play(name: string, opts?: PlayOptions): void {
    if (this.disposed) return;
    const buf = this.bufferFor(name);
    if (!buf) return;

    const rate = clamp(opts?.rate ?? 1, 0.05, 8);
    const gain = clamp(opts?.gain ?? 1, 0, 4);
    const pan = clamp(opts?.pan ?? 0, -1, 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    try {
      src.detune.value = clamp(opts?.detune ?? 0, -4800, 4800);
    } catch {
      /* 极老实现无 detune：忽略 */
    }
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g);
    g.connect(p);
    p.connect(this.dest);

    const now = this.ctx.currentTime;
    const stopAt = now + buf.duration / rate + 0.02;
    const id = this.budget.reserve(1, stopAt, () => {
      safeDisconnect(src);
      safeDisconnect(g);
      safeDisconnect(p);
    });
    if (!id) {
      // 预算耗尽：丢弃比爆音好
      this.dropped++;
      safeDisconnect(src);
      safeDisconnect(g);
      safeDisconnect(p);
      return;
    }
    src.onended = () => this.budget.finish(id);
    try {
      src.start(now);
      src.stop(stopAt);
    } catch {
      this.budget.finish(id);
    }
  }

  /**
   * 循环音（幂等）：同一 key 重复 on=true 只更新参数；on=false 时 0.15 s 淡出并 stop。
   * key 由调用方定义，例如 'thruster' / 'wind' / `pad_${id}`。
   */
  loop(name: string, key: string, on: boolean, opts?: LoopOptions): void {
    if (this.disposed) return;
    const cur = this.loops.get(key);

    if (!on) {
      if (!cur || cur.stopping) return; // 幂等：重复关闭无副作用
      this.stopVoice(cur, LOOP_FADE);
      return;
    }

    const gain = clamp(opts?.gain ?? 1, 0, 4);
    const rate = clamp(opts?.rate ?? 1, 0.05, 8);

    if (cur && !cur.stopping) {
      if (cur.name === name) {
        cur.baseGain = gain;
        cur.baseRate = rate;
        this.applyModulation(cur, 0.05);
        return; // 幂等：同 key 同素材 → 只更新增益/速率
      }
      this.stopVoice(cur, 0.06); // 同 key 换素材：旧的快速淡出
    }

    const buf = this.bufferFor(name);
    if (!buf) return;
    this.startVoice(name, key, buf, gain, rate);
  }

  /** 参数变化后重新施加循环音调制（推进器核心听感：推力越大越响越快） */
  remodulate(name: string): void {
    for (const v of this.loops.values()) {
      if (v.name === name && !v.stopping) this.applyModulation(v, 0.06);
    }
  }

  /** 全部循环音淡出停止（dispose / 暂停时用） */
  stopAll(fadeSec = 0.12): void {
    for (const v of Array.from(this.loops.values())) this.stopVoice(v, fadeSec);
  }

  dispose(): void {
    this.stopAll(0.02);
    this.disposed = true;
    this.fallbacks.clear();
  }

  /* ---------------- 内部 ---------------- */

  private startVoice(name: string, key: string, buf: AudioBuffer, gain: number, rate: number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    const p = this.ctx.createStereoPanner();
    src.connect(g);
    g.connect(p);
    p.connect(this.dest);

    const id = this.budget.reserve(1, Number.POSITIVE_INFINITY, () => {
      safeDisconnect(src);
      safeDisconnect(g);
      safeDisconnect(p);
    });
    if (!id) {
      safeDisconnect(src);
      safeDisconnect(g);
      safeDisconnect(p);
      return;
    }

    const voice: LoopVoice = {
      name, key, src, gain: g, pan: p,
      baseGain: gain, baseRate: rate, lease: id, stopping: false,
    };
    const mod = this.modulate?.(name) ?? null;
    const now = this.ctx.currentTime;
    g.gain.value = 0.0001;
    g.gain.setTargetAtTime(clamp(gain * (mod ? mod.gainScale : 1), 0.0001, 4), now, 0.03);
    src.playbackRate.value = clamp(rate * (mod ? mod.rateScale : 1), 0.05, 8);
    src.onended = () => this.budget.finish(id);
    this.loops.set(key, voice);

    try {
      src.start(now);
    } catch {
      this.loops.delete(key);
      this.budget.finish(id);
    }
  }

  private applyModulation(v: LoopVoice, tau: number): void {
    const mod = this.modulate?.(v.name) ?? null;
    const targetGain = clamp(v.baseGain * (mod ? mod.gainScale : 1), 0.0001, 4);
    const targetRate = clamp(v.baseRate * (mod ? mod.rateScale : 1), 0.05, 8);
    const now = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setTargetAtTime(targetGain, now, tau);
    v.src.playbackRate.cancelScheduledValues(now);
    v.src.playbackRate.setTargetAtTime(targetRate, now, tau);
  }

  private stopVoice(v: LoopVoice, fadeSec: number): void {
    v.stopping = true;
    this.loops.delete(v.key);
    const now = this.ctx.currentTime;
    const fade = Math.max(0.01, fadeSec);
    const g = v.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.linearRampToValueAtTime(0.0001, now + fade);
    const stopAt = now + fade + 0.02;
    this.budget.touch(v.lease, stopAt);
    this.budget.sweep(now);
    try {
      v.src.stop(stopAt);
    } catch {
      this.budget.finish(v.lease);
    }
  }
}
