/**
 * 世界坐标 ⇄ 屏幕坐标变换（冻结）
 * 世界单位 RU；1 RU = PX_PER_RU 像素 × 相机缩放。
 * render / game / input 都必须使用这里的变换，保证鼠标拾取与绘制完全一致。
 */
import type { ViewState, Vec2 } from '../sim/types';

export const PX_PER_RU = 128;

export interface Camera { x: number; y: number; zoom: number }

export function worldToScreen(view: ViewState, wx: number, wy: number, out?: Vec2): Vec2 {
  const o = out ?? { x: 0, y: 0 };
  const s = PX_PER_RU * view.camera.zoom;
  o.x = view.w * 0.5 + (wx - view.camera.x) * s;
  o.y = view.h * 0.5 + (wy - view.camera.y) * s;
  return o;
}

export function screenToWorld(view: ViewState, sx: number, sy: number, out?: Vec2): Vec2 {
  const o = out ?? { x: 0, y: 0 };
  const s = PX_PER_RU * view.camera.zoom;
  o.x = (sx - view.w * 0.5) / s + view.camera.x;
  o.y = (sy - view.h * 0.5) / s + view.camera.y;
  return o;
}

/** 当前视图在世界坐标下的可见半径（用于裁剪与剔除） */
export function viewRadius(view: ViewState): number {
  const s = PX_PER_RU * view.camera.zoom;
  return (0.5 * Math.hypot(view.w, view.h)) / s;
}

/** 世界长度 → 像素长度 */
export function worldLenToPx(view: ViewState, len: number): number {
  return len * PX_PER_RU * view.camera.zoom;
}

/** 像素长度 → 世界长度 */
export function pxLenToWorld(view: ViewState, px: number): number {
  return px / (PX_PER_RU * view.camera.zoom);
}
