/**
 * STARHERD — W-audio / src/audio/music.ts
 *
 * 自适应配乐引擎（生成式演奏 Python 生成的谱面 JSON，见 INTERFACES §5）：
 *
 *   · 前瞻调度器：setInterval 25 ms，向前调度 0.25 s 内的音符。
 *     **唯一时间基准是 audioCtx.currentTime**；所有音符的绝对发声时刻 = anchor + cycle·loopDur + t·spb，
 *     与"何时调用调度"完全解耦，因此定时器抖动/丢拍都不会累积漂移（见自验 4 的数学模拟）。
 *   · 无缝循环：一首播完 cycle++，不重建任何节点，下一次循环的第一个音与上一次严格相隔 loopDur。
 *   · 声部合成：pad / bass / arp / perc / lead，按 note.track 分发。
 *   · 强度门限：只播放 note.intensity <= 当前强度 + 0.08（迟滞余量），并按声部做施密特迟滞开关，
 *     避免强度在门限附近抖动时声部闪烁。
 *   · setMusic 切换：1.2 s 等功率交叉淡化（两个 TrackPlayer 槽位，节点不重建）。
 *   · 谱面缺失/异常 → 退化为代码内生成的和声进行（A 小调 i-VI-III-VII 等 5 套，按曲名哈希选取），
 *     保证"永远有音乐"。
 *   · 参数层：slowmo（轻微失谐 + 引擎侧低通）、alert（高频紧张脉冲层）、fuel（低于 25% 的心跳）。
 *
 * 本文件无模块级副作用，可被 Node 直接 import 做离线校验。
 */

import type { MusicNote, MusicScore, MusicSection } from '../sim/types';
import {
  OnceWarn,
  VoiceBudget,
  clamp,
  envPerc,
  envSustain,
  equalPowerCurve,
  getNoiseBuffer,
  hashSeed,
  lerp,
  midiToFreq,
  mulberry32,
  safeDisconnect,
} from './synth';

/* ------------------------------------------------------------------ 常量（契约值） */

/** 调度器检查周期（DESIGN §4.5：25 ms 前瞻） */
export const TICK_MS = 25;
/** 前瞻窗口：向前调度 0.25 s 内的音符 */
export const LOOKAHEAD = 0.25;
/** setMusic 交叉淡化时长 */
export const XFADE_SEC = 1.2;
/** 强度门限迟滞余量：note.intensity <= 当前强度 + 该值 */
export const NOTE_GATE_SLACK = 0.08;
/** 声部开关迟滞（施密特触发）带宽 */
const TRACK_HYST = 0.12;

export const TRACKS = ['pad', 'bass', 'arp', 'perc', 'lead'] as const;
export type MusicTrack = (typeof TRACKS)[number];

/** 各声部的"开启"阈值（关闭阈值 = 开启 − TRACK_HYST） */
export const TRACK_ON: Record<MusicTrack, number> = {
  pad: 0.0,
  bass: 0.05,
  arp: 0.3,
  perc: 0.15,
  lead: 0.7,
};

/* ------------------------------------------------------------------ 调式工具 */

const KEY_PC: Record<string, number> = {
  c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, fb: 4, 'e#': 5, f: 5,
  'f#': 6, gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11, cb: 11,
};

/** 调名 → 音级（0..11）；无法识别时按 A(9) 处理 */
export function keyToPc(key: string): number {
  const k = String(key ?? '').trim().toLowerCase();
  return KEY_PC[k] ?? 9;
}

/** 由调式音阶取五声音阶音级集合（音阶的 1 2 3 5 6 级）——lead 只走这些音 */
export function pentatonicSet(key: string, scale: number[]): number[] {
  const root = keyToPc(key);
  const deg = [0, 1, 2, 4, 5];
  const set = new Set<number>();
  for (const d of deg) {
    const step = scale.length ? scale[d % scale.length] : 0;
    set.add((((root + step) % 12) + 12) % 12);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/** 最接近 center、音级为 pc 的 MIDI 音（限制在 12..108） */
export function pitchNear(pc: number, center: number): number {
  const p = ((Math.round(pc) % 12) + 12) % 12;
  const base = Math.floor(center / 12) * 12 + p;
  let best = base;
  let bestD = Math.abs(base - center);
  for (const cand of [base - 12, base + 12]) {
    const d = Math.abs(cand - center);
    if (d < bestD) {
      best = cand;
      bestD = d;
    }
  }
  return clamp(best, 12, 108);
}

/** 把音高吸附到五声音阶（保持八度最近） */
export function snapToPentatonic(midi: number, pcs: number[]): number {
  if (!pcs.length) return clamp(Math.round(midi), 12, 108);
  let best = Math.round(midi);
  let bestD = Number.POSITIVE_INFINITY;
  for (const pc of pcs) {
    for (const cand of [pitchNear(pc, midi) - 12, pitchNear(pc, midi), pitchNear(pc, midi) + 12]) {
      const d = Math.abs(cand - midi);
      if (d < bestD) {
        best = cand;
        bestD = d;
      }
    }
  }
  return clamp(best, 12, 108);
}

/* ------------------------------------------------------------------ 谱面校验 / 退化乐谱 */

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/**
 * 防御式校验外部谱面：剔除非法音符、补齐缺省字段；连一个合法音符都没有 → 返回 null（调用方退化）。
 * 主 Agent / W-assets 的 JSON 只要大体符合 schema 就能通过，坏字段被静默修正而不是让引擎挂掉。
 */
export function normalizeScore(raw: unknown): MusicScore | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const bpm = num(r.bpm, 0);
  if (!(bpm >= 20 && bpm <= 320)) return null;
  const bpb = Math.round(num(r.beats_per_bar, 4));
  if (!(bpb >= 1 && bpb <= 16)) return null;

  const src = Array.isArray(r.notes) ? (r.notes as unknown[]) : [];
  const notes: MusicNote[] = [];
  for (const item of src) {
    if (!item || typeof item !== 'object') continue;
    const n = item as Record<string, unknown>;
    const t = num(n.t, Number.NaN);
    const dur = num(n.dur, Number.NaN);
    const midi = num(n.midi, Number.NaN);
    const track = n.track;
    if (!Number.isFinite(t) || t < 0) continue;
    if (!Number.isFinite(dur) || dur <= 0) continue;
    if (!Number.isFinite(midi)) continue;
    if (typeof track !== 'string' || !(TRACKS as readonly string[]).includes(track)) continue;
    notes.push({
      t,
      dur,
      midi: clamp(Math.round(midi), 0, 127),
      vel: clamp(num(n.vel, 0.8), 0, 1.5),
      track: track as MusicTrack,
      intensity: clamp(num(n.intensity, 0), 0, 1),
    });
  }
  if (!notes.length) return null;
  notes.sort((a, b) => a.t - b.t || a.midi - b.midi);

  const last = notes[notes.length - 1];
  let bars = Math.round(num(r.bars, 0));
  if (!(bars >= 1)) bars = Math.max(1, Math.ceil((last.t + last.dur) / bpb));

  const rawScale = Array.isArray(r.scale) ? (r.scale as unknown[]) : [];
  const scale = rawScale
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
    .map((x) => ((Math.round(x) % 12) + 12) % 12);

  const sections: MusicSection[] = [];
  const rawSections = Array.isArray(r.sections) ? (r.sections as unknown[]) : [];
  for (const s of rawSections) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    sections.push({
      start_bar: Math.max(0, Math.round(num(o.start_bar, 0))),
      name: typeof o.name === 'string' ? o.name : 'section',
      intensity: clamp(num(o.intensity, 0.3), 0, 1),
    });
  }
  if (!sections.length) sections.push({ start_bar: 0, name: 'auto', intensity: 0.3 });
  sections.sort((a, b) => a.start_bar - b.start_bar);

  return {
    name: typeof r.name === 'string' && r.name ? r.name : 'unnamed',
    bpm,
    bars,
    beats_per_bar: bpb,
    key: typeof r.key === 'string' && r.key ? r.key : 'A',
    mode: typeof r.mode === 'string' && r.mode ? r.mode : 'aeolian',
    scale: scale.length >= 5 ? scale : [0, 2, 3, 5, 7, 8, 10],
    sections,
    notes,
  };
}

interface Progression {
  key: string;
  mode: string;
  scale: number[];
  /** 每个和弦的音级（pitch class）三元组 */
  chords: number[][];
}

/** 5 套程序化和声进行（每章一首会按曲名哈希取到不同的一套） */
const PROGRESSIONS: Progression[] = [
  // A 自然小调 i - VI - III - VII : Am F C G
  { key: 'A', mode: 'aeolian', scale: [0, 2, 3, 5, 7, 8, 10], chords: [[9, 0, 4], [5, 9, 0], [0, 4, 7], [7, 11, 2]] },
  // E 弗里吉亚 i - VI - III - iv : Em C F Dm
  { key: 'E', mode: 'phrygian', scale: [0, 1, 3, 5, 7, 8, 10], chords: [[4, 7, 11], [0, 4, 7], [5, 9, 0], [2, 5, 9]] },
  // D 多利亚 i - IV - VII - i : Dm G C Dm
  { key: 'D', mode: 'dorian', scale: [0, 2, 3, 5, 7, 9, 10], chords: [[2, 5, 9], [7, 11, 2], [0, 4, 7], [2, 5, 9]] },
  // F 利底亚 I - II - V - I : F G C F
  { key: 'F', mode: 'lydian', scale: [0, 2, 4, 6, 7, 9, 11], chords: [[5, 9, 0], [7, 11, 2], [0, 4, 7], [5, 9, 0]] },
  // A 自然小调 i - VII - VI - VII : Am G F G
  { key: 'A', mode: 'aeolian', scale: [0, 2, 3, 5, 7, 8, 10], chords: [[9, 0, 4], [7, 11, 2], [5, 9, 0], [7, 11, 2]] },
];

/**
 * 代码内程序化和声进行：谱面不可用时的兜底，保证永远有音乐。
 * 结构：4 个和弦块（每块 4 小节）→ pad 长音 / bass 根音 / arp 八分音符 / perc / 后半段 lead 五声乐句。
 * 全部音符 t+dur ≤ bars·beats_per_bar，因此循环无缝。
 */
export function buildFallbackScore(name = 'fallback', bars = 16, beatsPerBar = 4): MusicScore {
  const prog = PROGRESSIONS[hashSeed('music:' + name) % PROGRESSIONS.length];
  const bpm = 92;
  const beatLen = Math.max(beatsPerBar * 2, bars * beatsPerBar);
  const barCount = Math.max(2, Math.round(beatLen / beatsPerBar));
  const blockBars = Math.max(1, Math.round(barCount / prog.chords.length));
  const blockBeats = blockBars * beatsPerBar;
  const rnd = mulberry32(hashSeed('fallback:' + name));
  const notes: MusicNote[] = [];
  const push = (
    t: number, dur: number, midi: number, vel: number, track: MusicTrack, intensity: number,
  ): void => {
    if (t < 0 || dur <= 0 || t >= beatLen) return;
    const end = Math.min(t + dur, beatLen);
    if (end - t <= 0.01) return;
    notes.push({
      t, dur: end - t, midi: clamp(Math.round(midi), 24, 108),
      vel: clamp(vel, 0, 1.5), track, intensity: clamp(intensity, 0, 1),
    });
  };

  const pcs = pentatonicSet(prog.key, prog.scale);

  for (let ci = 0; ci < prog.chords.length; ci++) {
    const startBeat = ci * blockBeats;
    if (startBeat >= beatLen) break;
    const chordPcs = prog.chords[ci];
    const voiced = chordPcs.map((pc) => pitchNear(pc, 60)); // pad 音域 ~55..67

    /* pad：整块和弦长音（0.6 s 慢起音在合成端实现） */
    for (const m of voiced) push(startBeat, blockBeats, m, 0.62, 'pad', 0.15);

    /* bass：每小节根音（隔小节上跳八度），后半小节加经过音 */
    for (let bar = 0; bar < blockBars; bar++) {
      const t = startBeat + bar * beatsPerBar;
      if (t >= beatLen) break;
      push(t, beatsPerBar - 0.5, pitchNear(chordPcs[0], 38) + (bar % 2 ? 12 : 0), 0.85, 'bass', 0.05);
      push(t + beatsPerBar - 1.5, 1.0, pitchNear(chordPcs[2], 45), 0.5, 'bass', 0.4);
    }

    /* arp：八分音符环绕和弦音；强度 > 0.6 时补 16 分音符（密度随强度上升） */
    const arpSet = voiced.map((m) => m + 12);
    for (let e = 0; e < blockBeats * 2; e++) {
      const t = startBeat + e * 0.5;
      if (t >= beatLen) break;
      const m = arpSet[e % arpSet.length] + (e % 8 >= 4 ? 12 : 0);
      push(t, 0.45, m, e % 2 === 0 ? 0.52 : 0.4, 'arp', 0.3);
      if (e % 2 === 0) push(t + 0.25, 0.22, arpSet[(e + 1) % arpSet.length], 0.3, 'arp', 0.62);
    }
  }

  /* perc：kick 1/3 拍、snare 2/4 拍、hat 八分音符；疏密由 intensity 分层 */
  for (let bar = 0; bar < barCount; bar++) {
    const b0 = bar * beatsPerBar;
    if (b0 >= beatLen) break;
    push(b0, 0.25, 36, 0.95, 'perc', 0.4);
    push(b0 + 2, 0.25, 36, 0.8, 'perc', 0.4);
    push(b0 + 1, 0.25, 38, 0.7, 'perc', 0.4);
    push(b0 + 3, 0.25, 38, 0.72, 'perc', 0.4);
    if (bar % 4 === 3) push(b0 + 3.5, 0.25, 36, 0.6, 'perc', 0.62); // 过门
    const hatStep = bar >= 4 ? 0.25 : 0.5;
    for (let t = b0; t < b0 + beatsPerBar && t < beatLen; t += hatStep) {
      const strong = Math.abs(t % 1) < 1e-6;
      push(t, 0.2, 42, strong ? 0.42 : 0.26, 'perc', strong ? 0.3 : 0.55);
    }
  }

  /* lead：后半段五声音阶乐句，强度门限 0.75（只有高强度才出现） */
  const leadStart = Math.floor(barCount / 2) * beatsPerBar;
  const phrase = [0, 2, 4, 2, 5, 4, 2, 0, 4, 5, 7, 5, 4, 2, 1, 0];
  for (let i = 0; i < 24; i++) {
    const t = leadStart + i * 1.5;
    if (t >= beatLen) break;
    const idx = phrase[i % phrase.length];
    const pc = pcs[idx % pcs.length];
    const oct = Math.floor(idx / pcs.length);
    const midi = pitchNear(pc, 72) + 12 * oct + (rnd() < 0.22 ? 12 : 0);
    push(t, 1.35, midi, 0.6, 'lead', 0.75);
  }

  const sections: MusicSection[] = [
    { start_bar: 0, name: 'intro', intensity: 0.15 },
    { start_bar: Math.min(2, barCount - 1), name: 'main', intensity: 0.55 },
    { start_bar: Math.max(2, Math.round(barCount * 0.75)), name: 'outro', intensity: 0.3 },
  ];

  // 调度器用单指针按时间顺序推进，因此必须按 t 升序返回（pad/bass/arp 是按和弦块生成的）
  notes.sort((a, b) => a.t - b.t || a.midi - b.midi);

  return {
    name,
    bpm,
    bars: Math.round(beatLen / beatsPerBar),
    beats_per_bar: beatsPerBar,
    key: prog.key,
    mode: prog.mode,
    scale: prog.scale.slice(),
    sections,
    notes,
  };
}

/* ------------------------------------------------------------------ 声部合成 */

/** 传给声部合成器的实时上下文（由 MusicScheduler 每 tick 刷新，避免反复分配对象） */
export interface VoiceEnv {
  ctx: AudioContext;
  dest: AudioNode;
  budget: VoiceBudget;
  /** 平滑后的强度（0..1） */
  intensity: number;
  /** 结构稳定性 0..1：越低 pad 失谐越宽（听感越"晃"） */
  stability: number;
  /** slowmo 的轻微失谐（cents，负值） */
  detuneCents: number;
  /** 五声音阶音级（lead 吸附用） */
  pcs: number[];
}

interface SourceSpec {
  n: AudioScheduledSourceNode;
  offset?: number;
}

/** 申请预算 → 启动源 → 绑定 onended 回收；失败时断开并返回 false */
function launch(
  env: VoiceEnv,
  count: number,
  start: number,
  stop: number,
  nodes: AudioNode[],
  sources: SourceSpec[],
): boolean {
  const id = env.budget.reserve(count, stop, () => {
    for (const nd of nodes) safeDisconnect(nd);
  });
  if (!id) {
    for (const nd of nodes) safeDisconnect(nd);
    return false;
  }
  const primary = sources.length ? sources[0].n : null;
  if (primary) primary.onended = () => env.budget.finish(id);
  for (const s of sources) {
    try {
      // AudioScheduledSourceNode 只声明 start(when)；带 offset 的只有 AudioBufferSourceNode
      if (s.offset !== undefined) (s.n as AudioBufferSourceNode).start(start, s.offset);
      else s.n.start(start);
      s.n.stop(stop);
    } catch {
      /* 启动失败：由预算兜底扫描回收 */
    }
  }
  return true;
}

/** pad：2~3 个失谐锯齿/三角 + 低通 + 0.6 s 慢起音 + 长释放（和弦长音） */
function playPad(env: VoiceEnv, note: MusicNote, when: number, dur: number): boolean {
  const n = Math.min(3, env.budget.available());
  if (n <= 0) return false;
  const ctx = env.ctx;
  const freq = midiToFreq(note.midi);
  const spread = 5 + 24 * (1 - clamp(env.stability, 0, 1));
  const peak = 0.085 * clamp(note.vel, 0, 1.4) * (0.8 + 0.35 * env.intensity);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = clamp(620 + 1900 * env.intensity + freq * 1.7, 260, 8200);
  filter.Q.value = 0.7;

  const amp = ctx.createGain();
  amp.gain.value = 0.0001;
  const attack = 0.6;
  const release = Math.max(1.4, dur * 0.4);
  const hold = Math.max(when + attack, when + dur);
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.linearRampToValueAtTime(peak, when + attack);
  amp.gain.setValueAtTime(peak, hold);
  amp.gain.linearRampToValueAtTime(0.0001, hold + release);

  const nodes: AudioNode[] = [filter, amp];
  const sources: SourceSpec[] = [];
  const addOsc = (type: OscillatorType, f: number, detune: number, level: number): void => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = clamp(f, 20, 12000);
    osc.detune.value = clamp(detune, -1200, 1200);
    if (level >= 0.999) {
      osc.connect(filter);
    } else {
      const og = ctx.createGain();
      og.gain.value = level;
      osc.connect(og);
      og.connect(filter);
      nodes.push(og);
    }
    nodes.push(osc);
    sources.push({ n: osc });
  };

  addOsc('sawtooth', freq, -spread + env.detuneCents, 1);
  if (n >= 2) addOsc('sawtooth', freq, spread + env.detuneCents, 0.9);
  if (n >= 3) addOsc('triangle', freq / 2, env.detuneCents, 0.5);

  filter.connect(amp);
  amp.connect(env.dest);
  return launch(env, n, when, hold + release + 0.05, nodes, sources);
}

/** bass：正弦 + 轻微方波，短衰减，跟和弦根音 */
function playBass(env: VoiceEnv, note: MusicNote, when: number, dur: number): boolean {
  const n = Math.min(2, env.budget.available());
  if (n <= 0) return false;
  const ctx = env.ctx;
  const freq = midiToFreq(note.midi);
  const peak = 0.3 * clamp(note.vel, 0, 1.4);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = clamp(230 + 420 * env.intensity, 140, 900);
  filter.Q.value = 0.9;

  const amp = ctx.createGain();
  amp.gain.value = 0.0001;
  const end = when + Math.max(0.14, dur);
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.linearRampToValueAtTime(peak, when + 0.012);
  amp.gain.setTargetAtTime(peak * 0.45, when + 0.012, 0.11); // 短衰减到持续电平
  amp.gain.setTargetAtTime(0.0001, end, 0.07); // 释放

  const nodes: AudioNode[] = [filter, amp];
  const sources: SourceSpec[] = [];
  const sine = ctx.createOscillator();
  sine.type = 'sine';
  sine.frequency.value = clamp(freq, 20, 2000);
  sine.detune.value = env.detuneCents;
  sine.connect(filter);
  nodes.push(sine);
  sources.push({ n: sine });

  if (n >= 2) {
    const sub = ctx.createOscillator();
    sub.type = 'square';
    sub.frequency.value = clamp(freq, 20, 2000);
    sub.detune.value = env.detuneCents + 6;
    const og = ctx.createGain();
    og.gain.value = 0.22;
    sub.connect(og);
    og.connect(filter);
    nodes.push(og, sub);
    sources.push({ n: sub });
  }

  filter.connect(amp);
  amp.connect(env.dest);
  const stop = end + 0.35;
  return launch(env, n, when, stop, nodes, sources);
}

const ARP_STOP = 0.5;

function arpVoice(env: VoiceEnv, midi: number, when: number, dur: number, vel: number, pan: number): boolean {
  if (env.budget.available() < 1) return false;
  const ctx = env.ctx;
  const freq = midiToFreq(midi);
  const osc = ctx.createOscillator();
  osc.type = env.intensity > 0.6 ? 'square' : 'triangle';
  osc.frequency.value = clamp(freq, 20, 12000);
  osc.detune.value = clamp(env.detuneCents, -1200, 1200);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = clamp(900 + 4200 * env.intensity + freq * 0.8, 400, 13000);
  filter.Q.value = 3.2;

  const amp = ctx.createGain();
  amp.gain.value = 0.0001;
  const stop = envPerc(amp.gain, when, 0.15 * clamp(vel, 0, 1.4), 0.004, Math.min(0.32, Math.max(0.07, dur * 0.9)));

  const p = ctx.createStereoPanner();
  p.pan.value = clamp(pan, -1, 1);

  osc.connect(filter);
  filter.connect(amp);
  amp.connect(p);
  p.connect(env.dest);
  return launch(env, 1, when, stop + 0.02, [osc, filter, amp, p], [{ n: osc }]);
}

/**
 * arp：三角/方波短促音；**强度越高音符越密** —— 用同一音高材料插入回声重触发
 * （>0.55 半程回声，>0.8 再加八度回声），这是"强度门限"在听感上的直接体现。
 */
function playArp(env: VoiceEnv, note: MusicNote, when: number, dur: number): boolean {
  const pan = ((note.midi % 5) - 2) / 2 * 0.45;
  const ok = arpVoice(env, note.midi, when, dur, note.vel, pan);
  if (env.intensity > 0.55 && env.budget.available() > 0) {
    const g = (env.intensity - 0.55) / 0.45;
    arpVoice(env, note.midi, when + dur * 0.5, dur * 0.5, note.vel * 0.5 * g, -pan);
  }
  if (env.intensity > 0.8 && env.budget.available() > 0) {
    const g = (env.intensity - 0.8) / 0.2;
    arpVoice(env, note.midi + 12, when + dur * 0.75, dur * 0.25, note.vel * 0.42 * g, pan * 0.5);
  }
  return ok;
}

/** perc：按 MIDI 音高分工（≤37 kick / 38..40 snare / ≥41 hat） */
function playPerc(env: VoiceEnv, note: MusicNote, when: number): boolean {
  const ctx = env.ctx;
  const vel = clamp(note.vel, 0, 1.5);

  if (note.midi <= 37) {
    /* kick：正弦音高下坠 */
    if (env.budget.available() < 1) return false;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(145, when);
    osc.frequency.exponentialRampToValueAtTime(44, when + 0.09);
    const amp = ctx.createGain();
    amp.gain.value = 0.0001;
    const stop = envPerc(amp.gain, when, 0.5 * vel, 0.002, 0.28);
    osc.connect(amp);
    amp.connect(env.dest);
    return launch(env, 1, when, stop + 0.02, [osc, amp], [{ n: osc }]);
  }

  if (note.midi <= 40) {
    /* snare：噪声爆发 + 带通 + 一点点正弦体 */
    const n = Math.min(2, env.budget.available());
    if (n <= 0) return false;
    const noise = ctx.createBufferSource();
    noise.buffer = getNoiseBuffer(ctx);
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1750;
    bp.Q.value = 1.1;
    const nAmp = ctx.createGain();
    nAmp.gain.value = 0.0001;
    const stop = envPerc(nAmp.gain, when, 0.34 * vel, 0.001, 0.15);
    noise.connect(bp);
    bp.connect(nAmp);
    nAmp.connect(env.dest);

    const nodes: AudioNode[] = [noise, bp, nAmp];
    const sources: SourceSpec[] = [{ n: noise, offset: (note.midi * 0.137) % 1.5 }];
    if (n >= 2) {
      const body = ctx.createOscillator();
      body.type = 'triangle';
      body.frequency.value = 195;
      const bAmp = ctx.createGain();
      bAmp.gain.value = 0.0001;
      envPerc(bAmp.gain, when, 0.16 * vel, 0.001, 0.07);
      body.connect(bAmp);
      bAmp.connect(env.dest);
      nodes.push(body, bAmp);
      sources.push({ n: body });
    }
    return launch(env, n, when, stop + 0.02, nodes, sources);
  }

  /* hat：高通噪声，极短 */
  if (env.budget.available() < 1) return false;
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer(ctx);
  noise.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 6800;
  const amp = ctx.createGain();
  amp.gain.value = 0.0001;
  const stop = envPerc(amp.gain, when, 0.15 * vel, 0.0008, 0.042);
  noise.connect(hp);
  hp.connect(amp);
  amp.connect(env.dest);
  return launch(env, 1, when, stop + 0.01, [noise, hp, amp], [{ n: noise, offset: (note.midi * 0.211) % 1.5 }]);
}

/** lead：仅在 intensity > 0.7 出现；五声音阶吸附 + 轻微起音滑音 */
function playLead(env: VoiceEnv, note: MusicNote, when: number, dur: number): boolean {
  if (env.intensity <= 0.7) return false; // 契约：lead 只在强度 > 0.7 时出现
  const n = Math.min(2, env.budget.available());
  if (n <= 0) return false;
  const ctx = env.ctx;
  const midi = snapToPentatonic(note.midi, env.pcs);
  const freq = midiToFreq(midi);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = clamp(1300 + 5200 * env.intensity, 800, 13000);
  filter.Q.value = 1.4;

  const amp = ctx.createGain();
  amp.gain.value = 0.0001;
  const stop = envSustain(amp.gain, when, dur, 0.12 * clamp(note.vel, 0, 1.4), 0.02, 0.28);

  const p = ctx.createStereoPanner();
  p.pan.value = (midi % 2 === 0 ? -1 : 1) * 0.22;

  const nodes: AudioNode[] = [filter, amp, p];
  const sources: SourceSpec[] = [];
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(clamp(freq * 0.985, 20, 12000), when);
  osc.frequency.linearRampToValueAtTime(clamp(freq, 20, 12000), when + 0.07);
  osc.detune.value = clamp(env.detuneCents + 4, -1200, 1200);
  osc.connect(filter);
  nodes.push(osc);
  sources.push({ n: osc });

  if (n >= 2) {
    const harm = ctx.createOscillator();
    harm.type = 'square';
    harm.frequency.value = clamp(freq, 20, 12000);
    harm.detune.value = clamp(env.detuneCents + 9, -1200, 1200);
    const og = ctx.createGain();
    og.gain.value = 0.3;
    harm.connect(og);
    og.connect(filter);
    nodes.push(og, harm);
    sources.push({ n: harm });
  }

  filter.connect(amp);
  amp.connect(p);
  p.connect(env.dest);
  return launch(env, n, when, stop + 0.02, nodes, sources);
}

/** 按 note.track 分发到不同合成器 */
function dispatchTrack(env: VoiceEnv, note: MusicNote, when: number, dur: number): boolean {
  switch (note.track) {
    case 'pad':
      return playPad(env, note, when, dur);
    case 'bass':
      return playBass(env, note, when, dur);
    case 'arp':
      return playArp(env, note, when, dur);
    case 'perc':
      return playPerc(env, note, when);
    case 'lead':
      return playLead(env, note, when, dur);
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ 单曲播放槽位 */

interface EnvHost {
  readonly env: VoiceEnv;
  gate(track: MusicTrack): boolean;
  /** 诊断：统计"真正发声 / 被门限或预算挡掉"的音符数 */
  noteStat(played: boolean): void;
}

/** 一首曲子的播放槽位：自己持有锚点/循环序号/音符指针，增益节点用于交叉淡化 */
class TrackPlayer {
  readonly gain: GainNode;
  signature = '';
  name = '';
  private notes: MusicNote[] = [];
  private ptr = 0;
  private cycle = 0;
  private anchor = 0;
  private spb = 0.5;
  private loopDur = 8;
  private running = false;

  constructor(private readonly ctx: AudioContext, dest: AudioNode, private readonly host: EnvHost) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(dest);
  }

  load(score: MusicScore, at: number, signature: string): void {
    const spb = 60 / score.bpm;
    // 调度器依赖"按 t 升序"这一前提；外部谱面即便被直接喂进来也在这里兜底修正
    let sorted = true;
    for (let i = 1; i < score.notes.length; i++) {
      if (score.notes[i].t < score.notes[i - 1].t) {
        sorted = false;
        break;
      }
    }
    const notes = sorted ? score.notes : score.notes.slice().sort((a, b) => a.t - b.t || a.midi - b.midi);
    const last = notes.length ? notes[notes.length - 1] : null;
    const barBeats = score.bars * score.beats_per_bar;
    const needBeats = last ? last.t + last.dur : 0;
    // 谱面音符超出声明小节数时，把循环长度补齐到整小节，避免尾音被截断破坏无缝
    const beatLen = needBeats > barBeats
      ? Math.ceil(needBeats / score.beats_per_bar) * score.beats_per_bar
      : barBeats;
    this.notes = notes;
    this.spb = spb;
    this.loopDur = Math.max(0.5, beatLen * spb);
    this.anchor = at;
    this.cycle = 0;
    this.ptr = 0;
    this.running = true;
    this.signature = signature;
    this.name = score.name;
  }

  /** 调度 [now, horizon) 内的音符；绝对时刻由锚点推出，与调用时机无关 */
  pump(now: number, horizon: number): void {
    if (!this.running || !this.notes.length) return;
    const notes = this.notes;
    let guard = 0;
    for (;;) {
      if (this.ptr >= notes.length) {
        this.ptr = 0;
        this.cycle++;
      }
      const note = notes[this.ptr];
      const when = this.anchor + this.cycle * this.loopDur + note.t * this.spb;
      if (when >= horizon) break;
      this.ptr++;
      if (++guard > 4096) break; // 安全阀：极端长时间挂起后不做无意义遍历
      if (when < now - 0.02) continue; // 过期音符直接丢弃，不补发（避免爆音）
      if (!this.host.gate(note.track)) {
        this.host.noteStat(false);
        continue;
      }
      const env = this.host.env;
      if (note.intensity > env.intensity + NOTE_GATE_SLACK) {
        this.host.noteStat(false); // 强度门限 + 迟滞余量
        continue;
      }
      this.host.noteStat(dispatchTrack(env, note, when, Math.max(0.02, note.dur * this.spb)));
    }
  }

  /** 重新锚定到"当前所在的那一轮循环"，保持相位（暂停/隐藏后恢复用） */
  reanchor(now: number): void {
    if (!this.running) return;
    const elapsed = now - this.anchor;
    if (elapsed > this.loopDur) {
      const loops = Math.floor(elapsed / this.loopDur);
      this.anchor += loops * this.loopDur;
    }
    this.cycle = 0;
    this.ptr = 0;
  }

  /** 等功率淡化到目标增益 */
  fadeTo(target: number, seconds: number, now: number): void {
    const g = this.gain.gain;
    const from = g.value;
    const stop = Math.max(0, target);
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(from, now);
      g.setValueCurveAtTime(equalPowerCurve(from, stop, 33), now, Math.max(0.05, seconds));
    } catch {
      // 某些实现不允许曲线重叠：退化为指数逼近
      g.setTargetAtTime(stop, now, Math.max(0.02, seconds / 3));
    }
  }

  reset(): void {
    this.running = false;
    this.notes = [];
    this.ptr = 0;
    this.cycle = 0;
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.setTargetAtTime(0, now, 0.02);
  }

  /** 彻底断开（引擎 dispose 用） */
  destroy(): void {
    this.reset();
    safeDisconnect(this.gain);
  }
}

function scoreSignature(s: MusicScore): string {
  return `${s.name}|${s.bpm}|${s.bars}|${s.beats_per_bar}|${s.notes.length}|${s.key}`;
}

/* ------------------------------------------------------------------ 参数层：心跳 / 警报 */

/** 燃料低于 25% 时的低频心跳（lub-dub），燃料越低越快越响 */
class HeartbeatLayer {
  private next = 0;

  tick(now: number, fuel: number, budget: VoiceBudget, ctx: AudioContext, dest: AudioNode): void {
    if (!(fuel >= 0) || fuel >= 0.25) {
      this.next = 0;
      return;
    }
    const sev = 1 - clamp(fuel / 0.25, 0, 1);
    const period = lerp(1.5, 0.62, sev);
    const peak = 0.15 + 0.13 * sev;
    if (this.next < now - 0.5 || this.next === 0) this.next = now + 0.05;
    let guard = 0;
    while (this.next < now + LOOKAHEAD && guard++ < 8) {
      this.thump(ctx, dest, budget, this.next, peak);
      this.next += period;
    }
  }

  private thump(ctx: AudioContext, dest: AudioNode, budget: VoiceBudget, when: number, peak: number): void {
    const n = Math.min(2, budget.available());
    if (n <= 0) return;
    const nodes: AudioNode[] = [];
    const sources: AudioScheduledSourceNode[] = [];
    let stop = when;
    const mk = (at: number, f0: number, f1: number, amp: number, decay: number): void => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0, at);
      osc.frequency.exponentialRampToValueAtTime(f1, at + 0.14);
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      const end = envPerc(g.gain, at, amp, 0.006, decay);
      osc.connect(g);
      g.connect(dest);
      nodes.push(osc, g);
      sources.push(osc);
      stop = Math.max(stop, end);
    };
    mk(when, 68, 40, peak, 0.17); // lub
    if (n >= 2) mk(when + 0.19, 58, 34, peak * 0.72, 0.15); // dub
    launchRaw(ctx, budget, n, when, stop + 0.02, nodes, sources);
  }
}

/** 不做 VoiceEnv 依赖的启动器（心跳层用） */
function launchRaw(
  ctx: AudioContext,
  budget: VoiceBudget,
  count: number,
  start: number,
  stop: number,
  nodes: AudioNode[],
  sources: AudioScheduledSourceNode[],
): boolean {
  const id = budget.reserve(count, stop, () => {
    for (const nd of nodes) safeDisconnect(nd);
  });
  if (!id) {
    for (const nd of nodes) safeDisconnect(nd);
    return false;
  }
  const primary = sources[0];
  if (primary) primary.onended = () => budget.finish(id);
  for (const s of sources) {
    try {
      s.start(start);
      s.stop(stop);
    } catch {
      /* 忽略 */
    }
  }
  return true;
}

/** alert=1 时叠加的紧张高频脉冲层（半音摩擦 + 音频速率脉冲调制） */
class AlertLayer {
  private gain: GainNode | null = null;
  private lfoGain: GainNode | null = null;
  private lfo: OscillatorNode | null = null;
  private oscs: OscillatorNode[] = [];
  private hp: BiquadFilterNode | null = null;
  private lease = 0;
  level = 0;

  constructor(private readonly ctx: AudioContext, private readonly dest: AudioNode, private readonly budget: VoiceBudget) {}

  setLevel(x: number): void {
    const v = clamp(x, 0, 1);
    this.level = v;
    if (v <= 0.001 && !this.gain) return;
    if (!this.gain) this.build();
    if (!this.gain || !this.lfoGain || !this.lfo) return;
    const now = this.ctx.currentTime;
    const peak = 0.05 * v;
    this.gain.gain.setTargetAtTime(peak * 0.5, now, 0.08);
    this.lfoGain.gain.setTargetAtTime(peak * 0.5, now, 0.08);
    this.lfo.frequency.setTargetAtTime(4.5 + 4.5 * v, now, 0.1);
  }

  private build(): void {
    const ctx = this.ctx;
    const nodes: AudioNode[] = [];
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1300;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 6;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0;

    // G6 + G#6：小二度摩擦 = 紧张；再叠一个高八度正弦做"嘀嘀"脉冲体
    const a = ctx.createOscillator();
    a.type = 'triangle';
    a.frequency.value = 1568;
    const b = ctx.createOscillator();
    b.type = 'square';
    b.frequency.value = 1661.2;
    b.detune.value = 6;
    const c = ctx.createOscillator();
    c.type = 'sine';
    c.frequency.value = 3136;

    a.connect(hp);
    b.connect(hp);
    c.connect(hp);
    hp.connect(gain);
    gain.connect(this.dest);
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    nodes.push(gain, hp, lfo, lfoGain, a, b, c);

    this.gain = gain;
    this.hp = hp;
    this.lfo = lfo;
    this.lfoGain = lfoGain;
    this.oscs = [a, b, c];

    const id = this.budget.reserve(4, Number.POSITIVE_INFINITY, () => {
      for (const nd of nodes) safeDisconnect(nd);
    });
    if (!id) {
      for (const nd of nodes) safeDisconnect(nd);
      this.gain = null;
      this.lfoGain = null;
      this.lfo = null;
      this.oscs = [];
      return;
    }
    this.lease = id;
    try {
      lfo.start();
      for (const o of this.oscs) o.start();
    } catch {
      /* 忽略 */
    }
  }

  dispose(): void {
    if (this.lease) {
      this.budget.finish(this.lease);
      this.lease = 0;
    } else {
      for (const o of this.oscs) safeDisconnect(o);
      safeDisconnect(this.gain);
      safeDisconnect(this.hp);
      safeDisconnect(this.lfo);
      safeDisconnect(this.lfoGain);
    }
    this.gain = null;
    this.hp = null;
    this.lfo = null;
    this.lfoGain = null;
    this.oscs = [];
  }
}

/* ------------------------------------------------------------------ 调度器 */

export interface MusicOptions {
  ctx: AudioContext;
  /** 音乐链入口（引擎侧：slowmo 低通 → 强度低通 → musicBus） */
  dest: AudioNode;
  /** 警报层输出（引擎侧：musicBus，绕过亮度滤波但受 duck/mute 影响） */
  alertDest: AudioNode;
  budget: VoiceBudget;
  warn?: OnceWarn;
  /** 每个 tick 结束回调（引擎用来更新强度低通等总线参数） */
  onTick?: (now: number) => void;
}

export class MusicScheduler implements EnvHost {
  readonly env: VoiceEnv;

  private readonly ctx: AudioContext;
  private readonly slots: TrackPlayer[] = [];
  private active: TrackPlayer | null = null;
  private retiring: TrackPlayer | null = null;
  private retireAt = 0;
  private timer: number | null = null;
  private paused = false;
  private disposed = false;

  private target = 0.5;
  private smooth = 0.5;
  private slowmo = 0;
  private stability = 1;
  private fuel = 1;
  private readonly hoppers: Record<MusicTrack, boolean> = {
    pad: true, bass: true, arp: false, perc: true, lead: false,
  };
  private readonly heartbeat = new HeartbeatLayer();
  private readonly alert: AlertLayer;

  /** 被强度门限/预算挡掉的音符数（诊断用） */
  dropped = 0;
  /** 已调度的音符总数（诊断用） */
  scheduled = 0;

  constructor(private readonly opts: MusicOptions) {
    this.ctx = opts.ctx;
    this.env = {
      ctx: opts.ctx,
      dest: opts.dest,
      budget: opts.budget,
      intensity: 0.5,
      stability: 1,
      detuneCents: 0,
      pcs: pentatonicSet('A', [0, 2, 3, 5, 7, 8, 10]),
    };
    this.slots.push(new TrackPlayer(opts.ctx, opts.dest, this));
    this.slots.push(new TrackPlayer(opts.ctx, opts.dest, this));
    this.alert = new AlertLayer(opts.ctx, opts.alertDest, opts.budget);
    if (!this.paused) this.start();
  }

  /* ---------------- 对外参数 ---------------- */

  /** 平滑后的当前强度（声部门限用） */
  get intensity(): number {
    return this.smooth;
  }

  get activeName(): string | null {
    return this.active ? this.active.name : null;
  }

  setIntensity(x: number): void {
    this.target = clamp(Number.isFinite(x) ? x : 0, 0, 1);
  }

  setSlowmo(x: number): void {
    this.slowmo = clamp(Number.isFinite(x) ? x : 0, 0, 1);
    // 轻微失谐（不真的改 playbackRate，避免破坏音高）
    this.env.detuneCents = -12 * this.slowmo;
  }

  setStability(x: number): void {
    this.stability = clamp(Number.isFinite(x) ? x : 1, 0, 1);
    this.env.stability = this.stability;
  }

  setAlert(x: number): void {
    this.alert.setLevel(Number.isFinite(x) ? x : 0);
  }

  setFuel(x: number): void {
    this.fuel = clamp(Number.isFinite(x) ? x : 1, 0, 1);
  }

  /** 声部迟滞门限 */
  gate(track: MusicTrack): boolean {
    return this.hoppers[track] === true;
  }

  /** 诊断计数（谱面演奏/丢弃统计） */
  noteStat(played: boolean): void {
    if (played) this.scheduled++;
    else this.dropped++;
  }

  /* ---------------- 播放列表 ---------------- */

  /**
   * 切换配乐：score=null → 淡出停止；谱面异常 → 退化为程序化和声进行。
   * 切换用 1.2 s 等功率交叉淡化，且两个槽位复用节点（不重建）。
   */
  setScore(score: MusicScore | null): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;

    if (score === null) {
      if (this.active) {
        this.retire(this.active, now);
        this.active = null;
      }
      return;
    }

    let use = normalizeScore(score);
    if (!use) {
      const nm = typeof (score as { name?: unknown }).name === 'string' ? String((score as { name?: unknown }).name) : 'fallback';
      this.opts.warn?.fire(
        'music-badscore',
        `[audio] 音乐谱面缺失或格式异常（${nm}），退化为代码内程序化和声进行（A 小调 i-VI-III-VII 等）`,
      );
      use = buildFallbackScore(nm);
    }

    const sig = scoreSignature(use);
    if (this.active && this.active.signature === sig) return; // 同一首：幂等

    const next = this.freeSlot();
    next.load(use, now + 0.06, sig);
    next.fadeTo(1, XFADE_SEC, now);
    if (this.active) this.retire(this.active, now);
    this.active = next;

    this.env.pcs = pentatonicSet(use.key, use.scale);
    this.smooth = clamp(this.smooth, 0, 1);
    if (!this.paused && this.timer === null) this.start();
  }

  /* ---------------- 生命周期 ---------------- */

  /** document.hidden → 暂停调度（引擎负责同时压掉音乐总线） */
  pause(): void {
    this.paused = true;
    this.stopTimer();
  }

  resume(): void {
    if (this.disposed) return;
    this.paused = false;
    const now = this.ctx.currentTime;
    for (const s of this.slots) s.reanchor(now);
    if (this.timer === null) this.start();
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.alert.dispose();
    for (const s of this.slots) s.destroy();
    this.active = null;
    this.retiring = null;
  }

  /* ---------------- 内部 ---------------- */

  private start(): void {
    this.stopTimer();
    this.timer = setInterval(this.tick, TICK_MS);
    this.tick();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private freeSlot(): TrackPlayer {
    for (const s of this.slots) {
      if (s !== this.active && s !== this.retiring) return s;
    }
    if (this.retiring) {
      const r = this.retiring;
      this.retiring = null;
      r.reset();
      return r;
    }
    const a = this.active as TrackPlayer;
    this.active = null;
    a.reset();
    return a;
  }

  private retire(p: TrackPlayer, now: number): void {
    this.retireAt = now + XFADE_SEC + 0.1;
    if (this.retiring && this.retiring !== p) this.retiring.reset();
    this.retiring = p;
    p.fadeTo(0, XFADE_SEC, now);
  }

  /**
   * 调度心跳：25 ms 唤醒一次，向前调度 0.25 s。
   * 时间基准只有 ctx.currentTime；音频线程按 AudioParam 时间线精确触发，
   * 因此 setInterval 的抖动不会传成音符抖动（见自验 4）。
   */
  private readonly tick = (): void => {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    this.opts.budget.sweep(now);

    // 强度平滑 + 声部施密特迟滞（避免门限附近声部闪烁）
    this.smooth += (this.target - this.smooth) * 0.25;
    if (Math.abs(this.smooth - this.target) < 1e-4) this.smooth = this.target;
    for (const t of TRACKS) {
      const on = TRACK_ON[t];
      const off = on - TRACK_HYST;
      this.hoppers[t] = this.smooth >= on ? true : this.smooth <= off ? false : this.hoppers[t];
    }

    this.env.intensity = this.smooth;
    this.env.stability = this.stability;
    this.env.detuneCents = -12 * this.slowmo;

    const horizon = now + LOOKAHEAD;
    if (this.active) this.active.pump(now, horizon);
    if (this.retiring) {
      if (now >= this.retireAt) {
        this.retiring.reset();
        this.retiring = null;
      } else {
        this.retiring.pump(now, horizon); // 淡化期间继续演奏，交叉淡化才听不出断层
      }
    }

    this.heartbeat.tick(now, this.fuel, this.opts.budget, this.ctx, this.opts.alertDest);
    this.opts.onTick?.(now);
  };
}
