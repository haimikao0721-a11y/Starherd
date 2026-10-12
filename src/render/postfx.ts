/**
 * STARHERD — 后处理（W-render）
 *
 * 性能铁律（真机原语探针）：全屏 `drawImage` 只有在
 *   **源偏移 0、目标整数坐标、源与目标尺寸 1:1** 时才走 GPU 快路径（~0.12ms）；
 * 任何缩放/小数偏移都会退化到 CPU 重采样（全屏 10~25ms）。
 *
 * 因此本文件：
 *  - 所有离屏 canvas（scene/bloom/chroma/vignette/danger）都与**输出 canvas 同尺寸**（device px）
 *  - 所有合成使用 identity 变换 + 整数坐标 + 1:1 尺寸
 *  - bloom 的模糊用**全屏整数偏移的加性 drawImage**（0.075ms/次）而不是缩放
 *  - 色差用整数像素偏移，并且只在 view.chroma > 阈值时才做（平时完全跳过）
 *  - vignette / 危险脉动**按输出尺寸烘焙一次**，每帧 1:1 贴回
 *  - 闪白 / 淡入淡出 / 慢动作冷色 / 扫描线全部用 fillRect / stroke 矢量路径（快）
 */
import type { Palette, Quality, ViewState } from '../sim/types';
import { SpriteBank, clamp, ctx2d, makeCanvas, mixColor, perf, rgba, TAU } from './draw';

/** 色差低于此强度直接跳过（避免常态付出两次全屏通道分离） */
const CHROMA_GATE = 0.15;

export class PostFX {
  private out: CanvasRenderingContext2D;
  private bank: SpriteBank;
  private w = 1600;
  private h = 900;
  private dpr = 1;
  private dw = 1600;
  private dh = 900;
  private q: Quality | null = null;

  /* 性能要点（实测标定得出）：
   * Chromium 的 Canvas2D 只在"源偏移 0 / 整数坐标 / 1:1"以及"**小图放大**合成"这两种情况下走快路径
   * （全屏 0.08~0.22ms）；而"大画布 + 非零偏移"的拷贝会退化到 CPU 逐像素路径（全屏 10~70ms）。
   * 因此 bloom / 色差 / vignette 全部在 1/4 分辨率上处理，再以显式目标尺寸放大贴回：
   *   模糊 10 次全屏拷贝 → 10 次 1/16 大小的拷贝，最后 1 次小图放大（快路径）。 */
  private bw = 400;
  private bh = 225;

  /* bloom：1/4 分辨率双缓冲 */
  private bA: HTMLCanvasElement | null = null;
  private bB: HTMLCanvasElement | null = null;
  private bgA: CanvasRenderingContext2D | null = null;
  private bgB: CanvasRenderingContext2D | null = null;

  /* 色差：1/4 分辨率通道缓冲（惰性分配） */
  private cR: HTMLCanvasElement | null = null;
  private cB: HTMLCanvasElement | null = null;
  private cgR: CanvasRenderingContext2D | null = null;
  private cgB: CanvasRenderingContext2D | null = null;

  /* 烘焙的全屏叠加层 */
  private vig: HTMLCanvasElement | null = null;
  private danger: HTMLCanvasElement | null = null;
  private bakeKey = '';

  private scan: CanvasPattern | null = null;

  constructor(out: CanvasRenderingContext2D, bank: SpriteBank) {
    this.out = out;
    this.bank = bank;
    const s = makeCanvas(1, 4);
    const sg = ctx2d(s);
    sg.fillStyle = '#ffffff';
    sg.fillRect(0, 0, 1, 1);
    this.scan = out.createPattern(s, 'repeat');
  }

  setQuality(q: Quality): void {
    this.q = q;
    if (!q.bloom) {
      this.bA = null;
      this.bB = null;
      this.bgA = null;
      this.bgB = null;
    }
    if (!q.chroma) {
      this.cR = null;
      this.cB = null;
      this.cgR = null;
      this.cgB = null;
    }
  }

  resize(w: number, h: number, dpr: number): void {
    this.w = Math.max(1, w | 0);
    this.h = Math.max(1, h | 0);
    this.dpr = dpr > 0 ? dpr : 1;
    this.dw = Math.max(1, Math.round(this.w * this.dpr));
    this.dh = Math.max(1, Math.round(this.h * this.dpr));
    this.bw = Math.max(8, Math.round(this.dw / 4));
    this.bh = Math.max(8, Math.round(this.dh / 4));
    this.bA = null;
    this.bB = null;
    this.cR = null;
    this.cB = null;
    this.bakeKey = '';
  }

  private ensureBloom(): boolean {
    if (this.bA && this.bB) return true;
    this.bA = makeCanvas(this.bw, this.bh);
    this.bB = makeCanvas(this.bw, this.bh);
    this.bgA = ctx2d(this.bA);
    this.bgB = ctx2d(this.bB);
    return true;
  }
  private ensureChroma(): boolean {
    if (this.cR && this.cB) return true;
    this.cR = makeCanvas(this.bw, this.bh);
    this.cB = makeCanvas(this.bw, this.bh);
    this.cgR = ctx2d(this.cR);
    this.cgB = ctx2d(this.cB);
    return true;
  }

  reset(): void {
    if (this.bgA) this.bgA.clearRect(0, 0, this.bw, this.bh);
    if (this.bgB) this.bgB.clearRect(0, 0, this.bw, this.bh);
    if (this.cgR) this.cgR.clearRect(0, 0, this.bw, this.bh);
    if (this.cgB) this.cgB.clearRect(0, 0, this.bw, this.bh);
  }

  /** vignette / 危险脉动：按 1/4 分辨率烘焙一次（尺寸变化才重建），合成时放大贴回 */
  private bakeOverlays(): void {
    const key = this.dw + 'x' + this.dh + '|' + this.dpr;
    if (this.vig && this.danger && this.bakeKey === key) return;
    const W = this.bw, H = this.bh;

    // 1) vignette：优先用素材（一次性缩放到输出尺寸），否则用缓存径向渐变
    const vig = makeCanvas(W, H);
    const vg = ctx2d(vig);
    if (this.bank.fromAsset('vignette')) {
      vg.drawImage(this.bank.raw('vignette'), 0, 0, W, H);
    } else {
      const cw = Math.max(2, Math.round(W * 0.25));
      const ch = Math.max(2, Math.round(H * 0.25));
      const small = makeCanvas(cw, ch);
      const sg = ctx2d(small);
      const r = Math.hypot(cw, ch) * 0.5;
      const gr = sg.createRadialGradient(cw * 0.5, ch * 0.5, r * 0.42, cw * 0.5, ch * 0.5, r);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(1, 'rgba(0,0,0,0.85)');
      sg.fillStyle = gr;
      sg.fillRect(0, 0, cw, ch);
      vg.drawImage(small, 0, 0, W, H);
    }

    // 2) 危险脉动：红色边缘
    const danger = makeCanvas(W, H);
    const dg = ctx2d(danger);
    const cw2 = Math.max(2, Math.round(W * 0.2));
    const ch2 = Math.max(2, Math.round(H * 0.2));
    const small2 = makeCanvas(cw2, ch2);
    const s2 = ctx2d(small2);
    const img = s2.createImageData(cw2, ch2);
    const d = img.data;
    const R = cw2 * 0.5, R2 = ch2 * 0.5;
    for (let y = 0; y < ch2; y++) {
      for (let x = 0; x < cw2; x++) {
        const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R2) / R2;
        const rr = Math.min(1, Math.hypot(dx, dy) * 1.02);
        const a = Math.pow(rr, 3.4);
        const i = (y * cw2 + x) * 4;
        d[i] = 255; d[i + 1] = 77; d[i + 2] = 94;
        d[i + 3] = (a * 255) | 0;
      }
    }
    s2.putImageData(img, 0, 0);
    dg.drawImage(small2, 0, 0, W, H);

    this.vig = vig;
    this.danger = danger;
    this.bakeKey = key;
  }

  /**
   * 场景 → 可见 canvas 的最终合成。全部 device px / identity / 整数坐标。
   * slow: 慢动作强度 0..1；warn: 危险脉动 0..1。
   */
  composite(scene: HTMLCanvasElement, view: ViewState, pal: Palette, t: number, warn: number, slow: number, hitstop: number): void {
    const g = this.out;
    const q = this.q ?? view.quality;
    const W = this.dw, H = this.dh;
    // 场景 canvas 可能是子分辨率（renderScale<1）→ 一律用"小图放大"合成（GPU 快路径）
    const SW = scene.width || W;
    const SH = scene.height || H;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;

    /* ---- 主画面 + 色差（1/4 分辨率通道 + 放大合成）---- */
    const chroma = q && q.chroma ? clamp(view.chroma, 0, 1) : 0;
    if (chroma > CHROMA_GATE && this.ensureChroma() && this.cgR && this.cgB && this.cR && this.cB) {
      const cw = this.bw, ch = this.bh;
      const gr = this.cgR, gb = this.cgB;
      gr.setTransform(1, 0, 0, 1, 0, 0);
      gr.globalCompositeOperation = 'source-over';
      gr.globalAlpha = 1;
      gr.clearRect(0, 0, cw, ch);
      gr.drawImage(scene, 0, 0, SW, SH, 0, 0, cw, ch); // 缩小采样（每帧一次，代价可控）
      gr.globalCompositeOperation = 'multiply';
      gr.fillStyle = '#ff0000';
      gr.fillRect(0, 0, cw, ch);
      gb.setTransform(1, 0, 0, 1, 0, 0);
      gb.globalCompositeOperation = 'source-over';
      gb.globalAlpha = 1;
      gb.clearRect(0, 0, cw, ch);
      gb.drawImage(scene, 0, 0, SW, SH, 0, 0, cw, ch);
      gb.globalCompositeOperation = 'multiply';
      gb.fillStyle = '#00ffff';
      gb.fillRect(0, 0, cw, ch);
      const di = Math.max(1, Math.round(0.5 + 3.2 * chroma)); // 整数像素偏移
      g.clearRect(0, 0, W, H);
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 1;
      g.drawImage(this.cR, -di, 0, W, H); // 小图放大 = 快路径
      g.drawImage(this.cB, di, 0, W, H);
      perf.draws += 6;
    } else {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      g.drawImage(scene, 0, 0, SW, SH, 0, 0, W, H); // 小图放大 = GPU 快路径
      perf.draws++;
    }

    /* ---- 近似 bloom：1/4 分辨率整数偏移加性模糊，最后放大贴回 ---- */
    if (q && q.bloom && this.ensureBloom() && this.bgA && this.bgB && this.bA && this.bB) {
      const bw = this.bw, bh = this.bh;
      const bA = this.bgA, bB = this.bgB;
      bA.setTransform(1, 0, 0, 1, 0, 0);
      bA.globalCompositeOperation = 'source-over';
      bA.globalAlpha = 1;
      bA.clearRect(0, 0, bw, bh);
      bA.drawImage(scene, 0, 0, SW, SH, 0, 0, bw, bh);
      // 横向 5 抽头（整数偏移 2px，等效全分辨率 8px）
      bB.setTransform(1, 0, 0, 1, 0, 0);
      bB.globalCompositeOperation = 'source-over';
      bB.globalAlpha = 1;
      bB.clearRect(0, 0, bw, bh);
      bB.globalCompositeOperation = 'lighter';
      bB.globalAlpha = 1 / 5;
      for (let k = -2; k <= 2; k++) bB.drawImage(this.bA, k * 2, 0);
      // 纵向 5 抽头
      bA.globalCompositeOperation = 'source-over';
      bA.globalAlpha = 1;
      bA.clearRect(0, 0, bw, bh);
      bA.globalCompositeOperation = 'lighter';
      bA.globalAlpha = 1 / 5;
      for (let k = -2; k <= 2; k++) bA.drawImage(this.bB, 0, k * 2);
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = clamp((0.26 + hitstop * 0.42) * view.intensity, 0.08, 0.8) * (q.glowScale || 1);
      g.drawImage(this.bA, 0, 0, W, H); // 放大合成 = 快路径
      perf.draws += 13;
    }

    /* ---- vignette（1/4 分辨率烘焙层，放大贴回）---- */
    this.bakeOverlays();
    if (this.vig) {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = clamp(0.72 * (0.6 + view.intensity * 0.5), 0, 0.95);
      g.drawImage(this.vig, 0, 0, W, H);
      perf.draws++;
    }

    /* ---- 危险脉动 ---- */
    if (warn > 0.01 && this.danger) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = clamp(warn * (0.35 + 0.3 * Math.abs(Math.sin(t * 5))), 0, 0.6);
      g.drawImage(this.danger, 0, 0, W, H);
      perf.draws++;
    }

    /* ---- 慢动作：冷色调（fillRect）+ 径向速度线（矢量 stroke）---- */
    if (slow > 0.02) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = clamp(slow * 0.1, 0, 0.12);
      g.fillStyle = mixColor(pal.orbit2, '#0a2a4a', 0.55);
      g.fillRect(0, 0, W, H);
      const cx = W * 0.5, cy = H * 0.5;
      const R = Math.hypot(W, H) * 0.5;
      g.globalAlpha = clamp(slow * 0.09, 0, 0.1);
      g.strokeStyle = rgba(mixColor(pal.orbit, '#ffffff', 0.5), 1);
      g.lineWidth = 1.3 * this.dpr;
      g.beginPath();
      const N = 48;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * TAU + Math.sin(t * 0.3 + i) * 0.05;
        const r0 = R * (0.5 + 0.22 * Math.abs(Math.sin(t * 0.7 + i * 1.7)));
        const dx = Math.cos(a), dy = Math.sin(a);
        g.moveTo(cx + dx * r0, cy + dy * r0);
        g.lineTo(cx + dx * R * 1.05, cy + dy * R * 1.05);
      }
      g.stroke();
      perf.draws += 2;
    }

    /* ---- 传感器式极淡横向扫描线（pattern 填充，alpha ≤ 0.03）---- */
    if (this.scan) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.028;
      g.fillStyle = this.scan;
      g.fillRect(0, 0, W, H);
      perf.draws++;
    }

    /* ---- 命中定格白闪 ---- */
    const flash = clamp(view.flash, 0, 1);
    if (flash > 0.004) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = flash * 0.75;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);
      perf.draws++;
    }

    /* ---- 场景淡入淡出 ---- */
    const fade = clamp(view.fade, 0, 1);
    if (fade > 0.002) {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = fade;
      g.fillStyle = '#000000';
      g.fillRect(0, 0, W, H);
      perf.draws++;
    }

    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }
}
