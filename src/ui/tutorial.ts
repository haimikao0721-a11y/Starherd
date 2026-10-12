/**
 * 操作演示动画（新手教学）。
 *
 * 为什么要它：玩法是"用引力井间接操纵货舱"，光看文字很难建立直觉——
 * 玩家反馈"看不懂、左右键像重合"。这里用分镜动画把核心心智模型一次讲清：
 *
 *   1 你是引力源（鼠标＝井，有惯性滞后）
 *   2 左键＝吸引（井放在货舱前方 → 拉住它、减速）
 *   3 右键＝排斥（极性反转 → 推开它）
 *   4 松手＝惯性滑行（不耗燃料）
 *   5 目标：把货舱送进对接环（速度要低于 v_max）
 *
 * 第 2/3/4 幕是**真实积分**：用与游戏完全相同的 `pointAccel` / `wellAccel`
 * （同一套 Plummer 软化与场强上限），所以演示里的运动方向和游戏里一致。
 * 第 5 幕是对接流程的示意动画（保证每次都能讲清楚结果）。
 */
import {
  FIELD_SOFTEN, OMEGA, WELL_MASS_MAX, WELL_PRESETS, ZETA, circularVelocity,
} from '../sim/constants';
import { pointAccel, wellAccel } from '../sim/physics';
import type { Vec2 } from '../sim/types';

/** 归一化天文单位：G=1、μ★=1（与 DESIGN §2 一致；演示里恒星按 μ=1 处理） */
const MU_STAR = 1;

export interface TutStep {
  /** 场景类型 */
  scene: 'aim' | 'attract' | 'repel' | 'coast' | 'dock';
  title: string;
  sub: string;
  text: string;
  hint: string;
  /** 是否显示"左键/右键按住"图示 */
  press?: 'left' | 'right' | null;
}

export const TUT_STEPS: TutStep[] = [
  {
    scene: 'aim', title: '你是引力源', sub: 'YOU ARE THE GRAVITY WELL',
    text: '你不是射手。屏幕上那个跟着你的环，就是你的"引力井"。按住左键时，井会被飞船拖着追随鼠标——有惯性、会滞后（按住 Shift 变精确、不甩尾）；松开就断电滑行。',
    hint: '按住时井跟随鼠标', press: 'left',
  },
  {
    scene: 'attract', title: '左键 = 吸引', sub: 'HOLD LEFT — ATTRACT',
    text: '按住左键给井通电，它会吸引周围的一切。想让货舱减速，就把井放在它"前进方向的前方"——货舱会被拉住、越来越慢。',
    hint: '按住左键 · 吸引', press: 'left',
  },
  {
    scene: 'repel', title: '右键 = 排斥', sub: 'HOLD RIGHT — REPEL',
    text: '按住右键，极性反转：井变成斥力源，把货舱推开。用途是紧急避让、防撞、以及靠近对接环时的微调——和左键方向相反，不是同一个功能。',
    hint: '按住右键 · 排斥', press: 'right',
  },
  {
    scene: 'coast', title: '松手 = 惯性滑行', sub: 'RELEASE — COAST',
    text: '松开按键就断电场，货舱沿真实轨道继续滑行，一分燃料都不花。省燃料的关键是：只在需要改变轨道时通电，其余时间让它自己飞。',
    hint: '松开 · 不耗燃料', press: null,
  },
  {
    scene: 'dock', title: '目标：软对接', sub: 'DOCK BELOW V_MAX',
    text: '把货舱送进空间站的对接环，而且相对速度要低于环的极限速度。太快＝硬对接（货舱受损），更快＝撞环弹开。绿色＝软对接满分。',
    hint: '进入环内 · 速度达标', press: null,
  },
];

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

interface Pod { x: number; y: number; vx: number; vy: number; trail: number[]; }

export class TutorialAnim {
  private cv: HTMLCanvasElement | null = null;
  private g: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private last = 0;
  private step = 0;
  private t = 0;
  private w = 900;
  private h = 360;
  private dpr = 1;

  /* 井（弹簧-阻尼追随鼠标），用与游戏相同的 ω/ζ */
  private wx = 0; private wy = 0; private wvx = 0; private wvy = 0;
  /* 鼠标目标（脚本驱动） */
  private cx = 0; private cy = 0;
  private pod: Pod = { x: 0, y: 0, vx: 0, vy: 0, trail: [] };
  private flash = 0;
  private acc: Vec2 = { x: 0, y: 0 };

  get count(): number { return TUT_STEPS.length; }
  get current(): number { return this.step; }
  get steps(): TutStep[] { return TUT_STEPS; }

  attach(cv: HTMLCanvasElement): void {
    this.detach();
    this.cv = cv;
    this.g = cv.getContext('2d');
    this.resize();
    // attach 时面板可能还没完成布局（rect 为 0）→ 下一帧再量一次，避免画布被 CSS 缩放糊掉
    requestAnimationFrame(() => this.resize());
    window.addEventListener('resize', this.onWinResize);
    this.resetScene();
    this.last = performance.now();
    const tick = (now: number): void => {
      const dt = clamp((now - this.last) / 1000, 0, 0.05);
      this.last = now;
      this.update(dt);
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private onWinResize = (): void => { this.resize(); };

  detach(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener('resize', this.onWinResize);
    this.cv = null;
    this.g = null;
  }

  setStep(i: number): void {
    const n = clamp(i | 0, 0, TUT_STEPS.length - 1);
    if (n === this.step) return;
    this.step = n;
    this.resetScene();
  }

  next(): void { this.setStep(this.step + 1); }
  prev(): void { this.setStep(this.step - 1); }

  resize(): void {
    const cv = this.cv;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    this.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    this.w = Math.max(320, Math.round(r.width || 900));
    this.h = Math.max(200, Math.round(r.height || 360));
    cv.width = Math.round(this.w * this.dpr);
    cv.height = Math.round(this.h * this.dpr);
  }

  /* ---------------------------------------------------------------- 场景 */

  private resetScene(): void {
    this.t = 0;
    this.flash = 0;
    const s = TUT_STEPS[this.step].scene;
    if (s === 'aim') {
      this.cx = 0; this.cy = -0.75;
      this.wx = 0; this.wy = -0.75; this.wvx = 0; this.wvy = 0;
      this.setPod(1.0, 0, 0, circularVelocity(MU_STAR, 1.0));
    } else if (s === 'attract' || s === 'repel') {
      this.setPod(-0.55, 0.15, 0, 0);
      this.wx = 0.75; this.wy = -0.1; this.wvx = 0; this.wvy = 0;
      this.cx = 0.75; this.cy = -0.1;
    } else if (s === 'coast') {
      this.setPod(0.72, 0, 0, circularVelocity(MU_STAR, 0.72) * 1.08); // 略快 → 椭圆
      this.wx = 2.2; this.wy = -1.2; this.wvx = 0; this.wvy = 0;
      this.cx = 2.2; this.cy = -1.2;
    } else {
      this.setPod(1.55, 0, 0, circularVelocity(MU_STAR, 1.55) * 0.93);
      this.wx = 1.9; this.wy = -0.4; this.wvx = 0; this.wvy = 0;
      this.cx = 1.9; this.cy = -0.4;
    }
  }

  private setPod(x: number, y: number, vx: number, vy: number): void {
    this.pod = { x, y, vx, vy, trail: [] };
  }

  private update(dt: number): void {
    this.t += dt;
    const s = TUT_STEPS[this.step].scene;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 1.6);

    /* 脚本驱动"鼠标"位置 */
    if (s === 'aim') {
      this.cx = Math.cos(this.t * 0.85) * 0.95;
      this.cy = Math.sin(this.t * 1.15) * 0.62;
    } else if (s === 'attract') {
      // 井停在货舱前方：货舱被拉住（真实积分）
      this.cx = 0.78 + Math.sin(this.t * 0.5) * 0.12;
      this.cy = -0.12 + Math.cos(this.t * 0.42) * 0.1;
    } else if (s === 'repel') {
      this.cx = 0.1 + Math.sin(this.t * 0.6) * 0.15;
      this.cy = 0.1 + Math.cos(this.t * 0.5) * 0.12;
    }

    /* 井：弹簧-阻尼追随（与游戏同一套 ω、ζ；演示里用重井更容易看出滞后） */
    const zeta = s === 'aim' ? ZETA : ZETA * 0.9;
    const ax = OMEGA * OMEGA * (this.cx - this.wx) - 2 * zeta * OMEGA * this.wvx;
    const ay = OMEGA * OMEGA * (this.cy - this.wy) - 2 * zeta * OMEGA * this.wvy;
    this.wvx += ax * dt; this.wvy += ay * dt;
    this.wx += this.wvx * dt; this.wy += this.wvy * dt;

    /* 货舱：真实积分（同一套公式） */
    const fieldOn = s === 'attract' || s === 'repel' || s === 'dock';
    const repel = s === 'repel';
    const mass = s === 'dock' ? WELL_PRESETS[1] : WELL_MASS_MAX * 0.55;
    const n = 4; // 子步，保持稳定
    const h = dt / n;
    for (let k = 0; k < n; k++) {
      this.acc.x = 0; this.acc.y = 0;
      if (s !== 'attract' && s !== 'repel') {
        // 恒星引力（演示里货舱按测试粒子处理，与游戏一致）
        pointAccel(this.pod.x, this.pod.y, MU_STAR, FIELD_SOFTEN, this.acc);
      }
      if (fieldOn) {
        const wx = s === 'dock' ? this.dockWellX() : this.wx;
        const wy = s === 'dock' ? this.dockWellY() : this.wy;
        wellAccel(this.pod.x, this.pod.y, wx, wy, mass, 3.0, repel, FIELD_SOFTEN, this.acc);
      }
      this.pod.vx += this.acc.x * h;
      this.pod.vy += this.acc.y * h;
      this.pod.x += this.pod.vx * h;
      this.pod.y += this.pod.vy * h;
    }

    /* 轨迹 */
    const tr = this.pod.trail;
    tr.push(this.pod.x, this.pod.y);
    if (tr.length > 480) tr.splice(0, tr.length - 480);

    /* 越界/超时 → 重播这一幕 */
    const far = Math.abs(this.pod.x) > 3.4 || Math.abs(this.pod.y) > 2.6 || this.t > 26;
    if (far) this.resetScene();
    if (s === 'dock' && this.dockProgress() > 0.999 && this.flash < 0.01) this.flash = 1;
  }

  /** 第 5 幕：把井放在货舱"前方"（沿速度反方向偏一点），示意减速下降 */
  private dockWellX(): number { return this.pod.x + this.pod.vx * 0.55; }
  private dockWellY(): number { return this.pod.y + this.pod.vy * 0.55; }

  private dockProgress(): number {
    const r = Math.hypot(this.pod.x, this.pod.y);
    return clamp((1.55 - r) / (1.55 - 1.15), 0, 1);
  }

  /* ---------------------------------------------------------------- 绘制 */

  private draw(): void {
    const g = this.g;
    if (!g) return;
    const s = TUT_STEPS[this.step].scene;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);

    // 背景（深空 + 网格暗示）
    const grad = g.createLinearGradient(0, 0, 0, this.h);
    grad.addColorStop(0, '#070b18');
    grad.addColorStop(1, '#04060f');
    g.fillStyle = grad;
    g.fillRect(0, 0, this.w, this.h);
    this.grid();

    const scale = Math.min(this.w / 4.4, this.h / 2.8);
    const ox = this.w * 0.5;
    const oy = this.h * 0.5;
    const X = (x: number): number => ox + x * scale;
    const Y = (y: number): number => oy + y * scale;

    if (s !== 'attract' && s !== 'repel') this.star(X(0), Y(0), scale);
    if (s === 'dock') this.station(X(1.15), Y(0), scale);

    // 场环（左键=向内箭头，右键=向外箭头，颜色固定在两种状态上）
    const engaged = s === 'attract' || s === 'repel' || s === 'dock';
    if (engaged) this.field(X(this.wx), Y(this.wy), scale, s === 'repel');
    // 未通电也要能看见"井在哪"——第 1 幕讲的就是"鼠标=引力井、井有惯性滞后"
    else this.wellIdle(X(this.wx), Y(this.wy), X(this.cx), Y(this.cy), scale);

    this.trail(X, Y);
    this.podGlyph(X(this.pod.x), Y(this.pod.y), scale, s === 'dock' ? this.dockProgress() : 0);
    this.cursor(X(this.cx), Y(this.cy));

    if (this.flash > 0) {
      g.globalAlpha = this.flash;
      g.fillStyle = 'rgba(126,247,208,1)';
      g.font = `600 ${Math.round(18)}px ui-monospace, Consolas, monospace`;
      g.textAlign = 'center';
      g.fillText('软对接成功 DOCKED', X(1.15), Y(0) - scale * 0.42);
      g.globalAlpha = 1;
    }

    // 图例
    g.font = '12px ui-monospace, Consolas, monospace';
    g.textAlign = 'left';
    g.fillStyle = 'rgba(159,179,200,0.75)';
    const legend = s === 'aim' ? '鼠标 = 引力井目标　·　环 = 井的真实位置（有惯性，会滞后）　·　按住左键才通电'
      : s === 'attract' ? '左键吸引：场线向内汇聚，货舱被拉向井'
        : s === 'repel' ? '右键排斥：场线向外扩散，货舱被推离井'
          : s === 'coast' ? '松手后只受恒星引力：货舱沿椭圆轨道滑行，Δv 不再增长'
            : '把货舱送进绿色对接环，相对速度达标即为软对接';
    g.fillText(legend, 16, this.h - 16);
  }

  private grid(): void {
    const g = this.g as CanvasRenderingContext2D;
    g.strokeStyle = 'rgba(90,130,190,0.10)';
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x < this.w; x += 48) { g.moveTo(x, 0); g.lineTo(x, this.h); }
    for (let y = 0; y < this.h; y += 48) { g.moveTo(0, y); g.lineTo(this.w, y); }
    g.stroke();
  }

  private star(x: number, y: number, scale: number): void {
    const g = this.g as CanvasRenderingContext2D;
    const r = scale * 0.1;
    const gr = g.createRadialGradient(x, y, 0, x, y, r * 5);
    gr.addColorStop(0, 'rgba(255,226,168,0.95)');
    gr.addColorStop(0.22, 'rgba(255,183,92,0.55)');
    gr.addColorStop(1, 'rgba(255,140,60,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, r * 5, 0, TAU); g.fill();
    g.fillStyle = '#fff3d6';
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    // 轨道参考圆
    g.strokeStyle = 'rgba(120,170,255,0.22)';
    g.lineWidth = 1;
    g.beginPath(); g.arc(x, y, scale * 1.0, 0, TAU); g.stroke();
  }

  private station(x: number, y: number, scale: number): void {
    const g = this.g as CanvasRenderingContext2D;
    const r = Math.max(10, scale * 0.075);
    g.save();
    g.strokeStyle = 'rgba(126,247,208,0.9)';
    g.lineWidth = 2;
    g.setLineDash([6, 5]);
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = 'rgba(126,247,208,0.5)';
    g.beginPath(); g.arc(x, y, r * 1.8, 0, TAU); g.stroke();
    g.fillStyle = 'rgba(126,247,208,0.16)';
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    g.restore();
  }

  private field(x: number, y: number, scale: number, repel: boolean): void {
    const g = this.g as CanvasRenderingContext2D;
    const col = repel ? '#7ef9ff' : '#ffd489';
    const R = scale * 0.62;
    g.save();
    g.strokeStyle = col;
    g.globalAlpha = 0.5;
    g.lineWidth = 1.5;
    if (repel) g.setLineDash([5, 6]);
    g.beginPath(); g.arc(x, y, R, 0, TAU); g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 0.28;
    g.beginPath(); g.arc(x, y, R * 0.62, 0, TAU); g.stroke();

    // 方向箭头：吸引向内、排斥向外（与调色板无关的形状语义）
    g.globalAlpha = 0.95;
    g.fillStyle = col;
    const N = 8;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + (repel ? 0.3 : 0) + this.t * (repel ? -0.35 : 0.35);
      const r0 = R * (repel ? 0.72 : 0.98);
      const r1 = R * (repel ? 1.0 : 0.72);
      const ax = x + Math.cos(a) * r0, ay = y + Math.sin(a) * r0;
      const bx = x + Math.cos(a) * r1, by = y + Math.sin(a) * r1;
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.lineWidth = 1.4;
      g.strokeStyle = col;
      g.stroke();
      // 箭头头部
      const ang = Math.atan2(by - ay, bx - ax);
      const hx = bx, hy = by, hs = 5.5;
      g.beginPath();
      g.moveTo(hx, hy);
      g.lineTo(hx - Math.cos(ang - 0.5) * hs, hy - Math.sin(ang - 0.5) * hs);
      g.lineTo(hx - Math.cos(ang + 0.5) * hs, hy - Math.sin(ang + 0.5) * hs);
      g.closePath();
      g.fill();
    }
    // 井心 + 徽标
    g.globalAlpha = 1;
    g.fillStyle = col;
    g.beginPath(); g.arc(x, y, 3.5, 0, TAU); g.fill();
    const label = repel ? '排斥' : '吸附';
    g.font = '600 13px ui-monospace, Consolas, monospace';
    g.textAlign = 'center';
    const tw = g.measureText(label).width;
    g.fillStyle = 'rgba(6,10,20,0.72)';
    g.fillRect(x - tw / 2 - 7, y - 34, tw + 14, 20);
    g.strokeStyle = col;
    g.lineWidth = 1;
    g.strokeRect(x - tw / 2 - 7, y - 34, tw + 14, 20);
    g.fillStyle = col;
    g.fillText(label, x, y - 20);
    g.restore();
  }

  /** 未通电的井：激光指示线（鼠标目标）+ 井的真实位置环 + 滞后可视化 */
  private wellIdle(x: number, y: number, cx: number, cy: number, scale: number): void {
    const g = this.g as CanvasRenderingContext2D;
    g.save();
    // 鼠标 → 井 的连线：长度就是滞后量
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke();
    g.setLineDash([]);
    // 井环（中性色，暗示"待机"）
    const R = Math.max(16, scale * 0.30);
    g.strokeStyle = 'rgba(159,179,200,0.85)';
    g.lineWidth = 1.6;
    g.beginPath(); g.arc(x, y, R, 0, TAU); g.stroke();
    g.globalAlpha = 0.35;
    g.strokeStyle = 'rgba(126,249,255,0.9)';
    g.beginPath(); g.arc(x, y, R * 1.5, 0, TAU); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(159,179,200,0.95)';
    g.beginPath(); g.arc(x, y, 3.2, 0, TAU); g.fill();
    // 标签
    const label = '引力井（待机）';
    g.font = '600 12px ui-monospace, Consolas, monospace';
    g.textAlign = 'center';
    const tw = g.measureText(label).width;
    g.fillStyle = 'rgba(6,10,20,0.72)';
    g.fillRect(x - tw / 2 - 7, y - R - 26, tw + 14, 19);
    g.strokeStyle = 'rgba(159,179,200,0.6)';
    g.lineWidth = 1;
    g.strokeRect(x - tw / 2 - 7, y - R - 26, tw + 14, 19);
    g.fillStyle = '#cfdcea';
    g.fillText(label, x, y - R - 12);
    g.restore();
  }

  private cursor(x: number, y: number): void {
    const g = this.g as CanvasRenderingContext2D;
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1;
    g.setLineDash([3, 4]);
    g.beginPath(); g.arc(x, y, 9, 0, TAU); g.stroke();
    g.setLineDash([]);
    g.beginPath();
    g.moveTo(x - 4, y); g.lineTo(x + 4, y);
    g.moveTo(x, y - 4); g.lineTo(x, y + 4);
    g.stroke();
    g.restore();
  }

  private trail(X: (v: number) => number, Y: (v: number) => number): void {
    const g = this.g as CanvasRenderingContext2D;
    const tr = this.pod.trail;
    if (tr.length < 6) return;
    g.save();
    g.lineWidth = 1.6;
    g.strokeStyle = 'rgba(255,120,210,0.55)';
    g.beginPath();
    g.moveTo(X(tr[0]), Y(tr[1]));
    for (let i = 2; i < tr.length; i += 2) g.lineTo(X(tr[i]), Y(tr[i + 1]));
    g.stroke();
    g.restore();
  }

  private podGlyph(x: number, y: number, scale: number, dockP: number): void {
    const g = this.g as CanvasRenderingContext2D;
    const s = clamp(scale * 0.028, 4, 9);
    g.save();
    g.translate(x, y);
    g.fillStyle = dockP > 0.999 ? '#7ef7d0' : '#ffd489';
    g.beginPath();
    g.rect(-s, -s, s * 2, s * 2);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 1;
    g.stroke();
    // 速度矢量
    const vx = this.pod.vx, vy = this.pod.vy;
    const m = Math.hypot(vx, vy) || 1;
    const L = clamp(m * scale * 0.5, 14, 60);
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo((vx / m) * L, (vy / m) * L);
    g.stroke();
    g.restore();
  }
}
