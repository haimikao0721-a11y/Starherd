/**
 * STARHERD — 渲染器（W-render，接口冻结）
 *
 * 纯 Canvas 2D，无 WebGL、无第三方库。
 *  - 世界层用 ctx 变换（translate/rotate/scale）直接以世界单位绘制
 *  - 位置一律用 alpha 插值：x = px + (x - px) * alpha（120Hz 物理 → 60Hz 渲染不抖）
 *  - 天体内部分辨率 = CSS 尺寸 × dpr，绘制坐标恒为 CSS 像素（setTransform(dpr,0,0,dpr,0,0)）
 *  - 热路径零分配：粒子走 typed array 池，等势线 120ms 缓存 Path2D，染色精灵按 (名,色) 缓存
 */
import type { AssetStore, Body, FxEvent, Palette, Quality, ViewState, World } from '../sim/types';
import { DEFAULT_QUALITY } from '../sim/types';
import { PX_PER_RU } from '../engine/view';
import {
  DrawEnv, DockInfo, PredictionCache, SpriteBank, WellView, blitC, clamp, ctx2d, drawBody, drawBounds,
  drawDock, drawFieldZones, drawGrid, drawOrbits, drawPredicted, drawTrail, drawVelocityVectors, drawWell, glowAt, makeCanvas,
  makeDockInfo, makeWellView, mixColor, perf, seedRng, tintColor, wo,
} from './draw';
import { Starfield } from './starfield';
import { Particles } from './particles';
import { FieldLayer } from './field';
import { PostFX } from './postfx';

const FX_RING = 64;
const RS_MIN = 0.35;
const RS_MAX = 1.0;
const MAX_DPR = 2;

interface ParticleStat { sparks: number; shards: number; streaks: number; glows: number; rings: number; spriteShards: number; }

interface DebugInfo {
  fps: number;
  particles: number;
  drawCalls: number;
  frameMs: number;
  /** 各类粒子上帧实际绘制数量（诊断） */
  fx: ParticleStat | null;
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

export class Renderer {
  /**
   * 暴露给 game 层：world.fx 由谁消费。
   * 默认 false —— game.ts 的 drainFx() 已经把每一条 world.fx 转发给 pushFx() 并清空数组，
   * 若再自行摄取会每条特效双重生成。集成方若改为「renderer 自己吃 world.fx」，
   * 把它设成 true，并让 game 层停止转发。
   */
  ingestWorldFx = false;

  readonly stats: { fps: number; drawCalls: number; particles: number } = { fps: 60, drawCalls: 0, particles: 0 };

  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private scene: HTMLCanvasElement;
  /** 场景渲染分辨率比例 */
  /** 渲染分辨率比例（自适应）：上限 1.0 原生、下限 0.35（再低画面太糊） */
  private rs = 0.62;
  private rsApplied = 0.62;
  private adaptWarmup = 0;
  /** 是否由性能自动调节分辨率（false = 玩家用滑块固定） */
  private rsAuto = true;
  private sg: CanvasRenderingContext2D;
  private bank: SpriteBank;
  private post: PostFX;
  private parts: Particles;
  private field = new FieldLayer();
  private stars: Starfield;
  private pal: Palette;
  private q: Quality;
  private lastVQ: Quality;
  private env: DrawEnv;

  private w = 1600;
  private h = 900;
  private dpr = 1;
  private t = 0;

  private fps = 60;
  private frameMs = 0;
  private dbg: DebugInfo = { fps: 60, particles: 0, drawCalls: 0, frameMs: 0, fx: null };

  private camX = 0;
  private camY = 0;
  private camZoom = 1;
  private camInit = false;
  private shakeEnv = 0;
  private shakeImpulse = 0;
  private shX = 0;
  private shY = 0;
  private shRot = 0;
  private warnHold = 0;

  private dockInfo: DockInfo = makeDockInfo();
  private wellView: WellView = makeWellView();
  private pred = new PredictionCache();
  private dockBody: Body | null = null;

  private fxRing: (FxEvent | null)[] = new Array<FxEvent | null>(FX_RING).fill(null);
  private fxHead = 0;
  private fxCount = 0;
  private fxSeen = new WeakSet<FxEvent>();

  constructor(canvas: HTMLCanvasElement, opts: { assets: AssetStore; palette: Palette; quality: Quality }) {
    this.canvas = canvas;
    this.g = ctx2d(canvas);
    this.pal = opts.palette;
    this.q = { ...(opts.quality || DEFAULT_QUALITY) };
    this.lastVQ = { ...this.q };
    this.bank = new SpriteBank(opts.assets);
    this.parts = new Particles(this.q.maxParticles);
    this.stars = new Starfield(this.bank, this.pal);
    this.scene = makeCanvas(1, 1);
    this.sg = ctx2d(this.scene);
    this.post = new PostFX(this.g, this.bank);
    this.post.setQuality(this.q);
    this.dbg.fx = this.parts.stat;
    this.env = {
      g: this.sg, bank: this.bank, pal: this.pal, t: 0, s: PX_PER_RU, inv: 1 / PX_PER_RU,
      gs: this.q.glowScale || 1, quality: this.q, starX: 0, starY: 0, budget: 1,
    };
    seedRng(0x4c435552); // "LCUR"
    const cw = canvas.clientWidth || canvas.width || 1600;
    const ch = canvas.clientHeight || canvas.height || 900;
    const d = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
    this.resize(cw, ch, Math.min(MAX_DPR, Math.max(1, d)));
    this.installDebug();
  }

  /**
   * window.__LC_DEBUG：自动化测试读取 {fps, particles, drawCalls, frameMs}。
   * game 层每帧会整体赋值 window.__LC_DEBUG（publishDebug），所以这里装一个
   * 「getter 返回稳定对象 + setter 合并对方字段」的访问器：
   * 两边写入都不丢，四个渲染指标始终是本渲染器的权威值。
   */
  private installDebug(): void {
    if (typeof window === 'undefined') return;
    const g = window as unknown as Record<string, unknown>;
    const existing = g.__LC_DEBUG;
    if (existing && typeof existing === 'object') this.mergeDebug(existing as Record<string, unknown>);
    try {
      Object.defineProperty(window, '__LC_DEBUG', {
        configurable: true,
        enumerable: true,
        get: () => this.dbg,
        set: (v: unknown) => {
          if (v && typeof v === 'object') this.mergeDebug(v as Record<string, unknown>);
          this.writeDebug();
        },
      });
    } catch (e) {
      this.mergeDebug({ __LC_DEBUG: undefined } as Record<string, unknown>);
      g.__LC_DEBUG = this.dbg;
    }
    this.writeDebug();
  }

  private mergeDebug(src: Record<string, unknown>): void {
    const dst = this.dbg as unknown as Record<string, unknown>;
    for (const k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) dst[k] = src[k];
    }
  }

  private writeDebug(): void {
    this.dbg.fps = this.fps;
    this.dbg.particles = this.parts.live;
    this.dbg.drawCalls = perf.draws;
    this.dbg.frameMs = this.frameMs;
    (this.dbg as DebugInfo & { renderScale?: number }).renderScale = this.rs;
  }

  /* ------------------------------------------------------------ 尺寸 */

  /**
   * 自适应渲染分辨率（用户反馈"只有 30Hz"的根因：`quality.targetFps` 一直存着却没人使用）。
   * 做法：以目标帧时间为预算，持续超标就降 `rs`，余量充足再回升；物理仍是 120Hz 固定步长，
   * **只有渲染分辨率随帧预算伸缩**——于是 60Hz 屏与 120Hz 屏都能落在各自目标上。
   * 用滞后带（1.12 / 0.72）避免在阈值附近来回抖动。
   */
  /**
   * 手动固定渲染分辨率（玩家反馈"分辨率设置作用不大"）。
   * `auto=false` 时关闭自动调节，完全按传入比例渲染；`auto=true` 交回自适应。
   */
  setRenderScale(v: number, auto: boolean): void {
    this.rsAuto = auto;
    const nv = clamp(v, RS_MIN, RS_MAX);
    if (auto || Math.abs(nv - this.rs) > 1e-3) {
      this.rs = auto ? this.rs : nv;
      if (Math.abs(this.rs - this.rsApplied) > 1e-3) {
        this.rsApplied = this.rs;
        this.resize(this.w, this.h, this.dpr);
      }
    }
  }

  get renderScale(): number { return this.rs; }
  get renderScaleAuto(): boolean { return this.rsAuto; }

  private adaptRenderScale(): void {
    if (!this.rsAuto) return;
    if (this.adaptWarmup < 45) { this.adaptWarmup++; return; }
    const target = clamp(this.q.targetFps || 60, 30, 144);
    const budget = 1000 / target;
    if (this.frameMs > budget * 1.12) {
      // **先降最贵的特效，再降分辨率**（反馈："弱机卡顿、分辨率设置作用不大"）。
      // 顺序按实测开销排：泛光/色差(全屏后处理) > 星场层数 > 渲染分辨率。
      // 分辨率最低只到 0.35，单靠它救不了弱机；把后处理关掉往往立竿见影。
      if (this.q.bloom && this.frameMs > budget * 1.2) { this.setQuality({ bloom: false }); return; }
      if (this.q.chroma && this.frameMs > budget * 1.2) { this.setQuality({ chroma: false }); return; }
      if (this.q.starLayers > 1 && this.frameMs > budget * 1.2) {
        this.setQuality({ starLayers: this.q.starLayers - 1 }); return;
      }
      if (this.q.fieldContours && this.frameMs > budget * 1.35) { this.setQuality({ fieldContours: false }); return; }
      this.rs = Math.max(RS_MIN, this.rs - 0.05);
    } else if (this.frameMs < budget * 0.72) {
      this.rs = Math.min(RS_MAX, this.rs + 0.01);
    } else {
      return;
    }
    if (Math.abs(this.rs - this.rsApplied) > 1e-3) {
      this.rsApplied = this.rs;
      this.resize(this.w, this.h, this.dpr);
    }
  }

  resize(w: number, h: number, dpr: number): void {
    const nw = Math.max(1, Math.round(w));
    const nh = Math.max(1, Math.round(h));
    const nd = clamp(dpr > 0 ? dpr : 1, 0.5, MAX_DPR * 2);
    const dw = Math.max(1, Math.round(nw * nd));
    const dh = Math.max(1, Math.round(nh * nd));
    const changed = nw !== this.w || nh !== this.h || nd !== this.dpr;
    this.w = nw;
    this.h = nh;
    this.dpr = nd;
    if (this.canvas.width !== dw) this.canvas.width = dw;
    if (this.canvas.height !== dh) this.canvas.height = dh;
    if (this.canvas.style) {
      this.canvas.style.width = nw + 'px';
      this.canvas.style.height = nh + 'px';
    }
    // 场景按 renderScale 降到子分辨率渲染，最终以"小图放大"合成到可见画布。
    // 实测：本环境里大画布 1:1 合成会退化到 CPU 路径（30ms+），而放大合成走 GPU 快路径（<1ms），
    // 同时整场光栅化像素数按 renderScale² 下降。
    const rd = nd * this.rs;
    const sdw = Math.max(2, Math.round(nw * rd));
    const sdh = Math.max(2, Math.round(nh * rd));
    if (this.scene.width !== sdw) this.scene.width = sdw;
    if (this.scene.height !== sdh) this.scene.height = sdh;
    this.sg.setTransform(rd, 0, 0, rd, 0, 0);
    this.post.resize(nw, nh, nd);
    this.stars.setViewport(nw, nh, rd);
    if (changed) this.field.invalidate();
  }

  private syncSize(view: ViewState): void {
    if (!view) return;
    const vw = view.w, vh = view.h, vd = view.dpr;
    if (vw > 0 && vh > 0 && (vw !== this.w || vh !== this.h || (vd > 0 && vd !== this.dpr))) {
      this.resize(vw, vh, vd > 0 ? vd : this.dpr);
    }
  }

  /* ------------------------------------------------------------ 调色板 / 质量 */

  setPalette(p: Palette): void {
    this.pal = p;
    this.env.pal = p;
    this.stars.setPalette(p);
    this.field.invalidate();
  }

  setQuality(q: Partial<Quality>): void {
    const t = this.q;
    if (q.maxParticles !== undefined) t.maxParticles = q.maxParticles;
    if (q.trails !== undefined) t.trails = q.trails;
    if (q.bloom !== undefined) t.bloom = q.bloom;
    if (q.chroma !== undefined) t.chroma = q.chroma;
    if (q.fieldContours !== undefined) t.fieldContours = q.fieldContours;
    if (q.starLayers !== undefined) t.starLayers = q.starLayers;
    if (q.glowScale !== undefined) t.glowScale = q.glowScale;
    if (q.targetFps !== undefined) t.targetFps = q.targetFps;
    this.applyQuality();
  }

  /** view.quality 变了才覆盖内部质量（setQuality 的效果不会被未变化的 view.quality 冲掉） */
  private syncQuality(vq: Quality | undefined): void {
    if (!vq) return;
    const l = this.lastVQ;
    if (
      vq.maxParticles === l.maxParticles && vq.trails === l.trails && vq.bloom === l.bloom &&
      vq.chroma === l.chroma && vq.fieldContours === l.fieldContours && vq.starLayers === l.starLayers &&
      vq.glowScale === l.glowScale && vq.targetFps === l.targetFps
    ) return;
    l.maxParticles = vq.maxParticles; l.trails = vq.trails; l.bloom = vq.bloom; l.chroma = vq.chroma;
    l.fieldContours = vq.fieldContours; l.starLayers = vq.starLayers; l.glowScale = vq.glowScale; l.targetFps = vq.targetFps;
    this.setQuality(vq);
  }

  private applyQuality(): void {
    const q = this.q;
    this.parts.setCapacity(Math.max(64, q.maxParticles | 0));
    this.post.setQuality(q);
    this.stars.setQuality(q);
    this.field.invalidate();
    this.env.gs = q.glowScale > 0 ? q.glowScale : 1;
    this.env.quality = q;
  }

  /* ------------------------------------------------------------ 特效队列 */

  pushFx(ev: FxEvent): void {
    if (!ev) return;
    const i = this.fxHead;
    this.fxRing[i] = ev;
    this.fxHead = i + 1 >= FX_RING ? 0 : i + 1;
    if (this.fxCount < FX_RING) this.fxCount++;
  }

  private drainFx(world: World, view: ViewState): void {
    if (this.fxCount === 0) return;
    const n = this.fxCount;
    this.fxCount = 0;
    let start = this.fxHead - n;
    if (start < 0) start += FX_RING;
    for (let k = 0; k < n; k++) {
      let i = start + k;
      if (i >= FX_RING) i -= FX_RING;
      const ev = this.fxRing[i];
      this.fxRing[i] = null;
      if (ev) this.parts.emit(ev, world, this.pal, view, this.bank);
    }
  }

  /** world.fx 由 sim/game 填充：按对象身份去重（同一事件只吃一次），保证「清空后重建」与「追加」两种约定都成立 */
  private ingestWorldFxEvents(world: World, view: ViewState): void {
    if (!this.ingestWorldFx) return;
    const arr = world.fx;
    if (!arr || arr.length === 0) return;
    const n = arr.length;
    const start = n > 48 ? n - 48 : 0;
    for (let i = start; i < n; i++) {
      const ev = arr[i];
      if (!ev || this.fxSeen.has(ev)) continue;
      this.fxSeen.add(ev);
      this.parts.emit(ev, world, this.pal, view, this.bank);
    }
  }

  /* ------------------------------------------------------------ 相机 / 屏震 */

  private updateCamera(world: World, view: ViewState, dt: number): void {
    const cam = view.camera;
    if (!cam) return;
    const wantX = cam.x;
    const wantY = cam.y;
    let wantZ = view.targetZoom > 0.01 ? view.targetZoom : cam.zoom;
    if (!(wantZ > 0.01)) wantZ = 1;
    wantZ = clamp(wantZ, 0.12, 8);
    if (!this.camInit) {
      this.camInit = true;
      this.camX = wantX; this.camY = wantY; this.camZoom = wantZ;
    } else {
      this.camX = wantX;
      this.camY = wantY;
      const k = 1 - Math.exp(-dt * 7.5);
      this.camZoom += (wantZ - this.camZoom) * k;
    }
    // 回写（供鼠标拾取复用；屏震只作用于绘制变换，不污染拾取）
    cam.x = this.camX;
    cam.y = this.camY;
    cam.zoom = this.camZoom;
  }

  private updateShake(view: ViewState, dt: number): void {
    this.shakeImpulse *= Math.exp(-dt * 2.6);
    if (this.shakeImpulse < 0.002) this.shakeImpulse = 0;
    const amp = clamp(view.shake, 0, 3) * 10 + clamp(this.shakeImpulse, 0, 3) * 8;
    this.shakeEnv += (amp - this.shakeEnv) * (1 - Math.exp(-dt * 16));
    if (this.shakeEnv < 0.01) {
      this.shakeEnv = 0;
      this.shX = 0; this.shY = 0; this.shRot = 0;
      return;
    }
    const t = this.t;
    // 高频噪声（时间函数，不是每帧跳变的随机数）
    const nx = wo(t, 41.3, 0.7) * 0.55 + wo(t, 27.1, 2.3) * 0.3 + wo(t, 63.7, 4.1) * 0.15;
    const ny = wo(t, 37.9, 1.9) * 0.55 + wo(t, 31.7, 3.7) * 0.3 + wo(t, 71.3, 5.3) * 0.15;
    const nr = wo(t, 23.3, 2.7);
    this.shX = nx * this.shakeEnv * 0.5;
    this.shY = ny * this.shakeEnv * 0.5;
    this.shRot = clamp(nr * this.shakeEnv * 0.00035, -0.00698, 0.00698); // ≤ 0.4°
  }

  private slowAmount(world: World, view: ViewState): number {
    // 三种可能约定都兼容：时间缩放(1=正常, 0.25=慢动作) / 强度(0=无, 1=最强)
    let s = 0;
    const cand = [view.slowmo, world.slowmo, world.timeScale];
    for (let i = 0; i < cand.length; i++) {
      const v = cand[i];
      if (v > 0 && v < 1) {
        const k = 1 - v;
        if (k > s) s = k;
      }
    }
    return clamp(s, 0, 1);
  }

  /* ------------------------------------------------------------ 主帧 */

  frame(world: World, alpha: number, dtReal: number, view: ViewState): void {
    const t0 = now();
    const dt = clamp(dtReal > 0 ? dtReal : 1 / 60, 0.0005, 0.1);
    const a = clamp(alpha, 0, 1);
    perf.draws = 0;

    this.syncSize(view);
    if (view) this.syncQuality(view.quality);
    this.bank.tick();
    this.t += dt;

    const inst = 1 / clamp(dtReal > 0 ? dtReal : 1 / 60, 0.0005, 0.5);
    this.fps += (inst - this.fps) * 0.08;

    // 特效：pushFx 队列 + world.fx
    this.drainFx(world, view);
    this.ingestWorldFxEvents(world, view);
    this.shakeImpulse += this.parts.impulse;
    this.parts.impulse = 0;
    if (this.parts.warn > 0) this.warnHold = 1;
    else this.warnHold *= Math.exp(-dt * 1.6);
    this.parts.warn = 0;

    const slow = this.slowAmount(world, view);
    const hitstop = clamp(view.hitstop, 0, 1);
    const dtP = dt * (1 - 0.72 * slow) * (1 - hitstop * 0.85);
    this.parts.update(dtP, world);

    this.updateCamera(world, view, dt);
    this.updateShake(view, dt);
    this.stars.update(dt, this.q);

    this.drawScene(world, a, view, dt, slow);

    this.post.composite(this.scene, view, this.pal, this.t, clamp(this.warnHold, 0, 1), slow, hitstop);

    const ms = now() - t0;
    this.frameMs += (ms - this.frameMs) * 0.1;
    this.adaptRenderScale();
    this.stats.fps = this.fps;
    this.stats.drawCalls = perf.draws;
    this.stats.particles = this.parts.live;
    this.writeDebug();
  }

  /** 关卡开始/结束：清空残留特效与拖尾、缓存 */
  reset(): void {
    this.parts.reset();
    this.field.invalidate();
    this.pred.clear();
    this.fxRing.fill(null);
    this.fxHead = 0;
    this.fxCount = 0;
    this.fxSeen = new WeakSet<FxEvent>();
    this.shakeEnv = 0;
    this.shakeImpulse = 0;
    this.shX = 0; this.shY = 0; this.shRot = 0;
    this.warnHold = 0;
    this.post.reset();
    this.camInit = false;
  }

  /* ------------------------------------------------------------ 场景绘制 */

  private drawScene(world: World, a: number, view: ViewState, dt: number, slow: number): void {
    const sg = this.sg;
    const w = this.w, h = this.h;
    const rd = this.dpr * this.rs;
    sg.setTransform(rd, 0, 0, rd, 0, 0);
    sg.globalCompositeOperation = 'source-over';
    sg.globalAlpha = 1;
    sg.lineCap = 'butt';
    sg.lineJoin = 'miter';
    sg.setLineDash(DASH_EMPTY);

    // 背景：渐变 + 星云 + 视差星场（内部 device px、1:1 整数偏移合成）
    this.stars.draw(sg, this.camX, this.camY, this.camZoom, this.shX, this.shY);

    // 世界变换（背景层会把变换重置为 identity，这里重新建立）
    sg.setTransform(rd, 0, 0, rd, 0, 0);
    sg.globalCompositeOperation = 'source-over';
    sg.globalAlpha = 1;
    const s = PX_PER_RU * this.camZoom;
    const env = this.env;
    env.g = sg;
    env.pal = this.pal;
    env.t = this.t;
    env.s = s;
    env.inv = 1 / s;
    env.gs = this.q.glowScale > 0 ? this.q.glowScale : 1;
    env.quality = this.q;
    env.budget = clamp(view.intensity, 0.2, 1);

    // 主恒星位置（受光方向）
    let starX = 0, starY = 0, found = false;
    const bodies = world.bodies;
    for (let i = 0; i < bodies.length; i++) {
      if (bodies[i].kind === 'star') {
        starX = bodies[i].px + (bodies[i].x - bodies[i].px) * a;
        starY = bodies[i].py + (bodies[i].y - bodies[i].py) * a;
        found = true;
        break;
      }
    }
    env.starX = starX;
    env.starY = starY;

    sg.save();
    sg.translate(w * 0.5 + this.shX, h * 0.5 + this.shY);
    if (this.shRot !== 0) sg.rotate(this.shRot);
    sg.scale(s, s);
    sg.translate(-this.camX, -this.camY);

    const viewR = (0.5 * Math.hypot(w, h)) / s + 0.5;
    const hw = w * 0.5 / s;
    const hh = h * 0.5 / s;

    // 坐标环网格 + 边界圈
    drawGrid(env, this.camX, this.camY, viewR, world.bounds);
    let prox = 0;
    const wl = world.well;
    if (wl) {
      const dmax = Math.hypot(wl.px + (wl.x - wl.px) * a, wl.py + (wl.y - wl.py) * a);
      prox = clamp((dmax - world.bounds * 0.72) / (world.bounds * 0.28 || 1), 0, 1);
    }
    const podsArr = world.pods;
    for (let i = 0; i < podsArr.length; i++) {
      const p = podsArr[i];
      const d = Math.hypot(p.x, p.y) / (world.bounds || 1);
      if (d > prox) prox = clamp((d - 0.72) / 0.28, 0, 1);
    }
    drawBounds(env, world.bounds, prox);

    if (view.showOrbits) drawOrbits(env, world, starX, starY);
    drawFieldZones(env, world);

    // 引力场：等势线（真实等势面，marching squares）+ 场向量箭头
    this.field.draw(env, world, dt, !!view.showField && !!this.q.fieldContours, !!view.showVectors);

    // 预测轨迹（Path2D 15 Hz 缓存，虚线 + 末端虚影货舱）
    if (view.showPredict) {
      this.pred.update(world, dt);
      const gr = podsArr.length > 0 ? podsArr[0].radius : 0.012;
      drawPredicted(env, world, this.pred, Math.max(gr, 0.008));
    }
    if (view.showVectors) drawVelocityVectors(env, world);

    // 拖尾（在天体之下）
    if (this.q.trails) {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (b.trailN < 2) continue;
        const bx = b.px + (b.x - b.px) * a;
        const by = b.py + (b.y - b.py) * a;
        if (Math.abs(bx - this.camX) > hw + 1 || Math.abs(by - this.camY) > hh + 1) continue;
        const col = b.kind === 'pod' ? this.pal.pod
          : b.kind === 'station' ? this.pal.station
            : b.kind === 'star' ? this.pal.star2
              : tintColor(this.pal, b.tint);
        drawTrail(sg, b, col, env.inv, b.kind === 'pod' ? 0.62 : 0.4, bx, by);
      }
    }

    // 天体
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      const bx = b.px + (b.x - b.px) * a;
      const by = b.py + (b.y - b.py) * a;
      const pad = Math.max(0.4, b.radius * 24);
      if (Math.abs(bx - this.camX) > hw + pad || Math.abs(by - this.camY) > hh + pad) continue;
      drawBodyAt(env, b, bx, by);
    }

    // 对接环
    const dock = world.dock;
    if (dock) {
      const di = this.dockInfo;
      di.x = dock.x; di.y = dock.y;
      di.r = dock.radius || 0.05;
      di.vMax = dock.vMax || 0.09;
      di.pulse = clamp(dock.pulse, 0, 1);
      di.hasPod = false;
      let best = Infinity;
      for (let i = 0; i < podsArr.length; i++) {
        const p = podsArr[i];
        if (p.delivered || p.lost) continue;
        const dd = (p.x - dock.x) * (p.x - dock.x) + (p.y - dock.y) * (p.y - dock.y);
        if (dd < best) {
          best = dd;
          di.hasPod = true;
          di.px = p.px + (p.x - p.px) * a;
          di.py = p.py + (p.y - p.py) * a;
          const db = this.resolveDockBody(world);
          const dvx = p.vx - (db ? db.vx : 0);
          const dvy = p.vy - (db ? db.vy : 0);
          di.rvx = dvx; di.rvy = dvy;
          di.vrel = Math.hypot(dvx, dvy);
          di.ok = di.vrel < di.vMax;
        }
      }
      drawDock(env, di);
    }

    // 引力井
    if (wl) {
      const wv = this.wellView;
      wv.x = wl.px + (wl.x - wl.px) * a;
      wv.y = wl.py + (wl.y - wl.py) * a;
      wv.tx = wl.tx; wv.ty = wl.ty;
      wv.mass = wl.mass; wv.k = wl.k;
      wv.engaged = wl.engaged; wv.repel = wl.repel;
      wv.intensity = wl.intensity; wv.thrust = wl.thrust;
      drawWell(env, wv);
    }

    // 粒子与冲击波
    this.parts.draw(env);

    sg.restore();
    sg.globalAlpha = 1;
    sg.globalCompositeOperation = 'source-over';
    sg.setLineDash(DASH_EMPTY);
  }

  private resolveDockBody(world: World): Body | null {
    const id = world.dock ? world.dock.bodyId : -1;
    if (this.dockBody && this.dockBody.id === id) return this.dockBody;
    this.dockBody = null;
    for (let i = 0; i < world.bodies.length; i++) {
      if (world.bodies[i].id === id) {
        this.dockBody = world.bodies[i];
        break;
      }
    }
    return this.dockBody;
  }
}

const DASH_EMPTY: number[] = [];

/** 以插值后的位置绘制天体（世界坐标已在 ctx 变换里）；临时借用 b.x/b.y，绘制后必定还原 */
function drawBodyAt(env: DrawEnv, b: Body, x: number, y: number): void {
  const ox = b.x, oy = b.y;
  b.x = x;
  b.y = y;
  try {
    drawBody(env, b);
  } finally {
    b.x = ox;
    b.y = oy;
  }
}

export type { Quality, Palette, AssetStore };
