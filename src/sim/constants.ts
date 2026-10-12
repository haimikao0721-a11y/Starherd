/**
 * 归一化天文单位制下的物理常数（冻结）
 * G=1, mu_star=1, 距离 1 RU（渲染 128px），时间 1 TU（实时 1.6s）
 * 所有数值都是在"真实公式 + 归一化单位"下推出来的，注释里给出推导。
 */

export const G = 1.0;
/** Plummer 软化半径，避免 r→0 时加速度发散（真实 N 体模拟标准做法） */
export const EPS = 0.02;
/** 1 TU = 1.6 秒实时 */
export const TIME_SCALE = 1.6;
/** 物理固定步长（Hz，实时） */
export const PHYS_HZ = 120;
/** 单个物理步的时间（TU）：(1/120 s) / 1.6 s·TU⁻¹ */
export const DT = 1 / (PHYS_HZ * TIME_SCALE);
/** 单帧最多补算的物理步数（防死亡螺旋） */
export const MAX_SUBSTEPS = 6;
/** 自适应子步的最大递归深度 */
export const MAX_ADAPT_DEPTH = 3;

/* ---------------------------------------------------------------- 牧星者号（引力井） */

/** 飞船真实质量（RU³ 质量单位）；引力井的"场质量"是投影出来的，不由飞船质量决定 */
export const SHIP_MASS = 0.00006;
/** 主推进器最大加速度（RU/TU²）。用作悬停参照：恒星在 r=1 处引力 1.0，r=0.4 处 6.25 */
export const A_MAX = 3.0;
/** 推进剂耗尽后的姿控加速度（真实的"RCS 只能微调"） */
export const RCS_FACTOR = 0.14;
/** 弹簧-阻尼跟踪的固有角频率：周期 0.5 TU ≈ 0.8 s（手感：跟手但有重量） */
export const OMEGA = (2 * Math.PI) / 0.5;
/** 阻尼比；Shift 精确模式提升到 1.0（临界阻尼，不甩尾） */
export const ZETA = 0.85;
export const ZETA_PRECISE = 1.0;
export const K_SPRING = SHIP_MASS * OMEGA * OMEGA;
export const C_DAMP = 2 * ZETA * Math.sqrt(K_SPRING * SHIP_MASS);
export const C_DAMP_PRECISE = 2 * ZETA_PRECISE * Math.sqrt(K_SPRING * SHIP_MASS);
/** 排气速度（RU/TU）——只用于把已消耗 Δv 换算成真实推进剂质量分数 e^{-Δv/ve} */
export const VE = 0.95;
/** 飞船半径 */
export const SHIP_RADIUS = 0.028;
/** 飞船迎风系数（星云阻力用；飞船造型流线，故小于岩石） */
export const SHIP_CD = 0.4;

/** 引力井场质量的可调范围（场投影器的额定功率区间）
 *  上限由"制导可控性"标定：货舱在 r≈0.3 处可获得的场加速度 0.16/0.09≈1.8 RU/TU²，
 *  足以在 0.1 RU 内把 0.5 RU/TU 的接近速度刹住（a=v²/2d=1.25），否则玩家与自动驾驶都刹不住车。 */
export const WELL_MASS_MIN = 0.004;
export const WELL_MASS_MAX = 0.16;
export const WELL_PRESETS = [0.008, 0.03, 0.09] as const;
/** 场域有效半径（RU）：超出后 1/(1+(r/R)^6) 迅速衰减 → 质量选择性耦合，不扰动主天体 */
export const WELL_RANGE = 1.4;
/**
 * 场投影器的硬件限制（这两条是"可操控性"的物理根源，不是魔法缓冲）：
 *  - FIELD_ACCEL_MAX：额定场强上限（RU/TU²）。参考量级：恒星在 r=1 处引力 1.0。
 *    没有它，1/r² 会在井贴近目标时产生数倍于恒星引力的暴力拉扯，形成正反馈弹射，
 *    玩家与自动驾驶都无法完成对接（实测货舱会被甩到 27 RU 外）。
 *  - FIELD_SOFTEN：近场焦斑半径（RU），把场核软化掉，使场强在 r→0 有界。
 */
export const FIELD_ACCEL_MAX = 1.1;
export const FIELD_SOFTEN = 0.12;

/**
 * 恒星光球层保护区（RU，叠加在恒星半径之上）。
 *
 * 为什么必须有它：牧星者号（引力井载具）的推力上限只有 `A_MAX = 3.0 RU/TU²`，
 * 而恒星表面附近的引力是 `μ/r²`——以 μ=1、r=0.1 计约 94 RU/TU²，**相差 30 倍**。
 * 一旦把井拖进这个区域，飞船物理上永远拉不回来，玩家会陷入"怎么点都没反应、只能重开"
 * 的死局（实测反馈）。所以控制层禁止把井的目标点设进保护区（从构造上消灭死局），
 * 仿真层再给一道紧急离场保底（见 step.ts 的安全阀）。
 */
export const STAR_KEEPOUT = 0.22;
/**
 * 光球层护盾带（RU，叠加在恒星半径之上）——保证"任何时候都能把井拖回来"。
 *
 * 硬边界还不够：r 处恒星引力 a(r)=r/(r²+ε²)^{3/2}，而推力上限 A_MAX=3.0，
 * 两者的交叉点在 r≈0.57 RU——也就是说在 0.57 RU 以内，飞船**根本没有足够推力离开**，
 * 井会永久贴在边界上（实测：塞进恒星后被挡在 0.32 RU，但鼠标怎么拖都出不来）。
 * 所以在这条带内按距离平滑抵消恒星引力（"辐射压支撑/护盾"），让 3.0 的推力重新拥有控制权；
 * 外缘平滑过渡到 0，不产生力的突变。
 */
export const STAR_SHIELD = 0.62;
/** 安全阀：进入护盾带后额外施加的紧急离场加速度上限（RU/TU²） */
export const ESCAPE_PUSH_MAX = 420;

/* ---------------------------------------------------------------- 环境与判定 */

/**
 * 辐射压系数。a_rad = K_RAD·sail·A/(r²·m)
 * 标定：标准货舱 (A=4.52e-4, m=2e-5, sail=0.7) 在 r=1 处获得 0.02 RU/TU²，
 * 即恒星引力的 2%（真实光帆量级已被艺术化放大 1 个数量级，文档可见）。
 */
export const K_RAD = 1.264e-3;
/** 迎风面积系数：A = π·radius² */
export const AREA_K = Math.PI;
/** 星风加速度 a = strength·env(t)/max(r,0.25)，方向径向向外 */
export const WIND_MIN_R = 0.25;
/** 碰撞损毁的临界相对速度（RU/TU） */
export const V_CRIT = 0.22;
/** 弹性碰撞恢复系数（岩质天体间） */
export const RESTITUTION = 0.55;
/** 对接后货舱挂在站上的偏移半径 */
export const DOCK_OFFSET = 0.045;

/* ---------------------------------------------------------------- 资源 */

/** 慢动作时间倍率 */
export const SLOWMO_SCALE = 0.25;
/** 算力：满槽 1.0；场强越大越费算力，慢动作另计 */
export const COMPUTE_MAX = 1.0;
export const COMPUTE_REGEN = 0.22;      // 每秒（实时）
export const COMPUTE_DRAIN_FIELD = 0.30; // 满场强时每秒
export const COMPUTE_DRAIN_SLOWMO = 0.55; // 慢动作每秒
/** 算力耗尽后需恢复到该值才能重新启用场/慢动作（迟滞） */
export const COMPUTE_HYSTERESIS = 0.3;
/** 货舱燃料耗尽后的"无动力"判定阈值 */
export const FUEL_EMPTY_EPS = 0.5;

/* ---------------------------------------------------------------- 渲染辅助 */

export const TRAIL_LEN = 180;
/** 拖尾采样间隔（TU） */
export const TRAIL_DT = 0.06;
/** 潮汐应力的可视化阈值 */
export const STRESS_WARN = 1.4;
export const STRESS_TEAR = 2.6;
/** 潮汐应力归一化参考：标准货舱恰好在洛希极限处应力≈STRESS_TEAR */
export const TIDAL_REF = 0.053;
/** 处于撕裂区多久才会解体（TU）：给玩家反应时间，也让"⚠ 已进入撕裂区"警告有意义 */
export const TEAR_GRACE = 0.45;

/* ---------------------------------------------------------------- 公式（供 HUD 与预测复用） */

/** 圆轨道速度 v = √(μ/r) */
export function circularVelocity(mu: number, r: number): number { return Math.sqrt(mu / Math.max(r, 1e-6)); }
/** 逃逸速度 v = √(2μ/r) */
export function escapeVelocity(mu: number, r: number): number { return Math.sqrt((2 * mu) / Math.max(r, 1e-6)); }
/** 开普勒第三定律 T = 2π√(a³/μ) */
export function keplerPeriod(mu: number, a: number): number { return 2 * Math.PI * Math.sqrt((a * a * a) / Math.max(mu, 1e-9)); }
/** 活力公式 v² = μ(2/r − 1/a) */
export function visViva(mu: number, r: number, a: number): number { return Math.sqrt(Math.max(0, mu * (2 / Math.max(r, 1e-6) - 1 / Math.max(a, 1e-6)))); }
/** 洛希极限 d ≈ R_p·(2ρ_p/ρ_s)^{1/3} */
export function rocheLimit(rPrimary: number, rhoPrimary: number, rhoSecondary: number): number {
  return rPrimary * Math.cbrt((2 * rhoPrimary) / Math.max(rhoSecondary, 1e-9));
}
/**
 * 潮汐撕裂半径（自引力判据，与经典洛希极限等价，但可以直接用质量/半径算，
 * 也是对黑洞等致密天体唯一有意义的写法）：
 *   自引力 g_self = G·m/dr²，跨天体潮汐差 2μ·dr/r³，令二者相等 →
 *   r_tear = (2·μ·dr / g_self)^(1/3)
 * ⚠️ 不要用"潮汐加速度 = 中心天体引力"作判据：那会把撕裂半径算小约 2.5 倍，
 *    从而把空间站放进不该进的区域，关卡会变成物理上不可能完成。
 * 标定：标准货舱 (m=2e-5, dr=0.012) 在 μ=1、R★=0.1 的恒星旁，r_tear = 0.557 RU。
 */
export function tidalTearRadius(mu: number, bodyMass: number, bodyRadius: number): number {
  const gSelf = (G * bodyMass) / (bodyRadius * bodyRadius);
  return Math.cbrt((2 * mu * bodyRadius) / Math.max(gSelf, 1e-12));
}
/** 球体密度 */
export function sphereDensity(mass: number, radius: number): number {
  return mass / ((4 / 3) * Math.PI * Math.pow(Math.max(radius, 1e-6), 3));
}
/** 潮汐梯度 Δa = 2·G·M·Δr/r³ */
export function tidalGradient(mu: number, r: number, dr: number): number {
  return (2 * mu * dr) / Math.pow(Math.max(r, 1e-6), 3);
}
/** 山丘球半径 r_H ≈ a·(m/(3M))^{1/3} */
export function hillSphere(a: number, m: number, M: number): number { return a * Math.cbrt(m / (3 * M)); }
/** 拉格朗日点（副星位于 +x 轴，距主星 R） */
export function lagrangePoints(m1: number, m2: number, R: number): { L1: number; L2: number; L3: number; L4: [number, number]; L5: [number, number] } {
  const q = Math.cbrt(m2 / (3 * m1));
  const L1 = R * (1 - q);
  const L2 = R * (1 + q);
  const L3 = -R * (1 + (5 * m2) / (12 * m1));
  const h = (R * Math.sqrt(3)) / 2;
  const cx = R * (m1 / (m1 + m2));
  return { L1, L2, L3, L4: [cx, -h], L5: [cx, h] };
}
/** 引力时间膨胀因子 Δt_∞ = Δt/√(1 − rs/r) */
export function timeDilation(r: number, rs: number): number {
  const x = rs / Math.max(r, rs * 1.0001);
  return 1 / Math.sqrt(Math.max(1e-6, 1 - x));
}
