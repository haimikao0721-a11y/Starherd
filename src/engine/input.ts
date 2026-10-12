/**
 * 输入层：鼠标为主（引力井目标点、吸引/斥力、滚轮调场强），键盘为辅（慢动作/质量档/精确/预测/场线…）
 * 只在这里做一次屏幕→世界坐标换算，保证与渲染用的变换完全一致。
 */
import type { ViewState } from '../sim/types';
import { screenToWorld, worldToScreen } from './view';

export interface InputSnapshot {
  /** CSS 像素 */
  mx: number; my: number;
  /** 世界坐标 */
  wx: number; wy: number;
  left: boolean; right: boolean; middle: boolean;
  wheel: number;
  /** Alt+滚轮的画面缩放步数（正=放大），每帧清零 */
  zoom: number;
  shift: boolean; ctrl: boolean; alt: boolean;
  inside: boolean;
}

export class Input {
  private keys = new Set<string>();
  private pressedKeys = new Set<string>();
  private releasedKeys = new Set<string>();
  private snap: InputSnapshot = {
    mx: 0, my: 0, wx: 0, wy: 0, left: false, right: false, middle: false,
    wheel: 0, zoom: 0, shift: false, ctrl: false, alt: false, inside: false,
  };
  private enabled = true;
  private tmp = { x: 0, y: 0 };
  /** 供 UI 命中测试：鼠标是否落在 HUD 可点区域（游戏层可覆盖） */
  public uiCapture = false;

  constructor(private canvas: HTMLCanvasElement) {}

  attach(): void {
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointerleave', this.onLeave);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('contextmenu', this.onCtx);
  }

  detach(): void {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointerleave', this.onLeave);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('contextmenu', this.onCtx);
  }

  setEnabled(v: boolean): void { this.enabled = v; if (!v) { this.snap.left = false; this.snap.right = false; } }

  private onCtx = (e: Event): void => { e.preventDefault(); };
  private onLeave = (): void => { this.snap.inside = false; };
  private onBlur = (): void => { this.keys.clear(); this.snap.left = false; this.snap.right = false; };

  private onMove = (e: PointerEvent): void => {
    const r = this.canvas.getBoundingClientRect();
    this.snap.mx = e.clientX - r.left;
    this.snap.my = e.clientY - r.top;
    this.snap.inside = this.snap.mx >= 0 && this.snap.my >= 0 && this.snap.mx <= r.width && this.snap.my <= r.height;
  };

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (e.button === 0) this.snap.left = true;
    if (e.button === 2) this.snap.right = true;
    if (e.button === 1) { this.snap.middle = true; e.preventDefault(); }
  };

  private onUp = (e: PointerEvent): void => {
    if (e.button === 0) this.snap.left = false;
    if (e.button === 2) this.snap.right = false;
    if (e.button === 1) this.snap.middle = false;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    // Alt + 滚轮 = 画面缩放（只影响世界视图，不动 HUD/菜单）；否则是场强调节。
    // 浏览器自身用 Ctrl+滚轮做页面缩放，Alt 组合是空闲的。
    if (e.altKey) this.snap.zoom += Math.sign(e.deltaY);
    else this.snap.wheel += Math.sign(e.deltaY);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.keys.add(e.code);
    this.pressedKeys.add(e.code);
    if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    this.snap.shift = e.shiftKey; this.snap.ctrl = e.ctrlKey; this.snap.alt = e.altKey;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    this.releasedKeys.add(e.code);
    this.snap.shift = e.shiftKey; this.snap.ctrl = e.ctrlKey; this.snap.alt = e.altKey;
  };

  /** 每帧开始时调用：把屏幕坐标换算成世界坐标（零分配） */
  update(view: ViewState): void {
    const w = screenToWorld(view, this.snap.mx, this.snap.my, this.tmp);
    this.snap.wx = w.x; this.snap.wy = w.y;
  }

  /** 每帧结束时调用：清空边沿触发状态 */
  endFrame(): void {
    this.pressedKeys.clear();
    this.releasedKeys.clear();
    this.snap.wheel = 0;
    this.snap.zoom = 0;
  }

  get snapshot(): InputSnapshot { return this.snap; }
  down(code: string): boolean { return this.keys.has(code); }
  pressed(code: string): boolean { return this.pressedKeys.has(code); }
  released(code: string): boolean { return this.releasedKeys.has(code); }
  anyPressed(...codes: string[]): boolean { return codes.some((c) => this.pressedKeys.has(c)); }
  /** 屏幕坐标（供 HUD 命中测试） */
  screenOf(view: ViewState, wx: number, wy: number): { x: number; y: number } {
    const p = worldToScreen(view, wx, wy, { x: 0, y: 0 });
    return { x: p.x, y: p.y };
  }
}
