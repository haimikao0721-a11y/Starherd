/**
 * STARHERD — 背景：竖向渐变 + fBm 星云 + 三层视差星场（W-render）
 *
 * 性能铁律（依据真机原语探针）：**运行期只允许 1:1、整数偏移的 drawImage**。
 * 缩放的 drawImage 会退化到 CPU 逐像素重采样（全屏一次 10~25ms）。
 * 因此星云/星场在「视口尺寸 / dpr / 调色板 / 星场层数」变化时**烘焙一次**到
 * 两张与视口同尺寸（device px，含 ±128px 视差边距）的离屏 canvas：
 *   near = 最近星层（视差大）  far = 星云 + 远星层（视差小）
 * 每帧只做：1 次渐变 fillRect + 2 次 1:1 加性 drawImage（整数偏移，快路径）。
 * 相机位移通过整数偏移在边距内消化，不需要重建。
 */
import type { Palette, Quality } from '../sim/types';
import { PX_PER_RU } from '../engine/view';
import { SpriteBank, clamp, ctx2d, makeCanvas, mixColor, perf, wo } from './draw';

/** 视差边距（CSS 像素）：相机位移在此范围内用整数偏移消化，不重建 */
const MARGIN = 128;
/** 背景烘焙分辨率比例（1 = 全分辨率，太慢；1/3 视觉几乎无差别且合成走快路径） */
const BAKE_SCALE = 0.34;

interface Layer {
  pf: number;
  alpha: number;
  scale: number;
  drift: number;
}

const LAYERS: Layer[] = [
  { pf: 0.05, alpha: 0.42, scale: 0.9, drift: 1.5 },
  { pf: 0.13, alpha: 0.22, scale: 1.6, drift: 3.2 },
  { pf: 0.26, alpha: 0.14, scale: 2.6, drift: 6.0 },
];

interface NebulaInst {
  px: number; py: number; size: number; alpha: number; spin: number; seed: number;
}

export class Starfield {
  private bank: SpriteBank;
  private pal: Palette;
  private q: Quality | null = null;

  private w = 1600;
  private h = 900;
  private dpr = 1;
  private dw = 1600;
  private dh = 900;

  private far: HTMLCanvasElement | null = null;
  private near: HTMLCanvasElement | null = null;
  private farW = 0;
  private farH = 0;
  /** 合成时的目标尺寸（全分辨率层尺寸，含视差边距） */
  private layerBw = 0;
  private layerBh = 0;
  private bakeKey = '';

  private grad: CanvasGradient | null = null;
  private gradKey = '';

  private t = 0;
  private recheck = 0;
  private assetKey = 0;

  private inst: NebulaInst[] = [
    { px: 0.32, py: 0.34, size: 1.55, alpha: 0.11, spin: 0.006, seed: 0 },
    { px: -0.38, py: 0.42, size: 1.15, alpha: 0.085, spin: -0.009, seed: 1 },
    { px: 0.05, py: -0.35, size: 0.95, alpha: 0.06, spin: 0.013, seed: 2 },
  ];

  constructor(bank: SpriteBank, pal: Palette) {
    this.bank = bank;
    this.pal = pal;
  }

  setPalette(p: Palette): void {
    this.pal = p;
    this.gradKey = '';
    this.bakeKey = '';
  }

  setQuality(q: Quality): void {
    if (this.q && this.q.starLayers === q.starLayers && this.q.glowScale === q.glowScale) {
      this.q = q;
      return;
    }
    this.q = q;
    this.bakeKey = '';
  }

  /** 视口/DPR 变化 → 需要重新烘焙 */
  setViewport(w: number, h: number, dpr: number): void {
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.dw = Math.max(1, Math.round(w * dpr));
    this.dh = Math.max(1, Math.round(h * dpr));
    this.gradKey = '';
    this.bakeKey = '';
  }

  update(dt: number, q: Quality): void {
    this.t += dt;
    if (!this.q) this.q = q;
    this.recheck += dt;
    if (this.recheck > 1.5) {
      this.recheck = 0;
      // 素材可能迟到：若星云/星场从程序化回退变成真素材，重建背景
      const k = (this.bank.fromAsset('star_field') ? 1 : 0) + (this.bank.fromAsset(this.pal.nebula || 'nebula_loop1') ? 2 : 0);
      if (k !== this.assetKey) {
        this.assetKey = k;
        this.bakeKey = '';
      }
    }
  }

  private gradient(g: CanvasRenderingContext2D): CanvasGradient {
    const key = this.pal.id + '|' + this.dh;
    if (this.grad && this.gradKey === key) return this.grad;
    const gr = g.createLinearGradient(0, 0, 0, this.dh);
    gr.addColorStop(0, this.pal.bg);
    gr.addColorStop(0.42, this.pal.bg2);
    gr.addColorStop(0.72, this.pal.bg);
    gr.addColorStop(1, '#010206');
    this.grad = gr;
    this.gradKey = key;
    return gr;
  }

  private resolveNebula(): CanvasImageSource {
    const name = this.pal.nebula || 'nebula_loop1';
    const src = this.bank.raw(name);
    if (this.bank.fromAsset(name)) return src;          // 真素材自带配色 → 原样使用
    return this.bank.tinted(name, mixColor(this.pal.well, this.pal.orbit, 0.45));
  }

  /**
   * 烘焙背景（device px、identity 变换）。只在视口/dpr/调色板/星层数变化时执行，
   * 因此这里允许出现缩放的 drawImage（一次性成本）。
   */
  private bake(): void {
    const dpr = this.dpr;
    const RS = BAKE_SCALE;
    const Md = Math.round(MARGIN * dpr);
    const bw = this.dw + Md * 2;
    const bh = this.dh + Md * 2;
    const bwS = Math.max(4, Math.round(bw * RS));
    const bhS = Math.max(4, Math.round(bh * RS));
    const MdS = Md * RS;
    const far = makeCanvas(bwS, bhS);
    const near = makeCanvas(bwS, bhS);
    const gf = ctx2d(far);
    const gn = ctx2d(near);
    const stars = this.bank.raw('star_field');
    const stw = (stars as HTMLCanvasElement).width || (stars as HTMLImageElement).naturalWidth || 512;
    const nl = clamp((this.q ? this.q.starLayers : 3) | 0, 0, 3);

    // 星云（大尺寸、加性、极低 alpha）→ far
    const neb = this.resolveNebula();
    gf.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.inst.length; i++) {
      const inst = this.inst[i];
      const size = Math.max(this.w, this.h) * inst.size * dpr * RS;
      const cx = MdS + this.dw * RS * 0.5 + inst.px * this.dw * RS;
      const cy = MdS + this.dh * RS * 0.5 + inst.py * this.dh * RS;
      gf.globalAlpha = inst.alpha;
      gf.drawImage(neb, cx - size * 0.5, cy - size * 0.5, size, size);
      perf.draws++;
    }
    // 星场：层 0 进 near（视差大），其余进 far
    for (let i = 0; i < nl; i++) {
      const L = LAYERS[i];
      const target = i === 0 ? gn : gf;
      const pat = target.createPattern(stars, 'repeat');
      if (!pat) continue;
      const k = L.scale * dpr * RS;
      target.save();
      target.globalCompositeOperation = 'lighter';
      target.globalAlpha = L.alpha;
      target.scale(k, k);
      target.fillStyle = pat;
      target.fillRect(0, 0, bwS / k, bhS / k);
      target.restore();
      perf.draws++;
    }
    this.far = far;
    this.near = near;
    this.farW = bwS;
    this.farH = bhS;
    this.layerBw = bw;
    this.layerBh = bh;
    this.bakeKey = [this.dw, this.dh, dpr, this.pal.id, nl, stw].join('|');
  }

  /**
   * 背景层（device px，identity 变换；调用方无需预先设置变换）。
   * 返回后 ctx 的 composite/alpha 已复位。
   */
  draw(g: CanvasRenderingContext2D, camX: number, camY: number, zoom: number, shakeX: number, shakeY: number): void {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = this.gradient(g);
    g.fillRect(0, 0, this.dw, this.dh);
    perf.draws++;

    const key = [this.dw, this.dh, this.dpr, this.pal.id, this.q ? this.q.starLayers : 3].join('|');
    if (!this.far || !this.near || this.bakeKey !== key) this.bake();
    if (!this.far || !this.near) return;

    const Md = Math.round(MARGIN * this.dpr);
    const s = PX_PER_RU * zoom * this.dpr; // device px / RU
    // 远层：星云 + 远星（视差小）；近层：最近星层（视差大）。整数偏移，1:1 合成。
    const pfFar = 0.035, pfNear = 0.14;
    let oxF = -camX * s * pfFar + shakeX * this.dpr * pfFar + wo(this.t, 0.03, 0.7) * 26 * this.dpr;
    let oyF = -camY * s * pfFar + shakeY * this.dpr * pfFar + wo(this.t, 0.024, 2.1) * 20 * this.dpr;
    let oxN = -camX * s * pfNear + shakeX * this.dpr * pfNear + wo(this.t, 0.05, 1.9) * 12 * this.dpr;
    let oyN = -camY * s * pfNear + shakeY * this.dpr * pfNear + wo(this.t, 0.041, 2.7) * 9 * this.dpr;
    oxF = Math.round(clamp(oxF, -Md, 0));
    oyF = Math.round(clamp(oyF, -Md, 0));
    oxN = Math.round(clamp(oxN, -Md, 0));
    oyN = Math.round(clamp(oyN, -Md, 0));
    const pulse = 0.82 + 0.18 * wo(this.t, 0.09, 0.3);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = pulse;
    // 小图放大贴回（显式目标尺寸 → GPU 快路径；1:1 大画布合成会走 CPU 慢路径）
    g.drawImage(this.far, 0, 0, this.farW, this.farH, oxF, oyF, this.layerBw, this.layerBh);
    g.globalAlpha = pulse * 0.9;
    g.drawImage(this.near, 0, 0, this.farW, this.farH, oxN, oyN, this.layerBw, this.layerBh);
    perf.draws += 2;
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  /** 诊断：背景是否已烘焙 */
  get baked(): boolean {
    return !!this.far && !!this.near;
  }
}
