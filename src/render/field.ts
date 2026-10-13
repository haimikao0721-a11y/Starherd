/**
 * STARHERD — 引力场可视化（W-render）
 *
 * 真实等势面  Φ(p) = -Σ G·m_i / sqrt(r_i² + ε²)
 * 在 80×45 粗网格上用 marching squares 求等值线（深空里的「引力地形等高线」），
 * 每 280 ms 重算一次并把结果缓存为 Path2D（不每帧重建、不每帧分配）；
 * 再叠一层稀疏场向量箭头（每 8 格一个，长度按 |g| 归一化）。
 */
import type { Palette, Quality, World } from '../sim/types';
import { PX_PER_RU } from '../engine/view';
import { clamp, hexToRgb, mixColor, perf, rgba, rgbToHex, mixRgb } from './draw';

export const FIELD_COLS = 80;
export const FIELD_ROWS = 45;
const REBUILD_MS = 280;
const ARROW_STEP = 8;
const MAX_LEVELS = 14;

/**
 * marching squares 核心（纯函数，可在 Node 中单测）。
 * values[gy*(cols+1)+gx] 为节点值；节点世界坐标 = (x0+gx*hx, y0+gy*hy)。
 * emit(x1,y1,x2,y2) 输出线段（世界坐标）。返回线段数。
 */
export function marchingSquares(
  values: Float32Array, cols: number, rows: number,
  x0: number, y0: number, hx: number, hy: number,
  level: number, emit: (x1: number, y1: number, x2: number, y2: number) => void,
): number {
  let segs = 0;
  const stride = cols + 1;
  for (let gy = 0; gy < rows; gy++) {
    const row = gy * stride;
    const row2 = row + stride;
    const wy0 = y0 + gy * hy;
    const wy1 = wy0 + hy;
    for (let gx = 0; gx < cols; gx++) {
      const v00 = values[row + gx];
      const v10 = values[row + gx + 1];
      const v11 = values[row2 + gx + 1];
      const v01 = values[row2 + gx];
      let mn = v00, mx = v00;
      if (v10 < mn) mn = v10; else if (v10 > mx) mx = v10;
      if (v11 < mn) mn = v11; else if (v11 > mx) mx = v11;
      if (v01 < mn) mn = v01; else if (v01 > mx) mx = v01;
      if (level < mn || level > mx) continue;
      let code = 0;
      if (v00 >= level) code |= 1;
      if (v10 >= level) code |= 2;
      if (v11 >= level) code |= 4;
      if (v01 >= level) code |= 8;
      if (code === 0 || code === 15) continue;
      const wx0 = x0 + gx * hx;
      const wx1 = wx0 + hx;
      // 边插值点（按需计算，零分配）
      // e0: c0(x0,y0)-c1(x1,y0)   e1: c1(x1,y0)-c2(x1,y1)
      // e2: c3(x0,y1)-c2(x1,y1)   e3: c0(x0,y0)-c3(x0,y1)
      let e0x = 0, e0y = wy0, e1x = wx1, e1y = 0, e2x = 0, e2y = wy1, e3x = wx0, e3y = 0;
      const d0 = v10 - v00, d1 = v11 - v10, d2 = v11 - v01, d3 = v01 - v00;
      e0x = wx0 + (d0 === 0 ? 0.5 : (level - v00) / d0) * hx;
      e1y = wy0 + (d1 === 0 ? 0.5 : (level - v10) / d1) * hy;
      e2x = wx0 + (d2 === 0 ? 0.5 : (level - v01) / d2) * hx;
      e3y = wy0 + (d3 === 0 ? 0.5 : (level - v00) / d3) * hy;
      switch (code) {
        case 1: case 14:
          emit(e3x, e3y, e0x, e0y); segs++; break;
        case 2: case 13:
          emit(e0x, e0y, e1x, e1y); segs++; break;
        case 3: case 12:
          emit(e3x, e3y, e1x, e1y); segs++; break;
        case 4: case 11:
          emit(e1x, e1y, e2x, e2y); segs++; break;
        case 6: case 9:
          emit(e0x, e0y, e2x, e2y); segs++; break;
        case 7: case 8:
          emit(e2x, e2y, e3x, e3y); segs++; break;
        case 5: {
          const center = (v00 + v10 + v11 + v01) * 0.25;
          if (center >= level) {
            emit(e0x, e0y, e1x, e1y); segs++;
            emit(e2x, e2y, e3x, e3y); segs++;
          } else {
            emit(e3x, e3y, e0x, e0y); segs++;
            emit(e1x, e1y, e2x, e2y); segs++;
          }
          break;
        }
        case 10: {
          const center = (v00 + v10 + v11 + v01) * 0.25;
          if (center >= level) {
            emit(e3x, e3y, e0x, e0y); segs++;
            emit(e1x, e1y, e2x, e2y); segs++;
          } else {
            emit(e0x, e0y, e1x, e1y); segs++;
            emit(e2x, e2y, e3x, e3y); segs++;
          }
          break;
        }
        default: break;
      }
    }
  }
  return segs;
}

/** 采样势场到网格（供单测与 FieldLayer 共用） */
export function samplePotential(
  out: Float32Array, cols: number, rows: number,
  x0: number, y0: number, hx: number, hy: number,
  bodies: { x: number; y: number; mass: number }[], G: number, eps: number,
): void {
  const stride = cols + 1;
  const e2 = eps * eps;
  for (let gy = 0; gy <= rows; gy++) {
    const wy = y0 + gy * hy;
    for (let gx = 0; gx <= cols; gx++) {
      const wx = x0 + gx * hx;
      let phi = 0;
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        const dx = wx - b.x, dy = wy - b.y;
        phi -= (G * b.mass) / Math.sqrt(dx * dx + dy * dy + e2);
      }
      out[gy * stride + gx] = phi;
    }
  }
}

interface Contour {
  level: number;
  path: Path2D;
  color: string;
  width: number;
  alpha: number;
}export class FieldLayer {
  private vals = new Float32Array((FIELD_COLS + 1) * (FIELD_ROWS + 1));
  private levels: number[] = [];
  private contours: Contour[] = [];
  private bands: (Path2D | null)[] = [null, null, null];
  private bandColor: string[] = ['#000000', '#000000', '#000000'];
  private bandAlpha: number[] = [0.2, 0.3, 0.42];
  private bandWidth: number[] = [1, 1.5, 2];
  private timer = 1e3;
  private bounds = 6;
  private dirty = true;
  private lastPalette = '';
  private segs = 0;

  /** 标记需要重算（关卡/调色板/质量变化时调用） */
  invalidate(): void {
    this.dirty = true;
    this.timer = 1e3;
  }

  private buildLevels(world: World): void {
    const bodies = world.bodies;
    const cand = this.levels;
    cand.length = 0;
    const G = world.G || 1;
    const eps = world.epsilon || 0.02;
    const bounds = world.bounds || 6;
    let mmax = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.mass > mmax) mmax = b.mass;
    }
    // 等值线半径：以 bounds 的比例为主，同时保证不小于天体自身尺度的若干倍
    const radFrac = [0.11, 0.17, 0.26, 0.4, 0.58, 0.8];
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.primary && b.kind !== 'pod') continue;
      const m = b.mass;
      if (m <= 0 || m < mmax * 0.004) continue;
      const R = Math.max(b.radius, 0.012);
      for (let k = 0; k < radFrac.length; k++) {
        // 下限 = max(天体尺度倍数, bounds 比例) ⇒ 网格能解析，不会画成多边形
        const r = Math.max(R * (1.8 + k * 2.2), bounds * radFrac[k]);
        cand.push(-(G * m) / Math.sqrt(r * r + eps * eps));
      }
    }
    if (cand.length === 0) return;
    cand.sort((a, b) => b - a);
    // 去重（相对容差 3%）
    let w = 0;
    for (let i = 0; i < cand.length; i++) {
      const v = cand[i];
      if (w > 0 && Math.abs(v - cand[w - 1]) < Math.abs(v) * 0.03) continue;
      cand[w++] = v;
    }
    cand.length = w;
    if (cand.length > MAX_LEVELS) {
      // 均匀抽样，保留由浅到深的分布
      const keep: number[] = [];
      for (let i = 0; i < MAX_LEVELS; i++) keep.push(cand[Math.round((i * (cand.length - 1)) / (MAX_LEVELS - 1))]);
      cand.length = 0;
      for (let i = 0; i < keep.length; i++) cand.push(keep[i]);
    }
  }

  rebuild(world: World, pal: Palette, quality: Quality): void {
    if (!quality.fieldContours) {
      this.contours.length = 0;
      return;
    }
    const bounds = world.bounds || 6;
    const x0 = -bounds, y0 = -bounds;
    const hx = (2 * bounds) / FIELD_COLS;
    const hy = (2 * bounds) / FIELD_ROWS;
    const G = world.G || 1;
    const eps = world.epsilon || 0.02;
    // 只用主天体（轻体对势场贡献可忽略，还能省一半算力）
    const b = world.primaries && world.primaries.length ? world.primaries : world.bodies;
    const src: { x: number; y: number; mass: number }[] = [];
    for (let i = 0; i < b.length; i++) {
      const o = b[i];
      if (o.mass > 0 && o.kind !== 'pod') src.push(o);
    }
    if (src.length === 0) {
      this.contours.length = 0;
      return;
    }
    samplePotential(this.vals, FIELD_COLS, FIELD_ROWS, x0, y0, hx, hy, src, G, eps);
    this.buildLevels(world);
    const lv = this.levels;
    this.contours.length = 0;
    this.segs = 0;
    const deep = hexToRgb(pal.well);
    const mid = hexToRgb(pal.orbit);
    const shallow = hexToRgb(pal.orbit2);
    let phiMin = 0;
    for (let i = 0; i < lv.length; i++) if (lv[i] < phiMin) phiMin = lv[i];
    // 按深度分 3 组：每组只描边一次（26 次 stroke → 3 次，省掉大量路径切换开销）
    const BANDS = 3;
    for (let b = 0; b < BANDS; b++) this.bands[b] = null;
    for (let i = 0; i < lv.length; i++) {
      const level = lv[i];
      const path = new Path2D();
      const s = marchingSquares(this.vals, FIELD_COLS, FIELD_ROWS, x0, y0, hx, hy, level, (x1, y1, x2, y2) => {
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);
      });
      if (s === 0) continue;
      this.segs += s;
      // 颜色随势阱深度变化：浅 → 轨道青，深 → 引力井品红
      const t = phiMin === 0 ? 0 : clamp(level / phiMin, 0, 1);
      const col = t < 0.55 ? mixRgb(shallow, mid, t / 0.55) : mixRgb(mid, deep, (t - 0.55) / 0.45);
      const band = t < 0.4 ? 0 : t < 0.72 ? 1 : 2;
      let bp = this.bands[band];
      if (!bp) {
        bp = new Path2D();
        this.bands[band] = bp;
      }
      bp.addPath(path);
      this.contours.push({ level, path, color: rgbToHex(col), width: 1, alpha: 0.14 + 0.34 * t });
    }
    // 每组的样式由该组代表性色温决定（避免逐层切换 strokeStyle）
    for (let b = 0; b < BANDS; b++) {
      this.bandColor[b] = rgbToHex(b === 0 ? mixRgb(shallow, mid, 0.45) : b === 1 ? mixRgb(mid, deep, 0.3) : deep);
      this.bandAlpha[b] = b === 0 ? 0.2 : b === 1 ? 0.3 : 0.42;
      this.bandWidth[b] = 1 + b * 0.5;
    }
    this.bounds = bounds;
    this.lastPalette = pal.id;
    this.dirty = false;
  }

  /**
   * 每帧入口：showContours 时按 120 ms 节流重算并绘制等势线；showVectors 时叠场向量箭头。
   */
  draw(env: { g: CanvasRenderingContext2D; pal: Palette; quality: Quality; inv: number; t: number; gs: number }, world: World, dt: number, showContours: boolean, showVectors: boolean): void {
    if (showContours) {
      this.timer += dt * 1000;
      if (this.dirty || this.timer >= REBUILD_MS || this.lastPalette !== env.pal.id || this.bounds !== (world.bounds || 6)) {
        this.timer = 0;
        this.rebuild(world, env.pal, env.quality);
      }
      const g = env.g;
      // 3 组深度各描边一次（而不是每层一次），大幅降低路径切换与光栅化开销
      let any = false;
      for (let b = 0; b < this.bands.length; b++) if (this.bands[b]) any = true;
      if (any) {
        g.globalCompositeOperation = 'lighter';
        g.lineJoin = 'round';
        g.lineCap = 'butt';
        for (let b = 0; b < this.bands.length; b++) {
          const bp = this.bands[b];
          if (!bp) continue;
          g.strokeStyle = rgba(this.bandColor[b], this.bandAlpha[b]);
          g.lineWidth = this.bandWidth[b] * env.inv;
          g.stroke(bp);
          perf.draws++;
        }
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
      }
    }
    if (showVectors) this.drawVectors(env, world);
  }

  /** 稀疏场向量箭头：每 8 格一个，长度按 |g| 归一化 */
  private drawVectors(env: { g: CanvasRenderingContext2D; pal: Palette; quality: Quality; inv: number; t: number; gs: number }, world: World): void {
    const g = env.g;
    const bounds = world.bounds || 6;
    const G = world.G || 1;
    const eps = world.epsilon || 0.02;
    const hx = (2 * bounds) / FIELD_COLS;
    const hy = (2 * bounds) / FIELD_ROWS;
    const e2 = eps * eps;
    const b = world.primaries && world.primaries.length ? world.primaries : world.bodies;
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = rgba(env.pal.orbit, 0.16);
    g.fillStyle = rgba(env.pal.orbit, 0.19);
    g.lineWidth = 0.9 * env.inv;
    g.beginPath();
    const cell = ARROW_STEP * hx;
    const cellY = ARROW_STEP * hy;
    const maxLen = Math.min(cell, cellY) * 0.34;
    for (let gy = ARROW_STEP * 0.5; gy < FIELD_ROWS; gy += ARROW_STEP) {
      const wy = -bounds + gy * hy;
      for (let gx = ARROW_STEP * 0.5; gx < FIELD_COLS; gx += ARROW_STEP) {
        const wx = -bounds + gx * hx;
        let ax = 0, ay = 0;
        for (let i = 0; i < b.length; i++) {
          const o = b[i];
          if (o.mass <= 0) continue;
          const dx = o.x - wx, dy = o.y - wy;
          const r2 = dx * dx + dy * dy + e2;
          const inv = (G * o.mass) / (r2 * Math.sqrt(r2));
          ax += dx * inv;
          ay += dy * inv;
        }
        const m = Math.hypot(ax, ay);
        if (m < 1e-9) continue;
        const L = maxLen * clamp(Math.log(1 + m * 60) * 0.5, 0.12, 1);
        const ux = ax / m, uy = ay / m;
        const x2 = wx + ux * L, y2 = wy + uy * L;
        g.moveTo(wx, wy);
        g.lineTo(x2, y2);
        // 箭头
        g.moveTo(x2, y2);
        g.lineTo(x2 - ux * L * 0.34 - uy * L * 0.18, y2 - uy * L * 0.34 + ux * L * 0.18);
        g.lineTo(x2 - ux * L * 0.34 + uy * L * 0.18, y2 - uy * L * 0.34 - ux * L * 0.18);
        g.closePath();
      }
    }
    g.stroke();
    g.fill();   // 箭头实心（线段子路径填充为空，无副作用）
    perf.draws += 2;
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }

  /** 诊断/自动化测试用 */
  get contourCount(): number { return this.contours.length; }
  get levelCount(): number { return this.levels.length; }
  get segmentCount(): number { return this.segs; }
}

export const FIELD_PX_PER_RU = PX_PER_RU;
