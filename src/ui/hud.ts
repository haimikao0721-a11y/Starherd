/**
 * src/ui/hud.ts — 传感器风格 Canvas 2D HUD（冻结 API）
 *
 * 集成约定（与主 Agent 约定，勿改）：
 *  1. HUD 与渲染器**共用同一块 canvas**（`#game`）。渲染器先把世界（含后处理）画完，
 *     HUD 用 `ctx.save()/restore()` 叠画在上层 —— 因此 `draw()` **不清屏、不填背景**。
 *  2. `draw()` 开头自行 `setTransform(dpr,0,0,dpr,0,0)`（渲染器会改 transform），
 *     并显式设置 `globalCompositeOperation='source-over'`；结束时 restore 还原一切状态。
 *  3. 所有世界坐标 → 屏幕坐标一律走 `worldToScreen(view, x, y)`（src/engine/view.ts），
 *     不自己算缩放；布局用 `view.w / view.h`（CSS px）。
 *  4. 物理公式全部从 `src/sim/constants.ts` 导入（圆轨道速度 / 逃逸速度 / 开普勒周期 /
 *     活力公式 / 洛希极限 / 山丘球 / 拉格朗日点 / 引力时间膨胀），HUD 不另写一套。
 *  5. 绘制预算 ≤ 400 次/帧；每次真实绘制原语都计入 `stats.drawCalls`（供 autotest 显示）。
 *     禁用 shadowBlur：发光一律用多层半透明 fillText / 描边叠加。
 *  6. 每帧调用顺序：`update(dtReal)` → `draw(f)`。
 */
import type { Body, FxEvent, Palette, ViewState, World } from '../sim/types';
import { podClass, type PodClass } from '../sim/types';
import { worldToScreen } from '../engine/view';
import {
  STRESS_WARN, WELL_MASS_MAX, WELL_MASS_MIN,
  circularVelocity, escapeVelocity, hillSphere, keplerPeriod, lagrangePoints,
  rocheLimit, sphereDensity, timeDilation, visViva, WELL_RANGE } from '../sim/constants';
import { cr3bp, jacobi, toRotating, zvcMask } from '../sim/zvc';
import { stateToElements } from '../sim/physics';
import {
  clamp, clamp01, fmtDv, fmtFixed, fmtPct, fmtSci, fmtDrift, fmtSig, fmtTime,
} from './format';

/* ------------------------------------------------------------------ 冻结类型 */

export interface HudToast { text: string; t: number; kind?: 'info' | 'warn' | 'good' }

export interface HudFrame {
  world: World; view: ViewState; palette: Palette;
  /** 分步引导条是否正在显示（决定顶部目标条的位置，避免重叠） */
  guideOn?: boolean;
  /** 引力井已脱离作业区（飞船飞出地图）：给出明确提示与重试入口 */
  wellLost?: boolean;
  fps: number; frameMs: number; steps: number;
  toasts: HudToast[]; showHelp: boolean;
  missionTime: number; status: 'running' | 'won' | 'lost';
  autotest?: boolean;
  /** 鼠标位置（CSS 像素，与 canvas 同坐标系）。给了就启用货舱清单的悬停提示。 */
  pointer?: { x: number; y: number };
}

/* ------------------------------------------------------------------ 常量 */

/** 等宽字体栈（与 web/styles.css 保持一致） */
const FONT = 'ui-monospace, "Cascadia Mono", Consolas, monospace';
/** 单条 toast 生命周期（秒，实时） */
const TOAST_LIFE = 4.5;
/** 屏幕右下角最多同时显示的 toast 条数 */
const TOAST_MAX = 6;
/** 守恒量曲线滚动窗口点数 */
const CURVE_N = 240;
/** 曲线采样间隔（秒，实时）→ 窗口 ≈ 24 s */
const SAMPLE_DT = 0.1;
/** 布局边距 */
const M = 14;
/** 左列面板宽度 */
const LEFT_W = 322;
/** 右列面板宽度 */
const RIGHT_W = 344;
/** 底部资源面板高度 */
const BOTTOM_H = 158;
/** 黑洞史瓦西半径缺省值（INTERFACES §3 契约：第 4 章 rs 默认 0.03） */
const RS_DEFAULT = 0.03;
/** 货舱级别标签尺寸（固定列宽 = 3 汉字 + 内边距，保证清单每行对齐） */
const CHIP_W = 47;
const CHIP_H = 15;
/** 清单行里"级别标签"之后文字的起始 x（相对面板左边界）：12 + 标签列 + 8 */
const ROW_TEXT_DX = 67 + 15;

/* ------------------------------------------------------------------ 颜色工具 */

/** '#rrggbb' / '#rgb' → [r,g,b]；解析失败返回 null */
function hexRgb(hex: string): [number, number, number] | null {
  if (typeof hex !== 'string' || hex.length < 4 || hex[0] !== '#') return null;
  let s = hex.slice(1);
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (s.length !== 6) return null;
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 调色板颜色 + alpha → 'rgba(...)'（非 hex 输入退化为原色 / 白色） */
function rgba(color: string, a: number): string {
  const alpha = clamp01(a);
  const c = hexRgb(color);
  if (!c) return `rgba(159,179,200,${alpha})`;
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

/** 圆角矩形路径（不用 ctx.roundRect，兼容老 WebView2） */
function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  g.moveTo(x + rad, y);
  g.lineTo(x + w - rad, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rad);
  g.lineTo(x + w, y + h - rad);
  g.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  g.lineTo(x + rad, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rad);
  g.lineTo(x, y + rad);
  g.quadraticCurveTo(x, y, x + rad, y);
  g.closePath();
}

/** toast 类型 → 颜色 */
function toastColor(kind: HudToast['kind'], pal: Palette): string {
  if (kind === 'warn') return pal.danger;
  if (kind === 'good') return pal.station;
  return pal.uiAccent;
}

/** FxEvent.kind → toast 类型 */
function fxToastKind(kind: FxEvent['kind']): HudToast['kind'] {
  switch (kind) {
    case 'lost': case 'tear': case 'warn': case 'fail': case 'impact': return 'warn';
    case 'dock': case 'win': case 'pulse': case 'ignite': return 'good';
    default: return 'info';
  }
}

/** 主货舱状态文案（清单里的状态图标文字） */
interface PodStatus { zh: string; en: string; color: string }

/* ------------------------------------------------------------------ HUD */

export class Hud {
  /** 实际绘制的画布（与渲染器共用 #game） */
  readonly canvas: HTMLCanvasElement;
  /** 性能计数：drawCalls = 本帧绘制原语数量（验收要求 ≤ 400） */
  readonly stats = { drawCalls: 0, frames: 0, podRows: 0, curvePoints: 0 };

  private g: CanvasRenderingContext2D;
  private w = 1280;
  private h = 720;
  private dpr = 1;
  private clock = 0;

  /** 内部 toast 队列（来自 pushToast / world.fx），t = 已经过时间（秒） */
  private toasts: HudToast[] = [];
  private seenFx = new WeakSet<object>();
  /** 外部传进来的 toast：按"首次出现时刻"计龄，避免对手方 t 语义不一致 */
  private extSeen = new WeakMap<object, number>();

  /** 守恒量历史（相对漂移），滚动窗口 240 点 */
  private eHist: number[] = [];
  private lHist: number[] = [];
  private sampleAcc = 0;
  private pendE = 0;
  private pendL = 0;
  private hasPend = false;

  /** 全屏"离线"斜纹图案（懒创建 + 缓存） */
  private stripes: CanvasPattern | null = null;

  /** 提示条文本缓存（避免每帧逐字符测量） */
  private hintCache = { key: '', size: 11, text: '' };

  /** 世界相关的查找缓存（每帧至多一次线性扫描） */
  private cacheWorld: World | null = null;
  private cacheDock: Body | undefined;
  private cacheStar: Body | undefined;

  /** 当前帧状态 */
  private calls = 0;
  private baseAlpha = 1;
  private curAlpha = 1;
  private fontKey = '';

  constructor(canvas: HTMLCanvasElement) {
    if (!canvas) throw new Error('[Hud] 构造需要一块 canvas 元素');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[Hud] 无法获取 2D 上下文（canvas.getContext("2d") 返回 null）');
    this.canvas = canvas;
    this.g = ctx as CanvasRenderingContext2D;
  }

  /* ---------------------------------------------------------- 生命周期 */

  /** 画布尺寸/DPR（CSS px）。宽高未变化时不重设，避免清空已画内容。
   *  画布的 CSS 尺寸由 web/styles.css 控制（#game: 100vw/100vh），这里只管后备存储。 */
  resize(w: number, h: number, dpr: number): void {
    const cw = Math.max(1, Math.round(w));
    const ch = Math.max(1, Math.round(h));
    const d = clamp(dpr || 1, 0.5, 4);
    this.w = cw; this.h = ch; this.dpr = d;
    const pw = Math.max(1, Math.round(cw * d));
    const ph = Math.max(1, Math.round(ch * d));
    if (this.canvas.width !== pw) this.canvas.width = pw;
    if (this.canvas.height !== ph) this.canvas.height = ph;
  }

  /** 推入一条 toast（t 从 0 开始计龄） */
  pushToast(text: string, kind: 'info' | 'warn' | 'good' = 'info'): void {
    const s = String(text ?? '').slice(0, 96);
    if (!s) return;
    // 同文本在 0.5 s 内重复触发时合并，避免物理事件连发刷屏
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      if (t.text === s && t.t < 0.5) { t.t = 0; return; }
    }
    this.toasts.push({ text: s, t: 0, kind });
    if (this.toasts.length > 24) this.toasts.splice(0, this.toasts.length - 24);
  }

  /** 推进 toast 生命周期与守恒量曲线采样 */
  update(dtReal: number): void {
    const dt = Number.isFinite(dtReal) && dtReal > 0 ? Math.min(dtReal, 0.25) : 0;
    this.clock += dt;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.t += dt;
      if (t.t > TOAST_LIFE) this.toasts.splice(i, 1);
    }
    this.sampleAcc += dt;
    if (this.hasPend && this.sampleAcc >= SAMPLE_DT) {
      this.sampleAcc = 0;
      this.pushSample(this.pendE, this.pendL);
    }
  }

  /* ---------------------------------------------------------- 内部工具 */

  private pushSample(e: number, l: number): void {
    if (!Number.isFinite(e) || !Number.isFinite(l)) return;
    this.eHist.push(e);
    this.lHist.push(l);
    if (this.eHist.length > CURVE_N) this.eHist.shift();
    if (this.lHist.length > CURVE_N) this.lHist.shift();
  }

  private setAlpha(a: number): void {
    const v = this.baseAlpha * clamp01(a);
    if (Math.abs(v - this.curAlpha) > 0.002) {
      this.g.globalAlpha = v;
      this.curAlpha = v;
    }
  }

  private setFont(size: number, weight: '400' | '600' = '400'): void {
    const key = weight + size;
    if (key === this.fontKey) return;
    this.fontKey = key;
    this.g.font = `${weight} ${size}px ${FONT}`;
  }

  /** 一次 fillText = 1 次绘制调用 */
  private txt(
    s: string, x: number, y: number, color: string,
    size = 11, align: CanvasTextAlign = 'left', weight: '400' | '600' = '400', alpha = 1,
  ): void {
    const g = this.g;
    this.setFont(size, weight);
    g.textAlign = align;
    g.textBaseline = 'alphabetic';
    g.fillStyle = color;
    this.setAlpha(alpha);
    g.fillText(s, x, y);
    this.setAlpha(1);
    this.calls++;
  }

  /** 多层半透明叠出的"发光"文字（替代 shadowBlur） */
  private glowTxt(
    s: string, x: number, y: number, color: string, size: number,
    align: CanvasTextAlign, weight: '400' | '600', layers = 3,
  ): void {
    const g = this.g;
    for (let i = layers; i >= 1; i--) {
      this.setFont(size + i * 1.6, weight);
      g.textAlign = align;
      g.textBaseline = 'alphabetic';
      g.fillStyle = rgba(color, 0.09 * (layers - i + 1));
      this.setAlpha(1);
      g.fillText(s, x, y);
      this.calls++;
    }
    this.txt(s, x, y, color, size, align, weight);
  }

  /** 玻璃面板：填充 + 细描边 + 顶部强调线 = 3 次调用 */
  private panel(x: number, y: number, w: number, h: number, pal: Palette, accent?: string, fill = 0.5): void {
    const g = this.g;
    const ac = accent ?? pal.uiAccent;
    g.beginPath();
    rr(g, x, y, w, h, 6);
    g.fillStyle = `rgba(5,7,15,${clamp01(fill)})`;
    this.setAlpha(1);
    g.fill();
    this.calls++;
    g.strokeStyle = rgba(ac, 0.34);
    g.lineWidth = 1;
    g.stroke();
    this.calls++;
    g.beginPath();
    g.moveTo(x + 8, y + 0.5);
    g.lineTo(x + w - 8, y + 0.5);
    g.strokeStyle = rgba(ac, 0.55);
    g.stroke();
    this.calls++;
  }

  /** 资源条：底槽 + 值 + 外框 = 3 次调用 */
  private bar(x: number, y: number, w: number, h: number, frac: number, color: string, alpha = 1): void {
    const g = this.g;
    g.fillStyle = 'rgba(255,255,255,0.07)';
    this.setAlpha(alpha);
    g.fillRect(x, y, w, h);
    this.calls++;
    const fw = clamp01(frac) * w;
    if (fw > 0.4) {
      g.fillStyle = color;
      g.fillRect(x, y, fw, h);
      this.calls++;
    }
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    this.calls++;
    this.setAlpha(1);
  }

  /**
   * 货舱级别标签（≤4 汉字）：圆角底 + 描边 + 居中文字 = 3 次调用。
   * 固定列宽（CHIP_W），让清单里每行的状态文字都从同一列开始。
   */
  private classChip(x: number, y: number, cls: PodClass, alpha = 1): void {
    const g = this.g;
    g.beginPath();
    rr(g, x, y, CHIP_W, CHIP_H, 3);
    g.fillStyle = rgba(cls.color, 0.16 * clamp01(alpha));
    this.setAlpha(1);
    g.fill();
    this.calls++;
    g.strokeStyle = rgba(cls.color, 0.8 * clamp01(alpha));
    g.lineWidth = 1;
    g.stroke();
    this.calls++;
    this.txt(cls.nameZh, x + CHIP_W / 2, y + 11, cls.color, 10, 'center', '600', alpha);
  }

  /** 按像素宽度粗折行（CJK 记 1em，ASCII 记 0.6em）：提示卡够用，不做精确排版 */
  private wrapText(s: string, size: number, maxW: number): string[] {
    const out: string[] = [];
    let line = '';
    let wpx = 0;
    for (const ch of s) {
      const cw = ch.charCodeAt(0) > 0x2e80 ? size : size * 0.6;
      if (line.length > 0 && wpx + cw > maxW) { out.push(line); line = ''; wpx = 0; }
      line += ch;
      wpx += cw;
    }
    if (line.length > 0) out.push(line);
    return out;
  }

  /** 小圆点状态灯：填充 + 外环 = 2 次调用 */
  private dot(cx: number, cy: number, r: number, color: string, alpha = 1): void {
    const g = this.g;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = color;
    this.setAlpha(alpha);
    g.fill();
    this.calls++;
    g.strokeStyle = rgba(color, 0.5);
    g.lineWidth = 1;
    g.stroke();
    this.calls++;
    this.setAlpha(1);
  }

  /* ---------------------------------------------------------- 世界查询 */

  /**
   * 该位置此刻实际环绕的中心天体 = 对它引力最强的那个主天体（真实判据，不是命名约定）。
   * 卫星系统关卡里货舱/空间站绕的是**行星**：HUD 若一律按恒星算轨道要素，
   * 会得到无意义的负近星点（实测 L2-3 报出「近星点 -2.45 RU」）——这是用户可见的错误回显。
   */
  /**
   * 系统类型回显（objective：HUD 需标出关卡属于哪种多体系统）。
   * 全部由关卡天体构成判定，不是人工标注——数据变了标签自动跟着变。
   */
  /**
   * 本关的卫星列表。判据用**真实束缚条件**：货舱/卫星被行星束缚 = 它到行星的距离
   * 小于该行星绕恒星的 Hill 球半径，且行星比它重。
   * 不用"离谁更近"这种朴素判据——行星会因为离自己的卫星很近而被误判成卫星
   * （实测 L2-3 把承载行星 planetHost 也算进去，报出"3 卫星"）。
   */
  private satellites(w: World): Body[] {
    const star = this.starBody(w);
    if (!star) return [];
    const planets = w.primaries.filter((b) => b.alive && b.kind === 'planet');
    const out: Body[] = [];
    for (const b of planets) {
      const dStar = Math.hypot(b.x - star.x, b.y - star.y);
      for (const p of planets) {
        if (p === b || p.mass <= b.mass) continue;
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        const aP = Math.hypot(p.x - star.x, p.y - star.y);
        if (aP <= 0) continue;
        const rH = hillSphere(aP, p.mass, star.mass);
        if (d < rH && d < dStar) { out.push(b); break; }
      }
    }
    return out;
  }

  private systemType(w: World): string {
    const stars = w.primaries.filter((b) => b.alive && b.kind === 'star');
    const holes = w.primaries.filter((b) => b.alive && b.kind === 'blackhole');
    const sats = this.satellites(w);
    if (holes.length > 0) return stars.length > 0 ? '黑洞+恒星双星' : '黑洞系统';
    if (stars.length >= 3) return `层级${stars.length}星`;
    if (stars.length === 2) {
      const main = stars.reduce((a, b) => (a.mass >= b.mass ? a : b));
      const sec = stars.find((b) => b !== main);
      const dock = w.primaries.find((b) => b.id === w.dock.bodyId);
      if (sec && dock) {
        const aSec = Math.hypot(sec.x - main.x, sec.y - main.y);
        const aDock = Math.hypot(dock.x - main.x, dock.y - main.y);
        // 站与伴星到主星的距离几乎相同 → 站停在 L4/L5 等边三角形顶点上
        if (aSec > 0 && Math.abs(aDock - aSec) < 0.05 * aSec) return '双星 · L4/L5 稳定岛';
      }
      return '双星';
    }
    if (sats.length >= 2) return `行星系 · ${sats.length} 卫星`;
    if (sats.length === 1) return '行星系 · 1 卫星';
    return '单恒星';
  }

  /** 共享实现见 render/draw.ts 的 dominantPrimary（含"排除自身"参数）。 */
  private dominantPrimary(w: World, x: number, y: number, exclude?: Body | null): Body | null {
    let best: Body | null = null;
    let bestA = -1;
    for (const p of w.primaries) {
      if (!p.alive || (exclude != null && p === exclude)) continue;
      const dx = x - p.x;
      const dy = y - p.y;
      const a = p.mu / Math.max(1e-4, dx * dx + dy * dy);
      if (a > bestA) { bestA = a; best = p; }
    }
    return best;
  }

  private dockBody(w: World): Body | undefined {
    if (this.cacheWorld === w) return this.cacheDock;
    this.cacheWorld = w;
    this.cacheDock = undefined;
    this.cacheStar = undefined;
    for (let i = 0; i < w.bodies.length; i++) {
      const b = w.bodies[i];
      if (b.id === w.dock.bodyId) { this.cacheDock = b; break; }
    }
    for (let i = 0; i < w.primaries.length; i++) {
      const b = w.primaries[i];
      if (b.kind === 'star' || b.kind === 'blackhole') { this.cacheStar = b; break; }
    }
    if (!this.cacheStar) this.cacheStar = w.primaries[0];
    return this.cacheDock;
  }

  private starBody(w: World): Body | undefined {
    if (this.cacheWorld !== w) this.dockBody(w);
    return this.cacheStar;
  }

  /** 主货舱：优先"仍在途"的第一个，其次第一个存活，最后任意 */
  private primaryPod(w: World): Body | undefined {
    const pods = w.pods;
    if (!pods || pods.length === 0) return undefined;
    for (let i = 0; i < pods.length; i++) {
      const p = pods[i];
      if (p.alive && !p.delivered && !p.docked) return p;
    }
    for (let i = 0; i < pods.length; i++) if (pods[i].alive) return pods[i];
    return pods[0];
  }

  private podStatus(p: Body, pal: Palette): PodStatus {
    if (!p.alive || p.lost) return { zh: '损毁', en: 'LOST', color: pal.danger };
    if (p.delivered) return { zh: '已对接', en: 'DOCKED', color: pal.station };
    if (p.docked) return { zh: '对接中', en: 'CAPTURE', color: pal.station2 };
    if (p.stress > STRESS_WARN) return { zh: '受力', en: 'STRESS', color: pal.danger2 };
    if (p.integrity >= 1 && p.stress <= 0.001 && Math.hypot(p.vx, p.vy) > 0) {
      return { zh: '待运', en: 'STANDBY', color: pal.ui };
    }
    return { zh: '在途', en: 'TRANSIT', color: pal.uiAccent };
  }

  /* ---------------------------------------------------------- 主绘制 */

  draw(f: HudFrame): void {
    const g = this.g;
    this.calls = 0;
    const pal = f.palette;
    const view = f.view;

    // view 是权威尺寸
    if (Number.isFinite(view.w) && view.w > 1) this.w = view.w;
    if (Number.isFinite(view.h) && view.h > 1) this.h = view.h;
    const dpr = Number.isFinite(view.dpr) && view.dpr > 0 ? view.dpr : this.dpr;

    const uiAlpha = clamp01(Number.isFinite(view.uiAlpha) ? view.uiAlpha : 1);
    if (uiAlpha <= 0.01) { this.stats.drawCalls = 0; this.stats.frames++; return; }

    // ---- 记录守恒量采样点（由 update() 按 0.1 s 节流写入历史） ----
    const st = f.world.stats;
    const e0 = Number.isFinite(st.energy0) && Math.abs(st.energy0) > 1e-12 ? st.energy0 : 0;
    const l0 = Number.isFinite(st.angular0) && Math.abs(st.angular0) > 1e-12 ? st.angular0 : 0;
    this.pendE = e0 !== 0 ? (st.energy - e0) / Math.abs(e0) : st.energy - st.energy0;
    this.pendL = l0 !== 0 ? (st.angularMomentum - l0) / Math.abs(l0) : st.angularMomentum - st.angular0;
    this.hasPend = true;

    g.save();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
    this.baseAlpha = uiAlpha;
    this.curAlpha = -1;
    this.fontKey = '';
    this.setAlpha(1);

    const w = this.w;
    const h = this.h;

    // 1) 算力耗尽 → 全屏极淡蓝色斜纹（画在最底层，面板压在它上面）
    if (f.world.compute <= 1e-4 || !f.world.fieldEnabled) this.drawOffline(w, h, pal);

    // 2) 左上：关卡信息
    this.drawLevelCard(f, pal, 0, 0);

    // 3) 左侧中部：货舱清单
    this.drawPods(f, pal, 0, 0);

    // 4) 右上：守恒量审计 + 轨道要素
    this.drawConservation(f, pal, 0, 0);

    // 5) 左下：资源条；右下：场投影器
    this.drawResources(f, pal, 0, 0);
    this.drawFieldCard(f, pal, 0, 0);

    this.drawSling(f, pal);
    this.drawZVC(f, pal);
    this.drawOberth(f, pal);
    this.drawHierarchy(f, pal);
    this.drawLegs(f, pal);
    // 6) 屏幕世界的危险叠加（潮汐应力环 / 货舱标记 / 实体名牌 / 目标指示）
    this.drawPodMarkers(f, pal);
    this.drawObjective(f, pal);
    this.drawEntityLabels(f, pal);

    // 7) 顶部危险横幅（星风爆发）
    if (f.world.windActive > 0.02) this.drawHazard(f, pal);

    // 8) 底部中央操作提示 / 完整帮助卡
    if (f.showHelp) this.drawHelpCard(f, pal);
    else this.drawHintBar(f, pal);

    // 9) 右下 toast
    this.drawToasts(f, pal);

    // 10) 结算横幅
    if (f.status !== 'running') this.drawResult(f, pal);

    g.restore();
    this.curAlpha = this.baseAlpha;

    this.stats.drawCalls = this.calls;
    this.stats.frames++;
    this.stats.curvePoints = this.eHist.length;
  }

  /* ---------------------------------------------------------- 左上：关卡信息 */

  private drawLevelCard(f: HudFrame, pal: Palette, _ox: number, _oy: number): void {
    const lv = f.world.level;
    const x = M;
    const y = M;
    const w = LEFT_W;
    const h = 96;
    this.panel(x, y, w, h, pal);
    this.txt(`${lv.nameZh}`, x + 12, y + 26, pal.ui, 15, 'left', '600');
    this.txt(`${lv.nameEn}`, x + 12, y + 41, pal.uiDim, 10);
    this.txt(`CH.${lv.chapter}  难度 ${lv.difficulty}/12  ·  ${this.systemType(f.world)}`, x + 12, y + 60, pal.uiAccent, 11);
    // 难度刻度（12 段 → 一次 fillRect 序列 + 一次描边）
    const dx = x + 138;
    const dw = 172;
    const seg = dw / 12;
    const g = this.g;
    g.fillStyle = rgba(pal.uiAccent, 0.85);
    for (let i = 0; i < lv.difficulty && i < 12; i++) {
      g.fillRect(dx + i * seg, y + 52, seg - 1.5, 9);
      this.calls++;
    }
    g.strokeStyle = rgba(pal.uiDim, 0.5);
    g.lineWidth = 1;
    g.beginPath();
    g.rect(dx + 0.5, y + 52.5, dw - 1, 8);
    g.stroke();
    this.calls++;

    // FPS / 帧耗时 / 物理步
    const fps = Number.isFinite(f.fps) ? f.fps : 0;
    const fcol = fps >= 55 ? pal.station : fps >= 40 ? pal.pod : pal.danger;
    const steps = Math.round(Number.isFinite(f.steps) ? f.steps : 0);
    this.txt(`FPS ${fmtFixed(fps, 1)}`, x + 12, y + 80, fcol, 11, 'left', '600');
    this.txt(`帧 ${fmtFixed(f.frameMs, 2)}ms`, x + 96, y + 80, pal.ui, 11);
    this.txt(`步 ${steps}`, x + 186, y + 80, pal.uiDim, 11);

    // 状态胶囊
    const statusZh = f.status === 'won' ? '任务完成' : f.status === 'lost' ? '任务失败' : '进行中';
    const scol = f.status === 'won' ? pal.station : f.status === 'lost' ? pal.danger : pal.uiAccent;
    const cw = 62;
    const cx = x + w - cw - 12;
    g.beginPath();
    rr(g, cx, y + 68, cw, 16, 4);
    g.fillStyle = rgba(scol, 0.14);
    g.fill();
    this.calls++;
    g.strokeStyle = rgba(scol, 0.6);
    g.stroke();
    this.calls++;
    this.txt(statusZh, cx + cw / 2, y + 80, scol, 10, 'center', '600');

    if (f.autotest) {
      this.txt(`AUTOTEST  DC ${this.calls}`, x + 12, y + 96 - 2, pal.pod, 9);
    }
  }

  /* ---------------------------------------------------------- 左侧：货舱清单 */

  private drawPods(f: HudFrame, pal: Palette, _ox: number, _oy: number): void {
    const pods = f.world.pods ?? [];
    const y0 = M + 96 + 10;
    const bottomLimit = this.h - M - BOTTOM_H - 10;
    const avail = bottomLimit - y0;
    const maxRows = clamp(Math.floor((avail - 26) / 38), 1, 8);
    const rows = Math.min(pods.length, maxRows);
    const x = M;
    const w = LEFT_W;
    const ph = 26 + rows * 38 + (pods.length > rows ? 14 : 0);
    if (ph < 40) return;
    this.panel(x, y0, w, ph, pal, pal.ui);

    const lv = f.world.level;
    this.txt('货舱清单 / CARGO MANIFEST', x + 12, y0 + 17, pal.uiDim, 10);
    this.txt(`${lv.podsDelivered}/${lv.podsTotal}`, x + w - 12, y0 + 17, pal.station, 10, 'right', '600');
    this.stats.podRows = rows;

    const dockB = this.dockBody(f.world);
    const dvx = dockB ? dockB.vx : 0;
    const dvy = dockB ? dockB.vy : 0;
    const vMax = f.world.dock.vMax;

    for (let i = 0; i < rows; i++) {
      const p = pods[i];
      const ry = y0 + 26 + i * 38;
      const stt = this.podStatus(p, pal);
      const alive = p.alive;

      // 屏幕投影后的"接近"信息用世界坐标算，与渲染无关
      const dx = f.world.dock.x - p.x;
      const dy = f.world.dock.y - p.y;
      const dist = Math.hypot(dx, dy);
      const rvx = p.vx - dvx;
      const rvy = p.vy - dvy;
      const vrel = Math.hypot(rvx, rvy);
      const gap = Math.max(0, dist - f.world.dock.radius);
      const closing = dist > 1e-6 ? -(dx * rvx + dy * rvy) / dist : 0;
      const eta = closing > 0.004 && gap > 0 ? gap / closing : -1;

      this.dot(x + 17, ry + 12, 4, stt.color, alive ? 1 : 0.45);
      // 级别标签（见 POD_CLASSES）：玩家一眼看出这一舱是什么脾气
      const cls = podClass(p.class);
      this.classChip(x + 27, ry + 4, cls, alive ? 1 : 0.45);
      this.txt(`${i + 1}. ${stt.zh}`, x + ROW_TEXT_DX, ry + 16, stt.color, 11, 'left', '600');

      // |v_rel| 与门限对比
      const vcol = vrel <= vMax ? pal.station : vrel <= vMax * 2.6 ? pal.pod : pal.danger;
      this.txt(`${fmtFixed(vrel, 3)}/${fmtFixed(vMax, 3)}`, x + w - 12, ry + 16, vcol, 10, 'right', '600');

      // 第二行：距离 / 接近倒计时 / 完整度
      const info = stt.zh === '已对接'
        ? '已锁入对接环'
        : stt.zh === '损毁'
          ? '结构解体 · 任务目标减一'
          : `距环 ${fmtFixed(gap, 3)} RU${eta >= 0 ? `  接近 ${fmtFixed(eta, 1)}s` : '  远离'}`;
      this.txt(info, x + ROW_TEXT_DX, ry + 31, pal.uiDim, 10);
      if (p.stress > STRESS_WARN && alive) {
        this.txt(`应力 ${fmtFixed(p.stress, 2)}`, x + w - 12, ry + 31, pal.danger, 10, 'right', '600');
      } else {
        this.bar(x + w - 68, ry + 27, 56, 4, clamp01(p.integrity), rgba(pal.station, 0.8), 0.9);
      }
    }
    if (pods.length > rows) {
      this.txt(`… 另有 ${pods.length - rows} 个货舱未显示`, x + 12, y0 + ph - 5, pal.uiDim, 9);
    }

    // 悬停：鼠标停在哪一行，就在清单右侧显示该货舱**级别**的一句话特性说明
    const ptr = f.pointer;
    if (ptr) {
      for (let i = 0; i < rows; i++) {
        const ry = y0 + 26 + i * 38;
        if (ptr.x >= x && ptr.x <= x + w && ptr.y >= ry - 4 && ptr.y <= ry + 36) {
          this.podClassTip(pal, pods[i], x + w + 12, clamp(ry - 8, M, this.h - M - 96));
          break;
        }
      }
    }
  }

  /**
   * 货舱级别提示卡（悬停）：级别名 + 实际参与的物理量读数 + 一句话特性说明。
   * 说明文字来自 POD_CLASSES[].note，与简报页共用同一份文案，避免两处不一致。
   */
  private podClassTip(pal: Palette, p: Body, x: number, y: number): void {
    const cls = podClass(p.class);
    const W = 430;
    const lines = this.wrapText(cls.note, 10, W - 24);
    const H = 62 + lines.length * 15;
    this.panel(x, y, W, H, pal, cls.color, 0.9);
    this.classChip(x + 12, y + 12, cls, 1);
    this.txt(cls.nameEn, x + 12 + CHIP_W + 8, y + 24, cls.color, 12, 'left', '600');
    this.txt(`m ${fmtSci(p.mass, 2)} · r ${fmtFixed(p.radius, 4)} · sail ${fmtFixed(p.sail ?? 1, 2)} · hull ${fmtFixed(p.integrity, 2)}`,
      x + 12, y + 44, pal.uiDim, 10);
    for (let i = 0; i < lines.length; i++) {
      this.txt(lines[i], x + 12, y + 62 + i * 15, pal.ui, 10);
    }
  }

  /* ---------------------------------------------------------- 左下：资源条 */

  private drawResources(f: HudFrame, pal: Palette, _ox: number, _oy: number): void {
    const w = f.world;
    const x = M;
    const h = BOTTOM_H;
    const y = this.h - M - h;
    this.panel(x, y, 322, h, pal, pal.station);

    const inner = 298;
    const ix = x + 12;

    this.txt('系统资源 / SHIP RESOURCES', ix, y + 17, pal.uiDim, 10);

    // ---- Δv 预算 ----
    const cap = w.fuelCapacity > 0 ? w.fuelCapacity : 1;
    const frac = clamp01(w.fuel / cap);
    const low = frac < 0.2;
    const pulse = low ? 0.6 + 0.4 * Math.sin(this.clock * 7.5) : 1;
    const dvCol = low ? pal.danger : pal.pod;
    this.txt('Δv 预算', ix, y + 39, pal.ui, 11, 'left', '600');
    this.txt(`${fmtDv(w.fuel)} / ${fmtDv(cap)}`, ix + inner, y + 39, dvCol, 11, 'right', '600');
    this.bar(ix, y + 45, inner, 8, frac, low ? rgba(pal.danger, pulse) : rgba(pal.pod, 0.95));
    if (low) {
      this.txt('!! Δv 低于 20%，优先低耗机动（霍曼转移）', ix, y + 69, rgba(pal.danger, pulse), 10, 'left', '600');
    } else {
      this.txt(`已消耗 ${fmtDv(w.level.fuelUsed)}  ·  par ${fmtDv(w.level.parFuel)}  ·  剩余 ${fmtPct(frac)}`,
        ix, y + 69, pal.uiDim, 10);
    }

    // ---- 算力 ----
    const cfrac = clamp01(w.compute / (w.computeMax > 0 ? w.computeMax : 1));
    const offline = w.compute <= 1e-4 || !w.fieldEnabled;
    this.txt('算力', ix, y + 92, pal.ui, 11, 'left', '600');
    this.txt(`${fmtFixed(w.compute, 2)} / ${fmtFixed(w.computeMax, 2)}`, ix + inner, y + 92,
      offline ? pal.danger : pal.uiAccent, 11, 'right', '600');
    this.bar(ix, y + 98, inner, 8, cfrac, offline ? rgba(pal.danger, 0.9) : rgba(pal.uiAccent, 0.9));
    this.txt(
      offline ? '!! 场投影器离线（慢动作与引力井共用算力）' : '场投影器在线  ·  慢动作消耗 0.55/s',
      ix, y + 122, offline ? pal.danger : pal.uiDim, 10, 'left', offline ? '600' : '400',
    );

    // ---- 任务时限 ----
    const limit = w.level.timeLimit > 0 ? w.level.timeLimit : 1;
    const tfrac = clamp01(w.time / limit);
    const tcol = tfrac > 0.85 ? pal.danger : tfrac > 0.6 ? pal.pod : pal.station;
    this.txt('任务时限', ix, y + 141, pal.ui, 11, 'left', '600');
    this.txt(`${fmtTime(w.time, 'floor')} / ${fmtTime(limit, 'floor')}`, ix + inner, y + 141, tcol, 11, 'right', '600');
    this.bar(ix, y + 146, inner, 6, tfrac, rgba(tcol, 0.9));
  }

  /* ---------------------------------------------------------- 右下：场投影器 */

  private drawFieldCard(f: HudFrame, pal: Palette, _ox: number, _oy: number): void {
    const w = f.world;
    const wl = w.well;
    const x = this.w - M - 268;
    const h = BOTTOM_H;
    const y = this.h - M - h;
    this.panel(x, y, 268, h, pal, pal.well);

    const ix = x + 12;
    const inner = 244;
    this.txt('场投影器 / FIELD PROJECTOR', ix, y + 17, pal.uiDim, 10);

    // 模式
    const mode = wl.engaged ? (wl.repel ? '斥力' : '吸引') : '待机';
    const mcol = wl.engaged ? (wl.repel ? pal.danger : pal.well) : pal.uiDim;
    this.txt('模式', ix, y + 39, pal.ui, 11, 'left', '600');
    this.g.beginPath();
    rr(this.g, ix + inner - 62, y + 27, 62, 16, 4);
    this.g.fillStyle = rgba(mcol, 0.16);
    this.g.fill();
    this.calls++;
    this.g.strokeStyle = rgba(mcol, 0.7);
    this.g.stroke();
    this.calls++;
    this.txt(mode, ix + inner - 31, y + 39, mcol, 11, 'center', '600');

    // 场强（三位有效数字）
    const mspan = Math.max(1e-6, WELL_MASS_MAX - WELL_MASS_MIN);
    const mfrac = clamp01((wl.mass - WELL_MASS_MIN) / mspan);
    this.txt('场强 M_w', ix, y + 62, pal.ui, 11, 'left', '600');
    this.txt(`${fmtSig(wl.mass, 3)} M*`, ix + inner, y + 62, pal.well, 11, 'right', '600');
    this.bar(ix, y + 68, inner, 7, mfrac, rgba(pal.well, 0.9));
    // 预设刻度 0.008 / 0.022 / 0.05
    const presets = [0.008, 0.022, 0.05];
    this.g.strokeStyle = rgba(pal.uiDim, 0.8);
    this.g.lineWidth = 1;
    this.g.beginPath();
    for (const pv of presets) {
      const px = ix + clamp01((pv - WELL_MASS_MIN) / mspan) * inner;
      this.g.moveTo(px, y + 66);
      this.g.lineTo(px, y + 77);
    }
    this.g.stroke();
    this.calls++;

    this.txt(`1/2/3 预设 ${presets.map((p) => fmtSig(p, 2)).join(' ')}`, ix, y + 92, pal.uiDim, 9);

    // 精确 / 慢动作 / 推力
    this.txt('精确模式', ix, y + 112, pal.ui, 10);
    this.txt(wl.precise ? '开 ζ=1.0' : '关 ζ=0.85', ix + 78, y + 112,
      wl.precise ? pal.station : pal.uiDim, 10, 'left', '600');
    const slow = w.slowmo < 0.99;
    this.txt('慢动作', ix + 132, y + 112, pal.ui, 10);
    this.txt(slow ? `×${fmtFixed(w.slowmo, 2)} 激活` : '待机', ix + 178, y + 112,
      slow ? pal.uiAccent : pal.uiDim, 10, 'left', '600');
    this.txt(`推力 F ${fmtFixed(wl.thrust, 3)}   时标 ${fmtFixed(w.timeScale, 2)}×`, ix, y + 130, pal.uiDim, 10);

    // 视图开关胶囊
    const chips: Array<[string, boolean]> = [
      ['场线 G', f.view.showField],
      ['矢量 F', f.view.showVectors],
      ['预测 Tab', f.view.showPredict],
    ];
    let cxp = ix;
    for (const [label, on] of chips) {
      const cwid = 76;
      const col = on ? pal.uiAccent : pal.uiDim;
      this.g.beginPath();
      rr(this.g, cxp, y + 138, cwid, 15, 3);
      this.g.fillStyle = rgba(col, on ? 0.18 : 0.07);
      this.g.fill();
      this.calls++;
      this.g.strokeStyle = rgba(col, on ? 0.65 : 0.3);
      this.g.stroke();
      this.calls++;
      this.txt(label, cxp + cwid / 2, y + 149, col, 9, 'center', on ? '600' : '400');
      cxp += cwid + 8;
    }
  }

  /* ---------------------------------------------------------- 右上：守恒量审计 */

  private drawConservation(f: HudFrame, pal: Palette, _ox: number, _oy: number): void {
    const w = f.world;
    const st = w.stats;
    const x = this.w - M - RIGHT_W;
    const y = M;
    const compact = this.h < 660;

    const lines: string[] = [];
    let orbitHeader = '';
    const pod = this.primaryPod(w);
    const star = this.starBody(w);
    const dockB = this.dockBody(w);
    const mu = star && star.mu > 0 ? star.mu : (star ? star.mass : 1) || 1;

    if (pod && star) {
      // **中心天体按引力主导动态选取**：卫星关卡里货舱绕行星，轨道要素/洛希极限/山丘球/L 点
      // 都必须用该中心天体的 μ 与半径算；按恒星算会得到完全错误的值（实测报出负近星点 -2.45 RU）。
      const cen = this.dominantPrimary(w, pod.x, pod.y, pod) ?? star;
      const cMu = cen.mu > 0 ? cen.mu : mu;
      const rx = pod.x - cen.x;
      const ry = pod.y - cen.y;
      const rvx = pod.vx - cen.vx;
      const rvy = pod.vy - cen.vy;
      const el = stateToElements(rx, ry, rvx, rvy, cMu);
      const r = Math.max(1e-6, el.r);
      const vNow = Math.hypot(rvx, rvy);
      const vc = circularVelocity(cMu, r);
      const vesc = escapeVelocity(cMu, r);
      const tc = keplerPeriod(cMu, r);
      const aPos = Number.isFinite(el.a) && el.a > 0 ? el.a : r;
      const T = Number.isFinite(el.period) && el.period > 0 && el.period !== Infinity
        ? el.period : keplerPeriod(cMu, aPos);
      const vv = visViva(cMu, r, aPos);
      const rhoPod = pod.radius > 0 ? sphereDensity(pod.mass, pod.radius) : 0;
      const rhoCen = sphereDensity(cen.mass, cen.radius);
      const dr = rocheLimit(cen.radius, rhoCen, rhoPod);
      const cenDock = dockB ? (this.dominantPrimary(w, dockB.x, dockB.y, dockB) ?? cen) : null;
      const aDock = dockB && cenDock ? Math.hypot(dockB.x - cenDock.x, dockB.y - cenDock.y) : 0;
      const rH = dockB && cenDock && aDock > 0 ? hillSphere(aDock, dockB.mass, cenDock.mass) : 0;
      const lp = cenDock && dockB && aDock > 0 ? lagrangePoints(cenDock.mass, dockB.mass, aDock) : null;

      orbitHeader = `主货舱 ${pod.tag || pod.key || 'POD'}  轨道要素 / ELEMENTS`;
      lines.push(`a = ${fmtSig(aPos, 4)} RU      e = ${fmtSig(clamp(el.e, 0, 0.9999), 3)}`);
      lines.push(`T = ${fmtSig(T, 4)} TU   (r 处圆轨道 ${fmtSig(tc, 4)})`);
      lines.push(`r = ${fmtSig(r, 4)}   v = ${fmtFixed(vNow, 4)} / 活力公式 ${fmtFixed(vv, 4)}`);
      lines.push(`v_c = ${fmtFixed(vc, 4)}   v_esc = ${fmtFixed(vesc, 4)}`);
      if (!compact) {
        const satLines: string[] = [];
        // 卫星回显：列出本关的卫星及其**山丘球**（"卫星走廊"里要绕开的就是这个范围）
        const sats = this.satellites(w);
        if (sats.length > 0) {
          const parts = sats.slice(0, 3).map((b) => {
            const c = this.dominantPrimary(w, b.x, b.y, b)!;
            const aRel = Math.hypot(b.x - c.x, b.y - c.y);
            return `${b.key} r_H ${fmtSig(hillSphere(aRel, b.mass, c.mass), 2)}`;
          });
          satLines.push(`卫星 ${sats.length}：${parts.join(' · ')}`);
        }
        lines.push(`中心 ${cen.key}  μ ${fmtSig(cen.mu, 3)} · 洛希极限 d_R = ${fmtSig(dr, 3)}`
          + (r < dr ? '  !! 已进入撕裂区' : '  （安全）'));
        lines.push(`山丘球 r_H = ${fmtSig(rH, 3)}` + (lp
          ? `   L1 ${fmtSig(lp.L1, 4)}  L2 ${fmtSig(lp.L2, 4)}` : ''));
        for (const s of satLines) lines.push(s);
      }
      // 黑洞视界的时间膨胀（Body 无 rs 字段时用契约默认 0.03）
      const bh = w.primaries.find((b) => b.kind === 'blackhole');
      if (bh && !compact) {
        const extra = bh as Body & { rs?: number };
        const rs = typeof extra.rs === 'number' && extra.rs > 0 ? extra.rs : RS_DEFAULT;
        const rb = Math.hypot(pod.x - bh.x, pod.y - bh.y);
        const gam = timeDilation(rb, rs);
        lines.push(`引力时间膨胀 γ = ${fmtSig(gam, 6)}  (r_s ${fmtSig(rs, 2)})`);
      }
    } else {
      orbitHeader = '轨道要素 / ELEMENTS';
      lines.push('无货舱数据');
    }

    const curveH = 52;
    const headH = 176;
    const H = Math.min(headH + 14 + lines.length * 15 + 12, this.h - M * 2 - 8);
    this.panel(x, y, RIGHT_W, H, pal, pal.uiAccent);

    this.txt('守恒量审计 / CONSERVED QUANTITIES', x + 12, y + 18, pal.uiAccent, 10, 'left', '600');
    // 保真度评级胶囊
    const grade = (w.level.fidelityGrade || '—').slice(0, 2);
    const gcol = grade.startsWith('S') ? pal.station : grade.startsWith('A') ? pal.uiAccent
      : grade.startsWith('B') ? pal.pod : pal.danger;
    this.g.beginPath();
    rr(this.g, x + RIGHT_W - 44, y + 8, 32, 15, 3);
    this.g.fillStyle = rgba(gcol, 0.16);
    this.g.fill();
    this.calls++;
    this.g.strokeStyle = rgba(gcol, 0.7);
    this.g.stroke();
    this.calls++;
    this.txt(grade, x + RIGHT_W - 28, y + 19, gcol, 10, 'center', '600');

    // 曲线 A：能量相对漂移
    this.txt(`E  ${fmtSci(st.energy, 4)}`, x + 12, y + 36, pal.ui, 10);
    this.txt(`ΔE/E ${fmtDrift(this.eHist.length ? this.eHist[this.eHist.length - 1] : 0)}`,
      x + RIGHT_W - 12, y + 36, this.driftColor(this.lastOf(this.eHist), pal), 10, 'right', '600');
    this.drawCurve(x + 12, y + 42, RIGHT_W - 24, curveH, this.eHist, pal.uiAccent, pal);

    // 曲线 B：角动量相对漂移
    const yB = y + 42 + curveH + 20;
    this.txt(`L  ${fmtSci(st.angularMomentum, 4)}`, x + 12, yB - 6, pal.ui, 10);
    this.txt(`ΔL/L ${fmtDrift(this.lastOf(this.lHist))}`, x + RIGHT_W - 12, yB - 6,
      this.driftColor(this.lastOf(this.lHist), pal), 10, 'right', '600');
    this.drawCurve(x + 12, yB, RIGHT_W - 24, curveH, this.lHist, pal.station, pal);

    // 漂移数值（物理保真度卖点）
    const dy = y + headH - 4;
    this.g.strokeStyle = rgba(pal.uiDim, 0.45);
    this.g.lineWidth = 1;
    this.g.beginPath();
    this.g.moveTo(x + 12, dy - 14.5);
    this.g.lineTo(x + RIGHT_W - 12, dy - 14.5);
    this.g.stroke();
    this.calls++;
    this.txt(`ΔE/E = ${fmtDrift(st.energyDrift, 2)}`, x + 12, dy, this.driftColor(st.energyDrift, pal), 11, 'left', '600');
    this.txt(`ΔL/L = ${fmtDrift(st.angularDrift, 2)}`, x + RIGHT_W - 12, dy,
      this.driftColor(st.angularDrift, pal), 11, 'right', '600');

    // 轨道要素
    let ly = dy + 20;
    this.txt(orbitHeader, x + 12, ly, pal.uiDim, 9);
    ly += 15;
    for (const s of lines) {
      if (ly > y + H - 6) break;
      const danger = s.indexOf('!!') >= 0;
      this.txt(s, x + 12, ly, danger ? pal.danger : pal.ui, 10);
      ly += 15;
    }
  }

  private lastOf(arr: number[]): number {
    return arr.length ? arr[arr.length - 1] : 0;
  }

  private driftColor(v: number, pal: Palette): string {
    const a = Math.abs(v);
    if (a < 1e-5) return pal.station;
    if (a < 1e-4) return pal.uiAccent;
    if (a < 1e-3) return pal.pod;
    return pal.danger;
  }

  /** 迷你滚动曲线（自动缩放 + 中轴 + 端点标记）*/
  /**
   * 引力井甩摆：捕获判定 + 相对轨道。
   *
   * 井是**软化 1/r² 场**（a = M_w/r²，带核心软化与外截止，见 physics.wellAccel），
   * 所以能用**能量判据**严格判定是否被捕获（不是启发式）：
   *   |v_rel| < v_esc = sqrt(2·M_w/r)  →  束缚轨道
   * 半长轴由活力公式 a = 1/(2/r − v²/μ) 给出，周期 Kepler 第三定律 T = 2π√(a³/μ)。
   * 玩家据此判断"什么时候松手能把它甩出去"——这正是甩摆玩法的核心信息。
   */
  /** ZVC 离屏栅格缓存（键 = μ|C） */
  private zvcCache: { key: string; cv: HTMLCanvasElement; frac: number } | null = null;

  /**
   * 零速度曲线（Z 键）：把 CR3BP 的"禁区"（2Ω < C）画成半透明色块，边界即 ZVC。
   *
   * 取**两个最重的主天体**做两体近似。本作多数关卡不止两个天体、还有引力井，
   * 因此 C 会漂移 —— 界面上如实标注"两体近似"，不宣称精确积分。
   */
  /** 飞船相对主星的径向距离历史极小/极大（Oberth 提示用） */
  private rMin = Number.POSITIVE_INFINITY;
  /** 相对**井**的径向距离历史极小（甩摆窗口判定；与相对恒星的 rMin 分开） */
  private rWellMin = Number.POSITIVE_INFINITY;
  private rWellMax = 0;
  private rMax = 0;

  /** 每关重置（换关/重开时调用）。 */
  /** 换关时由 game 层调用，清空 Oberth 的径向历史（因此是 public） */
  resetOberth(): void { this.rMin = Number.POSITIVE_INFINITY; this.rMax = 0; this.rWellMin = Number.POSITIVE_INFINITY; this.rWellMax = 0; }

  /**
   * Oberth 效应提示。
   *
   * OBER 效应：同样大小的 Δv，在速度大的地方做能换来更多动能。
   * 椭圆轨道上近星点速度最大 → 近星点机动最省燃料；远星点最亏。
   * 本作物理天然满足这一点（一次性 Δv 直接加到速度上），这里只是把它**显示出来**，
   * 让玩家能自己判断"什么时候点火"。
   */
  private drawOberth(f: HudFrame, pal: Palette): void {
    const w = f.world;
    const ship = w.pods.find((p) => p.alive && !p.delivered) ?? w.pods[0];
    const star = w.primaries.find((p) => p.kind === 'star' || p.kind === 'blackhole') ?? w.primaries[0];
    if (!ship || !star) return;
    const dx = ship.x - star.x;
    const dy = ship.y - star.y;
    const r = Math.hypot(dx, dy);
    if (!(r > 1e-6) || !Number.isFinite(r)) return;
    if (r < this.rMin) this.rMin = r;
    if (r > this.rMax) this.rMax = r;
    const span = this.rMax - this.rMin;
    if (!(span > 1e-4)) return;                       // 圆轨道：没有近远星点之分
    const relV = Math.hypot(ship.vx - star.vx, ship.vy - star.vy);
    const radV = ((ship.vx - star.vx) * dx + (ship.vy - star.vy) * dy) / r;

    const nearPeri = r < this.rMin + span * 0.08;
    const nearApo = r > this.rMax - span * 0.08;
    if (!nearPeri && !nearApo) return;

    const boxW = 300;
    const bx = this.w - boxW - 16;
    const by = this.h - 214;
    this.panel(bx, by, boxW, 56, pal);
    this.txt('奥伯特窗口 / OBERTH', bx + 12, by + 16, pal.uiDim, 10);
    if (nearPeri) {
      const p = 0.6 + 0.4 * Math.sin(this.clock * 6);
      this.txt('近星点 —— 此处加速最省 Δv', bx + 12, by + 34, rgba(pal.station, p), 12, 'left', '600');
    } else {
      this.txt('远星点 —— 此处加速最亏，尽量别在这点火', bx + 12, by + 34, pal.danger, 12, 'left', '600');
    }
    this.txt(`r = ${r.toFixed(2)} RU（${this.rMin.toFixed(2)}~${this.rMax.toFixed(2)}）· 相对速度 ${relV.toFixed(3)} · 径向 ${radV.toFixed(3)}`,
      bx + 12, by + 48, pal.uiDim, 9);
  }

  /** 层级构型面板：显示"谁是内轨/外轨、半径比、稳定性"，以及**诚实的 KL 状态**。 */
  private drawHierarchy(f: HudFrame, pal: Palette): void {
    const h = f.world.hierarchy;
    if (!h) return;
    const ratio = h.aOut / Math.max(1e-9, h.aIn);
    const boxW = 300;
    const bx = this.w - boxW - 16;
    const by = this.h - 276;
    this.panel(bx, by, boxW, 58, pal);
    this.txt('层级构型 / HIERARCHY', bx + 12, by + 16, pal.uiDim, 10);
    this.txt(`${h.inner} 绕 ${h.outer} · 半径比 ${ratio.toFixed(1)}`, bx + 12, by + 34,
      pal.uiAccent, 12, 'left', '600');
    // 诚实：二维共面系统里 KL 不可能发生（它需要 > 39.23° 的离面倾角）
    const iCritDeg = (Math.acos(Math.sqrt(3 / 5)) * 180) / Math.PI;
    this.txt(`内轨 e = ${h.eIn.toFixed(3)} · 倾角 0°（本作物理为二维共面）`,
      bx + 12, by + 48, pal.uiDim, 9);
    this.txt(`→ 不发生 Kozai-Lidov 振荡（KL 需要离面倾角 > ${iCritDeg.toFixed(1)}°）`,
      bx + 12, by + 58, pal.uiDim, 9);
  }

  private drawZVC(f: HudFrame, pal: Palette): void {
    if (!f.view.showZVC) return;
    const w = f.world;
    const prim = [...w.primaries].sort((a, b) => b.mass - a.mass).filter((b) => b.mass > 0);
    if (prim.length < 2) return;
    const A = prim[0];
    const B = prim[1];
    const d = Math.hypot(B.x - A.x, B.y - A.y);
    if (!(d > 1e-6) || B.mass / (A.mass + B.mass) > 0.5) return;
    const par = cr3bp(A.mass, B.mass, d);
    const pod = w.pods.find((p) => p.alive && !p.delivered) ?? w.pods[0];
    if (!pod) return;
    const rot = toRotating(pod.x, pod.y, pod.vx - A.vx, pod.vy - A.vy,
      A.x, A.y, B.x, B.y, A.mass, B.mass);
    const C = jacobi(rot.mu, rot.x, rot.y, rot.vx, rot.vy);

    // ---- 离屏栅格（48×48，缓存）----
    const N = 48;
    const span = 2.6;                       // 归一化视野：覆盖两主天体与近场
    const key = `${rot.mu.toFixed(4)}|${C.toFixed(2)}|${N}`;
    if (!this.zvcCache || this.zvcCache.key !== key) {
      const mask = zvcMask(rot.mu, C, -span * 0.4, span, -span * 0.6, span * 0.6, N, N);
      const cv = document.createElement('canvas');
      cv.width = N; cv.height = N;
      const cg = cv.getContext('2d');
      if (!cg) return;
      const img = cg.createImageData(N, N);
      let blocked = 0;
      for (let i = 0; i < mask.blocked.length; i++) {
        if (mask.blocked[i]) {
          blocked++;
          img.data[i * 4 + 0] = 255; img.data[i * 4 + 1] = 90; img.data[i * 4 + 2] = 90;
          img.data[i * 4 + 3] = 58;
        }
      }
      cg.putImageData(img, 0, 0);
      this.zvcCache = { key, cv, frac: blocked / mask.blocked.length };
    }
    const cache = this.zvcCache;
    if (!cache) return;

    // ---- 归一化旋转系 → 屏幕：原点在重天体，x 轴指向轻天体，单位 = d ----
    const ux = (B.x - A.x) / d;
    const uy = (B.y - A.y) / d;
    const toScr = (nx: number, ny: number, out: { x: number; y: number }) =>
      worldToScreen(f.view, A.x + (nx + rot.mu) * d * ux - ny * d * uy,
        A.y + (nx + rot.mu) * d * uy + ny * d * ux, out);
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 0, y: 0 };
    toScr(-span * 0.4, -span * 0.6, p0);
    toScr(span, span * 0.6, p1);
    const g = this.g;
    g.save();
    g.globalAlpha = 0.85;
    g.drawImage(cache.cv, p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    g.restore();

    // ---- 读数（如实标注近似）----
    const boxW = 330;
    const bx = this.w - boxW - 16;
    const by = this.h - 150;
    this.panel(bx, by, boxW, 52, pal);
    this.txt('零速度曲线 / ZVC (Z)', bx + 12, by + 16, pal.uiDim, 10);
    this.txt(`雅可比常数 C = ${C.toFixed(3)}`, bx + 12, by + 34, pal.uiAccent, 12, 'left', '600');
    this.txt(`禁区占比 ${(cache.frac * 100).toFixed(0)}% · 两体近似（主星+最重行星，其余天体与引力井会让 C 漂移）`,
      bx + 12, by + 46, pal.uiDim, 9);
  }

  private drawSling(f: HudFrame, pal: Palette): void {
    const wl = f.world.well;
    const ix = f.world.level ? 0 : 0;
    void ix;
    const W = 430;
    const x = (this.w - W) / 2;
    const y = 118;
    let line1 = '待机';
    let col = pal.uiDim;
    let line2 = '把货舱甩进井的轨道即可捕获（相对速度 < 该处逃逸速度）';
    if (f.world.fieldEnabled && wl.mass > 0) {
      for (const p of f.world.pods) {
        if (!p.alive || p.delivered) continue;
        const dx = p.x - wl.x;
        const dy = p.y - wl.y;
        const r = Math.hypot(dx, dy);
        if (r < 1e-4 || r > WELL_RANGE * 2.2) continue;   // 2.2×range 是 wellAccel 的硬截断
        const vx = p.vx - wl.vx;
        const vy = p.vy - wl.vy;
        const v = Math.hypot(vx, vy);
        // 与 physics.wellAccel 完全一致的外截止因子，否则远处会误判为捕获
      const cut = 1 / (1 + Math.pow(r / WELL_RANGE, 6));
      const mu = wl.mass * cut;
        const vEsc = Math.sqrt(2 * mu / r);
        if (v >= vEsc) continue;                     // 会逃逸 → 未捕获
        const a = 1 / Math.max(1e-9, (2 / r) - (v * v) / mu);
        if (!(a > 0)) continue;
        const T = 2 * Math.PI * Math.sqrt((a * a * a) / Math.max(1e-9, mu));
        const ecc = Math.sqrt(Math.max(0, 1 - (r * v * v) / mu));
        const peri = a * (1 - ecc);

        // 甩摆窗口：相对井的径向距离接近历史极小 → 松手能抛出最大速度
        if (r < this.rWellMin) this.rWellMin = r;
        if (r > this.rWellMax) this.rWellMax = r;
        const wspan = this.rWellMax - this.rWellMin;
        const atPeri = wspan > 1e-4 && r < this.rWellMin + wspan * 0.10;        line1 = `已捕获 · 周期 ${T.toFixed(1)}s`;
        col = pal.station;
        line2 = `相对速度 ${v.toFixed(3)} / 逃逸 ${vEsc.toFixed(3)} · 近井点 ${peri.toFixed(2)} RU · 松手即沿当前速度方向甩出`;
        if (atPeri) line2 += '  ⚑ 甩摆窗口：现在松手可获得最大抛射速度';
        break;
      }
    }
    this.panel(x, y, W, 54, pal);
    this.txt('甩摆捕获 / SLING', x + 12, y + 17, pal.uiDim, 10);
    this.txt(line1, x + 12, y + 36, col, 12, 'left', '600');
    this.txt(line2, x + 12, y + 48, pal.uiDim, 10);
  }

  /** 多段目标（多星串联）：显示当前航段与目标。单站关不显示。 */
  private drawLegs(f: HudFrame, pal: Palette): void {
    const lv = f.world.level;
    if (!lv.objectives || lv.objectivesTotal <= 1) return;
    const o = lv.objectives[lv.objectiveIndex];
    const x = 16;
    const y = 84;
    this.txt(`航段 ${lv.objectiveIndex + 1}/${lv.objectivesTotal} · ${o?.label_zh ?? '目标'}`,
      x, y, pal.uiAccent, 12, 'left', '600');
    this.txt('把货舱送到当前泊位后，站台会自动切换到下一段', x, y + 14, pal.uiDim, 10);
  }

  private drawCurve(
    x: number, y: number, w: number, h: number, data: number[], color: string, pal: Palette,
  ): void {
    const g = this.g;
    // 边框
    g.strokeStyle = rgba(color, 0.22);
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    this.calls++;
    // 中轴 + 四条时间基准线（一次路径）
    g.beginPath();
    g.moveTo(x, y + h * 0.5 + 0.5);
    g.lineTo(x + w, y + h * 0.5 + 0.5);
    g.strokeStyle = rgba(pal.uiDim, 0.35);
    g.stroke();
    this.calls++;
    g.beginPath();
    for (let i = 1; i < 4; i++) {
      const gx = x + (w * i) / 4;
      g.moveTo(gx + 0.5, y);
      g.lineTo(gx + 0.5, y + h);
    }
    g.strokeStyle = rgba(pal.uiDim, 0.18);
    g.stroke();
    this.calls++;

    const n = data.length;
    if (n < 2) {
      this.txt('采样中…', x + w * 0.5, y + h * 0.5 + 4, pal.uiDim, 10, 'center');
      return;
    }
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = data[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    // 展平序列的最小可视跨度：保留 1e-6 相对量级的分辨率
    const floor = Math.max(1e-12, 1e-3 * Math.max(Math.abs(mn), Math.abs(mx), 1e-12));
    const span = Math.max(mx - mn, floor);
    const mid = (mx + mn) * 0.5;
    const top = mid + span * 0.5;
    const bot = mid - span * 0.5;
    const pad = 4;
    const ih = h - pad * 2;
    const sx = (w - 2) / (CURVE_N - 1);

    g.beginPath();
    for (let i = 0; i < n; i++) {
      const px = x + 1 + (i + (CURVE_N - n)) * sx;
      const norm = (data[i] - bot) / (top - bot || 1);
      const py = y + pad + (1 - clamp01(norm)) * ih;
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.strokeStyle = color;
    g.lineWidth = 1.25;
    g.stroke();
    this.calls++;

    // 端点光点
    const lastV = data[n - 1];
    const lastNorm = (lastV - bot) / (top - bot || 1);
    const lx = x + 1 + (n - 1 + (CURVE_N - n)) * sx;
    const lyy = y + pad + (1 - clamp01(lastNorm)) * ih;
    g.fillStyle = color;
    g.fillRect(lx - 1.5, lyy - 1.5, 3, 3);
    this.calls++;

    // 量程标注（科学计数法，标出这是 1e-6 级别的抖动）
    this.txt(fmtSci(mx, 1), x + 3, y + 9, rgba(color, 0.75), 8);
    this.txt(fmtSci(mn, 1), x + 3, y + h - 3, rgba(color, 0.75), 8);
  }

  /* ---------------------------------------------------------- 底部：提示条 / 帮助 */

  private hintTokens(f: HudFrame): string {
    const w = f.world;
    const mode = w.well.engaged ? (w.well.repel ? '斥力' : '吸引') : '待机';
    return [
      '左键 吸引', '右键 斥力', '滚轮 场强', 'Alt+滚轮 缩放', '0 复位缩放', '空格 慢动作', 'T 加速', '1/2/3 质量档', 'Shift 精确',
      'Tab 预测', 'G 场线', 'Z 零速度曲线', 'F 矢量', 'R 重置', 'Esc 暂停', 'M 静音', '(H 帮助)',
    ].join(' · ') + `   [${mode}]`;
  }

  private drawHintBar(f: HudFrame, pal: Palette): void {
    const y = this.h - M - 30;
    const x = M + LEFT_W + 12;
    const w = Math.max(160, this.w - M - 268 - 12 - x);
    this.panel(x, y, w, 30, pal, pal.uiAccent, 0.42);

    // 缓存键必须包含"当前极性"：提示条尾部会显示 [吸引/斥力/待机]，
    // 只按宽度做键会让模式切换后文字卡住不更新。
    const wl = f.world.well;
    const modeTag = wl.engaged ? (wl.repel ? 'R' : 'A') : 'I';
    const key = `${Math.round(w)}|${modeTag}`;
    if (this.hintCache.key !== key) {
      const full = this.hintTokens(f);
      const sizes = [10.5, 10, 9.5, 9, 8.5];
      this.g.textAlign = 'left';
      let chosen = sizes[sizes.length - 1];
      for (const s of sizes) {
        this.setFont(s);
        if (this.g.measureText(full).width <= w - 20) { chosen = s; break; }
      }
      let text = full;
      this.setFont(chosen);
      if (this.g.measureText(text).width > w - 20) {
        // 极端窄窗：截断到放得下（只在宽度/极性变化时算一次）
        while (text.length > 8 && this.g.measureText(text + '…').width > w - 20) text = text.slice(0, -1);
        text += '…';
      }
      this.hintCache = { key, size: chosen, text };
    }
    this.txt(this.hintCache.text, x + w * 0.5, y + 20, pal.ui, this.hintCache.size, 'center');
  }

  private drawHelpCard(f: HudFrame, pal: Palette): void {
    const W = Math.min(880, this.w - 80);
    const H = Math.min(476, this.h - 80);
    const x = Math.round((this.w - W) * 0.5);
    const y = Math.round((this.h - H) * 0.5);
    this.panel(x, y, W, H, pal, pal.uiAccent, 0.82);
    this.txt('操作与公式 / CONTROLS & FORMULAS', x + 16, y + 26, pal.uiAccent, 13, 'left', '600');
    this.txt('H / Esc 关闭', x + W - 16, y + 26, pal.uiDim, 10, 'right');

    const colW = Math.floor((W - 48) * 0.5);
    const rx = x + 16 + colW + 16;
    let ly = y + 52;
    this.txt('— 操作 / CONTROLS —', x + 16, ly, pal.uiDim, 10);
    this.txt('— 公式速查 / FORMULAS —', rx, ly, pal.uiDim, 10);
    ly += 8;

    const keys: Array<[string, string]> = [
      ['鼠标移动', '设定引力井目标位置（弹簧阻尼追随，有惯性）'],
      ['左键按住', '井通电 = 吸引；松开则待机（质量归零）'],
      ['右键按住', '极性反转 = 斥力井（紧急制动 / 防撞）'],
      ['滚轮', '连续调节井质量 M_w（0.004 → 0.08 M*）'],
      ['Alt + 滚轮', '画面缩放 0.45×~3.2×（只缩放世界视图，HUD 不动；跨关卡保留）'],
      ['0', '画面缩放复位到 1.00×'],
      ['空格', '时间膨胀 ×0.25（慢动作，消耗算力）'],
      ['T', '时间加速 1×→2×→4×（相位窗口不用干等）'],
      ['1 / 2 / 3', '质量预设：轻 / 中 / 重'],
      ['Shift', '精确模式：阻尼比 ζ→1.0，跟手不甩尾'],
      ['Tab', '轨道预测：同一积分器前推 6 s 虚影'],
      ['G / F', '引力场线 / 速度矢量与轨道要素'],
      ['H', '展开 / 收起本卡片'],
      ['R / Esc / M', '重置关卡 / 暂停菜单 / 静音'],
    ];

    const w0 = f.world;
    const star = this.starBody(w0);
    const pod = this.primaryPod(w0);
    const mu = star && star.mu > 0 ? star.mu : 1;
    let live = '';
    let liveRoche = '';
    let liveL1 = '';
    let liveDil = '';
    if (pod && star) {
      // 轨道要素按**引力主导的中心天体**解算，并把它标出来（卫星关卡里是行星，不是恒星）
      const cen = this.dominantPrimary(w0, pod.x, pod.y) ?? star;
      const cMu = cen.mu > 0 ? cen.mu : mu;
      const el = stateToElements(pod.x - cen.x, pod.y - cen.y, pod.vx - cen.vx, pod.vy - cen.vy, cMu);
      const r = Math.max(1e-6, el.r);
      const aPos = Number.isFinite(el.a) && el.a > 0 ? el.a : r;
      live = `v_c ${fmtFixed(circularVelocity(cMu, r), 3)} · T ${fmtSig(keplerPeriod(cMu, aPos), 3)}`
        + ` · 中心 ${cen.key === 'star' ? '恒星' : cen.key === 'core' ? '黑洞' : cen.key}`;
      const rhoS = sphereDensity(star.mass, star.radius);
      const rhoP = sphereDensity(pod.mass, pod.radius);
      liveRoche = fmtSig(rocheLimit(star.radius, rhoS, rhoP), 3);
      const dockB = this.dockBody(w0);
      if (dockB) {
        const aDock = Math.hypot(dockB.x - star.x, dockB.y - star.y);
        if (aDock > 0) {
          const lp = lagrangePoints(star.mass, dockB.mass, aDock);
          liveL1 = `L1 ${fmtSig(lp.L1, 4)} / L2 ${fmtSig(lp.L2, 4)}`;
        }
      }
      const bh = w0.primaries.find((b) => b.kind === 'blackhole');
      if (bh) {
        const extra = bh as Body & { rs?: number };
        const rs = typeof extra.rs === 'number' && extra.rs > 0 ? extra.rs : RS_DEFAULT;
        liveDil = fmtSig(timeDilation(Math.hypot(pod.x - bh.x, pod.y - bh.y), rs), 6);
      }
    }

    const formulas: Array<[string, string]> = [
      ['F = G·m₁m₂/r²', '万有引力 —— 一切运动的唯一来源（Plummer 软化 ε）'],
      ['v_{n+1/2} → x → v (KDK)', '辛积分器蛙跳 —— 长期能量守恒，ΔE/E ≈ 1e-6'],
      [`d_R ≈ R(2ρ_M/ρ_m)^{1/3} = ${liveRoche || '—'}`, '洛希极限 —— 太近则潮汐撕裂成碎片'],
      ['Δv = I_sp·g₀·ln(m₀/m_f)', '齐奥尔科夫斯基火箭方程 —— Δv 预算的由来'],
      ['Δv₁ = √(μ/r₁)(√(2r₂/(r₁+r₂))−1)', '霍曼转移 —— 最省燃料的轨道路径'],
      ['a_rad = k·sail·A/(r²m)', '光压 —— 光帆货舱被推离恒星'],
      ['F_d = −½ρ C_d A|v_rel|v_rel', '二次阻力 —— 星云共转系里的气动刹车'],
      [`v_c = √(μ/r) = ${live || '—'}`, '开普勒第三定律 T = 2π√(a³/μ) 与圆轨道速度'],
      [`L₁ = R(1−(m/3M)^{1/3})  ${liveL1}`, '拉格朗日点 —— 稳定停泊位（L4/L5 等边三角）'],
      [`Δt_∞ = Δt/√(1−r_s/r) = ${liveDil || '—'}`, '引力时间膨胀 —— 黑洞关卡的时间流速'],
    ];

    for (let i = 0; i < keys.length; i++) {
      const ry = ly + 20 + i * 30;
      if (ry > y + H - 24) break;
      this.g.beginPath();
      rr(this.g, x + 16, ry - 13, 88, 17, 3);
      this.g.fillStyle = rgba(pal.uiAccent, 0.12);
      this.g.fill();
      this.calls++;
      this.g.strokeStyle = rgba(pal.uiAccent, 0.45);
      this.g.stroke();
      this.calls++;
      this.txt(keys[i][0], x + 60, ry, pal.uiAccent, 10, 'center', '600');
      this.txt(keys[i][1], x + 112, ry, pal.ui, 10);
    }
    for (let i = 0; i < formulas.length; i++) {
      const ry = ly + 20 + i * 33;
      if (ry > y + H - 24) break;
      this.txt(formulas[i][0], rx, ry, pal.station, 10, 'left', '600');
      this.txt(formulas[i][1], rx, ry + 12, pal.uiDim, 9);
    }
    this.txt('所有公式均为教科书形式，常数集中在 src/sim/constants.ts，Python 端可独立复核',
      x + 16, y + H - 10, pal.uiDim, 9);
  }

  /* ---------------------------------------------------------- 危险叠加 */

  private drawOffline(w: number, h: number, pal: Palette): void {
    const g = this.g;
    if (!this.stripes) this.stripes = this.makeStripePattern();
    if (!this.stripes) return;
    const pulse = 0.55 + 0.45 * Math.sin(this.clock * 2.2);
    g.save();
    g.globalAlpha = this.baseAlpha * 0.075 * pulse;
    g.fillStyle = this.stripes;
    g.fillRect(0, 0, w, h);
    g.restore();
    this.calls++;
    this.txt('FIELD PROJECTOR OFFLINE — 算力耗尽，等待回充（迟滞 30%）',
      w * 0.5, h - M - 40, rgba(pal.uiAccent, 0.5 * pulse + 0.25), 10, 'center', '600');
  }

  private makeStripePattern(): CanvasPattern | null {
    const doc = this.canvas.ownerDocument
      ?? (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const c = doc.createElement('canvas');
    c.width = 18;
    c.height = 18;
    const g2 = c.getContext('2d');
    if (!g2) return null;
    g2.strokeStyle = 'rgba(120,190,255,0.75)';
    g2.lineWidth = 1.6;
    g2.beginPath();
    g2.moveTo(-4, 22);
    g2.lineTo(22, -4);
    g2.moveTo(5, 31);
    g2.lineTo(31, 5);
    g2.stroke();
    return this.g.createPattern(c, 'repeat');
  }

  private drawHazard(f: HudFrame, pal: Palette): void {
    const w = f.world;
    const W = Math.min(540, Math.max(300, this.w - M * 2 - LEFT_W - RIGHT_W - 24));
    const x = Math.round((this.w - W) * 0.5);
    const y = M;
    const H = 46;
    const env = clamp01(w.windActive);
    this.panel(x, y, W, H, pal, pal.danger, 0.62);
    const pulse = 0.7 + 0.3 * Math.sin(this.clock * 9);
    this.glowTxt('!! 星风爆发 / STELLAR WIND BURST', x + 12, y + 20, rgba(pal.danger, pulse), 12, 'left', '600', 2);
    this.txt(`包络 ${fmtPct(env)}`, x + W - 12, y + 20, pal.danger, 10, 'right', '600');
    this.bar(x + 12, y + 27, W - 24, 7, env, rgba(pal.danger2, 0.95));
    this.txt(`下一次脉冲 ${fmtFixed(Math.max(0, w.windTimer), 1)}s  ·  径向向外推离，注意货舱轨道抬升`,
      x + 12, y + 42, rgba(pal.danger, 0.85), 9);
  }

  /** 顶部中央：当前目标一句话（玩家反馈"不知道目标是什么"）。
   *  第 1 关首次游玩时顶部有分步引导条，这里自动下移避免打架。 */
  private drawObjective(f: HudFrame, pal: Palette): void {
    const lv = f.world.level;
    const need = Math.max(0, lv.podsTotal - lv.podsDelivered);
    const W = this.w;
    const w = 470;
    const h = 30;
    const x = (W - w) * 0.5;
    const y = f.guideOn ? 96 : 16;
    this.panel(x, y, w, h, pal);
    const line = need > 0
      ? `目标：把货舱送进对接环（相对速度 < ${fmtFixed(f.world.dock.vMax, 2)}）`
      : '目标达成：全部货舱已送达 · 等待结算';
    this.txt(line, x + w * 0.5, y + 19, need > 0 ? pal.pod : pal.station, 11, 'center', '600');

    /* 撞星预警：把"你正在把货舱拉向恒星"这件事在损失发生前说出来。
       判据用近星点 r_peri = a(1−e) 与恒星半径比较（真实轨道要素，不是事后诸葛亮）。
       **中心天体必须按引力主导判据动态选取**：卫星系统关卡里货舱绕的是行星，
       若一律按恒星算要素，近星点会算出负数（实测 L2-3 报出 -2.45 RU），预警全错。 */
    const star = f.world.primaries.find((p) => p.kind === 'star' && p.alive);
    if (need > 0) {
      let worst = Infinity;
      let worstCore: Body | null = null;
      for (const p of f.world.pods) {
        if (!p.alive || p.delivered) continue;
        const c = this.dominantPrimary(f.world, p.x, p.y);
        if (!c || (c.kind !== 'star' && c.kind !== 'blackhole')) continue; // 绕行星的货舱由洛希/撕裂判据负责
        const el = stateToElements(p.x - c.x, p.y - c.y, p.vx - c.vx, p.vy - c.vy, c.mu || 1);
        const rp = el.a * (1 - Math.min(0.999, Math.abs(el.e)));
        if (rp < worst) { worst = rp; worstCore = c; }
      }
      const safe = (worstCore?.radius ?? star?.radius ?? 0.1) * 2.2;
      if (worst < safe && Number.isFinite(worst)) {
        const pulse = 0.55 + 0.45 * Math.sin(this.clock * 6);
        this.txt(`⚠ 货舱近星点 ${fmtFixed(worst, 2)} RU < 安全线 ${fmtFixed(safe, 2)} —— 再拉下去它会撞进恒星`,
          x + w * 0.5, y + h + 15, rgba(pal.danger, pulse), 10, 'center', '600');
      }
    }

    /* 引力井脱离作业区（玩家反馈："引力井飞出地图了，但没有重开的内容"）：
       必须主动告诉玩家"发生了什么 + 怎么出去"，而不是让他自己想到按 R。 */
    if (f.wellLost) {
      const pulse2 = 0.6 + 0.4 * Math.sin(this.clock * 7);
    /* 事件预警（宇宙风暴等）：**必须可预见**，否则就退化成运气 —— 提前 5 秒给 ETA。 */
    if (f.world.events && f.world.events.length) {
      const flare = f.world.level.events?.find((e) => e.kind === 'flare');
      const shower = f.world.level.events?.find((e) => e.kind === 'shower');
      if (shower) {
        const per = shower.period > 0 ? shower.period : 1e9;
        const lead = shower.t0 > f.world.time ? shower.t0 - f.world.time
          : per - ((f.world.time - shower.t0) % per);
        if (lead < 4) {
          const ps = 0.55 + 0.45 * Math.sin(this.clock * 8);
          this.txt(`⚠ 小行星雨 ${lead.toFixed(1)} 秒后进入 —— 把货舱挪出雨带，别硬闯`,
            x + w * 0.5, y + h + 105, rgba(pal.danger, ps), 10.5, 'center', '600');
        }
      }
      const wave = f.world.level.events?.find((e) => e.kind === 'wave');
      if (flare) {
        const lead = flare.t0 - f.world.time;
        if (lead > 0 && lead < 5) {
          const pf = 0.55 + 0.45 * Math.sin(this.clock * 8);
          this.txt(`⚠ 太阳耀斑 ${lead.toFixed(1)} 秒后抵达 —— 薄壳货舱（易碎/光帆）将受重创，先让它们避一避`,
            x + w * 0.5, y + h + 75, rgba(pal.danger, pf), 10.5, 'center', '600');
        } else if (lead <= 0 && lead > -(flare.duration ?? 1.2)) {
          this.txt('⚠ 太阳耀斑轰击中 —— 薄壳货舱正在受损',
            x + w * 0.5, y + h + 75, rgba(pal.danger, 0.95), 10.5, 'center', '600');
        }
      }
      if (wave) {
        const lead = wave.t0 - f.world.time;
        if (lead > 0 && lead < 4) {
          const pg = 0.55 + 0.45 * Math.sin(this.clock * 7);
          this.txt(`⚠ 引力波 ${lead.toFixed(1)} 秒后掠过 —— 潮汐会拉伸压扁轨迹，稳一点`,
            x + w * 0.5, y + h + 90, rgba(pal.uiAccent, pg), 10.5, 'center', '600');
        } else if (lead <= 0 && lead > -(wave.duration ?? 2.5)) {
          this.txt('⚠ 引力波过境中 —— 潮汐四极正在拉伸货舱轨迹',
            x + w * 0.5, y + h + 90, rgba(pal.uiAccent, 0.95), 10.5, 'center', '600');
        }
      }
      const rescue = f.world.level.events?.find((e) => e.kind === 'rescue');
      if (rescue) {
        const lead = rescue.t0 - f.world.time;
        const pod = f.world.pods.find((p) => p.alive && !p.delivered);
        if (lead > 0 && lead < 6) {
          const pw = 0.55 + 0.45 * Math.sin(this.clock * 7);
          this.txt(`⚠ 救援警报：${lead.toFixed(1)} 秒后货舱开始泄漏（约 ${(1 / (rescue.leakRate ?? 0.02)).toFixed(0)} 秒解体）`,
            x + w * 0.5, y + h + 60, rgba(pal.danger, pw), 10.5, 'center', '600');
        } else if (lead <= 0 && pod) {
          const secs = Math.max(0, pod.integrity / (rescue.leakRate ?? 0.02));
          const pw = 0.6 + 0.4 * Math.sin(this.clock * 9);
          this.txt(`⚠ 船体泄漏中 —— 约 ${secs.toFixed(1)} 秒后解体，尽快入坞`,
            x + w * 0.5, y + h + 60, rgba(pal.danger, pw), 10.5, 'center', '600');
        }
      }

      const ev = f.world.events[0];
      if (ev.active) {
        const p2 = 0.6 + 0.4 * Math.sin(this.clock * 8);
        this.txt('⚠ 宇宙风暴过境中 —— 锋面会推偏货舱，提前留出侧向余量',
          x + w * 0.5, y + h + 45, rgba(pal.danger, p2), 10.5, 'center', '600');
      } else if (ev.eta > 0 && ev.eta < 5) {
        const p3 = 0.55 + 0.45 * Math.sin(this.clock * 6);
        this.txt(`⚠ 宇宙风暴 ${ev.eta.toFixed(1)} 秒后抵达 —— 把货舱挪出锋面路径，或顺风借力`,
          x + w * 0.5, y + h + 45, rgba(pal.danger, p3), 10.5, 'center', '600');
      }
    }

      this.txt('⚠ 引力井已脱离作业区（飞船飞到地图外）—— 鼠标移回画面中心即可召回，或按 R 重试本关',
        x + w * 0.5, y + h + 30, rgba(pal.danger, pulse2), 10.5, 'center', '600');
    }
  }

  /**
   * 实体名牌 + 屏幕外目标箭头。
   * 玩家反馈"紫色是飞船吗？那目标是什么？"——光点没有名字，也没有"该往哪走"的指示。
   * 这里给恒星/空间站/货舱/牧星者号各加一个中文名牌；当目标在屏幕外时，在屏幕边缘画箭头 + 距离。
   */
  private drawEntityLabels(f: HudFrame, pal: Palette): void {
    const w = f.world;
    const out = { x: 0, y: 0 };
    const W = this.w;
    const H = this.h;
    const label = (wx: number, wy: number, text: string, color: string, dy: number): void => {
      const s = worldToScreen(f.view, wx, wy, out);
      if (s.x < 10 || s.y < 10 || s.x > W - 10 || s.y > H - 10) return;
      this.txt(text, s.x, s.y + dy, color, 10, 'center', '600');
      this.calls++;
    };
    const star = w.primaries.find((p) => p.kind === 'star' && p.alive);
    if (star) label(star.x, star.y, '恒星（引力源）', rgba(pal.uiDim, 0.95), -30);
    label(w.dock.x, w.dock.y, '空间站 · 对接环 ← 目标', pal.station, -34);
    for (let i = 0; i < w.pods.length; i++) {
      const p = w.pods[i];
      if (!p.alive) continue;
      label(p.x, p.y, p.delivered ? `货舱${i + 1} 已送达` : `货舱${i + 1} ← 送它进环`, pal.pod, -20 - (i % 2) * 13);
    }
    label(w.well.x, w.well.y, '牧星者号（引力井）', pal.well, -38);

    // 屏幕外指示
    this.edgeArrow(f, pal, w.dock.x, w.dock.y, '对接环', pal.station);
    for (let i = 0; i < w.pods.length; i++) {
      const p = w.pods[i];
      if (p.alive && !p.delivered) this.edgeArrow(f, pal, p.x, p.y, `货舱${i + 1}`, pal.pod);
    }
  }

  /** 目标在屏幕外时：屏幕边缘画箭头 + 直线距离（RU） */
  private edgeArrow(f: HudFrame, pal: Palette, wx: number, wy: number, name: string, color: string): void {
    const g = this.g;
    const out = { x: 0, y: 0 };
    const s = worldToScreen(f.view, wx, wy, out);
    const W = this.w;
    const H = this.h;
    const pad = 58;
    if (s.x >= pad && s.y >= pad && s.x <= W - pad && s.y <= H - pad) return; // 屏内不需要箭头
    const cx = W * 0.5;
    const cy = H * 0.5;
    let dx = s.x - cx;
    let dy = s.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const t = Math.min((W * 0.5 - pad) / Math.max(1e-6, Math.abs(dx)), (H * 0.5 - pad) / Math.max(1e-6, Math.abs(dy)));
    const ax = cx + dx * t;
    const ay = cy + dy * t;
    const pulse = 0.68 + 0.32 * Math.sin(this.clock * 3.2);
    g.save();
    g.translate(ax, ay);
    g.rotate(Math.atan2(dy, dx));
    g.beginPath();
    g.moveTo(13, 0); g.lineTo(-7, 8); g.lineTo(-7, -8);
    g.closePath();
    g.fillStyle = rgba(color, 0.85 * pulse);
    g.fill();
    g.strokeStyle = rgba(color, 1);
    g.lineWidth = 1;
    g.stroke();
    g.restore();
    const dist = Math.hypot(wx - f.world.well.x, wy - f.world.well.y);
    this.txt(`${name} ${fmtFixed(dist, 2)} RU`, ax, ay + 22, rgba(color, 0.95), 9, 'center', '600');
    this.calls += 4;
  }

  private drawPodMarkers(f: HudFrame, pal: Palette): void {
    const g = this.g;
    const pts = f.world.pods;
    if (!pts || pts.length === 0) return;
    const out = { x: 0, y: 0 };
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p.alive) continue;
      const s = worldToScreen(f.view, p.x, p.y, out);
      if (s.x < -40 || s.y < -40 || s.x > this.w + 40 || s.y > this.h + 40) continue;

      if (p.stress > STRESS_WARN) {
        const k = clamp01((p.stress - STRESS_WARN) / (2.6 - STRESS_WARN));
        const pulse = 0.6 + 0.4 * Math.sin(this.clock * 8 + i);
        if (k > 0.4) {
          g.beginPath();
          g.arc(s.x, s.y, 9 + k * 5, 0, Math.PI * 2);
          g.fillStyle = rgba(pal.danger, 0.10 * k * pulse);
          g.fill();
          this.calls++;
        }
        for (let ring = 0; ring < 3; ring++) {
          const rad = 10 + ring * 5 + k * 4 * pulse;
          g.beginPath();
          g.arc(s.x, s.y, rad, 0, Math.PI * 2);
          g.strokeStyle = rgba(pal.danger, (0.55 - ring * 0.14) * pulse);
          g.lineWidth = 1.2;
          g.stroke();
          this.calls++;
        }
        this.txt(`应力 ${fmtFixed(p.stress, 2)}`, s.x + 16, s.y + 4, pal.danger, 9, 'left', '600');
      } else if (!p.delivered && !p.docked) {
        g.strokeStyle = rgba(pal.pod, 0.5);
        g.lineWidth = 1;
        g.strokeRect(s.x - 5.5, s.y - 5.5, 11, 11);
        this.calls++;
        this.txt(`${i + 1}`, s.x + 9, s.y - 6, rgba(pal.pod, 0.7), 9);
      }
    }
  }

  /* ---------------------------------------------------------- toast */

  private drawToasts(f: HudFrame, pal: Palette): void {
    // 1) world.fx 里带文字的事件 → toast（WeakSet 去重，同一事件只弹一次）
    const fx = f.world.fx;
    if (fx && fx.length) {
      for (let i = 0; i < fx.length; i++) {
        const ev = fx[i];
        if (!ev.text) continue;
        if (this.seenFx.has(ev)) continue;
        this.seenFx.add(ev);
        this.pushToast(ev.text, fxToastKind(ev.kind));
      }
    }

    // 2) 合并外部传入的 toast：
    //    · 同文本的内部 toast 还活着 → 跳过（游戏层常常 pushToast 与 f.toasts 双投递同一条事件）
    //    · 外部 toast 由 HUD 按"首次出现时刻"计龄：兼容 age / 倒计时两种 t 语义，
    //      且对方数组里长期保留的旧对象也不会变成永不消散的幽灵条目
    const list: HudToast[] = [];
    for (let i = 0; i < this.toasts.length; i++) list.push(this.toasts[i]);
    const ext = f.toasts;
    if (ext && ext.length) {
      for (let i = 0; i < ext.length; i++) {
        const t = ext[i];
        if (!t || !t.text) continue;
        const key = t as unknown as object;
        let born = this.extSeen.get(key);
        if (born === undefined) { born = this.clock; this.extSeen.set(key, born); }
        const age = this.clock - born;
        if (age > TOAST_LIFE) continue;
        let dup = false;
        for (let k = 0; k < list.length; k++) {
          if (list[k].text === t.text && list[k].t < TOAST_LIFE) { dup = true; break; }
        }
        if (dup) continue;
        list.push({ text: t.text, t: age, kind: t.kind });
      }
    }
    if (list.length === 0) return;
    if (list.length > TOAST_MAX) list.splice(0, list.length - TOAST_MAX);

    // 3) 从下往上堆叠（最新的一条贴底）
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      const age = clamp(t.t, 0, TOAST_LIFE);
      const alpha = age < 0.18 ? age / 0.18 : age < 3.4 ? 1 : clamp01(1 - (age - 3.4) / (TOAST_LIFE - 3.4));
      if (alpha <= 0.02) continue;
      const slot = list.length - 1 - i;
      const y = this.h - M - 176 - slot * 30;
      const col = toastColor(t.kind, pal);
      this.setFont(10);
      this.g.textAlign = 'left';
      const tw = Math.min(292, this.g.measureText(t.text).width + 26);
      const x = this.w - M - tw;
      this.panel(x, y, tw, 24, pal, col, 0.6 * alpha);
      this.bar(x + 6, y + 5, 3, 14, 1, col, alpha);
      this.txt(t.text, x + 14, y + 16, rgba(pal.ui, alpha), 10, 'left', '400', alpha);
    }
  }

  /* ---------------------------------------------------------- 结算横幅 */

  private drawResult(f: HudFrame, pal: Palette): void {
    const win = f.status === 'won';
    const g = this.g;
    const cy = this.h * 0.42;
    const bandH = 132;
    const top = cy - bandH * 0.5;
    const col = win ? pal.station : pal.danger;
    const pulse = 0.82 + 0.18 * Math.sin(this.clock * 2.4);

    g.fillStyle = 'rgba(5,7,15,0.55)';
    g.fillRect(0, top, this.w, bandH);
    this.calls++;
    g.strokeStyle = rgba(col, 0.5);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, top + 0.5);
    g.lineTo(this.w, top + 0.5);
    g.moveTo(0, top + bandH - 0.5);
    g.lineTo(this.w, top + bandH - 0.5);
    g.stroke();
    this.calls++;

    const title = win ? '任务完成' : '任务失败';
    const sub = win ? 'MISSION COMPLETE' : 'MISSION FAILED';
    this.glowTxt(title, this.w * 0.5, top + 62, rgba(col, pulse), 46, 'center', '600', 3);
    this.txt(sub, this.w * 0.5, top + 84, rgba(col, 0.75), 12, 'center', '600');

    const lv = f.world.level;
    const stat = `送达 ${lv.podsDelivered}/${lv.podsTotal}  ·  损毁 ${lv.podsLost}  ·  用时 ${fmtTime(lv.elapsed, 'floor')}`
      + `  ·  Δv ${fmtDv(lv.fuelUsed)}  ·  保真 ${lv.fidelityGrade}`;
    this.txt(stat, this.w * 0.5, top + 106, pal.ui, 11, 'center');
    this.txt(win ? 'Enter 查看结算  ·  Esc 暂停菜单' : 'R 重试  ·  Esc 暂停菜单',
      this.w * 0.5, top + bandH + 22, pal.uiDim, 10, 'center');
  }
}
