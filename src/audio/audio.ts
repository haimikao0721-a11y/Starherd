/**
 * STARHERD — W-audio / src/audio/audio.ts
 *
 * AudioEngine：W-audio 对外唯一入口（接口冻结，见 INTERFACES §6 + 任务书）。
 *
 * 总线结构：
 *   sfxBus ─────────────────────────────┐
 *   musicTone(低通,slowmo) → musicFilter(低通,intensity) → musicBus ─┴→ masterGain
 *        → DynamicsCompressor(阈值 −12 dB, 比例 6) → destination
 *   （alert 警报层与 fuel 心跳直接进 musicBus：绕过亮度滤波，但仍受 duck / mute 影响）
 *
 * setParam 语义（新增冻结项）：
 *   · 'wellMass'  引力井质量：期望 M★ 绝对值（DESIGN §3：0.0005 .. 0.05，内部按 /0.05 归一）。
 *                 传入归一化比例会被饱和到 1——只影响推进器音色调制，不影响功能。
 *   · 'wellThrust' 引力井推力：期望归一化 0..1；>1 视为绝对推力并按 x/(1+x) 软饱和。
 *                 驱动 thruster_loop 的增益与播放速率（本作核心听感反馈）。
 *   · 'slowmo'    0..1：音乐总线轻微"降速感"= 低通下压 + 新建声部轻微负失谐（不改 playbackRate，音高不破）。
 *   · 'alert'     0..1：叠加紧张高频脉冲层（G6/G#6 小二度 + 音频速率脉冲调制）。
 *   · 'fuel'      0..1：低于 0.25 加入低频心跳（越低越快越响）。
 *   · 'stability' 0..1：结构稳定性，越低 pad 失谐越宽（听感更"晃"）。
 *   · 'musicGain' 0..1：音乐总线音量。
 *   · 'sfxGain'   0..1：音效总线音量。
 *   未列出的名字一律忽略（不抛错）。
 *
 * 生命周期：init() 必须在用户手势后调用；document.hidden 时引擎自行暂停调度器并压掉输出。
 */

import type { AssetStore, MusicScore } from '../sim/types';
import { SfxPlayer, type LoopModulation, type LoopOptions, type PlayOptions } from './sfx';
import { MusicScheduler } from './music';
import { OnceWarn, VOICE_CAP, VoiceBudget, clamp, safeDisconnect } from './synth';

const SFX_BUS_GAIN = 0.9;
const MASTER_DEFAULT = 0.8;

/** 压缩器（总线保护，避免多声部叠加削波） */
const COMP_THRESHOLD_DB = -12;
const COMP_RATIO = 6;
const COMP_KNEE_DB = 12;
const COMP_ATTACK = 0.004;
const COMP_RELEASE = 0.22;

/** 强度 → 音乐总线低通（越高越亮） */
const MUSIC_LP_MIN = 900;
const MUSIC_LP_MAX = 16000;
/** slowmo 的"降速感"低通 */
const TONE_LP_OPEN = 20000;
const TONE_LP_SLOW = 1500;

/** duck：0.08 s 内压到 35%，之后指数恢复 */
const DUCK_LEVEL = 0.35;
const DUCK_ATTACK_TAU = 0.08 / 3; // 3τ ≈ 0.08 s
const DUCK_RELEASE_TAU = 0.35;

type AudioCtxCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioCtxCtor | null {
  const g = globalThis as unknown as { AudioContext?: AudioCtxCtor; webkitAudioContext?: AudioCtxCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export type AudioParamName =
  | 'wellMass' | 'wellThrust' | 'slowmo' | 'alert' | 'fuel' | 'stability'
  | 'musicGain' | 'sfxGain';

interface ParamState {
  wellMass: number; // 归一化 0..1（源值 M★ / 0.05）
  wellThrust: number; // 归一化 0..1
  slowmo: number;
  alert: number;
  fuel: number;
  stability: number;
}

export class AudioEngine {
  private readonly assets: AssetStore;
  private readonly warn = new OnceWarn((m) => console.warn(m));
  private readonly budget = new VoiceBudget(VOICE_CAP);

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicTone: BiquadFilterNode | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private sfx: SfxPlayer | null = null;
  private music: MusicScheduler | null = null;
  /** 主菜单播放的外来录音（与程序化谱面互斥） */
  private recorded: AudioBufferSourceNode | null = null;
  private recordedGain: GainNode | null = null;
  private recordedUrl: string | null = null;
  private recordedToken = 0;
  private recordedLoop = false;
  private recordedEnded: (() => void) | null = null;
  private pendingRecording: string | null = null;

  private initPromise: Promise<void> | null = null;
  private readyFlag = false;
  private disposed = false;

  private masterLevel = MASTER_DEFAULT;
  /** 与存档默认一致：音乐 0.55、音效 0.9。滑块改的就是这两条总线。 */
  private musicLevel = 0.55;
  private sfxLevel = SFX_BUS_GAIN;
  private muted = false;
  /** 滑块连发时用它记住“耳朵里现在的响度”，避免每次都从旧目标跳一下。 */
  private masterGlide = { value: MASTER_DEFAULT, toward: MASTER_DEFAULT, at: 0, tau: 0.18 };
  private musicGlide = { value: 0.55, toward: 0.55, at: 0, tau: 0.18 };
  private sfxGlide = { value: SFX_BUS_GAIN, toward: SFX_BUS_GAIN, at: 0, tau: 0.18 };
  private hidden = false;
  private duckUntil = 0;

  private intensityTarget = 0.5;
  private musicSet = false;
  private pendingMusic: MusicScore | null = null;
  private thrustSeen = false;

  private readonly params: ParamState = {
    wellMass: 0.4, // ≈0.02 M★（中量级预设）
    wellThrust: 0.5,
    slowmo: 0,
    alert: 0,
    fuel: 1,
    stability: 1,
  };

  constructor(assets: AssetStore) {
    this.assets = assets;
  }

  /* ------------------------------------------------------------------ 生命周期 */

  /**
   * 必须在用户手势里调用：建图 → resume()（suspended 时）→ 应用此前挂起的设置。
   * 任何失败都退化为"静默模式"，绝不抛错打断游戏启动。
   */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (this.disposed) return;
    const Ctor = audioContextCtor();
    if (!Ctor) {
      this.warn.fire('no-webaudio', '[audio] 当前环境没有 WebAudio（AudioContext 缺失），音频引擎以静默模式运行');
      return;
    }

    let ctx: AudioContext | null = null;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      try {
        ctx = new Ctor();
      } catch (err) {
        this.warn.fire('ctx-fail', `[audio] AudioContext 创建失败，音频引擎以静默模式运行：${String(err)}`);
        return;
      }
    }
    if (!ctx) return;
    this.ctx = ctx;

    /* ---- 总线 ---- */
    const master = ctx.createGain();
    master.gain.value = this.effectiveMaster();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = COMP_THRESHOLD_DB;
    comp.ratio.value = COMP_RATIO;
    comp.knee.value = COMP_KNEE_DB;
    comp.attack.value = COMP_ATTACK;
    comp.release.value = COMP_RELEASE;

    master.connect(comp);
    comp.connect(ctx.destination);

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = this.sfxLevel;
    sfxBus.connect(master);

    const musicBus = ctx.createGain();
    musicBus.gain.value = this.hidden ? 0 : this.musicLevel;
    musicBus.connect(master);

    const musicTone = ctx.createBiquadFilter();
    musicTone.type = 'lowpass';
    musicTone.frequency.value = TONE_LP_OPEN;
    musicTone.Q.value = 0.5;

    const musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.frequency.value = this.intensityToHz(this.intensityTarget);
    musicFilter.Q.value = 0.7;

    musicTone.connect(musicFilter);
    musicFilter.connect(musicBus);

    this.master = master;
    this.comp = comp;
    this.sfxBus = sfxBus;
    this.musicBus = musicBus;
    this.musicTone = musicTone;
    this.musicFilter = musicFilter;

    /* ---- 子系统 ---- */
    this.sfx = new SfxPlayer(ctx, sfxBus, this.budget, this.assets, this.warn, this.loopModulation);
    this.music = new MusicScheduler({
      ctx,
      dest: musicTone,
      alertDest: musicBus,
      budget: this.budget,
      warn: this.warn,
      onTick: this.onMusicTick,
    });

    // 应用挂起的设置（init 之前调用过的 setXxx 不能丢）
    this.music.setIntensity(this.intensityTarget);
    this.music.setSlowmo(this.params.slowmo);
    this.music.setStability(this.params.stability);
    this.music.setAlert(this.params.alert);
    this.music.setFuel(this.params.fuel);
    this.musicFilter.frequency.setValueAtTime(this.intensityToHz(this.intensityTarget), ctx.currentTime);
    this.applyToneFilter(0.01);

    if (!this.pendingRecording && this.musicSet) this.music.setScore(this.pendingMusic);

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.onVisibility);
      this.setHidden(this.readHidden(), true);
    }

    if (ctx.state === 'suspended') {
      // 浏览器自动播放策略：没有用户手势时 resume() 会**一直 pending**（既不 resolve 也不 reject）。
      // 绝不能无条件 await——那会让整个启动流程永久卡在"装载素材 100%"。
      // 这里与超时赛跑；超时也继续（引擎可在 suspended 下建图/合成），首个用户手势会再次 resume。
      try {
        await Promise.race([
          ctx.resume(),
          new Promise<void>((r) => { setTimeout(r, 600); }),
        ]);
      } catch (err) {
        this.warn.fire('resume-fail', `[audio] AudioContext.resume() 失败（需用户手势）：${String(err)}`);
      }
    }
    this.readyFlag = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    this.stopRecording();
    try {
      this.sfx?.dispose();
    } catch {
      /* 忽略 */
    }
    try {
      this.music?.dispose();
    } catch {
      /* 忽略 */
    }
    this.budget.forceAll();
    for (const n of [this.sfxBus, this.musicTone, this.musicFilter, this.musicBus, this.master, this.comp]) {
      safeDisconnect(n);
    }
    const ctx = this.ctx;
    this.ctx = null;
    this.sfx = null;
    this.music = null;
    this.readyFlag = false;
    if (ctx) {
      try {
        void ctx.close().catch(() => undefined);
      } catch {
        /* 忽略 */
      }
    }
  }

  /* ------------------------------------------------------------------ 只读状态 */

  /** 音频时钟（秒）；未初始化时返回 0 */
  get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  get ready(): boolean {
    return this.readyFlag;
  }

  /* ------------------------------------------------------------------ 播放 */

  /** 一次性音效；素材缺失时自动用内置兜底音，永不抛错 */
  play(name: string, opts?: PlayOptions): void {
    if (this.disposed || !this.readyFlag) return;
    this.ensureRunning();
    try {
      this.sfx?.play(name, opts);
    } catch (err) {
      this.warn.fire('play-fail:' + name, `[audio] 播放 "${name}" 失败（已忽略）：${String(err)}`);
    }
  }

  /**
   * 循环音（幂等）：key 由调用方定义；on=false 时 0.15 s 淡出并 stop。
   * thruster_loop 的增益/速率由 setParam('wellThrust') 实时调制。
   */
  loop(name: string, key: string, on: boolean, opts?: LoopOptions): void {
    if (this.disposed || !this.readyFlag) return;
    this.ensureRunning();
    try {
      this.sfx?.loop(name, key, on, opts);
    } catch (err) {
      this.warn.fire('loop-fail:' + name, `[audio] 循环音 "${name}" 操作失败（已忽略）：${String(err)}`);
    }
  }

  /* ------------------------------------------------------------------ 音乐 */

  /** 交叉淡化切换配乐；null = 淡出停止；会先停掉外来录音 */
  setMusic(track: MusicScore | null): void {
    if (this.disposed) return;
    this.pendingRecording = null;
    this.stopRecording();
    this.musicSet = true;
    this.pendingMusic = track;
    try {
      this.music?.setScore(track);
    } catch (err) {
      this.warn.fire('music-fail', `[audio] 配乐切换失败（已忽略）：${String(err)}`);
    }
  }

  /**
   * 播放一首已有的录音（循环），走音乐总线，因此静音 / 切后台 / 音效压低仍然生效。
   * 失败时返回 false，调用方可以退回程序化谱面。
   */
  playRecording(url: string, opts?: { loop?: boolean; onEnded?: () => void }): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    this.pendingRecording = url;
    this.pendingMusic = null;
    this.musicSet = true;
    this.recordedLoop = opts?.loop === true;
    this.recordedEnded = opts?.onEnded ?? null;
    const run = (): Promise<boolean> => {
      if (this.pendingRecording !== url || !this.ctx || !this.musicBus) return Promise.resolve(false);
      return this.beginRecording(url);
    };
    if (!this.readyFlag) return this.init().then(run);
    return run();
  }

  private async beginRecording(url: string): Promise<boolean> {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus || this.pendingRecording !== url) return false;
    this.ensureRunning();
    if (this.recordedUrl === url && this.recorded) return true;
    this.music?.setScore(null);
    const token = ++this.recordedToken;
    this.stopRecordingNodes();
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(raw.slice(0));
      if (token !== this.recordedToken || this.pendingRecording !== url) return false;
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      src.loop = this.recordedLoop;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.setTargetAtTime(0.55, ctx.currentTime, 0.18);
      src.connect(gain);
      gain.connect(bus);
      const ended = this.recordedEnded;
      src.onended = () => {
        if (token !== this.recordedToken) return;
        ended?.();
      };
      src.start();
      this.recorded = src;
      this.recordedGain = gain;
      this.recordedUrl = url;
      return true;
    } catch (err) {
      this.warn.fire('recording-fail', `[audio] 无法播放录音 ${url}：${String(err)}`);
      return false;
    }
  }

  private stopRecording(): void {
    this.recordedToken++;
    this.stopRecordingNodes();
  }

  private stopRecordingNodes(): void {
    const ctx = this.ctx;
    const gain = this.recordedGain;
    const src = this.recorded;
    this.recorded = null;
    this.recordedGain = null;
    this.recordedUrl = null;
    if (gain && ctx) {
      try { gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08); } catch { /* 忽略 */ }
    }
    if (src && ctx) {
      try { src.stop(ctx.currentTime + 0.35); } catch { /* 已经停过 */ }
    }
  }

  /** 0..1，驱动配器层数与音乐总线低通（900 Hz .. 16 kHz） */
  setIntensity(x: number): void {
    const v = clamp(Number.isFinite(x) ? x : 0, 0, 1);
    this.intensityTarget = v;
    this.music?.setIntensity(v);
    const f = this.musicFilter;
    if (f && this.ctx) f.frequency.setTargetAtTime(this.intensityToHz(v), this.ctx.currentTime, 0.15);
  }

  /* ------------------------------------------------------------------ 输出电平 */

  /** 0..1 */
  setMaster(gain: number): void {
    this.masterLevel = clamp(Number.isFinite(gain) ? gain : 0, 0, 1);
    this.applyMaster(0.18);
  }

  setMuted(m: boolean): void {
    this.muted = !!m;
    this.applyMaster(0.08);
  }

  /** 短暂压低音乐（号角/关键音效）；seconds 后恢复 */
  duck(seconds: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const now = ctx.currentTime;
    const hold = clamp(Number.isFinite(seconds) ? seconds : 0.6, 0.05, 12);
    const base = this.hidden ? 0 : this.musicLevel;
    const dipped = base * DUCK_LEVEL;
    this.glideGain(bus.gain, this.musicGlide, dipped, DUCK_ATTACK_TAU);
    const until = Math.max(now + hold, this.duckUntil);
    this.duckUntil = until;
    bus.gain.setTargetAtTime(base, until + 0.05, DUCK_RELEASE_TAU);
    this.musicGlide.value = dipped;
    this.musicGlide.toward = base;
    this.musicGlide.at = now;
    this.musicGlide.tau = DUCK_RELEASE_TAU;
  }

  /* ------------------------------------------------------------------ 实时参数 */

  setParam(name: string, v: number): void {
    const x = Number.isFinite(v) ? v : 0;
    switch (name as AudioParamName) {
      case 'wellMass':
        this.params.wellMass = clamp(x / 0.05, 0, 1);
        this.sfx?.remodulate('thruster_loop');
        break;
      case 'wellThrust':
        this.thrustSeen = true;
        this.params.wellThrust = x <= 1 ? clamp(x, 0, 1) : clamp(x / (x + 1), 0, 1);
        this.sfx?.remodulate('thruster_loop');
        break;
      case 'slowmo':
        this.params.slowmo = clamp(x, 0, 1);
        this.music?.setSlowmo(this.params.slowmo);
        this.applyToneFilter(0.1);
        break;
      case 'alert':
        this.params.alert = clamp(x, 0, 1);
        this.music?.setAlert(this.params.alert);
        break;
      case 'fuel':
        this.params.fuel = clamp(x, 0, 1);
        this.music?.setFuel(this.params.fuel);
        break;
      case 'stability':
        this.params.stability = clamp(x, 0, 1);
        this.music?.setStability(this.params.stability);
        break;
      case 'musicGain':
        this.musicLevel = clamp(x, 0, 1);
        this.applyMusicBus(0.18);
        break;
      case 'sfxGain':
        this.sfxLevel = clamp(x, 0, 1);
        this.applySfxBus(0.18);
        break;
      default:
        break; // 未知参数：静默忽略（不抛错）
    }
  }

  /* ------------------------------------------------------------------ 内部 */

  /** 推进器：推力越大越响越快（未调用过 setParam('wellThrust') 时不干预调用方给的增益） */
  private readonly loopModulation = (name: string): LoopModulation | null => {
    if (name !== 'thruster_loop') return null;
    if (!this.thrustSeen) return { gainScale: 1, rateScale: 1 };
    const t = this.params.wellThrust;
    const m = this.params.wellMass;
    return {
      gainScale: clamp(0.12 + 0.95 * t, 0.05, 2.5),
      rateScale: clamp(0.7 + 0.6 * t + 0.1 * m, 0.4, 2.2),
    };
  };

  private readonly onMusicTick = (now: number): void => {
    const f = this.musicFilter;
    if (f && this.music) {
      f.frequency.setTargetAtTime(this.intensityToHz(this.music.intensity), now, 0.15);
    }
  };

  private intensityToHz(x: number): number {
    return MUSIC_LP_MIN * Math.pow(MUSIC_LP_MAX / MUSIC_LP_MIN, clamp(x, 0, 1));
  }

  private effectiveMaster(): number {
    return this.muted || this.hidden ? 0 : this.masterLevel;
  }

  private sampleGlide(g: { value: number; toward: number; at: number; tau: number }, now: number): number {
    const dt = Math.max(0, now - g.at);
    return g.toward + (g.value - g.toward) * Math.exp(-dt / Math.max(0.001, g.tau));
  }

  /** 从当前响度滑向目标，不读 AudioParam.value（那是上一次写下的目标，不是耳朵里的值）。 */
  private glideGain(param: AudioParam, g: { value: number; toward: number; at: number; tau: number }, target: number, tau: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const current = this.sampleGlide(g, now);
    const safeTau = Math.max(0.02, tau);
    param.cancelScheduledValues(now);
    param.setValueAtTime(Math.max(0, current), now);
    param.setTargetAtTime(Math.max(0, target), now, safeTau);
    g.value = current;
    g.toward = target;
    g.at = now;
    g.tau = safeTau;
  }

  private applyMaster(ramp: number): void {
    const g = this.master?.gain;
    if (!g) return;
    this.glideGain(g, this.masterGlide, this.effectiveMaster(), ramp);
  }

  private applyMusicBus(ramp: number): void {
    const g = this.musicBus?.gain;
    if (!g) return;
    this.glideGain(g, this.musicGlide, this.hidden ? 0 : this.musicLevel, ramp);
  }

  private applySfxBus(ramp: number): void {
    const g = this.sfxBus?.gain;
    if (!g) return;
    this.glideGain(g, this.sfxGlide, this.sfxLevel, ramp);
  }

  private applyToneFilter(ramp: number): void {
    const ctx = this.ctx;
    const f = this.musicTone;
    if (!ctx || !f) return;
    const hz = TONE_LP_OPEN * Math.pow(TONE_LP_SLOW / TONE_LP_OPEN, this.params.slowmo);
    f.frequency.setTargetAtTime(hz, ctx.currentTime, Math.max(0.01, ramp));
  }

  /** 上下文被浏览器挂起时（切标签/系统休眠）尽力恢复；播放路径里顺手 resume 是安全的 */
  private ensureRunning(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state === 'suspended') {
      try {
        void ctx.resume().catch(() => undefined);
      } catch {
        /* 忽略 */
      }
    }
  }

  private readHidden(): boolean {
    if (typeof document === 'undefined') return false;
    if (typeof document.hidden === 'boolean') return document.hidden;
    return document.visibilityState === 'hidden';
  }

  private readonly onVisibility = (): void => {
    this.setHidden(this.readHidden(), false);
  };

  /**
   * 页面隐藏：暂停配乐调度器并压掉输出（不 suspend 上下文，
   * 以免无头自检/后台标签页里被浏览器策略卡住）。
   */
  private setHidden(hidden: boolean, force: boolean): void {
    if (!force && this.hidden === hidden) return;
    this.hidden = hidden;
    if (hidden) {
      this.music?.pause();
      this.applyMusicBus(0.06);
    } else {
      this.music?.resume();
      this.applyMusicBus(0.3);
    }
    this.applyMaster(hidden ? 0.06 : 0.2);
  }
}
