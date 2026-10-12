/**
 * STARHERD — W-audio / src/audio/synth.ts
 *
 * 合成原语层：只放"与游戏语义无关"的积木，供 sfx.ts / music.ts / audio.ts 复用。
 *   · 数学换算（midi→Hz、dB→线性、cents、确定性 PRNG）
 *   · 采样域滤波器（单极低通 / Chamberlin 状态变量滤波器）
 *   · 缓冲区工具（Float32 → AudioBuffer、无缝循环折叠、Schroeder 混响）
 *   · AudioParam 包络（打击型 / 持续型 / 等功率交叉淡化曲线）
 *   · 振荡器预算 VoiceBudget（全局 ≤ VOICE_CAP 个活跃振荡器，onended + 兜底扫描双保险）
 *
 * 约束：纯 WebAudio API，无第三方库；本文件**没有任何模块级副作用**、不触碰 document/window，
 * 因此可以被 Node 直接 import 做离线数学校验（见自验脚本）。
 */

/** 同时活跃振荡器上限（音频线程 CPU 保护），所有声部共用一份预算 */
export const VOICE_CAP = 64;

/* ------------------------------------------------------------------ 数学 */

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** MIDI 音高 → 频率（A4 = 69 = 440 Hz，十二平均律） */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** mulberry32：确定性 PRNG（兜底素材每次生成结果一致，便于复现与自验） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串 → 32bit 种子（给程序化乐谱/兜底音色做稳定变化） */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function safeDisconnect(node: AudioNode | null | undefined): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    /* 已断开或节点已销毁：忽略 */
  }
}

/* ------------------------------------------------------------------ 采样域滤波器 */

/** 单极低通（用于兜底素材的噪声塑形） */
export class OnePoleLP {
  private y = 0;
  private a = 1;

  constructor(private sr: number, hz: number) {
    this.setCutoff(hz);
  }

  setCutoff(hz: number): void {
    this.a = 1 - Math.exp((-2 * Math.PI * clamp(hz, 1, this.sr * 0.45)) / this.sr);
  }

  process(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

/** Chamberlin 状态变量滤波器：同时给出 lp/bp/hp（共振由 q 控制） */
export class SVF {
  lp = 0;
  bp = 0;
  hp = 0;
  private f = 0.1;
  private q = 1;

  constructor(private sr: number, cutoff: number, q = 0.7) {
    this.setCutoff(cutoff);
    this.setQ(q);
  }

  setCutoff(hz: number): void {
    this.f = 2 * Math.sin((Math.PI * clamp(hz, 5, this.sr * 0.45)) / this.sr);
  }

  setQ(q: number): void {
    this.q = 1 / Math.max(0.05, q);
  }

  /** 处理一个样本；结果放在 lp/bp/hp 字段（不分配对象） */
  process(x: number): void {
    this.hp = x - this.lp - this.q * this.bp;
    this.bp += this.f * this.hp;
    this.lp += this.f * this.bp;
  }
}

/* ------------------------------------------------------------------ 缓冲区工具 */

export function samplesToBuffer(ctx: BaseAudioContext, data: Float32Array): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.max(1, data.length), ctx.sampleRate);
  buf.copyToChannel(data, 0);
  return buf;
}

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

/** 共享白噪声缓冲（2 s / 单声道）；所有噪声类声部复用它，避免反复分配 */
export function getNoiseBuffer(ctx: BaseAudioContext, seconds = 2, seed = 0x9e3779b9): AudioBuffer {
  const hit = noiseCache.get(ctx);
  if (hit) return hit;
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(seconds * sr));
  const data = new Float32Array(n);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) data[i] = rnd() * 2 - 1;
  const buf = samplesToBuffer(ctx, data);
  noiseCache.set(ctx, buf);
  return buf;
}

/**
 * 无缝循环折叠：把 gen[loopLen .. loopLen+n) 这段"循环点之后的自然延续"
 * 与开头 n 个样本交叉淡化后折回头部，使 out[loopLen-1] → out[0] 连续。
 * 返回长度为 loopLen 的新数组（gen 需至少 loopLen + n 个样本）。
 */
export function foldLoop(gen: Float32Array, loopLen: number, fadeSamples: number): Float32Array {
  const len = Math.max(1, Math.min(loopLen, gen.length));
  const n = Math.max(0, Math.min(fadeSamples, Math.floor(len / 4), gen.length - len));
  const out = gen.slice(0, len);
  for (let i = 0; i < n; i++) {
    const w = i / n;
    out[i] = gen[i] * w + gen[len + i] * (1 - w);
  }
  return out;
}

/**
 * Schroeder/Freeverb 简化混响（单声道原地处理）：4 梳状 + 2 全通，延迟按 44.1 kHz 调音缩放。
 * 仅用于兜底的 fanfare / 钟声尾巴，运行时混响由素材自带。
 */
export function schroederReverb(data: Float32Array, sr: number, mix = 0.28, roomSize = 0.84): void {
  const scale = sr / 44100;
  const combLen = [1116, 1188, 1277, 1356].map((s) => Math.max(1, Math.round(s * scale)));
  const apLen = [556, 441].map((s) => Math.max(1, Math.round(s * scale)));
  const combs = combLen.map((n) => ({ buf: new Float32Array(n), i: 0, damp: 0 }));
  const aps = apLen.map((n) => ({ buf: new Float32Array(n), i: 0 }));
  const damp = 0.22;
  const wet = new Float32Array(data.length);

  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    let acc = 0;
    for (let c = 0; c < combs.length; c++) {
      const cb = combs[c];
      const y = cb.buf[cb.i];
      cb.damp = y * (1 - damp) + cb.damp * damp;
      cb.buf[cb.i] = x + cb.damp * roomSize;
      cb.i = (cb.i + 1) % cb.buf.length;
      acc += y;
    }
    acc /= combs.length;
    for (let a = 0; a < aps.length; a++) {
      const ap = aps[a];
      const y = ap.buf[ap.i];
      ap.buf[ap.i] = acc + y * 0.5;
      ap.i = (ap.i + 1) % ap.buf.length;
      acc = y - acc;
    }
    wet[i] = acc;
  }

  const w = clamp(mix, 0, 1);
  for (let i = 0; i < data.length; i++) data[i] = data[i] * (1 - w) + wet[i] * w;
}

/* ------------------------------------------------------------------ AudioParam 包络 */

/** 打击型包络：快速起音 + 指数衰减（返回结束时间） */
export function envPerc(
  p: AudioParam,
  when: number,
  peak: number,
  attack: number,
  decay: number,
  floor = 0.0001,
): number {
  const a = Math.max(0.0005, attack);
  const d = Math.max(0.005, decay);
  p.cancelScheduledValues(when);
  p.setValueAtTime(floor, when);
  p.linearRampToValueAtTime(Math.max(floor, peak), when + a);
  p.exponentialRampToValueAtTime(floor, when + a + d);
  return when + a + d;
}

/** 持续型包络：起音 → 保持 → 线性释放（返回释放结束时间） */
export function envSustain(
  p: AudioParam,
  when: number,
  dur: number,
  peak: number,
  attack: number,
  release: number,
  floor = 0.0001,
): number {
  const a = Math.max(0.001, attack);
  const r = Math.max(0.01, release);
  const hold = Math.max(when + a, when + dur);
  p.cancelScheduledValues(when);
  p.setValueAtTime(floor, when);
  p.linearRampToValueAtTime(Math.max(floor, peak), when + a);
  p.setValueAtTime(Math.max(floor, peak), hold);
  p.linearRampToValueAtTime(floor, hold + r);
  return hold + r;
}

/**
 * 等功率淡化曲线：value(t) = √((1−t)·from² + t·to²)。
 * 两条互补曲线（1→0 与 0→1）的平方和为常数 1，因此交叉淡化过程中总能量不塌陷。
 */
export function equalPowerCurve(from: number, to: number, n = 33): Float32Array {
  const count = Math.max(2, n | 0);
  const out = new Float32Array(count);
  const a = Math.max(0, from);
  const b = Math.max(0, to);
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    out[i] = Math.sqrt((1 - t) * a * a + t * b * b);
  }
  return out;
}

/* ------------------------------------------------------------------ 振荡器预算 */

interface Lease {
  n: number;
  releaseAt: number;
  cleanup: () => void;
}

/**
 * 全局振荡器预算：任何"会持续发声"的节点组在创建前 reserve，释放时 release。
 * 释放路径有两条：source.onended（正常）与 sweep(now)（兜底，防止 onended 未触发导致预算泄漏）。
 * finish() 幂等，两条路径都可安全调用。
 */
export class VoiceBudget {
  private used = 0;
  private seq = 0;
  private readonly leases = new Map<number, Lease>();

  constructor(readonly cap: number = VOICE_CAP) {}

  get active(): number {
    return this.used;
  }

  get count(): number {
    return this.leases.size;
  }

  available(): number {
    return Math.max(0, this.cap - this.used);
  }

  /** 申请 n 个振荡器槽位；失败返回 0（调用方降级或丢弃该声部） */
  reserve(n: number, releaseAt: number, cleanup: () => void): number {
    if (n <= 0 || this.used + n > this.cap) return 0;
    const id = ++this.seq;
    this.used += n;
    this.leases.set(id, { n, releaseAt, cleanup });
    return id;
  }

  /** 更新预计释放时间（循环音停止时把兜底扫描时间提前） */
  touch(id: number, releaseAt: number): void {
    const l = this.leases.get(id);
    if (l) l.releaseAt = releaseAt;
  }

  release(id: number): void {
    const l = this.leases.get(id);
    if (!l) return;
    this.leases.delete(id);
    this.used -= l.n;
    if (this.used < 0) this.used = 0;
  }

  /** 释放槽位并断开节点（幂等） */
  finish(id: number): void {
    const l = this.leases.get(id);
    if (!l) return;
    this.release(id);
    try {
      l.cleanup();
    } catch {
      /* 节点可能已断开 */
    }
  }

  /** 兜底扫描：超过预计释放时间 2 s 仍未回收的租约强制回收 */
  sweep(now: number): void {
    let dead: number[] | null = null;
    for (const [id, l] of this.leases) {
      if (now > l.releaseAt + 2) (dead ??= []).push(id);
    }
    if (!dead) return;
    for (const id of dead) this.finish(id);
  }

  /** 全量回收（dispose / 暂停时用） */
  forceAll(): void {
    for (const id of Array.from(this.leases.keys())) this.finish(id);
  }
}

/* ------------------------------------------------------------------ 一次警告 */

/** 同名问题只警告一次，避免缺素材时刷爆控制台 */
export class OnceWarn {
  private readonly seen = new Set<string>();

  constructor(private readonly sink: (msg: string) => void = (m) => console.warn(m)) {}

  fire(key: string, msg: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.sink(msg);
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  clear(): void {
    this.seen.clear();
  }
}
