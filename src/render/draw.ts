/**
 * STARHERD — 绘制原语 / 精灵染色缓存 / 天体绘制 （W-render）
 *
 * 性能铁律（本文件与所有调用方共同遵守）：
 *  - 绝不在热路径使用 shadowBlur / ctx.filter / createRadialGradient（每帧）
 *  - 发光全部靠 assets.image() 预渲染精灵 + globalCompositeOperation='lighter'
 *  - 染色精灵按 (spriteName, color) 缓存到离屏 canvas，启动/首次使用时生成一次
 *  - 热循环内不新建 canvas / 数组 / 对象；大量实体走 typed array + 对象池
 *
 * 坐标约定：调用方进入世界坐标变换（1 世界单位 = env.s 设备像素），
 * 因此本文件内所有几何量都以「世界单位」传入，线宽用 env.inv 由像素换算。
 */
import type { AssetStore, Body, Palette, Quality, Well, World } from '../sim/types';
import { PX_PER_RU } from '../engine/view';
import { hillSphere, tidalTearRadius } from '../sim/physics';

export const TAU = Math.PI * 2;

/** 绘制调用计数器（stats.drawCalls 来源，跨模块共享） */
export const perf = { draws: 0 };

/* ------------------------------------------------------------------ 数学 */

/** NaN 安全（未初始化的 ViewState 字段不会污染几何计算） */
export function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v === v ? v : a;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}
/** 确定性正弦振荡：用于屏震/脉动（不是每帧跳变的随机数） */
export function wo(t: number, f: number, ph: number): number {
  return Math.sin(t * f + ph);
}

/* ---- 确定性 PRNG（xorshift32，无分配，便于自动化测试复现） ---- */
let rngState = 0x9e3779b9 >>> 0;
export function seedRng(s: number): void {
  rngState = (s >>> 0) || 0x9e3779b9;
}
export function rnd(): number {
  let x = rngState;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  rngState = x || 0x9e3779b9;
  return x * 2.3283064365386963e-10;
}
export function rndR(a: number, b: number): number {
  return a + (b - a) * rnd();
}
export function rndS(a: number): number {
  return (rnd() * 2 - 1) * a;
}

/* ---- 值噪声 / fBm（程序化星云与云带；只在生成期调用） ---- */
function hash2i(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function wrapi(v: number, p: number): number {
  const m = v % p;
  return m < 0 ? m + p : m;
}
export function vnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = period > 0 ? wrapi(xi, period) : xi;
  const y0 = period > 0 ? wrapi(yi, period) : yi;
  const x1 = period > 0 ? wrapi(xi + 1, period) : xi + 1;
  const y1 = period > 0 ? wrapi(yi + 1, period) : yi + 1;
  const a = hash2i(x0, y0, seed), b = hash2i(x1, y0, seed);
  const c = hash2i(x0, y1, seed), d = hash2i(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
export function fbm(x: number, y: number, oct: number, base: number, seed: number, tile: boolean): number {
  let sum = 0, amp = 0.5, tot = 0, f = base, p = base;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f, tile ? p : 0, seed + i * 977);
    tot += amp;
    amp *= 0.5; f *= 2; p *= 2;
  }
  return sum / (tot || 1);
}

/* ------------------------------------------------------------------ canvas */

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext('2d');
  if (!g) throw new Error('LagrangeCourier/render: 2D context unavailable');
  return g;
}
function srcW(s: CanvasImageSource): number {
  const im = s as HTMLImageElement;
  if (im.naturalWidth) return im.naturalWidth;
  const cv = s as HTMLCanvasElement;
  return cv.width || 64;
}
function srcH(s: CanvasImageSource): number {
  const im = s as HTMLImageElement;
  if (im.naturalHeight) return im.naturalHeight;
  const cv = s as HTMLCanvasElement;
  return cv.height || 64;
}

/* ------------------------------------------------------------------ 颜色 */

const rgbCache = new Map<string, number>();
export function hexToRgb(hex: string): number {
  const c = rgbCache.get(hex);
  if (c !== undefined) return c;
  let v = 0xffffff;
  if (typeof hex === 'string' && hex.charCodeAt(0) === 35 && hex.length >= 7) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (r === r && g === g && b === b) v = ((r << 16) | (g << 8) | b) >>> 0;
  }
  if (rgbCache.size < 1024) rgbCache.set(hex, v);
  return v;
}
export function rgbToHex(v: number): string {
  const n = v >>> 0;
  return '#' + ((n & 0xffffff) | 0x1000000).toString(16).slice(1);
}
export function mixRgb(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = (((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * k)) | 0;
  const g = (((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * k)) | 0;
  const bl = ((a & 255) + (((b & 255) - (a & 255)) * k)) | 0;
  return ((r << 16) | (g << 8) | bl) >>> 0;
}
export function mixColor(a: string, b: string, t: number): string {
  return rgbToHex(mixRgb(hexToRgb(a), hexToRgb(b), t));
}
export function rgba(color: string, a: number): string {
  const v = hexToRgb(color);
  const alpha = a < 0 ? 0 : a > 1 ? 1 : a;
  return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + alpha + ')';
}

/* ------------------------------------------------------------------ 精灵库 */

function tintSprite(src: CanvasImageSource, color: string, shade: boolean): HTMLCanvasElement {
  const w = srcW(src), h = srcH(src);
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  g.drawImage(src, 0, 0, w, h);
  if (shade) {
    // 灰度亮度图（球体/云带/涡旋）：multiply 保亮度，再 destination-in 还原 alpha
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(src, 0, 0, w, h);
  } else {
    // 白色 alpha 形状（辉光/环/火花）：source-in 直接染色
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
  }
  g.globalCompositeOperation = 'source-over';
  return c;
}

/**
 * 精灵库：素材精灵 + 程序化回退 + (名称, 颜色) 染色缓存。
 * mode 0 = source-in（白色 alpha 形状），mode 1 = multiply（灰度亮度图）。
 */
export class SpriteBank {
  private assets: AssetStore;
  private rawCache = new Map<string, CanvasImageSource>();
  private rawFromAsset = new Set<string>();
  private procCache = new Map<string, HTMLCanvasElement>();
  private slots = new Map<string, number>();
  private slotColors: string[] = [];
  private cache = new Map<string, (HTMLCanvasElement | undefined)[][]>();
  private frame = 0;

  constructor(assets: AssetStore) {
    this.assets = assets;
    this.slot('#ffffff'); // slot 0 = 白
  }

  /** 颜色槽（粒子/热路径用整数索引，避免每帧拼 key 字符串） */
  slot(color: string): number {
    let s = this.slots.get(color);
    if (s === undefined) {
      if (this.slotColors.length >= 256) {
        this.slots.clear();
        this.slotColors.length = 0;
        this.cache.clear();
        this.slotColors.push('#ffffff');
        this.slots.set('#ffffff', 0);
      }
      s = this.slotColors.length;
      this.slotColors.push(color);
      this.slots.set(color, s);
    }
    return s;
  }
  colorOf(slot: number): string {
    const c = this.slotColors[slot];
    return c === undefined ? '#ffffff' : c;
  }
  bySlot(name: string, slot: number, mode: number): CanvasImageSource {
    let per = this.cache.get(name);
    if (per === undefined) {
      per = [];
      this.cache.set(name, per);
    }
    let arr = per[mode];
    if (arr === undefined) {
      arr = [];
      per[mode] = arr;
    }
    let c = arr[slot];
    if (c === undefined) {
      c = tintSprite(this.raw(name), this.colorOf(slot), mode === 1);
      arr[slot] = c;
    }
    return c;
  }
  byColor(name: string, color: string, mode: number): CanvasImageSource {
    return this.bySlot(name, this.slot(color), mode);
  }
  /** 白色 alpha 形状染色（辉光族） */
  tinted(name: string, color: string): CanvasImageSource {
    return this.byColor(name, color, 0);
  }
  /** 灰度亮度图着色（球体/云带/涡旋） */
  shaded(name: string, color: string): CanvasImageSource {
    return this.byColor(name, color, 1);
  }
  fromAsset(name: string): boolean {
    return this.rawFromAsset.has(name);
  }
  private tryImage(name: string): HTMLImageElement | undefined {
    try {
      const im = this.assets.image(name);
      if (im && im.complete && im.naturalWidth > 0) return im;
    } catch (e) {
      /* 素材仓库尚未就绪 / 名称未知：走程序化回退 */
    }
    return undefined;
  }
  raw(name: string): CanvasImageSource {
    let s = this.rawCache.get(name);
    if (s === undefined) {
      const im = this.tryImage(name);
      if (im) {
        s = im;
        this.rawFromAsset.add(name);
      } else {
        s = this.proc(name);
      }
      this.rawCache.set(name, s);
    }
    return s;
  }
  proc(name: string): HTMLCanvasElement {
    let c = this.procCache.get(name);
    if (c === undefined) {
      c = buildProcedural(name);
      this.procCache.set(name, c);
    }
    return c;
  }
  /** 每帧调用一次：素材若迟到加载完成，替换程序化回退并失效染色缓存 */
  tick(): void {
    this.frame++;
    if ((this.frame & 63) !== 0) return;
    let changed = false;
    const names: string[] = [];
    this.rawCache.forEach((_v, k) => {
      if (!this.rawFromAsset.has(k)) names.push(k);
    });
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      const im = this.tryImage(n);
      if (im) {
        this.rawCache.set(n, im);
        this.rawFromAsset.add(n);
        changed = true;
      }
    }
    if (changed) this.cache.clear();
  }
}

/* ------------------------------------------------------------------ 程序化回退精灵 */

function mkGlowSoft(size: number): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const f = r >= 1 ? 0 : Math.pow(1 - r, 2.1);
      const core = r >= 0.34 ? 0 : Math.pow(1 - r / 0.34, 2.6) * 0.75;
      const a = clamp(f + core, 0, 1);
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function mkGlowRing(size: number): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const band = Math.exp(-Math.pow((r - 0.82) / 0.11, 2));
      const halo = r > 0.82 ? Math.exp(-Math.pow((r - 0.82) / 0.3, 2)) * 0.22 : 0;
      const a = clamp(band + halo, 0, 1);
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function mkSpark(size: number): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const core = r >= 1 ? 0 : Math.pow(1 - r, 5.0);
      const sx = Math.exp(-Math.abs(dy) / 0.045) * Math.pow(Math.max(0, 1 - Math.abs(dx)), 2.6) * 0.55;
      const sy = Math.exp(-Math.abs(dx) / 0.045) * Math.pow(Math.max(0, 1 - Math.abs(dy)), 2.6) * 0.55;
      const a = clamp(core + sx + sy, 0, 1);
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function mkShard(size: number): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const R = size * 0.5;
  g.translate(R, R);
  g.beginPath();
  g.moveTo(-R * 0.85, -R * 0.25);
  g.lineTo(R * 0.9, -R * 0.6);
  g.lineTo(R * 0.35, R * 0.75);
  g.lineTo(-R * 0.55, R * 0.5);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.fill();
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.moveTo(-R * 0.1, -R * 0.9);
  g.lineTo(R * 0.18, R * 0.9);
  g.lineWidth = size * 0.06;
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.stroke();
  return c;
}

function mkStarField(size: number): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  g.clearRect(0, 0, size, size);
  const seedSave = rngState;
  seedRng(0x51a2b3);
  const n = 260;
  for (let i = 0; i < n; i++) {
    const x = rnd() * size, y = rnd() * size;
    const p = Math.pow(rnd(), 3.1); // 幂律亮度分布
    const a = 0.16 + p * 0.84;
    const s = p > 0.86 ? 2.2 : p > 0.5 ? 1.4 : 1;
    g.globalAlpha = a;
    g.fillStyle = '#ffffff';
    g.fillRect(x, y, s, s);
    if (p > 0.93) {
      g.globalAlpha = a * 0.22;
      g.fillRect(x - s * 2, y - s * 2, s * 5, s * 5);
    }
  }
  g.globalAlpha = 1;
  rngState = seedSave;
  return c;
}

function mkVignette(size: number): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.02);
      const a = Math.pow(r, 2.3) * 0.92;
      const i = (y * size + x) * 4;
      d[i] = 0; d[i + 1] = 0; d[i + 2] = 0;
      d[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function mkLens(w: number, h: number): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const g = ctx2d(c);
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const vy = Math.exp(-Math.pow((v - 0.5) / 0.26, 2));
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const ux = 0.25 + 0.75 * Math.pow(Math.sin(Math.PI * u), 1.3);
      const a = clamp(vy * ux, 0, 1);
      const i = (y * w + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function mkRingDock(size: number): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const R = size * 0.5;
  g.translate(R, R);
  g.strokeStyle = '#ffffff';
  g.lineWidth = size * 0.022;
  g.beginPath();
  g.arc(0, 0, R * 0.8, 0, TAU);
  g.stroke();
  g.globalAlpha = 0.75;
  g.lineWidth = size * 0.012;
  g.beginPath();
  g.arc(0, 0, R * 0.62, 0, TAU);
  g.stroke();
  // 刻度（真实对接环的机械感）
  g.globalAlpha = 0.95;
  g.lineWidth = size * 0.03;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    const r0 = R * (i % 3 === 0 ? 0.66 : 0.72);
    const r1 = R * 0.94;
    g.beginPath();
    g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    g.stroke();
  }
  g.globalAlpha = 1;
  return c;
}

function mkGridHex(size: number): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const R = size * 0.5;
  g.translate(R, R);
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 1;
  const r = R * 0.92;
  g.beginPath();
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * TAU + Math.PI / 6;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  return c;
}

function mkSphere(size: number): HTMLCanvasElement {
  // 灰度亮度图：光源自左侧（-x），边缘暗淡（limb darkening）
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const edge = 1 - smoothstep(0.88, 1.0, r);
      const nz = Math.sqrt(Math.max(0, 1 - Math.min(1, r) * Math.min(1, r)));
      const lit = clamp(-dx * 0.72 - dy * 0.28 + nz * 0.62, 0, 1);
      const v = Math.pow(0.06 + lit * 0.94, 1.35) * edge;
      const a = r >= 1 ? 0 : edge;
      const i = (y * size + x) * 4;
      const b = (v * 255) | 0;
      d[i] = b; d[i + 1] = b; d[i + 2] = b;
      d[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function mkBands(size: number): HTMLCanvasElement {
  // 圆盘内的横向云带（灰度亮度 + 圆盘 alpha），绘制时按自转角旋转
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const edge = 1 - smoothstep(0.9, 1.0, r);
      const band = fbm((x + 0.5) / size * 3.0, (y + 0.5) / size * 9.0, 4, 1, 7717, false);
      const v = clamp((band - 0.28) * 1.9, 0, 1) * edge;
      const i = (y * size + x) * 4;
      const b = (v * 255) | 0;
      d[i] = b; d[i + 1] = b; d[i + 2] = b;
      d[i + 3] = (edge * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function mkVortex(size: number): HTMLCanvasElement {
  // 螺旋臂（灰度亮度 + 径向 mask），用于引力井涡旋
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  const R = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      const a0 = Math.atan2(dy, dx);
      const mask = (1 - smoothstep(0.55, 1.0, r)) * smoothstep(0.05, 0.35, r);
      const sp = 0.5 + 0.5 * Math.sin(a0 * 2 + Math.log(Math.max(r, 0.04)) * 4.2);
      const v = Math.pow(sp, 2.4);
      const i = (y * size + x) * 4;
      const b = (v * 255) | 0;
      d[i] = b; d[i + 1] = b; d[i + 2] = b;
      d[i + 3] = (clamp(mask, 0, 1) * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function mkNebula(size: number, name: string): HTMLCanvasElement {
  // fBm 值噪声星云（可平铺），白色 + alpha 形状，按调色板染色
  const c = makeCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const d = img.data;
  let seed = 1337;
  for (let i = 0; i < name.length; i++) seed = (seed * 31 + name.charCodeAt(i)) | 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      let n = fbm(u, v, 4, 3, seed, true);
      n = Math.pow(clamp((n - 0.34) * 1.85, 0, 1), 1.5);
      const dx = u - 0.5, dy = v - 0.5;
      const rad = Math.sqrt(dx * dx + dy * dy) * 2;
      const mask = 1 - smoothstep(0.62, 1.0, rad);
      const a = clamp(n * mask, 0, 1);
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = (a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

export function buildProcedural(name: string): HTMLCanvasElement {
  switch (name) {
    case 'glow_soft': return mkGlowSoft(128);
    case 'glow_ring': return mkGlowRing(128);
    case 'spark': return mkSpark(64);
    case 'shard': return mkShard(32);
    case 'star_field': return mkStarField(256);
    case 'vignette': return mkVignette(192);
    case 'lens_gradient': return mkLens(160, 64);
    case 'ring_dock': return mkRingDock(128);
    case 'grid_hex': return mkGridHex(128);
    case 'nebula_loop1':
    case 'nebula_loop2':
    case 'nebula_loop3':
    case 'nebula_loop4':
    case 'nebula': return mkNebula(160, name);
    case 'sphere': return mkSphere(128);
    case 'bands': return mkBands(128);
    case 'vortex': return mkVortex(192);
    default: return mkGlowSoft(64);
  }
}

/* ------------------------------------------------------------------ 绘制环境 */

export interface DrawEnv {
  g: CanvasRenderingContext2D;
  bank: SpriteBank;
  pal: Palette;
  /** 视觉时钟（秒） */
  t: number;
  /** 设备像素 / 世界单位 */
  s: number;
  /** 世界单位 / 设备像素 */
  inv: number;
  /** 辉光强度系数（quality.glowScale） */
  gs: number;
  quality: Quality;
  /** 主恒星位置（天体受光方向） */
  starX: number;
  starY: number;
  budget: number;
}

export function blit(g: CanvasRenderingContext2D, src: CanvasImageSource, x: number, y: number, w: number, h: number, alpha: number): void {
  if (alpha <= 0.002 || w <= 0 || h <= 0) return;
  g.globalAlpha = alpha > 1 ? 1 : alpha;
  g.drawImage(src, x, y, w, h);
  perf.draws++;
}
export function blitC(g: CanvasRenderingContext2D, src: CanvasImageSource, cx: number, cy: number, w: number, h: number, alpha: number): void {
  blit(g, src, cx - w * 0.5, cy - h * 0.5, w, h, alpha);
}
/** 单次发光精灵的设备像素上限：超过它会退化到 CPU 重采样慢路径（宽晕交给 bloom） */
export const MAX_GLOW_PX = 320;

export function glowAt(env: DrawEnv, name: string, color: string, x: number, y: number, size: number, alpha: number): void {
  const max = MAX_GLOW_PX * env.inv;
  const sz = size > max ? max : size;
  blitC(env.g, env.bank.tinted(name, color), x, y, sz, sz, alpha);
}
export function glowAtS(env: DrawEnv, name: string, slot: number, x: number, y: number, size: number, alpha: number): void {
  const max = MAX_GLOW_PX * env.inv;
  const sz = size > max ? max : size;
  blitC(env.g, env.bank.bySlot(name, slot, 0), x, y, sz, sz, alpha);
}

/** 天体颜色：tint 索引 → 调色板 tints（闭环） */
export function tintColor(pal: Palette, tint: number): string {
  const n = pal.tints.length;
  if (n === 0) return pal.ui;
  const i = ((tint | 0) % n + n) % n;
  return pal.tints[i];
}

/* ------------------------------------------------------------------ 天体 */

export function drawStar(env: DrawEnv, b: Body): void {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const pulse = 0.9 + 0.1 * wo(env.t, 0.55 + (b.id % 7) * 0.03, b.id);
  const gs = env.gs;
  g.globalCompositeOperation = 'lighter';
  glowAt(env, 'glow_soft', pal.star2, b.x, b.y, R * 22 * pulse, 0.075 * gs);
  glowAt(env, 'glow_soft', pal.star2, b.x, b.y, R * 11 * pulse, 0.13 * gs);
  glowAt(env, 'glow_soft', pal.star, b.x, b.y, R * 5.2 * pulse, 0.3 * gs);
  glowAt(env, 'glow_soft', pal.star, b.x, b.y, R * 2.5, 0.62 * gs);
  // 稀薄日冕：两层缓慢反向自转的环
  g.save();
  g.translate(b.x, b.y);
  g.rotate(env.t * 0.05 + b.id);
  blitC(g, env.bank.tinted('glow_ring', pal.star), 0, 0, R * 4.4, R * 2.0, 0.14 * gs);
  g.rotate(-env.t * 0.09 - b.id * 2);
  blitC(g, env.bank.tinted('glow_ring', pal.star2), 0, 0, R * 3.1, R * 3.1, 0.1 * gs);
  g.restore();
  // 光球
  g.globalCompositeOperation = 'lighter';
  blitC(g, env.bank.shaded('sphere', mixColor(pal.star, '#ffffff', 0.55)), b.x, b.y, R * 2.05, R * 2.05, 1);
  if (b.contact > 0) glowAt(env, 'glow_soft', '#ffffff', b.x, b.y, R * 14, clamp(b.contact, 0, 1) * 0.5);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

export function drawPlanet(env: DrawEnv, b: Body): void {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const base = tintColor(pal, b.tint);
  const toStar = Math.atan2(env.starY - b.y, env.starX - b.x);
  g.globalCompositeOperation = 'lighter';
  // 大气/边缘光晕
  glowAt(env, 'glow_soft', mixColor(base, pal.star, 0.4), b.x, b.y, R * 7.5, 0.1 * env.gs);
  // 本体（光源朝向恒星）
  g.save();
  g.translate(b.x, b.y);
  g.rotate(toStar + Math.PI);
  blitC(g, env.bank.shaded('sphere', base), 0, 0, R * 2.06, R * 2.06, 1);
  g.restore();
  // 云带（随自转）
  g.save();
  g.translate(b.x, b.y);
  g.rotate(b.ang);
  blitC(g, env.bank.shaded('bands', mixColor(base, '#ffffff', 0.45)), 0, 0, R * 1.9, R * 1.9, 0.22);
  g.restore();
  // 边缘光（rim light）
  blitC(g, env.bank.tinted('glow_ring', mixColor(base, '#ffffff', 0.6)), b.x, b.y, R * 2.6, R * 2.6, 0.32 * env.gs);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

export function drawBlackHole(env: DrawEnv, b: Body): void {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const tilt = 0.34 + 0.06 * wo(env.t, 0.13, b.id);
  const dil = b.dilation > 0 ? clamp(b.dilation, 0.5, 4) : 1;
  const disk = mixColor(pal.star2, pal.well, 0.35);
  g.globalCompositeOperation = 'lighter';
  // 透镜化假象：光子环上下方向的径向拉伸
  g.save();
  g.translate(b.x, b.y);
  g.rotate(tilt);
  const lens = env.bank.tinted('lens_gradient', mixColor(pal.orbit, '#ffffff', 0.5));
  blitC(g, lens, 0, -R * 2.35, R * 5.6, R * 2.1, 0.3 * env.gs);
  blitC(g, lens, 0, R * 2.35, R * 5.6, R * 2.1, 0.3 * env.gs);
  blitC(g, lens, -R * 2.95, 0, R * 2.1, R * 5.6, 0.16 * env.gs);
  blitC(g, lens, R * 2.95, 0, R * 2.1, R * 5.6, 0.16 * env.gs);
  g.restore();
  // 吸积盘（椭圆、倾斜、含多普勒式左右不对称）
  g.save();
  g.translate(b.x, b.y);
  g.rotate(tilt);
  g.scale(1, 0.3);
  blitC(g, env.bank.tinted('glow_soft', disk), 0, 0, R * 7.2, R * 7.2, 0.34 * env.gs);
  blitC(g, env.bank.tinted('glow_soft', mixColor(disk, '#ffffff', 0.5)), -R * 1.5, 0, R * 5.0, R * 5.0, 0.34 * env.gs);
  blitC(g, env.bank.tinted('glow_soft', disk), R * 1.7, 0, R * 3.6, R * 3.6, 0.1 * env.gs);
  g.restore();
  // 光子环
  glowAt(env, 'glow_ring', mixColor(pal.star, '#ffffff', 0.35), b.x, b.y, R * 3.1, 0.85 * env.gs * dil);
  glowAt(env, 'glow_soft', mixColor(pal.orbit, '#ffffff', 0.4), b.x, b.y, R * 6.4, 0.16 * env.gs);
  // 视界（纯黑盘，压在最上层）
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = '#000000';
  g.beginPath();
  g.arc(b.x, b.y, R * 1.02, 0, TAU);
  g.fill();
  perf.draws++;
  // 盘的前缘（从黑洞前方掠过的一小段亮带）
  g.globalCompositeOperation = 'lighter';
  g.save();
  g.translate(b.x, b.y);
  g.rotate(tilt);
  g.scale(1, 0.3);
  g.strokeStyle = rgba(disk, 0.5);
  g.lineWidth = R * 0.34;
  g.beginPath();
  g.arc(0, 0, R * 2.5, Math.PI * 0.12, Math.PI * 0.88);
  g.stroke();
  perf.draws++;
  g.restore();
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

export function drawStation(env: DrawEnv, b: Body): void {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const col = pal.station;
  g.globalCompositeOperation = 'lighter';
  glowAt(env, 'glow_soft', col, b.x, b.y, R * 9, 0.09 * env.gs);
  // 旋转对接环
  g.save();
  g.translate(b.x, b.y);
  g.rotate(b.ang + env.t * 0.35);
  blitC(g, env.bank.tinted('ring_dock', col), 0, 0, R * 3.4, R * 3.4, 0.6);
  g.rotate(-env.t * 0.6);
  blitC(g, env.bank.tinted('ring_dock', mixColor(col, pal.station2, 0.6)), 0, 0, R * 2.2, R * 2.2, 0.35);
  g.restore();
  // 六边形骨架
  g.strokeStyle = rgba(col, 0.85);
  g.lineWidth = 1.6 * env.inv;
  g.beginPath();
  const rr = R * 1.05;
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * TAU + Math.PI / 6 + b.ang * 0.2;
    const x = b.x + Math.cos(a) * rr, y = b.y + Math.sin(a) * rr;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  perf.draws++;
  g.lineWidth = 1 * env.inv;
  g.strokeStyle = rgba(col, 0.45);
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + Math.PI / 6 + b.ang * 0.2;
    g.moveTo(b.x, b.y);
    g.lineTo(b.x + Math.cos(a) * rr, b.y + Math.sin(a) * rr);
  }
  g.stroke();
  perf.draws++;
  // 核心与信标
  blitC(g, env.bank.shaded('sphere', mixColor(col, '#ffffff', 0.4)), b.x, b.y, R * 0.9, R * 0.9, 0.9);
  const blink = 0.5 + 0.5 * wo(env.t, 2.6, b.id * 1.7);
  if (blink > 0.45) glowAt(env, 'spark', '#ffffff', b.x, b.y - R * 1.5, R * 1.6 * (0.6 + blink), (blink - 0.45) * 1.5);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

export function drawPod(env: DrawEnv, b: Body): void {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const integ = clamp(b.integrity, 0, 1);
  const col = mixColor(pal.pod, pal.danger, 1 - integ);
  g.globalCompositeOperation = 'lighter';
  glowAt(env, 'glow_soft', col, b.x, b.y, R * 7.5, (0.24 + (1 - integ) * 0.3) * env.gs);
  glowAt(env, 'glow_soft', mixColor(col, '#ffffff', 0.5), b.x, b.y, R * 3.2, 0.5 * env.gs);
  // 光帆
  if (b.area > 0) {
    g.save();
    g.translate(b.x, b.y);
    g.rotate(b.ang);
    g.strokeStyle = rgba(pal.pod2, 0.35);
    g.lineWidth = 1.1 * env.inv;
    g.beginPath();
    g.moveTo(0, 0); g.lineTo(-R * 3.4, -R * 1.2);
    g.moveTo(0, 0); g.lineTo(-R * 3.4, R * 1.2);
    g.moveTo(-R * 3.4, -R * 1.2); g.lineTo(-R * 3.4, R * 1.2);
    g.stroke();
    perf.draws++;
    g.restore();
  }
  // 舱体
  blitC(g, env.bank.shaded('sphere', col), b.x, b.y, R * 2.05, R * 2.05, 1);
  blitC(g, env.bank.tinted('glow_ring', mixColor(col, '#ffffff', 0.55)), b.x, b.y, R * 2.9, R * 2.9, 0.34 * env.gs);
  // 受击反馈
  if (b.jolt > 0.02) glowAt(env, 'glow_soft', '#ffffff', b.x, b.y, R * 9, clamp(b.jolt, 0, 1) * 0.5);
  // 潮汐应力预警
  if (b.stress > 0.5) {
    const s = clamp((b.stress - 0.5) / 1.5, 0, 1);
    glowAt(env, 'glow_ring', pal.danger, b.x, b.y, R * (3.4 + s * 2.4), s * 0.45 * (0.55 + 0.45 * wo(env.t, 9, b.id)));
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

export function drawRock(env: DrawEnv, b: Body): void {
  const g = env.g, pal = env.pal;
  const R = b.radius;
  const col = tintColor(pal, b.tint);
  g.globalCompositeOperation = 'lighter';
  g.save();
  g.translate(b.x, b.y);
  g.rotate(b.ang);
  blitC(g, env.bank.tinted('shard', col), 0, 0, R * 2.7, R * 2.7, b.kind === 'debris' ? 0.85 : 0.95);
  g.restore();
  glowAt(env, 'glow_soft', col, b.x, b.y, R * 5.0, 0.12 * env.gs);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

export function drawBody(env: DrawEnv, b: Body): void {
  switch (b.kind) {
    case 'star': drawStar(env, b); break;
    case 'planet': drawPlanet(env, b); break;
    case 'blackhole': drawBlackHole(env, b); break;
    case 'station': drawStation(env, b); break;
    case 'pod': drawPod(env, b); break;
    default: drawRock(env, b); break;
  }
}

/* ------------------------------------------------------------------ 拖尾 */

/**
 * 环形缓冲拖尾：O(n)、零分配。分段（chunk）变宽变亮，头部最亮。
 * 世界坐标；ix/iy 为插值后的当前位置（补到头部）。
 */
export function drawTrail(g: CanvasRenderingContext2D, b: Body, color: string, inv: number, alpha: number, ix: number, iy: number): void {
  const cap = b.trailX.length;
  if (cap < 4 || b.trailY.length !== cap) return;
  let n = b.trailN;
  if (n > cap) n = cap;
  if (n < 2) return;
  let start = b.trailHead - n;
  start = ((start % cap) + cap) % cap;
  const CH = 6;
  g.globalCompositeOperation = 'lighter';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = color;
  for (let c = 0; c < CH; c++) {
    const i0 = Math.floor((n - 1) * c / CH);
    const i1 = Math.floor((n - 1) * (c + 1) / CH);
    if (i1 <= i0) continue;
    const f = (c + 0.5) / CH;
    const a = alpha * (0.05 + 0.95 * f * f);
    if (a < 0.006) continue;
    const w = (0.5 + 2.4 * f * f) * inv;
    g.globalAlpha = a;
    g.lineWidth = w;
    g.beginPath();
    let idx = start + i0;
    if (idx >= cap) idx -= cap;
    g.moveTo(b.trailX[idx], b.trailY[idx]);
    for (let k = i0 + 1; k <= i1; k++) {
      let j = start + k;
      if (j >= cap) j -= cap;
      g.lineTo(b.trailX[j], b.trailY[j]);
    }
    if (i1 >= n - 1) g.lineTo(ix, iy);
    g.stroke();
    perf.draws++;
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

/* ------------------------------------------------------------------ 对接环 */

export interface DockInfo {
  x: number; y: number; r: number; vMax: number; pulse: number;
  hasPod: boolean; px: number; py: number; rvx: number; rvy: number; ok: boolean;
  vrel: number;
}
export function makeDockInfo(): DockInfo {
  return { x: 0, y: 0, r: 0.09, vMax: 0.09, pulse: 0, hasPod: false, px: 0, py: 0, rvx: 0, rvy: 0, ok: true, vrel: 0 };
}

export function drawDock(env: DrawEnv, d: DockInfo): void {
  const g = env.g, pal = env.pal;
  const col = d.hasPod && !d.ok ? pal.danger : pal.station;
  const a = env.bank.tinted('ring_dock', col);
  g.globalCompositeOperation = 'lighter';
  blitC(g, a, d.x, d.y, d.r * 2.2, d.r * 2.2, 0.7);
  glowAt(env, 'glow_soft', col, d.x, d.y, d.r * 6, 0.11 * env.gs);
  // 速度门限提示环（超出时红色脉冲）
  const gate = d.hasPod ? clamp(d.vrel / (d.vMax || 1e-6), 0, 3) : 0;
  g.strokeStyle = rgba(col, d.hasPod && !d.ok ? 0.5 + 0.5 * wo(env.t, 16, 0) : 0.5);
  g.lineWidth = 1.6 * env.inv;
  g.setLineDash(DASH_S);
  g.beginPath();
  g.arc(d.x, d.y, d.r * (1 + Math.min(gate, 2) * 0.16), 0, TAU);
  g.stroke();
  g.setLineDash(DASH_N);
  perf.draws++;
  // 速度差箭头
  if (d.hasPod && !d.ok) {
    const mag = Math.hypot(d.rvx, d.rvy) || 1e-6;
    const L = d.r * (1.6 + Math.min(gate, 3) * 0.8);
    const ux = d.rvx / mag, uy = d.rvy / mag;
    const x1 = d.px, y1 = d.py;
    const x2 = x1 + ux * L, y2 = y1 + uy * L;
    g.strokeStyle = rgba(pal.danger, 0.8);
    g.lineWidth = 1.8 * env.inv;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    g.beginPath();
    g.moveTo(x2, y2);
    g.lineTo(x2 - ux * L * 0.28 - uy * L * 0.16, y2 - uy * L * 0.28 + ux * L * 0.16);
    g.lineTo(x2 - ux * L * 0.28 + uy * L * 0.16, y2 - uy * L * 0.28 - ux * L * 0.16);
    g.closePath();
    g.fillStyle = rgba(pal.danger, 0.8);
    g.fill();
    perf.draws += 2;
  }
  // 对接成功爆发环
  if (d.pulse > 0.01) {
    const p = clamp(d.pulse, 0, 1);
    glowAt(env, 'glow_ring', pal.station, d.x, d.y, d.r * (2.4 + (1 - p) * 9), p * 0.75);
    glowAt(env, 'glow_soft', '#ffffff', d.x, d.y, d.r * 8 * (1.2 - p), p * 0.35);
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

/* ------------------------------------------------------------------ 引力井 */

export interface WellView {
  x: number; y: number; tx: number; ty: number;
  mass: number; k: number; engaged: boolean; repel: boolean; intensity: number; thrust: number;
}
export function makeWellView(): WellView {
  return { x: 0, y: 0, tx: 0, ty: 0, mass: 0, k: 0, engaged: false, repel: false, intensity: 0, thrust: 0 };
}

/* ---- 引力井模式语义 ----
 * 「吸引 / 排斥」必须在任何章节调色板下都能一眼分辨，所以模式提示（雪佛龙 + 徽标）
 * 一律使用与调色板**无关**的固定强调色；井体主色继续用调色板色，章节风格不丢。
 * loop3 的 well/orbit、loop4 的 well/orbit 几乎同色，只靠调色板区分是不可靠的。 */
/** 吸引：暖金。用于环上内向雪佛龙、内圈实线、模式徽标与力矢量箭头 */
export const WELL_ATTRACT_COLOR = '#ffd489';
/** 排斥：冷青。用于环上外向雪佛龙、外圈虚线、模式徽标与力矢量箭头 */
export const WELL_REPEL_COLOR = '#7ef9ff';
/** 徽标字体：与 HUD 同一字体栈（src/ui/hud.ts 的 FONT），不引入新字体 */
const WELL_FONT = 'ui-monospace, "Cascadia Mono", Consolas, monospace';
/** 环上雪佛龙数量（沿环均匀分布，≥6） */
const HINT_N = 6;
/** 模式提示环半径（相对井体半径 R） */
const HINT_RING = 2.6;
/** 徽标字号 / 内边距 / 距井心最小间距（CSS 像素口径：draw.ts 里 env.inv = 1 / (PX_PER_RU·zoom)
 *  就是「世界单位→屏幕像素」的换算，字号与 HUD 同一量级；BADGE_OFF_MIN 是相机拉到最远、
 *  井体很小时的兜底，保证徽标仍在「井心上方约 40px」而不会压住井体） */
const BADGE_SZ = 13;
const BADGE_PAD = 7;
const BADGE_OFF_MIN = 40;

/**
 * 模式形状提示（只在 engaged 时调用，与调色板无关）：
 *  - 吸引：环上 6 个**向内**指的雪佛龙 + 内圈实线；
 *  - 排斥：环上 6 个**向外**指的雪佛龙 + 外圈虚线。
 * 6 个雪佛龙合并进同一条 Path，各描边一次（宽一圈的柔光 + 实心主描边共 2 次 draw call），
 * 环线 1 次；无 shadowBlur、无每帧新对象。
 */
function drawWellModeHints(env: DrawEnv, w: WellView, R: number, accent: string): void {
  const g = env.g;
  const ring = R * HINT_RING;
  const hl = R * 0.45;  // 雪佛龙沿半径方向的长度
  const hw = R * 0.45;  // 雪佛龙沿切向的半宽
  const dir = w.repel ? 1 : -1;      // 尖端朝向：+1 向外（排斥），-1 向内（吸引）
  const tipR = ring + dir * hl;
  const wingR = ring - dir * hl;
  const dth = Math.atan2(hw, wingR > 0 ? wingR : ring);
  const pulse = 0.78 + 0.16 * wo(env.t, 2.4, 0);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i < HINT_N; i++) {
    // 固定相位：环顶部（−90°）留出缺口给模式徽标，互不遮挡
    const a = (i * TAU) / HINT_N;
    const a1 = a - dth, a2 = a + dth;
    g.moveTo(w.x + Math.cos(a1) * wingR, w.y + Math.sin(a1) * wingR);
    g.lineTo(w.x + Math.cos(a) * tipR, w.y + Math.sin(a) * tipR);
    g.lineTo(w.x + Math.cos(a2) * wingR, w.y + Math.sin(a2) * wingR);
  }
  // 先一圈柔光（保持霓虹观感），再实心主描边（保证在明亮涡旋上也读得出方向）
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = rgba(accent, 0.2);
  g.lineWidth = 6.5 * env.inv;
  g.stroke();
  perf.draws++;
  g.globalCompositeOperation = 'source-over';
  g.strokeStyle = rgba(accent, pulse);
  g.lineWidth = 2.6 * env.inv;
  g.stroke();
  perf.draws++;
  // 吸引 = 内圈实线 / 排斥 = 外圈虚线
  const ringR = w.repel ? R * 3.15 : R * 1.7;
  if (w.repel) g.setLineDash(DASH_B);
  g.strokeStyle = rgba(accent, 0.8);
  g.lineWidth = 1.8 * env.inv;
  g.beginPath();
  g.arc(w.x, w.y, ringR, 0, TAU);
  g.stroke();
  g.setLineDash(DASH_N);   // 虚线用完立即复位（DASH_N = [0,0]，等价于无虚线）
  g.lineCap = 'butt';
  g.lineJoin = 'miter';
  perf.draws++;
}

/**
 * 井旁模式徽标（只在 engaged 时调用）：固定强调色文字「吸附 / 排斥」+ 半透明底衬，
 * 保证在任何背景与任何章节调色板上都可读；位置取井心上方，跟随井体缩放但有下限。
 */
function drawWellBadge(env: DrawEnv, w: WellView, R: number, accent: string, label: string): void {
  const g = env.g;
  const off = Math.max(R * HINT_RING, BADGE_OFF_MIN * env.inv);
  const cx = w.x, cy = w.y - off;
  const bw = (BADGE_SZ * 2 + BADGE_PAD * 2) * env.inv;   // 文案恒为 2 个全角字
  const bh = (BADGE_SZ + BADGE_PAD * 1.6) * env.inv;
  const x = cx - bw * 0.5, y = cy - bh * 0.5;
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = 'rgba(4,7,14,0.74)';
  g.fillRect(x, y, bw, bh);
  g.strokeStyle = rgba(accent, 0.72);
  g.lineWidth = 1 * env.inv;
  g.strokeRect(x, y, bw, bh);
  g.font = `600 ${BADGE_SZ * env.inv}px ${WELL_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = accent;
  g.fillText(label, cx, cy + 0.5 * env.inv);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  perf.draws += 3;
}

export function drawWell(env: DrawEnv, w: WellView): void {
  const g = env.g, pal = env.pal;
  const massN = clamp(w.mass / 0.05, 0, 1);
  const col = w.repel ? mixColor(pal.orbit, '#ffffff', 0.15) : pal.well;
  /** 模式强调色：固定语义色，不随章节漂移（用于雪佛龙 / 徽标 / 力矢量箭头） */
  const accent = w.repel ? WELL_REPEL_COLOR : WELL_ATTRACT_COLOR;
  const col2 = w.repel ? pal.orbit2 : pal.well2;
  const on = w.engaged || w.mass > 1e-5;
  const scale = (0.55 + massN * 1.5) * (on ? 1 : 0.45);
  const R = 0.16 * scale;
  const bright = (0.3 + massN * 0.7) * (on ? 1 : 0.35);
  g.globalCompositeOperation = 'lighter';
  // 目标点
  g.strokeStyle = rgba(col, 0.35);
  g.lineWidth = 1 * env.inv;
  g.setLineDash(DASH_M);
  g.beginPath();
  g.moveTo(w.x, w.y);
  g.lineTo(w.tx, w.ty);
  g.stroke();
  g.setLineDash(DASH_N);
  perf.draws++;
  g.beginPath();
  g.arc(w.tx, w.ty, 0.012, 0, TAU);
  g.strokeStyle = rgba(col, 0.5);
  g.stroke();
  perf.draws++;
  // 多层旋转涡旋
  const vtx = env.bank.shaded('vortex', col);
  g.save();
  g.translate(w.x, w.y);
  const rot = w.repel ? -1 : 1;
  g.rotate(env.t * 0.45 * rot);
  blitC(g, vtx, 0, 0, R * 6.2, R * 6.2, 0.14 * bright * env.gs);
  g.rotate(env.t * 0.75 * rot + 1.1);
  blitC(g, vtx, 0, 0, R * 4.0, R * 4.0, 0.24 * bright * env.gs);
  g.rotate(-env.t * 1.25 * rot);
  blitC(g, env.bank.shaded('vortex', col2), 0, 0, R * 2.4, R * 2.4, 0.4 * bright * env.gs);
  g.restore();
  glowAt(env, 'glow_soft', col, w.x, w.y, R * 7 * (0.9 + 0.1 * wo(env.t, 3, 0)), 0.22 * bright * env.gs);
  glowAt(env, 'glow_ring', mixColor(col, '#ffffff', 0.4), w.x, w.y, R * 3.2 * (1 + 0.05 * wo(env.t, 4.4, 0)), 0.42 * bright * env.gs);
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#04060c';
  g.beginPath();
  g.arc(w.x, w.y, R * 0.5, 0, TAU);
  g.fill();
  perf.draws++;
  // 弹簧位移矢量：真实显示 -k·(x - x_target)
  if (on) {
    const dx = w.x - w.tx, dy = w.y - w.ty;
    const fx = -w.k * dx * (w.repel ? -1 : 1);
    const fy = -w.k * dy * (w.repel ? -1 : 1);
    const fm = Math.hypot(fx, fy);
    if (fm > 1e-9) {
      const L = clamp(Math.log(1 + fm * 400) * 0.06, 0.02, 0.5);
      const ux = fx / fm, uy = fy / fm;
      const x1 = w.x, y1 = w.y;
      const x2 = x1 + ux * L, y2 = y1 + uy * L;
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = rgba(accent, 0.85);
      g.lineWidth = 2.0 * env.inv;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.beginPath();
      g.moveTo(x2, y2);
      g.lineTo(x2 - ux * L * 0.3 - uy * L * 0.17, y2 - uy * L * 0.3 + ux * L * 0.17);
      g.lineTo(x2 - ux * L * 0.3 + uy * L * 0.17, y2 - uy * L * 0.3 - ux * L * 0.17);
      g.closePath();
      g.fillStyle = rgba(accent, 0.85);
      g.fill();
      perf.draws += 2;
      g.globalCompositeOperation = 'source-over';
    }
  }
  // 模式提示（形状与固定语义色）：按场时才画，且只有 2 次描边 + 3 次徽标调用
  if (w.engaged) {
    drawWellModeHints(env, w, R, accent);
    drawWellBadge(env, w, R, accent, w.repel ? '排斥' : '吸附');
  }
  g.globalAlpha = 1;
}

/* ------------------------------------------------------------------ 预测轨迹 */

/** Path2D 缓存：15 Hz 或点数变化时重建，避免每帧新建对象 */
export class PredictionCache {
  private paths: (Path2D | undefined)[] = [];
  private ns: number[] = [];
  private timer = 99;
  private count = 0;

  update(world: World, dt: number): void {
    this.timer += dt;
    const expired = this.timer >= 0.066;
    if (expired) this.timer = 0;
    const list = world.predicted;
    const n0 = list.length;
    for (let i = 0; i < n0; i++) {
      const p = list[i];
      const n = p.n | 0;
      if (expired || this.paths[i] === undefined || this.ns[i] !== n) {
        const path = new Path2D();
        if (n > 0) {
          path.moveTo(p.xs[0], p.ys[0]);
          for (let k = 1; k < n; k++) path.lineTo(p.xs[k], p.ys[k]);
        }
        this.paths[i] = path;
        this.ns[i] = n;
      }
    }
    if (this.count > n0) {
      this.paths.length = n0;
      this.ns.length = n0;
    }
    this.count = n0;
  }
  get(i: number): Path2D | undefined {
    return this.paths[i];
  }
  clear(): void {
    this.paths.length = 0;
    this.ns.length = 0;
    this.count = 0;
    this.timer = 99;
  }
}

export function drawPredicted(env: DrawEnv, world: World, cache: PredictionCache, ghostRadius: number): void {
  const g = env.g, pal = env.pal;
  const list = world.predicted;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const path = cache.get(i);
    if (!path || p.n < 2) continue;
    const hazard = p.hazard;
    const flash = hazard ? 0.45 + 0.55 * Math.abs(wo(env.t, 7.5, i * 1.3)) : 1;
    const col = hazard ? pal.danger : pal.orbit;
    g.globalCompositeOperation = 'lighter';
    g.setLineDash(DASH_P);
    g.strokeStyle = rgba(col, (hazard ? 0.75 : 0.5) * flash);
    g.lineWidth = 1.4 * env.inv;
    g.stroke(path);
    perf.draws++;
    g.setLineDash(DASH_N);
    // 末端虚影货舱
    const ex = p.xs[p.n - 1], ey = p.ys[p.n - 1];
    const a = hazard ? 0.3 * flash + 0.1 : 0.34;
    blitC(g, env.bank.shaded('sphere', mixColor(pal.pod, hazard ? pal.danger : pal.pod2, hazard ? 0.6 : 0.15)), ex, ey, ghostRadius * 2.1, ghostRadius * 2.1, a);
    glowAt(env, 'glow_soft', col, ex, ey, ghostRadius * 7, a * 0.5);
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

/* ------------------------------------------------------------------ 世界辅助层 */

const DASH_N = [0, 0];
const DASH_S = [3, 4];
const DASH_M = [2, 3];
const DASH_P = [4, 5];
const DASH_B = [7, 9];

/**
 * 极淡坐标环 + 放射网格：以世界原点（恒星）为心的 0.5 RU 同心圆，
 * 离原点越远越淡；只画落在视口内的那一圈环带。
 */
export function drawGrid(env: DrawEnv, camX: number, camY: number, viewR: number, bounds: number): void {
  const g = env.g, pal = env.pal;
  const STEP = 0.5;
  const dist = Math.hypot(camX, camY);
  const r0 = Math.max(0, dist - viewR);
  const r1 = dist + viewR + STEP;
  let k0 = Math.max(1, Math.ceil(r0 / STEP));
  let k1 = Math.min(k0 + 44, Math.floor(r1 / STEP));
  if (k1 < k0) return;
  const maxR = Math.max(1.5, bounds * 1.35, r1 * 0.6);
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = pal.uiDim;
  g.lineWidth = 0.9 * env.inv;
  // 所有同心圆一次描边（按半径分组只影响亮度，不逐环切换状态）
  g.globalAlpha = 0.07;
  g.beginPath();
  let drawn = 0;
  for (let k = k0; k <= k1 && drawn < 26; k++, drawn++) {
    const r = k * STEP;
    g.moveTo(r, 0);
    g.arc(0, 0, r, 0, TAU);
  }
  g.stroke();
  perf.draws++;
  // 放射线（只画视口环带，避免多余填充）
  g.globalAlpha = 0.045;
  g.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    g.moveTo(ca * r0, sa * r0);
    g.lineTo(ca * r1, sa * r1);
  }
  g.stroke();
  perf.draws++;
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
}

/** 边界圈：危险红虚线，接近时脉冲 */
export function drawBounds(env: DrawEnv, bounds: number, proximity: number): void {
  const g = env.g, pal = env.pal;
  const p = clamp(proximity, 0, 1);
  const pulse = 0.5 + 0.5 * wo(env.t, 2.2 + p * 5, 0);
  g.globalCompositeOperation = 'lighter';
  g.setLineDash(DASH_B);
  g.strokeStyle = rgba(pal.danger, 0.22 + p * 0.55 * pulse);
  g.lineWidth = (1.4 + p * 2.2) * env.inv;
  g.beginPath();
  g.arc(0, 0, bounds, 0, TAU);
  g.stroke();
  perf.draws++;
  g.setLineDash(DASH_N);
  if (p > 0.02) glowAt(env, 'glow_ring', pal.danger, 0, 0, bounds * 2.06, p * 0.22 * env.gs);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

/** 轨道参考圈（showOrbits：以主恒星为焦点的圆近似） */
/**
 * 该位置此刻实际环绕的中心天体 = 对它引力最强的那个主天体（真实判据 a = μ/r²）。
 * 层级轨道（卫星、绕行星的空间站/货舱）必须用它来定位"中心"，否则轨道会画成绕恒星、
 * 轨道要素也会按错误的 μ 解算（实测 L2-3 报出负近星点）。
 */
export function dominantPrimary(world: World, x: number, y: number, exclude?: Body | null): Body | null {
  let best: Body | null = null;
  let bestA = -1;
  for (const p of world.primaries) {
    if (!p.alive || (exclude != null && p === exclude)) continue;
    const dx = x - p.x, dy = y - p.y;
    const a = p.mu / Math.max(1e-4, dx * dx + dy * dy);
    if (a > bestA) { bestA = a; best = p; }
  }
  return best;
}

/**
 * 场区可视化（objective：回显卫星 Hill 球与各天体撕裂半径）。
 *  - 每颗卫星画它的**山丘球**（虚线细圈）：这就是"卫星走廊"里要绕开的危险区；
 *  - 每个恒星/黑洞/行星画**潮汐撕裂半径**（危险色虚线）：货舱进到里面会被撕开。
 * 全部由 physics.ts 的真实公式给出，不另写一套。
 */
export function drawFieldZones(env: DrawEnv, world: World): void {
  const g = env.g, pal = env.pal;
  const lv = world.level;
  // 全部用**细实线**：虚线圆弧在软件光栅化下非常贵（帧时余量被吃掉，fps 在阈值附近反复擦线）。
  // 视觉上实线 + 低透明度同样能表达"这是一个范围圈"，与实心的轨道线也不冲突。
  g.setLineDash(DASH_N);
  // 卫星山丘球
  for (const b of world.primaries) {
    if (!b.alive || (b.kind !== 'planet')) continue;
    // **排除自身**：天体到自己的距离为 0，引力项会发散并把它自己选成"中心天体"，
    // 于是卫星的山丘球算成 0、圆圈也画不出来（实测面板显示 "moonA r_H 0.0"）。
    const c = dominantPrimary(world, b.x, b.y, b);
    if (!c || c.kind === 'star' || c.kind === 'blackhole') continue; // 只画"绕行星"的卫星
    const aRel = Math.hypot(b.x - c.x, b.y - c.y);
    if (aRel < 1e-4) continue;
    const rH = hillSphere(aRel, b.mass, c.mass);
    if (rH < 0.004) continue;
    g.strokeStyle = rgba(pal.orbit, 0.30);
    g.lineWidth = 1 * env.inv;
    g.beginPath();
    g.arc(b.x, b.y, rH, 0, TAU);
    g.stroke();
    perf.draws++;
  }
  // 潮汐撕裂半径（只对恒星/黑洞画：那是真正会把货舱撕开的天体）
  // **用细实线而非虚线**：大半径虚线圆在软件光栅化下很贵（帧时余量被吃掉，
  // fps 在阈值 24 附近反复擦线）。小半径的卫星山丘球仍保留虚线，视觉区分不受影响。
  g.setLineDash(DASH_N);
  for (const b of world.primaries) {
    if (!b.alive || (b.kind !== 'star' && b.kind !== 'blackhole')) continue;
    const pod = world.pods.find((p) => p.alive && !p.delivered);
    if (!pod) continue;
    const rT = tidalTearRadius(b.mu, pod.mass, pod.radius);
    if (rT < 0.02 || rT > 40) continue;
    g.strokeStyle = rgba(pal.danger, 0.24);
    g.lineWidth = 1 * env.inv;
    g.beginPath();
    g.arc(b.x, b.y, rT, 0, TAU);
    g.stroke();
    perf.draws++;
  }
  g.setLineDash(DASH_N);
  void lv;
}

export function drawOrbits(env: DrawEnv, world: World, starX: number, starY: number): void {
  const g = env.g, pal = env.pal;
  const body = world.bodies;
  g.globalCompositeOperation = 'lighter';
  g.setLineDash(DASH_S);
  g.strokeStyle = rgba(pal.orbit2, 0.28);
  g.lineWidth = 1 * env.inv;
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b.kind === 'star') continue;
    // **按各自的实际中心天体画**：卫星/绕行星的天体要绕行星画圈。
    // 原先一律以 starX/starY 为圆心，卫星轨道会被画成绕恒星的大圈（视觉错误）。
    const c = dominantPrimary(world, b.x, b.y) ?? { x: starX, y: starY };
    const r = Math.hypot(b.x - c.x, b.y - c.y);
    if (r < 1e-4 || r > 60) continue;
    g.beginPath();
    g.arc(c.x, c.y, r, 0, TAU);
    g.stroke();
    perf.draws++;
  }
  g.setLineDash(DASH_N);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

/** 速度矢量（showVectors） */
export function drawVelocityVectors(env: DrawEnv, world: World): void {
  const g = env.g, pal = env.pal;
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = rgba(pal.orbit, 0.55);
  g.lineWidth = 1.1 * env.inv;
  g.beginPath();
  for (let i = 0; i < world.bodies.length; i++) {
    const b = world.bodies[i];
    const L = 0.35;
    const m = Math.hypot(b.vx, b.vy) || 1e-6;
    const k = Math.min(1, m) * L / m;
    g.moveTo(b.x, b.y);
    g.lineTo(b.x + b.vx * k, b.y + b.vy * k);
  }
  g.stroke();
  perf.draws++;
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
}

/** 世界 ⇄ 屏幕辅助（含抖动偏移） */
export function worldScale(zoom: number): number {
  return PX_PER_RU * zoom;
}

export type { Well };
