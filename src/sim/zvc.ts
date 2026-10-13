/**
 * zvc.ts —— 圆型限制性三体问题（CR3BP）的 Jacobi 常数与零速度曲线。
 *
 * 物理
 * ----
 * 设两天体质量 m1 ≥ m2，间距 d，令
 *   μ = m2/(m1+m2)（质量比）、ω = sqrt((m1+m2)/d³)（开普勒第三定律，平均运动）
 * 在**随两天体一同旋转**的坐标系里（原点取质心、单位长度取 d），归一化后两个主天体
 * 固定在 (−μ, 0) 与 (1−μ, 0)，有效势
 *   Ω(x, y) = (x² + y²)/2 + (1−μ)/r₁ + μ/r₂
 * 其中 r₁、r₂ 分别是到两个主天体的距离。Jacobi 常数
 *   C = 2Ω − v²
 * 沿无动力轨迹**守恒**（这是 CR3BP 唯一的运动积分）。
 *
 * 零速度曲线（ZVC）
 * ----------------
 * 给定 C，速度必须满足 v² = 2Ω − C ≥ 0，所以 2Ω < C 的区域**不可达**。
 * 等值线 2Ω = C 就是零速度曲线——它把"能去哪儿"和"禁区"分开。
 * 本模块提供网格化的 ZVC 判定，供渲染层画禁区/边界。
 *
 * 与游戏的关系：本作多数关卡是单星 + 行星，取"主星 + 最重行星"作两体近似时
 * ZVC 才有意义（其它天体与引力井会让 C 漂移）。因此它是**近似可视化**，
 * 界面上必须如实标注，不能宣称是精确积分。
 */

export interface Cr3bp {
  /** 质量比 m2/(m1+m2)，约定 m1 ≥ m2，故 μ ∈ (0, 0.5] */
  mu: number;
  /** 平均运动 ω = sqrt((m1+m2)/d³)，单位 1/TU */
  omega: number;
  /** 两天体间距（RU） */
  d: number;
  /** 轻天体在旋转系里的位置（归一化 x 坐标 = 1−μ，y = 0） */
  m1: number;
  m2: number;
}

/** 由两个质量与间距构造 CR3BP 参数（内部保证 m1 ≥ m2）。 */
export function cr3bp(mA: number, mB: number, d: number): Cr3bp {
  const m1 = Math.max(mA, mB);
  const m2 = Math.min(mA, mB);
  const total = m1 + m2;
  const dd = Math.max(1e-9, d);
  return { mu: total > 0 ? m2 / total : 0, omega: Math.sqrt(total / (dd * dd * dd)), d: dd, m1, m2 };
}

/** 归一化坐标下的有效势 Ω */
export function omegaEff(mu: number, x: number, y: number): number {
  const r1 = Math.hypot(x + mu, y);            // 到重天体 (−μ, 0)
  const r2 = Math.hypot(x - 1 + mu, y);        // 到轻天体 (1−μ, 0)
  return 0.5 * (x * x + y * y) + (1 - mu) / Math.max(1e-12, r1) + mu / Math.max(1e-12, r2);
}

/** Jacobi 常数 C = 2Ω − v²（归一化单位） */
export function jacobi(mu: number, x: number, y: number, vx: number, vy: number): number {
  return 2 * omegaEff(mu, x, y) - (vx * vx + vy * vy);
}

/**
 * 把世界坐标下的状态转成旋转系归一化状态。
 *
 * @param px,py        目标点在惯性系中的位置（RU）
 * @param vx,vy        目标点**相对重天体**的速度（RU/TU，调用者先做减法）
 * @param a1x,a1y      重天体的惯性位置
 * @param a2x,a2y      轻天体的惯性位置
 * @returns 旋转系归一化坐标与速度（同时给出 μ 与 ω 供调用者使用）
 */
export function toRotating(
  px: number, py: number, vx: number, vy: number,
  a1x: number, a1y: number, a2x: number, a2y: number,
  m1: number, m2: number,
): { mu: number; omega: number; x: number; y: number; vx: number; vy: number } {
  const dx = a2x - a1x;
  const dy = a2y - a1y;
  const d = Math.max(1e-9, Math.hypot(dx, dy));
  const total = m1 + m2;
  const mu = total > 0 ? Math.min(m1, m2) / total : 0;
  const omega = Math.sqrt(total / (d * d * d));
  // 旋转系：以重天体为参考原点，e_x 指向轻天体
  const ex = dx / d;
  const ey = dy / d;
  const rx = px - a1x;
  const ry = py - a1y;
  // 投影到旋转轴（除以 d 归一化，并把原点挪到质心：重天体在 −μ）
  const x = (rx * ex + ry * ey) / d - mu;
  const y = (-rx * ey + ry * ex) / d;
  // vx/vy 语义：**相对重天体**的速度（调用者先做 v − v_primary）
  const relx = vx * ex + vy * ey;
  const rely = -vx * ey + vy * ex;
  const pvx = relx / (omega * d);              // 归一化：长度 d、时间 1/ω
  const pvy = rely / (omega * d);
  return { mu, omega, x, y, vx: pvx + y, vy: pvy - x };   // 加上旋转带来的 −ω×r 项（归一化后为 (y, −x)）
}

/** 两个共线点（L1/L2）的 x 坐标：解 ∂Ω/∂x = 0（用二分法，稳健） */
export function collinearX(mu: number, side: -1 | 0 | 1): number {
  // side = -1 → L1（两星之间）；0 → L2（轻星外侧）；1 → L3（重星外侧）
  const f = (x: number): number => {
    const r1 = Math.abs(x + mu);
    const r2 = Math.abs(x - 1 + mu);
    const s1 = x + mu >= 0 ? 1 : -1;
    const s2 = x - 1 + mu >= 0 ? 1 : -1;
    return x - (1 - mu) * (s1 / (r1 * r1)) - mu * (s2 / (r2 * r2));
  };
  let lo: number;
  let hi: number;
  if (side === -1) { lo = -mu + 1e-6; hi = 1 - mu - 1e-6; }
  else if (side === 0) { lo = 1 - mu + 1e-6; hi = 1 - mu + 4; }
  else { lo = -mu - 4; hi = -mu - 1e-6; }
  let flo = f(lo);
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if ((flo <= 0) === (fm <= 0)) { lo = mid; flo = fm; } else { hi = mid; }
  }
  return 0.5 * (lo + hi);
}

/** 共线点的 Jacobi 常数 C = 2Ω（该处速度为零） */
export function collinearC(mu: number, side: -1 | 0 | 1): number {
  const x = collinearX(mu, side);
  return 2 * omegaEff(mu, x, 0);
}

/** 三角点 L4/L5 的解析 Jacobi 常数：C = 3 − μ + μ² */
export function triangularC(mu: number): number {
  return 3 - mu + mu * mu;
}

/** 归一化旋转系里某点的可达性：2Ω ≥ C 才可达 */
export function reachable(mu: number, C: number, x: number, y: number): boolean {
  return 2 * omegaEff(mu, x, y) >= C;
}

/**
 * 生成零速度曲线的网格掩码（true = 禁区）。
 * 供渲染层把禁区画成半透明色块，边界即 ZVC。
 */
export function zvcMask(
  mu: number, C: number, x0: number, x1: number, y0: number, y1: number, nx: number, ny: number,
): { w: number; h: number; blocked: Uint8Array } {
  const blocked = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = y0 + ((j + 0.5) / ny) * (y1 - y0);
    for (let i = 0; i < nx; i++) {
      const x = x0 + ((i + 0.5) / nx) * (x1 - x0);
      blocked[j * nx + i] = reachable(mu, C, x, y) ? 0 : 1;
    }
  }
  return { w: nx, h: ny, blocked };
}
