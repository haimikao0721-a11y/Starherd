/**
 * 真实天体力学公式实现（核心可信度所在）
 * 每个函数都对应教科书公式，Python 端 python/physics_ref.py 有独立实现可交叉复核。
 */
import type { Body, Vec2 } from './types';
import { G, EPS, K_RAD, AREA_K, FIELD_SOFTEN, FIELD_ACCEL_MAX } from './constants';

/**
 * 纯公式重导出：这些是教科书公式（圆轨道速度、逃逸速度、开普勒第三定律、活力公式、
 * 洛希极限、球体密度、潮汐梯度、山丘球、拉格朗日点、引力时间膨胀），
 * 定义在 constants.ts（HUD 与关卡工具都从那里取），这里统一从 physics 入口再导出，
 * 使 sim 内部与外部都能用同一个实现，避免出现两套公式。
 */
export {
  circularVelocity, escapeVelocity, keplerPeriod, visViva, rocheLimit,
  sphereDensity, tidalGradient, hillSphere, lagrangePoints, timeDilation, tidalTearRadius,
} from './constants';

/** Plummer 软化后的引力加速度：a = G·m·r/(r²+ε²)^{3/2} */
export function softenInvCube(dx: number, dy: number, eps: number): number {
  const r2 = dx * dx + dy * dy + eps * eps;
  return 1 / (r2 * Math.sqrt(r2));
}

/**
 * 光速（游戏单位 RU/TU）。
 *
 * ⚠️ 本作单位是**游戏单位**（G = μ = 1），不是 SI —— 所以这个值不是 299792458，
 * 而是为了让 1PN 近星点进动"看得见但不夸张"而选的常数：
 * 取轨道速度 ~0.5 RU/TU、μ=1、a≈1.5 时每圈进动约 1°（Δϖ = 6πμ/(c²a(1−e²))）。
 * 更强的相对论效应留给黑洞关（那里 μ/r 大得多），普通关卡几乎无感。
 */
export const C_LIGHT = 30.0;

/** 1PN 是否在该处显著：μ/(c²r) 可忽略就跳过（普通关卡自动走纯牛顿） */
export function relSignificant(mu: number, r: number): boolean {
  return mu / (C_LIGHT * C_LIGHT * Math.max(1e-9, r)) > 1e-5;
}

/**
 * 一阶后牛顿（1PN）相对加速度，**累加**到 out。
 *
 * @param dx,dy   相对位置 r⃗ = **目标点 − 源**（注意方向，反了会让整项变号）
 * @param dvx,dvy 相对速度 v⃗
 * @param muTotal μ_tot = G(m₁+m₂)
 */
export function relAccel(dx: number, dy: number, dvx: number, dvy: number,
  muTotal: number, out: Vec2): void {
  const r2 = dx * dx + dy * dy;
  const r = Math.sqrt(r2);
  if (!relSignificant(muTotal, r)) return;
  const v2 = dvx * dvx + dvy * dvy;
  const rv = dx * dvx + dy * dvy;
  const k = muTotal / (C_LIGHT * C_LIGHT * r2 * r);
  const c1 = (4 * muTotal) / r - v2;
  out.x += k * (c1 * dx + 4 * rv * dvx);
  out.y += k * (c1 * dy + 4 * rv * dvy);
}

/** 单质点引力加速度（写入 out） */
export function pointAccel(dx: number, dy: number, mu: number, eps: number, out: Vec2): void {
  const k = mu * softenInvCube(dx, dy, eps);
  out.x += k * dx;
  out.y += k * dy;
}

/**
 * 主天体群对 (x,y) 的引力加速度，**含 1PN 相对论修正**（近致密源才生效，见 relSignificant）。
 *
 * 与 primaryAccel 的区别只是多要一个速度——1PN 项依赖速度，这是它产生近星点进动的原因。
 */
export function primaryAccelRel(x: number, y: number, vx: number, vy: number,
  primaries: Body[], eps: number, out: Vec2): void {
  for (let i = 0; i < primaries.length; i++) {
    const b = primaries[i];
    if (!b.alive) continue;
    const dx = b.x - x;
    const dy = b.y - y;
    pointAccel(dx, dy, b.mu, eps, out);
    const r2 = dx * dx + dy * dy;
    // 只在**黑洞**附近开启 1PN：普通恒星的 μ/(c²r) 也可观，但那样会改变既有解法的可解性，
    // 而可行性分析器（Python）并不建模 1PN —— 与其让两套口径打架，不如把相对论效应
    // 限定在本来就是"强场"的黑洞关。判定用运行时已有的 kind，不新增数据字段。
    if (b.kind === 'blackhole' && r2 > 1e-12 && relSignificant(b.mu, Math.sqrt(r2))) {
      // ⚠️ 约定：relAccel 要的是 r⃗ = 目标 − 源、v⃗ = 目标速度 − 源速度。
      // 而上面的 dx = b.x − x 是**源 − 目标**，所以这里必须取反——否则 1PN 项整体变号，
      // 圆轨道上本该有的排斥修正会变成吸引，近星点进动方向也跟着反。
      relAccel(-dx, -dy, vx - b.vx, vy - b.vy, b.mu, out);
    }
  }
}

/** 主天体群对 (x,y) 的引力加速度（O(M)，M=主天体数） */
export function primaryAccel(x: number, y: number, primaries: Body[], eps: number, out: Vec2): void {
  for (let i = 0; i < primaries.length; i++) {
    const b = primaries[i];
    if (!b.alive) continue;
    pointAccel(b.x - x, b.y - y, b.mu, eps, out);
  }
}

/**
 * 引力井（场投影器）的加速度。
 * a = G·M/(r²+ε_f²)^{3/2} · r̂ · w(r)，再受额定场强上限截断。
 *  w(r) = 1/(1+(r/R)^6) 是有限作用半径的平滑截断（内部≈完整牛顿场，外部迅速归零）
 *  ε_f = FIELD_SOFTEN 是近场焦斑软化半径，使 r→0 时场强有界（避免正反馈弹射）
 */
export function wellAccel(x: number, y: number, wx: number, wy: number, fieldMass: number, range: number, repel: boolean, eps: number, out: Vec2): void {
  const dx = wx - x, dy = wy - y;
  const r = Math.hypot(dx, dy);
  if (r > range * 2.2) return;
  const t = r / range;
  const cut = 1 / (1 + Math.pow(t, 6));
  if (cut < 1e-4) return;
  const soft = Math.max(FIELD_SOFTEN, eps);
  let mag = fieldMass * softenInvCube(dx, dy, soft) * cut;
  if (mag * r > FIELD_ACCEL_MAX) mag = FIELD_ACCEL_MAX / Math.max(r, 1e-6);
  if (repel) mag = -mag;
  out.x += mag * dx;
  out.y += mag * dy;
}

/** 辐射压：a = K_RAD·sail·A/(r²·m)，方向背离恒星 */
export function radiationAccel(x: number, y: number, star: Body, area: number, sail: number, mass: number, out: Vec2): void {
  if (sail <= 0 || mass <= 0) return;
  const dx = x - star.x, dy = y - star.y;
  const r2 = dx * dx + dy * dy;
  const r = Math.sqrt(r2);
  if (r < 1e-4) return;
  const mag = (K_RAD * sail * area) / (r2 * mass);
  out.x += (mag * dx) / r;
  out.y += (mag * dy) / r;
}

/** 星云阻力（二次阻力）：a = −½·ρ·Cd·A/m·|v_rel|·v_rel，介质以 ω 共转 */
export function dragAccel(
  x: number, y: number, vx: number, vy: number,
  rho: number, cd: number, area: number, mass: number, omega: number, out: Vec2,
): void {
  if (rho <= 0 || mass <= 0) return;
  // 共转介质速度 v_med = ω × r（2D：ω·(-y, x)）
  const vmx = -omega * y, vmy = omega * x;
  const rx = vx - vmx, ry = vy - vmy;
  const sp = Math.hypot(rx, ry);
  if (sp < 1e-9) return;
  const k = (0.5 * rho * cd * area * sp) / mass;
  out.x -= k * rx;
  out.y -= k * ry;
}

/** 开普勒方程 M = E − e·sinE 的牛顿迭代解 */
export function solveKepler(M: number, e: number): number {
  let m = M % (2 * Math.PI);
  if (m < 0) m += 2 * Math.PI;
  let E = e < 0.8 ? m : Math.PI;
  for (let i = 0; i < 12; i++) {
    const f = E - e * Math.sin(E) - m;
    const fp = 1 - e * Math.cos(E);
    const d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

export interface StateVec { x: number; y: number; vx: number; vy: number; }

/**
 * 由开普勒六要素（以原点天体为焦点）求状态矢量。
 *   E 由开普勒方程 M = E − e·sinE 解出
 *   r = a(1−e·cosE)
 *   真近点角 ν = 2·atan2(√(1+e)·sin(E/2), √(1−e)·cos(E/2))     ← 注意是 E/2
 *   近焦点系速度 v = √(μ/a)·(−sinE, √(1−e²)·cosE)/(1−e·cosE)
 * ⚠️ 若把 ν 写成 2·atan2(√(1+e)·sinE, √(1−e)·cosE)（用 E 而不是 E/2），
 *    位置角会变成 2E 而速度仍切于 E，二者不自洽 → 每个天体都被初始化成
 *    大偏心率轨道（实测空间站 r 在 1.26~2.89 之间乱摆），这是必须避免的经典错误。
 */
export function elementsToState(a: number, e: number, omega: number, M0: number, mu: number): StateVec {
  // 约定：a < 0 表示**逆行轨道**（角动量与参考方向相反）。位置与运动方向无关，
  // 因此用 |a| 解算位置/速率，再把速度矢量取反。levelgen 用这个约定生成"逆行对穿"的小行星，
  // 若不处理会让 sqrt(mu/a) 得到 NaN（实测导致第 2/3 章开场整场崩溃）。
  const retro = a < 0;
  const A = Math.abs(a);
  const E = solveKepler(M0, e);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const denom = 1 - e * cosE;
  const r = A * denom;
  const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
  const sq = Math.sqrt(mu / A);
  const vxp = (-sq * sinE) / denom;
  const vyp = (sq * Math.sqrt(Math.max(0, 1 - e * e)) * cosE) / denom;
  const cw = Math.cos(omega), sw = Math.sin(omega);
  const s = retro ? -1 : 1;
  return {
    x: xp * cw - yp * sw,
    y: xp * sw + yp * cw,
    vx: s * (vxp * cw - vyp * sw),
    vy: s * (vxp * sw + vyp * cw),
  };
}

/** 由状态矢量反解轨道要素（HUD 显示用） */
export function stateToElements(x: number, y: number, vx: number, vy: number, mu: number): { a: number; e: number; omega: number; nu: number; period: number; r: number } {
  const r = Math.hypot(x, y);
  const v2 = vx * vx + vy * vy;
  const a = 1 / (2 / Math.max(r, 1e-6) - v2 / mu);
  const h = x * vy - y * vx; // 比角动量（z 分量）
  const e = Math.sqrt(Math.max(0, 1 - (h * h) / (mu * Math.max(Math.abs(a), 1e-6))));
  const nu = Math.atan2(y, x);
  const period = a > 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;
  return { a, e, omega: 0, nu, period, r };
}

/** 天体迎风面积 */
export function areaOf(radius: number): number { return AREA_K * radius * radius; }

/** 岩质天体密度 */
export function densityOf(b: Body): number {
  return b.mass / ((4 / 3) * Math.PI * Math.pow(Math.max(b.radius, 1e-6), 3));
}

export interface Conserved { ke: number; pe: number; energy: number; angular: number; px: number; py: number; }

/**
 * 守恒量审计：E = Σ½mv² − ΣΣ G·mᵢmⱼ/√(r²+ε²)，L = Σ m(x·vy − y·vx)，p = Σ m·v
 * 主天体之间按完整 N 体计，轻体只与主天体计势能（与仿真一致，保证可比）。
 */
export function conservedQuantities(primaries: Body[], light: Body[], eps: number): Conserved {
  let ke = 0, pe = 0, angular = 0, px = 0, py = 0;
  for (let i = 0; i < primaries.length; i++) {
    const b = primaries[i];
    if (!b.alive) continue;
    ke += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
    angular += b.mass * (b.x * b.vy - b.y * b.vx);
    px += b.mass * b.vx; py += b.mass * b.vy;
    for (let j = i + 1; j < primaries.length; j++) {
      const c = primaries[j];
      if (!c.alive) continue;
      pe -= (G * b.mass * c.mass) / Math.sqrt((b.x - c.x) ** 2 + (b.y - c.y) ** 2 + eps * eps);
    }
  }
  for (let i = 0; i < light.length; i++) {
    const b = light[i];
    if (!b.alive) continue;
    ke += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
    angular += b.mass * (b.x * b.vy - b.y * b.vx);
    px += b.mass * b.vx; py += b.mass * b.vy;
    for (let j = 0; j < primaries.length; j++) {
      const c = primaries[j];
      if (!c.alive) continue;
      pe -= (G * b.mass * c.mass) / Math.sqrt((b.x - c.x) ** 2 + (b.y - c.y) ** 2 + eps * eps);
    }
  }
  return { ke, pe, energy: ke + pe, angular, px, py };
}

/** 把世界坐标的标量场（等势）批量求值，渲染层做 marching squares 用 */
export function potentialAt(x: number, y: number, primaries: Body[], wellMass: number, wx: number, wy: number, range: number, eps: number): number {
  let phi = 0;
  for (let i = 0; i < primaries.length; i++) {
    const b = primaries[i];
    if (!b.alive) continue;
    phi -= b.mu / Math.sqrt((b.x - x) ** 2 + (b.y - y) ** 2 + eps * eps);
  }
  if (wellMass > 0) {
    const r = Math.hypot(wx - x, wy - y);
    const cut = 1 / (1 + Math.pow(r / range, 6));
    phi -= (G * wellMass * cut) / Math.sqrt(r * r + eps * eps);
  }
  return phi;
}
