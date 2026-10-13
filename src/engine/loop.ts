/**
 * 多循环宿主：渲染循环（rAF）+ 固定步长物理循环（累加器）+ 1Hz 遥测循环，
 * 并对 document.hidden 做后台降级（暂停物理与音频调度，恢复时重置时基，避免时间跳变）。
 */
import { DT, MAX_SUBSTEPS } from '../sim/constants';

export interface LoopHooks {
  /** 返回本帧希望推进的模拟时间（TU）。游戏层在此施加时间膨胀/慢动作/自动测试加速 */
  simDt(dtReal: number): number;
  /** 每个固定物理步 */
  fixed(dtTU: number): void;
  /** 每帧渲染（alpha 为物理相位插值系数） */
  frame(alpha: number, dtReal: number, simDt: number): void;
  /** 1Hz 回调（遥测、存档节流） */
  second(dtReal: number): void;
  /** 页面可见性变化 */
  onVisibility(hidden: boolean): void;
}

export class GameLoop {
  private raf = 0;
  private last = 0;
  private acc = 0;
  private accSecond = 0;
  /** 帧率上限：帧间隔小于该毫秒数就跳过本帧（0 = 不限） */
  /** 物理固定步长（可切 120Hz/60Hz：弱机上把 CPU 占用减半） */
  private dt = DT;
  private minFrameMs = 0;
  private frameGate = 0;
  private running = false;
  private hidden = false;
  private _fps = 60;
  private _frameMs = 0;
  private _steps = 0;
  private _frames = 0;
  /** 用于自动测试：无 rAF 时可由外部手动 pump */
  private manual = false;

  constructor(private hooks: LoopHooks) {}

  get fps(): number { return this._fps; }
  get frameMs(): number { return this._frameMs; }
  get steps(): number { return this._steps; }
  get lastSimDt(): number { return this.acc; }

  /**
   * 设置帧率上限（0 = 不限）。超出预算的帧**整帧跳过**（不推进模拟、不渲染），
   * 于是帧间隔变稳——玩家反馈"帧率低，希望有固定帧率生效"，抖动比峰值更影响手感。
   * 跳过帧不会丢时间：`this.last` 已更新，下一帧的 dtReal 会自然累积，模拟保持一致。
   */
  /**
   * 设置物理固定步长（默认 120Hz）。传 `DT * 2` 即 60Hz：
   * 每帧的子步数减半 → CPU 占用明显下降；速度 Verlet 在 2× 步长下仍然稳定，
   * 只是积分精度略降（远距离交会无感，近距离高速掠过大天体时误差会大一些）。
   */
  setFixedDt(dt: number): void {
    this.dt = Math.max(1e-4, Math.min(0.05, dt));
  }

  get fixedDt(): number { return this.dt; }

  setFrameCap(fps: number): void {
    this.minFrameMs = fps > 0 ? 1000 / Math.max(1, Math.min(240, fps)) : 0;
    this.frameGate = 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    document.addEventListener('visibilitychange', this.onVis);
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVis);
  }

  /** 手动推进一帧（自动测试 / 无头环境） */
  pump(dtReal: number): void {
    this.step(dtReal * 1000, true);
  }

  private onVis = (): void => {
    this.hidden = document.hidden;
    this.last = performance.now();
    this.acc = 0;
    this.hooks.onVisibility(this.hidden);
  };

  private tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    this.step(now, false);
  };

  private step(now: number, manual: boolean): void {
    const t0 = performance.now();
    let dtReal = (now - this.last) / 1000;
    this.last = now;
    if (manual) dtReal = (now - (this.lastManual ?? now - 16)) / 1000;
    this.lastManual = now;
    if (!isFinite(dtReal) || dtReal < 0) dtReal = 0;
    // 后台或长时间挂起后不要一次补太多（否则物理会"瞬移"）
    if (dtReal > 0.1) dtReal = 0.1;
    // 帧率上限：还没到下一帧的时间点就整帧跳过（渲染与物理都不做）
    if (this.minFrameMs > 0) {
      this.frameGate += dtReal * 1000;
      if (this.frameGate < this.minFrameMs - 0.5) return;
      this.frameGate = 0;
    }

    let steps = 0;
    if (!this.hidden && dtReal > 0) {
      const want = this.hooks.simDt(dtReal);
      this.acc += want;
      while (this.acc >= this.dt && steps < MAX_SUBSTEPS * 3) {
        this.hooks.fixed(this.dt);
        this.acc -= this.dt;
        steps++;
      }
      if (steps >= MAX_SUBSTEPS * 3) this.acc = 0; // 死亡螺旋保护：丢弃积压
      this._steps = steps;
      this.accSecond += dtReal;
      if (this.accSecond >= 1) {
        this.hooks.second(this.accSecond);
        this.accSecond = 0;
      }
    } else {
      this._steps = 0;
    }

    const alpha = Math.max(0, Math.min(1, this.acc / this.dt));
    this.hooks.frame(alpha, dtReal, steps * this.dt);
    const ms = performance.now() - t0;
    this._frameMs = this._frameMs * 0.9 + ms * 0.1;
    const inst = dtReal > 0 ? 1 / dtReal : 60;
    this._fps = this._fps * 0.92 + Math.min(240, inst) * 0.08;
    this._frames++;
  }

  private lastManual: number | undefined;
}
