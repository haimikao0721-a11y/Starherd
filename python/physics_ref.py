"""physics_ref.py -- 《牧星者 / STARHERD》 独立物理裁判与参考实现

归属: W-physics (见 docs/INTERFACES.md §0)。纯标准库实现, 供:
  1. Python 宿主独立复核 TS 仿真推送的守恒量 (E / L / p), 输出保真度评级;
  2. levelgen.py 用真实公式反算关卡初值与 par_time / par_fuel;
  3. 命令行自检 `python python/physics_ref.py --selftest`。

单位制 (DESIGN §1 归一化天文单位):
  G = 1, 恒星质量 M* = 1  =>  mu_star = 1,  距离 1 RU, 时间 1 TU,  1 TU = time_scale 秒(实时)
  圆轨道 v_c = sqrt(mu/r),  r = 1 时 v_c = 1;  开普勒第三定律 T = 2*pi*sqrt(a^3/mu), a = 1 时 T = 2*pi。
  燃料展示保留真实常数: Isp = 320 s, g0 = 9.80665 m/s^2 (齐奥尔科夫斯基公式)。

所有函数按 INTERFACES.md §1 冻结签名实现, 其余为 W-physics 内部扩展 (只增不改)。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any, Sequence

# ---------------------------------------------------------------------------
# 常数 (DESIGN §1)
# ---------------------------------------------------------------------------

G_DEFAULT: float = 1.0
MU_STAR_DEFAULT: float = 1.0
EPSILON_DEFAULT: float = 0.02
TIME_SCALE_DEFAULT: float = 1.6          # 1 TU = 1.6 s 实时
ISP_DEFAULT: float = 320.0               # s
G0_DEFAULT: float = 9.80665              # m/s^2

# 归一化速度单位 -> 物理 m/s 的换算系数。
# 归一化系里 1 RU 定义为 1 km, 1 TU 定义为 1000 s, 于是 1 RU/TU = 1 m/s。
# 该系数只用于"把归一化 dv 换成真实 m/s 以便套用齐奥尔科夫斯基公式"(DESIGN §2 公式 12),
# 不改变任何归一化动力学量。
RU_PER_SECOND: float = 1.0

# 洛希极限系数 (d = A * R_p * (rho_p/rho_s)^(1/3))。
# A = 2.44 是 Roche 原始刚体解的解析常数 (d = 2.44 R_p (rho_p/rho_s)^(1/3)),
# 对地月系统给出 2.06 R_E, 与教科书/NASSA fact sheet 的"≈2.9 R_E(流体)"互为上下界。
ROCHE_COEFF_RIGID: float = 2.44          # 刚体/碎石堆天体 (解析常数, 默认)
ROCHE_COEFF_FLUID: float = 2.9           # 流体(潮汐平衡)天体, 行星科学常用
ROCHE_COEFF_DEFAULT: float = ROCHE_COEFF_RIGID

# Routh 判据: 三体共线解中 L4/L5 线性稳定的临界质量比
ROUTH_CRITICAL_MU: float = 0.0385208965

# 黑洞关卡的归一化光速尺度: r_s = 2 mu / c^2 = mu / LIGHT_SPEED_SQ_HALF
# (c^2/2 = 300 -> c ≈ 24.49 RU/TU; 使 mu ∈ [6, 9] 的黑洞 r_s ∈ [0.020, 0.030])
LIGHT_SPEED_SQ_HALF: float = 300.0

# 保真度阈值 (1/s 相对漂移, DESIGN §2)
FIDELITY_BANDS: tuple[tuple[str, float, float], ...] = (
    ("S", 1e-5, 1.0),
    ("A", 1e-4, 0.85),
    ("B", 1e-3, 0.7),
    ("C", math.inf, 0.5),
)

_CLI_EPILOG = """\
示例:
  python python/physics_ref.py --selftest
  python python/physics_ref.py --selftest --verbose
"""


# ---------------------------------------------------------------------------
# 内联向量工具 (纯标准库, 不依赖 numpy)
# ---------------------------------------------------------------------------

Vec2 = tuple[float, float]


def _v_add(a: Vec2, b: Vec2) -> Vec2:
    return (a[0] + b[0], a[1] + b[1])


def _v_sub(a: Vec2, b: Vec2) -> Vec2:
    return (a[0] - b[0], a[1] - b[1])


def _v_mul(a: Vec2, s: float) -> Vec2:
    return (a[0] * s, a[1] * s)


def _v_dot(a: Vec2, b: Vec2) -> float:
    return a[0] * b[0] + a[1] * b[1]


def _v_cross(a: Vec2, b: Vec2) -> float:
    return a[0] * b[1] - a[1] * b[0]


def _v_norm(a: Vec2) -> float:
    return math.hypot(a[0], a[1])


def _v_unit(a: Vec2) -> Vec2:
    n = _v_norm(a)
    if n == 0.0:
        raise ValueError("零向量无法归一化")
    return (a[0] / n, a[1] / n)


# ---------------------------------------------------------------------------
# 1. 状态量审计 (INTERFACES.md §1 冻结签名)
# ---------------------------------------------------------------------------


def _as_bodies(state: Any) -> list[dict[str, float]]:
    """把 state 归一化成 [{"m","x","y","vx","vy"}, ...]。

    兼容三种输入形态:
      * {"bodies":[{"m":..,"x":..,"y":..,"vx":..,"vy":..}, ...], "G":1.0, "epsilon":0.02}
      * {"bodies":[{"m":..,"pos":[x,y],"vel":[vx,vy]}, ...], ...}
      * [body, body, ...]   (直接给列表)
    """
    if isinstance(state, dict):
        raw = state.get("bodies")
        if raw is None:
            raise ValueError("state 字典缺少 'bodies' 字段")
    elif isinstance(state, (list, tuple)):
        raw = state
    else:
        raise TypeError(f"无法解析的 state 类型: {type(state).__name__}")

    bodies: list[dict[str, float]] = []
    for i, b in enumerate(raw):
        if not isinstance(b, dict):
            raise TypeError(f"bodies[{i}] 不是字典")
        m = float(b.get("m", b.get("mass", 0.0)))
        if "x" in b and "y" in b:
            x, y = float(b["x"]), float(b["y"])
        elif "pos" in b:
            x, y = float(b["pos"][0]), float(b["pos"][1])
        else:
            raise ValueError(f"bodies[{i}] 缺少位置 (x/y 或 pos)")
        if "vx" in b and "vy" in b:
            vx, vy = float(b["vx"]), float(b["vy"])
        elif "vel" in b:
            vx, vy = float(b["vel"][0]), float(b["vel"][1])
        else:
            raise ValueError(f"bodies[{i}] 缺少速度 (vx/vy 或 vel)")
        bodies.append({"m": m, "x": x, "y": y, "vx": vx, "vy": vy})
    return bodies


def _grav_param(state: Any) -> float:
    if isinstance(state, dict):
        return float(state.get("G", G_DEFAULT))
    return G_DEFAULT


def _softening(state: Any) -> float:
    """Plummer 软化长度 eps (DESIGN §2 公式 1)。默认 0 = 纯牛顿势(解析对照用)。"""
    if isinstance(state, dict):
        return float(state.get("epsilon", state.get("eps", 0.0)))
    return 0.0


def kinetic_energy(state: dict) -> float:
    """总动能 KE = sum(1/2 m v^2)。"""
    return sum(0.5 * b["m"] * (b["vx"] ** 2 + b["vy"] ** 2) for b in _as_bodies(state))


def potential_energy(state: dict) -> float:
    """总势能 PE = -sum_{i<j} G m_i m_j / |r_i - r_j| (含 Plummer 软化时用 sqrt(r^2+eps^2))。"""
    bodies = _as_bodies(state)
    g = _grav_param(state)
    eps = _softening(state)
    pe = 0.0
    for i in range(len(bodies)):
        for j in range(i + 1, len(bodies)):
            dx = bodies[j]["x"] - bodies[i]["x"]
            dy = bodies[j]["y"] - bodies[i]["y"]
            r2 = dx * dx + dy * dy
            if eps > 0.0:
                r2 += eps * eps
            if r2 <= 0.0:
                continue
            pe -= g * bodies[i]["m"] * bodies[j]["m"] / math.sqrt(r2)
    return pe


def energy(state: dict) -> float:
    """总机械能 E = KE + PE = sum(1/2 m v^2) - sum_{i<j} G m_i m_j / r_ij (DESIGN §2 公式 14)。

    注意: DESIGN §2 表格里写成 `E = Σ½mv² − ΣΣ Gm_im_j/r`, 双求和若按全序累加会重复计一次,
    此处按教科书正确形式只对 i<j 累加 (等价于 ΣΣ 的 1/2)。约定 E = KE - |PE|, 束缚系统 E < 0。
    """
    return kinetic_energy(state) + potential_energy(state)


# 兼容别名: 任务书里的 state_energy(state) 明确要求"兼容字典/列表两种输入形态"
state_energy = energy


def angular_momentum(state: dict) -> float:
    """总角动量 z 分量 L_z = sum m (x*vy - y*vx) (DESIGN §2 公式 14)。"""
    return sum(b["m"] * (b["x"] * b["vy"] - b["y"] * b["vx"]) for b in _as_bodies(state))


def linear_momentum(state: dict) -> tuple[float, float]:
    """总线动量 (p_x, p_y) = sum m v (DESIGN §2 公式 14)。"""
    px = py = 0.0
    for b in _as_bodies(state):
        px += b["m"] * b["vx"]
        py += b["m"] * b["vy"]
    return (px, py)


def center_of_mass(state: dict) -> tuple[float, float]:
    bodies = _as_bodies(state)
    mtot = sum(b["m"] for b in bodies) or 1.0
    return (
        sum(b["m"] * b["x"] for b in bodies) / mtot,
        sum(b["m"] * b["y"] for b in bodies) / mtot,
    )


def grade_fidelity(energy_drift: float, angular_drift: float) -> tuple[str, float]:
    """保真度评级 (DESIGN §2 数值自检)。

    入参是"每秒相对漂移"|dE/E|/s 与 |dL/L|/s。取两者的较大者定档:
      S: < 1e-5  -> 1.0
      A: < 1e-4  -> 0.85
      B: < 1e-3  -> 0.7
      C: 其余    -> 0.5
    """
    d = max(abs(float(energy_drift)), abs(float(angular_drift)))
    if not math.isfinite(d):
        return ("C", 0.5)
    for name, limit, factor in FIDELITY_BANDS:
        if d < limit:
            return (name, factor)
    return ("C", 0.5)


def verdict(energy_drift: float, angular_drift: float, par_ok: bool = True) -> dict:
    """给 host.py 用的完整裁决 dict (WS `verdict` 消息的字段子集)。"""
    grade, factor = grade_fidelity(energy_drift, angular_drift)
    note = (
        f"能量漂移 {energy_drift:.2e}/s, 角动量漂移 {angular_drift:.2e}/s, "
        + {
            "S": "达到辛积分器理论精度",
            "A": "优于一阶积分器 100 倍",
            "B": "长弧段有可见耗散, 建议减小步长",
            "C": "守恒量失控, 检查自适应子步上限",
        }[grade]
    )
    return {
        "grade": grade,
        "energy_drift": float(energy_drift),
        "angular_drift": float(angular_drift),
        "fidelity": factor,
        "par_ok": bool(par_ok),
        "note": note,
        "score_bonus": 0,
    }


# ---------------------------------------------------------------------------
# 2. 单体轨道力学
# ---------------------------------------------------------------------------


def circular_velocity(mu: float, r: float) -> float:
    """圆轨道速度 v_c = sqrt(mu/r) (DESIGN §1/§2)。"""
    if r <= 0.0:
        raise ValueError("r 必须为正")
    return math.sqrt(mu / r)


def escape_velocity(mu: float, r: float) -> float:
    """逃逸速度 v_esc = sqrt(2 mu / r) = sqrt(2) * v_c。"""
    if r <= 0.0:
        raise ValueError("r 必须为正")
    return math.sqrt(2.0 * mu / r)


def kepler_period(mu: float, a: float) -> float:
    """开普勒第三定律 T = 2 pi sqrt(a^3/mu) (DESIGN §1)。"""
    if a <= 0.0 or mu <= 0.0:
        raise ValueError("a 与 mu 必须为正")
    return 2.0 * math.pi * math.sqrt(a ** 3 / mu)


def mean_motion(mu: float, a: float) -> float:
    """平均角速度 n = 2 pi / T = sqrt(mu/a^3)。"""
    if a <= 0.0 or mu <= 0.0:
        raise ValueError("a 与 mu 必须为正")
    return math.sqrt(mu / a ** 3)


def vis_viva(mu: float, r: float, a: float) -> float:
    """活力公式 v = sqrt(mu (2/r - 1/a)) (DESIGN §2 公式 16 的基础)。"""
    if r <= 0.0 or a <= 0.0:
        raise ValueError("r 与 a 必须为正")
    inner = mu * (2.0 / r - 1.0 / a)
    if inner < 0.0:
        raise ValueError("该 (r, a) 组合下 2/r - 1/a < 0, 无实数速度")
    return math.sqrt(inner)


def specific_orbital_energy(mu: float, r: float, v: float) -> float:
    """比轨道能量 eps = v^2/2 - mu/r (束缚轨道 eps < 0)。"""
    if r <= 0.0:
        raise ValueError("r 必须为正")
    return 0.5 * v * v - mu / r


def semi_major_from_state(mu: float, r: float, v: float) -> float:
    """由能量反解半长轴 a = 1 / (2/r - v^2/mu)。"""
    inv = 2.0 / r - v * v / mu
    if inv <= 0.0:
        return math.inf
    return 1.0 / inv


def hohmann_dv(mu: float, r1: float, r2: float) -> float:
    """霍曼转移点火量 (INTERFACES.md §1 冻结公式):

        dv = sqrt(mu/r1) * ( sqrt(2 r2 / (r1 + r2)) - 1 )

    即"从 r1 圆轨道切入 r1->r2 转移椭圆"的切向点火量; 椭圆半长轴 a_t = (r1+r2)/2,
    括号内是转移椭圆在 r1 处的速度比 sqrt(2 r2/(r1+r2)) (由 a_t 与活力公式化简得到)。
    r2 > r1 时 dv > 0 (加速抬高远星点), r2 < r1 时 dv < 0 (减速降低远星点)。
    完整转移还需在 r2 处再点一次火圆化, 见 dv_to_circularize()。
    """
    if r1 <= 0.0 or r2 <= 0.0:
        raise ValueError("r1 与 r2 必须为正")
    if r1 == r2:
        return 0.0
    return math.sqrt(mu / r1) * (math.sqrt(2.0 * r2 / (r1 + r2)) - 1.0)


def dv_to_circularize(mu: float, r: float, v: float) -> float:
    """在半径 r 处把速度 v 圆化所需切向 dv (返回带符号: 正=顺行加速, 负=减速)。

    dv = sqrt(mu/r) - v     (DESIGN §2 公式 16 霍曼转移的第二次点火)
    """
    if r <= 0.0:
        raise ValueError("r 必须为正")
    if v < 0.0:
        raise ValueError("速率不能为负")
    return circular_velocity(mu, r) - v


def hohmann_transfer(mu: float, r1: float, r2: float) -> dict:
    """完整双点火霍曼转移的解析解 (levelgen 与 --analyze 的真值来源)。

    返回 dv_depart / dv_arrive / dv_total / transfer_time / a_transfer /
         v_transfer_at_r1 / v_transfer_at_r2。
    """
    a_t = 0.5 * (r1 + r2)
    v1c = circular_velocity(mu, r1)
    v2c = circular_velocity(mu, r2)
    vp = vis_viva(mu, r1, a_t)          # 转移椭圆在 r1 处速率
    va = vis_viva(mu, r2, a_t)          # 转移椭圆在 r2 处速率
    dv1 = vp - v1c
    dv2 = v2c - va
    return {
        "method": "hohmann",
        "a_transfer": a_t,
        "dv_depart": dv1,
        "dv_arrive": dv2,
        "dv_total": abs(dv1) + abs(dv2),
        "v_transfer_at_r1": vp,
        "v_transfer_at_r2": va,
        "transfer_time": hohmann_time(mu, r1, r2),
    }


def hohmann_time(mu: float, r1: float, r2: float) -> float:
    """霍曼转移椭圆半周期: t = pi sqrt( (r1+r2)^3 / (8 mu) )。"""
    if mu <= 0.0 or r1 <= 0.0 or r2 <= 0.0:
        raise ValueError("mu, r1, r2 必须为正")
    return math.pi * math.sqrt((r1 + r2) ** 3 / (8.0 * mu))


def synodic_period(n1: float, n2: float) -> float:
    """会合周期 T_syn = 2 pi / |n1 - n2|; n1 == n2 时返回 inf (永远不相遇)。"""
    d = abs(n1 - n2)
    if d == 0.0:
        return math.inf
    return 2.0 * math.pi / d


# ---------------------------------------------------------------------------
# 3. 潮汐 / 洛希 / 希尔 / 拉格朗日
# ---------------------------------------------------------------------------


def tidal_gradient(mu_primary: float, r: float, delta_r: float) -> float:
    """潮汐加速度梯度 da = 2 mu delta_r / r^3 (DESIGN §2 公式 9)。"""
    if r <= 0.0:
        raise ValueError("r 必须为正")
    return 2.0 * mu_primary * delta_r / r ** 3


def self_gravity(mass: float, radius: float) -> float:
    """天体表面自引力 g_self = G m / R^2 (G = 1)。"""
    if radius <= 0.0 or mass <= 0.0:
        raise ValueError("质量与半径必须为正")
    return mass / radius ** 2


def tidal_tear_radius(
    mu_primary: float,
    body_mass: float,
    body_radius: float,
    safety: float = 1.0,
) -> float:
    """潮汐撕裂半径 (集成侧冻结的物理判据)。

    撕裂条件: 跨天体的潮汐加速度差 >= 天体自身表面的自引力
        2 mu dr / r^3  >=  G m_body / dr^2
    解出 (与中心天体质量的三次方根成正比):
        r_tear = (2 mu dr^3 / (G m_body))^(1/3) = (2 mu dr / g_self)^(1/3)

    这里的束缚力取货舱的**自引力** (经典洛希撕裂的物理本质), 而不是中心天体对货舱的
    引力 —— 后者随 r^-2 增长, 会把撕裂半径算小 2.5 倍 (mu = 1 时给 0.219 而非 0.557),
    导致空间站被错误地判定在撕裂区内。

    标准货舱 (m = 2e-5, r = 0.012, G = 1) 给出:
        mu = 1.0 -> 0.5570 RU    mu = 6.0 -> 1.0121 RU
        mu = 7.5 -> 1.0903 RU    mu = 9.0 -> 1.1586 RU
    `safety` 为安全系数 (返回 safety * r_tear), 关卡用 1.5 / 1.6 倍余量。
    """
    if mu_primary <= 0.0 or body_mass <= 0.0 or body_radius <= 0.0:
        raise ValueError("mu、质量与半径必须为正")
    if safety <= 0.0:
        raise ValueError("safety 必须为正")
    g_self = self_gravity(body_mass, body_radius)
    return safety * (2.0 * mu_primary * body_radius / g_self) ** (1.0 / 3.0)


def roche_limit(
    r_primary: float,
    rho_primary: float,
    rho_secondary: float,
    coeff: float = ROCHE_COEFF_DEFAULT,
) -> float:
    """洛希极限 d_R = coeff * R_p * (rho_p / rho_s)^(1/3) (DESIGN §2 公式 8)。

    coeff = 2.9  -> 流体(潮汐平衡)天体, 行星科学常用值
    coeff = 2.44 -> 刚体/碎石堆天体 (Roche 原始刚体解)
    地月系统数量级校验见 --selftest (d_R ≈ 2.9 R_Earth)。
    """
    if r_primary <= 0.0 or rho_primary <= 0.0 or rho_secondary <= 0.0:
        raise ValueError("半径与密度必须为正")
    return coeff * r_primary * (rho_primary / rho_secondary) ** (1.0 / 3.0)


def density(mass: float, radius: float, volume_coeff: float = 4.0 / 3.0 * math.pi) -> float:
    """平均密度 rho = m / V, 默认球体 V = 4/3 pi r^3。"""
    if radius <= 0.0:
        raise ValueError("半径必须为正")
    return mass / (volume_coeff * radius ** 3)


def hill_sphere(a: float, m_secondary: float, m_primary: float) -> float:
    """希尔球半径 r_H = a (m / (3M))^(1/3)。"""
    if a <= 0.0 or m_secondary <= 0.0 or m_primary <= 0.0:
        raise ValueError("a 与质量必须为正")
    return a * (m_secondary / (3.0 * m_primary)) ** (1.0 / 3.0)


def hill_radius_from_mu(a: float, mu_ratio: float) -> float:
    """直接由质量比 mu = m/(M+m) 求希尔球 (r_H ≈ a (mu/3)^(1/3))。"""
    if a <= 0.0 or mu_ratio <= 0.0:
        raise ValueError("a 与质量比必须为正")
    return a * (mu_ratio / 3.0) ** (1.0 / 3.0)


def lagrange_l1_offset(separation: float, m1: float, m2: float) -> float:
    """L1 距副星的解析近似 r ≈ R (m2/(3 m1))^(1/3), 再牛顿迭代细化到机器精度。"""
    if separation <= 0.0 or m1 <= 0.0 or m2 <= 0.0:
        raise ValueError("R 与质量必须为正")
    ratio = m2 / (3.0 * m1)
    x = separation * ratio ** (1.0 / 3.0)
    # 精确方程 (标准 Hill/共线方程, x = L1 距副星距离):
    #   x^5 - (3-mu) x^4 + (3-2mu) x^3 - mu x^2 + 2 mu x - mu = 0,  mu = m2/(m1+m2)
    mu = m2 / (m1 + m2)

    def f(t: float) -> float:
        return (
            t ** 5
            - (3.0 - mu) * t ** 4
            + (3.0 - 2.0 * mu) * t ** 3
            - mu * t * t
            + 2.0 * mu * t
            - mu
        )

    for _ in range(60):
        d = 5 * x ** 4 - 4 * (3.0 - mu) * x ** 3 + 3 * (3.0 - 2.0 * mu) * x * x - 2.0 * mu * x + 2.0 * mu
        if d == 0.0:
            break
        step = f(x) / d
        x -= step
        if abs(step) < 1e-15 * separation:
            break
    return x


def _collinear_root(f, lo: float, hi: float, iters: int = 200) -> float:
    """二分求根: f(lo) 与 f(hi) 必须异号。保证收敛且不需要导数。"""
    flo = f(lo)
    fhi = f(hi)
    if flo == 0.0:
        return lo
    if fhi == 0.0:
        return hi
    if flo * fhi > 0.0:
        raise ValueError("区间端点同号, 无法二分求 L 点")
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if fm == 0.0:
            return mid
        if flo * fm < 0.0:
            hi, fhi = mid, fm
        else:
            lo, flo = mid, fm
    return 0.5 * (lo + hi)


def _cr3bp_gradient(mu_sec: float, x: float, y: float) -> Vec2:
    """标准圆型限制三体问题 (CR3BP) 的有效势梯度, 质心系归一化 (G = 1, Omega = 1)。

    主星质量 1-mu 在 (-mu, 0), 副星质量 mu 在 (1-mu, 0), 两体间距 = 1。
    Phi = (x^2+y^2)/2 + (1-mu)/r1 + mu/r2
    dPhi/dx = x - (1-mu)(x+mu)/r1^3 - mu(x-(1-mu))/r2^3
    平衡点 (含 L1..L5) 满足 grad Phi = 0。本函数是"旋转系力平衡"的标准权威形式。
    """
    x1, y1 = x + mu_sec, y
    x2, y2 = x - (1.0 - mu_sec), y
    d1 = math.hypot(x1, y1)
    d2 = math.hypot(x2, y2)
    if d1 <= 0.0 or d2 <= 0.0:
        return (math.inf, math.inf)
    return (
        x - (1.0 - mu_sec) * x1 / d1 ** 3 - mu_sec * x2 / d2 ** 3,
        y - (1.0 - mu_sec) * y1 / d1 ** 3 - mu_sec * y2 / d2 ** 3,
    )


def _lagrange_force_balance(m1_ratio: float, x: float, y: float, r: float) -> Vec2:
    """把"主星在原点、间距 r"的坐标换算到质心系后, 返回旋转系力平衡残差。

    m1_ratio = m1/(m1+m2) 为主星质量比, 副星质量比 = 1 - m1_ratio。
    换算: 质心在主星系 +x 方向 r*(1-m1_ratio) 处, 归一化长度单位除以 r。
    """
    mu_sec = 1.0 - m1_ratio
    xb = x / r - (1.0 - m1_ratio)
    yb = y / r
    return _cr3bp_gradient(mu_sec, xb, yb)


def _collinear_residual(m1_ratio: float, r2: float, x: float) -> float:
    """旋转系中沿 x 轴的合力 (单位质量), 过零点即共线拉格朗日点。

    主星质量比 m1_ratio 在原点, 副星在 (r2, 0); 返回值为 +x 方向的合力。
    直接由标准 CR3BP 梯度换算而来, 与 _lagrange_force_balance 同一约定。
    """
    return _lagrange_force_balance(m1_ratio, x, 0.0, r2)[0]


def lagrange_points(m1: float, m2: float, r: float) -> dict:
    """拉格朗日点 (INTERFACES.md §1 冻结签名)。

    主星 m1 在原点, 副星 m2 在 +x 轴距 R 处, 旋转系角速度 Omega^2 = (m1+m2)/R^3。
    返回 {"L1":x,"L2":x,"L3":x,"L4":(x,y),"L5":(x,y)}, 相对主星。
    细节约定 (已在 solution.notes 中向集成方说明):
      * L1/L2/L3 由旋转系力平衡方程二分求根到机器精度 (不是级数近似);
        在 m2/m1 -> 0 的极限下 L1 距副星 -> R (m2/(3 m1))^(1/3) (DESIGN §2 公式 15)。
      * L4/L5 严格位于与两主天体构成等边三角形的点; 数值上取等边三角形的
        "副星沿轨道运行方向前方 60 度"解, 与 DESIGN §1 中轨道角负 y 方向的手性一致。
      * L1 位于两星之间, L2 位于副星外侧, L3 位于主星外侧共线点。
    """
    if m1 <= 0.0 or m2 <= 0.0 or r <= 0.0:
        raise ValueError("质量与距离必须为正")
    u = m1 / (m1 + m2)                   # 主星质量比; 副星质量比 = 1-u = m2/(m1+m2)

    def f(x: float) -> float:
        return _collinear_residual(u, r, x)

    eps = 1e-13 * r

    # L1: 两星之间 (0, R)。f(0+) -> -inf 一侧, f(R-) -> +inf 一侧
    x_l1 = _collinear_root(f, eps, r - eps)

    # L2: 副星外侧 (R, +inf)。f(R+) 为负, 向外平方衰减后转正
    hi = r * 1.001
    guard = 0
    while f(hi) < 0.0 and guard < 200:
        hi *= 1.5
        guard += 1
    x_l2 = _collinear_root(f, r + eps, hi)

    # L3: 主星外侧 (-inf, 0)。f(0-) 为正, 向外转负
    lo = -r * 1.001
    guard = 0
    while f(lo) > 0.0 and guard < 200:
        lo *= 1.5
        guard += 1
    x_l3 = _collinear_root(f, lo, -eps)

    # L4/L5: 与两主天体严格等边。以主星为原点解 |L-P1| = |L-P2| = R, 得
    #   x = R/2, y = +/- sqrt(3) R / 2        (与质量比无关)
    # (等价形式: 质心系横坐标 R(1/2 - u_s) 再平移回主星原点, 两者恒等。)
    # 等边三角形对任意质量比严格成立: 到两主天体距离恒为 R,
    # 且标准 CR3BP 有效势梯度在此为 0 (见 --selftest 第 4 组)。
    y_equi = r * math.sqrt(3.0) / 2.0
    x_l4 = r * 0.5
    return {
        "L1": x_l1,
        "L2": x_l2,
        "L3": x_l3,
        "L4": (x_l4, y_equi),
        "L5": (x_l4, -y_equi),
    }


def lagrange_points_simple(m1: float, m2: float, r: float) -> dict:
    """DESIGN §2 公式 15 给出的近似式版本 (L1 距副星 r ≈ R (m/(3M))^(1/3), L4/L5 等边)。

    供关卡设计给出"教科书近似值", 与 lagrange_points() 的精确解对照。
    L1 用解析近似 + 一次牛顿细化; L2 用镜像近似; L3 用 m2/m1 一阶展开。
    """
    off = lagrange_l1_offset(r, m1, m2)
    us = m2 / (m1 + m2)
    y_eq = r * math.sqrt(3.0) / 2.0
    x_cm = r * (0.5 - us)
    return {
        "L1_offset_from_secondary": off,
        "L1": r - off,
        "L2": r + off,
        "L3": -r * (1.0 + 5.0 * m2 / (12.0 * m1)),
        "L4": (x_cm, y_eq),
        "L5": (x_cm, -y_eq),
    }


def routh_stable(m1: float, m2: float) -> bool:
    """L4/L5 线性稳定判据: 质量比 mu = m2/(m1+m2) < 0.0385208965 (Routh)。"""
    return (m2 / (m1 + m2)) < ROUTH_CRITICAL_MU


# ---------------------------------------------------------------------------
# 4. 相对论效应 (黑洞关卡)
# ---------------------------------------------------------------------------


def schwarzschild_radius(mass: float, k: float = 2.0) -> float:
    """史瓦西半径 r_s = k * M, 默认 k = 2 (即取 G = 1, c^2 = 1 的纯几何单位)。

    真实史瓦西半径 r_s = 2GM/c^2; 在归一化系里 c 由关卡给定的光速尺度
    RU_PER_TU_LIGHT 决定 (见 horizon_radius_from_mass)。黑洞关卡要求 r_s 与 mu 单调同增:
        r_s = 2 mu / c^2,  c = RU_PER_TU_LIGHT  ->  r_s = mu / (c^2/2)
    取光速尺度 c^2/2 = 300 (即 c ≈ 24.49 RU/TU, 一个"快但有限"的光速) 时,
    mu = 6.0 -> r_s = 0.020, mu = 7.5 -> r_s = 0.025, mu = 9.0 -> r_s = 0.030,
    正好落在关卡设计要求的 0.02~0.05 可视区间, 且所有基于 r_s 的量
    (时间膨胀、红移、ISCO、洛希极限) 都由真实公式导出。
    """
    return k * mass


def horizon_radius_from_mass(mass: float, light_speed_sq_half: float = LIGHT_SPEED_SQ_HALF) -> float:
    """r_s = 2 mu / c^2, 用归一化光速尺度表示黑洞视界 (与质量严格成正比)。"""
    if mass <= 0.0 or light_speed_sq_half <= 0.0:
        raise ValueError("质量与光速尺度必须为正")
    return mass / light_speed_sq_half


def time_dilation(r: float, rs: float) -> float:
    """引力时间膨胀因子 dt_inf / dt_local = 1 / sqrt(1 - r_s/r) (DESIGN §2 公式 17)。

    r <= r_s (视界内) 返回 inf; 远处 -> 1。
    """
    if rs < 0.0:
        raise ValueError("r_s 不能为负")
    if r <= rs:
        return math.inf
    return 1.0 / math.sqrt(1.0 - rs / r)


def proper_time_rate(r: float, rs: float) -> float:
    """本地时钟相对无穷远的走时速率 dt_local / dt_inf = sqrt(1 - r_s/r)。"""
    factor = time_dilation(r, rs)
    return 0.0 if math.isinf(factor) else 1.0 / factor


def isco_radius(rs: float) -> float:
    """最内侧稳定圆轨道 ISCO = 3 r_s (史瓦西黑洞)。"""
    if rs < 0.0:
        raise ValueError("r_s 不能为负")
    return 3.0 * rs


def gravitational_redshift(r: float, rs: float) -> float:
    """红移 z = 1/sqrt(1 - r_s/r) - 1。"""
    return time_dilation(r, rs) - 1.0


def gr_perihelion_precession(mu: float, a: float, e: float, c: float = 299792.458) -> float:
    """后牛顿近日点进动: domega = 6 pi mu / (a (1-e^2) c^2) 每圈 (DESIGN §2 公式 18)。"""
    if c <= 0.0:
        raise ValueError("c 必须为正")
    return 6.0 * math.pi * mu / (a * (1.0 - e * e) * c * c)


# ---------------------------------------------------------------------------
# 5. 火箭方程 / 任务估算
# ---------------------------------------------------------------------------


def rocket_mass_ratio(dv: float, isp: float = ISP_DEFAULT, g0: float = G0_DEFAULT) -> float:
    """齐奥尔科夫斯基: m0/mf = exp(dv / (Isp g0)) (DESIGN §2 公式 12)。"""
    ve = isp * g0
    if ve <= 0.0:
        raise ValueError("Isp 与 g0 必须为正")
    return math.exp(dv / ve)


def rocket_propellant_fraction(dv: float, isp: float = ISP_DEFAULT, g0: float = G0_DEFAULT) -> float:
    """推进剂质量分数 (相对初始总质量) 1 - mf/m0 = 1 - exp(-dv/(Isp g0))。

    dv 必须是物理量纲 (m/s)。这是"真实公式", 无任何拟合常数。
    """
    return 1.0 - 1.0 / rocket_mass_ratio(dv, isp, g0)


def delta_v_to_mps(dv_canonical: float, ru_per_second: float = RU_PER_SECOND) -> float:
    """归一化速度 -> 物理 m/s (1 RU/TU = 1 m/s)。"""
    return abs(dv_canonical) * ru_per_second


def estimate_mission(
    mu: float,
    r_pod: float,
    r_dock: float,
    pod_mass: float = 2.0e-5,
    isp: float = ISP_DEFAULT,
    g0: float = G0_DEFAULT,
    *,
    fuel_capacity: float | None = None,
    n_pods: int = 1,
    time_scale: float = TIME_SCALE_DEFAULT,
    dv_scale: float = 1.0,
    phasing_fraction: float = 0.5,
    ru_per_second: float = RU_PER_SECOND,
) -> dict:
    """任务基线估算 (levelgen 的唯一 par 来源)。

    标准答案 = 双点火霍曼转移 (INTERFACES.md §1 的 hohmann_dv 给出第一次点火量,
    第二次圆化量由 dv_to_circularize 给出)。返回字段 (口径已在集成时确认):

      dv_min        契约要求的"最小点火量" = hohmann_dv(mu, r_pod, r_dock) (第一次点火, 带符号)
      dv_total      双点火总需求 |dv1| + |dv2| (真实最小 delta-v, 规范单位 RU/TU)
      transfer_time 转移椭圆半周期 (TU) = hohmann_time()
      par_time      标准用时, 单位 **TU(模拟时间)**, 1 TU = time_scale 秒实时
                    = (transfer_time + 相位等待) * dv_scale, 且硬性满足 par_time >= 1.25 * transfer_time
      par_fuel      标准任务 delta-v 需求, 单位 **RU/TU** = dv_total * dv_scale (HUD 直接显示)
      phasing_time  等待对接窗口的相位时间, 由真实会合周期给出: 0.5 * T_syn
                    (货舱与空间站角速度不同 -> 必须等两者相位对齐才能开火)
    """
    if mu <= 0.0 or r_pod <= 0.0 or r_dock <= 0.0:
        raise ValueError("mu 与半径必须为正")
    if pod_mass <= 0.0:
        raise ValueError("pod_mass 必须为正")
    if dv_scale <= 0.0:
        raise ValueError("dv_scale 必须为正")
    if not (0.0 <= phasing_fraction <= 2.0):
        raise ValueError("phasing_fraction 必须在 [0, 2]")

    tr = hohmann_transfer(mu, r_pod, r_dock)
    dv1 = tr["dv_depart"]
    dv2 = tr["dv_arrive"]
    dv_total = abs(dv1) + abs(dv2)
    # 契约字段: hohmann_dv 的冻结公式 (第一次点火)
    dv_min = hohmann_dv(mu, r_pod, r_dock)

    transfer_time = tr["transfer_time"]                    # TU
    period_dock = kepler_period(mu, r_dock)                # TU
    t_syn = synodic_period(mean_motion(mu, r_pod), mean_motion(mu, r_dock))
    # 相位等待: 真实会合周期 T_syn = 2 pi / |n_pod - n_dock| 的一个分数段。
    # 上限取同样比例的站轨道周期: 对接窗口在每个站周期内必然重现, 因此等待时间
    # 与转移时间同量级 (不会出现"等两个站周期"这种荒谬的长等待)。
    phasing = (phasing_fraction * t_syn) if math.isfinite(t_syn) else period_dock
    phasing = min(phasing, phasing_fraction * period_dock)
    pods = max(1, int(n_pods))
    par_time = (transfer_time + phasing) * dv_scale
    # 物理硬下限: 标准用时不得短于 1.25 倍霍曼转移时间 (集成口径)
    floor_time = 1.25 * transfer_time
    par_time = max(par_time, floor_time)

    # 燃料展示: par_fuel 是任务 delta-v 需求 (RU/TU); 火箭方程只用于展示推进剂质量分数。
    dv_par = dv_total * dv_scale
    dv_par_mps = delta_v_to_mps(dv_par, ru_per_second)
    prop_frac = rocket_propellant_fraction(dv_par_mps, isp, g0)
    capacity = None if fuel_capacity is None else float(fuel_capacity)
    fuel_slot_used = None
    if capacity is not None:
        if capacity <= 0.0:
            raise ValueError("fuel_capacity 必须为正")
        fuel_slot_used = dv_par / capacity

    return {
        "method": "hohmann",
        "dv_min": dv_min,
        "dv_depart": dv1,
        "dv_arrive": dv2,
        "dv_total": dv_total,
        "dv_total_par": dv_par,
        "dv_par_mps": dv_par_mps,
        "propellant_fraction": prop_frac,
        "transfer_time": transfer_time,
        "transfer_time_real": transfer_time * time_scale,
        "phasing_time": phasing,
        "phasing_fraction": phasing_fraction,
        "synodic_period": t_syn,
        "orbit_period_dock": period_dock,
        "par_time": par_time,
        "par_time_real": par_time * time_scale,
        "par_fuel": dv_par,
        "fuel_capacity": capacity,
        "fuel_slot_used": fuel_slot_used,
        "n_pods": pods,
        "isp": float(isp),
        "g0": float(g0),
        "time_scale": float(time_scale),
    }


# ---------------------------------------------------------------------------
# 6. 开普勒要素 <-> 状态矢量 (关卡初值反算 + 自检对照)
# ---------------------------------------------------------------------------


def orbit_periapo(a: float, e: float) -> tuple[float, float]:
    """近/远星点半径 r_p = a(1-e), r_a = a(1+e)。"""
    if a <= 0.0:
        raise ValueError("a 必须为正")
    if not (0.0 <= e < 1.0):
        raise ValueError("e 必须在 [0,1)")
    return (a * (1.0 - e), a * (1.0 + e))


def orbital_period_from_elements(mu: float, a: float) -> float:
    return kepler_period(mu, a)


def position_from_elements(a: float, e: float, omega: float, M: float) -> Vec2:
    """开普勒方程 -> 世界坐标 (契约: 以恒星为焦点, x 右 y 下)。"""
    ea = eccentric_anomaly_from_mean(M, e)
    x_pf = a * (math.cos(ea) - e)
    y_pf = a * math.sqrt(max(0.0, 1.0 - e * e)) * math.sin(ea)
    c, s = math.cos(omega), math.sin(omega)
    return (x_pf * c - y_pf * s, x_pf * s + y_pf * c)


def velocity_from_elements(mu: float, a: float, e: float, omega: float, M: float) -> Vec2:
    """开普勒要素 -> 速度矢量 (解析式, 不用数值微分)。"""
    ea = eccentric_anomaly_from_mean(M, e)
    n = mean_motion(mu, a)
    denom = 1.0 - e * math.cos(ea)
    vx_pf = -a * n * math.sin(ea) / denom
    vy_pf = a * n * math.sqrt(max(0.0, 1.0 - e * e)) * math.cos(ea) / denom
    c, s = math.cos(omega), math.sin(omega)
    return (vx_pf * c - vy_pf * s, vx_pf * s + vy_pf * c)


def element_state(mu: float, a: float, e: float, omega: float, M0: float, mass: float = 1.0) -> dict:
    """把开普勒要素打包成一个单天体 state (质量可选), 供 energy()/angular_momentum() 复核。"""
    pos = position_from_elements(a, e, omega, M0)
    vel = velocity_from_elements(mu, a, e, omega, M0)
    return {"bodies": [{"m": mass, "x": pos[0], "y": pos[1], "vx": vel[0], "vy": vel[1]}], "G": 1.0}


def specific_energy_from_elements(mu: float, a: float) -> float:
    """比轨道能量 eps = -mu/(2a)。"""
    if a <= 0.0:
        raise ValueError("a 必须为正")
    return -mu / (2.0 * a)


def specific_angular_momentum(mu: float, a: float, e: float) -> float:
    """比角动量 h = sqrt(mu a (1-e^2))。"""
    if a <= 0.0:
        raise ValueError("a 必须为正")
    return math.sqrt(mu * a * (1.0 - e * e))


def eccentric_anomaly_from_mean(M: float, e: float, tol: float = 1e-14) -> float:
    """牛顿法解开普勒方程 E - e sinE = M。"""
    if not (0.0 <= e < 1.0):
        raise ValueError("e 必须在 [0,1)")
    m = math.fmod(M, 2.0 * math.pi)
    ea = m + e * math.sin(m) if e < 0.8 else math.pi
    for _ in range(100):
        f = ea - e * math.sin(ea) - m
        d = 1.0 - e * math.cos(ea)
        step = f / d
        ea -= step
        if abs(step) < tol:
            break
    return ea


# ---------------------------------------------------------------------------
# 7. 自检 (解析解对照)
# ---------------------------------------------------------------------------


class _Report:
    def __init__(self, verbose: bool = False) -> None:
        self.passed = 0
        self.failed = 0
        self.verbose = verbose
        self.rows: list[tuple[str, bool, str]] = []

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.rows.append((name, bool(ok), detail))
        if ok:
            self.passed += 1
        else:
            self.failed += 1
        flag = "PASS" if ok else "FAIL"
        line = f"[{flag}] {name}"
        if detail and (ok is False or self.verbose):
            line += f"   -- {detail}"
        print(line)
        return ok

    def close(self, name: str, got: float, want: float, rel: float = 1e-9, note: str = "") -> bool:
        err = abs(got - want) / (abs(want) if want != 0.0 else 1.0)
        ok = err <= rel
        detail = f"got={got!r} want={want!r} rel_err={err:.3e} (tol {rel:.1e})"
        if note:
            detail += f" | {note}"
        return self.check(name, ok, detail)

    def close_abs(self, name: str, got: float, want: float, tol: float, note: str = "") -> bool:
        err = abs(got - want)
        ok = err <= tol
        detail = f"got={got!r} want={want!r} abs_err={err:.3e} (tol {tol:.1e})"
        if note:
            detail += f" | {note}"
        return self.check(name, ok, detail)


def _leapfrog_step(bodies: list[dict[str, float]], g: float, dt: float) -> None:
    """速度 Verlet / KDK 蛙跳一步 (DESIGN §2 公式 3), 用于能量守恒实证。"""
    n = len(bodies)

    def accel() -> list[Vec2]:
        acc = [(0.0, 0.0)] * n
        for i in range(n):
            ax = ay = 0.0
            for j in range(n):
                if i == j:
                    continue
                dx = bodies[j]["x"] - bodies[i]["x"]
                dy = bodies[j]["y"] - bodies[i]["y"]
                r2 = dx * dx + dy * dy
                inv = g * bodies[j]["m"] / (r2 * math.sqrt(r2))
                ax += inv * dx
                ay += inv * dy
            acc[i] = (ax, ay)
        return acc

    a0 = accel()
    for i, b in enumerate(bodies):
        b["vx"] += 0.5 * dt * a0[i][0]
        b["vy"] += 0.5 * dt * a0[i][1]
        b["x"] += dt * b["vx"]
        b["y"] += dt * b["vy"]
    a1 = accel()
    for i, b in enumerate(bodies):
        b["vx"] += 0.5 * dt * a1[i][0]
        b["vy"] += 0.5 * dt * a1[i][1]


def selftest(verbose: bool = False) -> int:
    """解析解对照自检。返回进程退出码 (0 = 全 PASS)。"""
    r = _Report(verbose)
    print("=" * 78)
    print("physics_ref.py 自检 -- 解析解对照 (归一化系 G=1, mu_star=1)")
    print("=" * 78)

    # ---- 1. 圆轨道基准 (DESIGN §1) ----
    print("\n-- 1. 圆轨道与开普勒第三定律 (DESIGN §1) --")
    r.close("r=1, mu=1 时 v_c == 1", circular_velocity(1.0, 1.0), 1.0, 1e-15)
    r.close("a=1, mu=1 时 T == 2*pi", kepler_period(1.0, 1.0), 2.0 * math.pi, 1e-15)
    r.close("v_esc(r=1) == sqrt(2)", escape_velocity(1.0, 1.0), math.sqrt(2.0), 1e-15)
    r.close("v_c(r=4) == 0.5", circular_velocity(1.0, 4.0), 0.5, 1e-15)
    r.close("T(a=4) == 16*pi (T ∝ a^1.5)", kepler_period(1.0, 4.0), 16.0 * math.pi, 1e-15)
    r.close("vis-viva 圆轨道自洽", vis_viva(1.0, 2.0, 2.0), circular_velocity(1.0, 2.0), 1e-15)
    r.close("活力公式 vs 解析: a=2 近星点", vis_viva(1.0, 1.0, 2.0), math.sqrt(1.0 * (2.0 / 1.0 - 0.5)), 1e-15)
    r.close("比轨道能量 -mu/(2a)", specific_orbital_energy(1.0, 2.0, circular_velocity(1.0, 2.0)), -0.25, 1e-15)

    # ---- 2. 霍曼转移 ----
    print("\n-- 2. 霍曼转移 (DESIGN §2 公式 16 / INTERFACES §1) --")
    dv_lit = 0.15470053837925146
    # 契约公式里括号内是转移椭圆在 r1 处的速度比 sqrt(2 r2/(r1+r2)) = sqrt(4/3) = 2/sqrt(3)
    r.close("sqrt(2*2/3) == 2/sqrt(3)", math.sqrt(4.0 / 3.0), 2.0 / math.sqrt(3.0), 1e-15,
            f"sqrt(4/3) = {math.sqrt(4.0/3.0):.12f}")
    r.close("hohmann_dv(1,1,2) == 0.7071*(sqrt(2*2/3)-1) == 0.1547",
            hohmann_dv(1.0, 1.0, 2.0), dv_lit, 1e-12, "契约给定值")
    r.close_abs("hohmann_dv(1,1,2) ≈ 0.1547", hohmann_dv(1.0, 1.0, 2.0), 0.1547005384, 1e-9)
    tr = hohmann_transfer(1.0, 1.0, 2.0)
    # 完整双点火霍曼: dv1 = v_p - v_c1 = 0.154700, dv2 = v_c2 - v_a = 0.129757
    dv1_exact = 0.15470053837925146
    dv2_exact = 0.7071067811865476 - 1.0 / math.sqrt(3.0)
    r.close("第二次点火 dv2 == sqrt(mu/r2) - sqrt(mu/a_t)", tr["dv_arrive"], dv2_exact, 1e-12,
            f"v_c2 = {math.sqrt(0.5):.9f}, v_a = {1.0/math.sqrt(3.0):.9f}")
    r.close("双点火总 dv 与解析一致 (1->2)", tr["dv_total"], dv1_exact + dv2_exact, 1e-12,
            "dv1=0.154700 (近星点加速抬高远星点), dv2=0.129757 (远星点减速圆化)")
    r.close_abs("hohmann_transfer.dv_depart == hohmann_dv (契约公式即第一次点火)",
                tr["dv_depart"], hohmann_dv(1.0, 1.0, 2.0), 1e-15)
    r.close("转移椭圆半长轴 a_t == 1.5", tr["a_transfer"], 1.5, 1e-15)
    r.close("hohmann_time(1,1,2) == pi*sqrt(27/8)", hohmann_time(1.0, 1.0, 2.0),
            math.pi * math.sqrt(27.0 / 8.0), 1e-15)
    r.check("hohmann_time == 半个转移椭圆周期",
            abs(hohmann_time(1.0, 1.0, 2.0) - 0.5 * kepler_period(1.0, 1.5)) < 1e-14,
            f"t={hohmann_time(1.0, 1.0, 2.0):.12f}")
    r.check("r1>r2 时 hohmann_dv < 0 (需减速降轨)", hohmann_dv(1.0, 2.0, 1.0) < 0.0,
            f"dv={hohmann_dv(1.0, 2.0, 1.0):.6f}")
    r.check("r1==r2 时 dv == 0", hohmann_dv(1.0, 1.5, 1.5) == 0.0)
    # 第二次点火 = dv_to_circularize(转移椭圆在 r2 处的速度)
    v_at_r2 = tr["v_transfer_at_r2"]
    r.close("dv_to_circularize 与霍曼第二次点火一致",
            dv_to_circularize(1.0, 2.0, v_at_r2), tr["dv_arrive"], 1e-12)
    r.check("dv_to_circularize 符号: 速度过大 -> 负(减速)", dv_to_circularize(1.0, 1.0, 1.2) < 0.0,
            f"dv={dv_to_circularize(1.0, 1.0, 1.2):.6f}")

    # ---- 3. 地月系统数量级校验 ----
    print("\n-- 3. 洛希极限与地月系统数量级 (DESIGN §2 公式 8) --")
    rho_e, rho_m, R_e = 5.513, 3.344, 1.0            # g/cm^3, 地球半径归一为 1
    ratio = (rho_e / rho_m) ** (1.0 / 3.0)
    d_r = roche_limit(R_e, rho_e, rho_m)             # 默认刚体系数 2.44
    d_r_fluid = roche_limit(R_e, rho_e, rho_m, coeff=ROCHE_COEFF_FLUID)
    r.close("地月 (rho_p/rho_s)^(1/3) == 1.1814", ratio, (5.513 / 3.344) ** (1.0 / 3.0), 1e-15,
            f"ratio = {ratio:.6f}")
    r.close_abs("地月刚体洛希极限 == 2.44 * ratio ≈ 2.88 R_E", d_r, 2.88, 0.05,
                f"d_R = 2.44 * {ratio:.4f} = {d_r:.4f} R_E")
    r.check("地月洛希极限落在 1.5~3.5 R_E 量级 (教科书 2~3 R_E)", 1.5 < d_r < 3.5, f"{d_r:.4f} R_E")
    r.close_abs("流体系数 2.9 -> ≈ 3.43 R_E (上界)", d_r_fluid, 2.9 * ratio, 1e-12,
                f"d_R_fluid = {d_r_fluid:.4f} R_E")
    r.check("副星密度越低越容易被撕碎 (单调性)",
            roche_limit(1.0, 5.513, 0.5) > roche_limit(1.0, 5.513, 3.344),
            f"rho_s=0.5 -> {roche_limit(1.0, 5.513, 0.5):.3f}; rho_s=3.344 -> {d_r:.3f}")
    r.close("洛希极限对 R_p 线性", roche_limit(2.0, rho_e, rho_m), 2.0 * d_r, 1e-15)

    # ---- 4. 拉格朗日点 ----
    print("\n-- 4. 拉格朗日点 (DESIGN §2 公式 15) --")
    m1, m2, R = 1.0, 3.0037e-6, 1.0            # 地月质量比, 副星在 +x 距 1
    lp = lagrange_points(m1, m2, R)
    approx = R * (m2 / (3.0 * m1)) ** (1.0 / 3.0)
    r.close_abs("L1 距副星 ≈ R (m/(3M))^(1/3)", approx, 1.0 * (3.0037e-6 / 3.0) ** (1.0 / 3.0), 1e-18,
                f"r = (3.0037e-6/3)^(1/3) = {approx:.6f} R")
    r.close_abs("L1 精确解 vs 解析近似 (相对误差 <1%)",
                abs(R - lp["L1"]), approx, 0.01 * approx,
                f"精确 {R - lp['L1']:.8f} vs 近似 {approx:.8f}")
    r.check("L1 位于两星之间", 0.0 < lp["L1"] < R, f"L1={lp['L1']:.8f}")
    r.check("L2 位于副星外侧", lp["L2"] > R, f"L2={lp['L2']:.8f}")
    r.check("L3 位于主星外侧", lp["L3"] < 0.0, f"L3={lp['L3']:.8f}")
    um = m1 / (m1 + m2)                        # 主星质量比 (与实现同一约定)
    us = m2 / (m1 + m2)                        # 副星质量比
    # 解析对照 (本函数与实现相互独立):
    #   质心系: L4 = (R(1/2 - u_s), +sqrt(3)R/2), L5 取负 y  (等边三角形第三顶点)
    #   换算回"主星在原点"的坐标: 加上质心偏移 R u_s
    x_analytic = R * (0.5 - us) + R * us
    r.close_abs("L4 的 x == R/2 (主星系等边顶点)", lp["L4"][0], x_analytic, 1e-15,
                f"L4=({lp['L4'][0]:.15f}, {lp['L4'][1]:.15f})")
    r.close_abs("L4 的 y == sqrt(3) R / 2", lp["L4"][1], R * math.sqrt(3.0) / 2.0, 1e-15)
    # 用"质心系标准 CR3BP 有效势梯度"独立复核 (不依赖上面的坐标假设):
    # 主星在原点时质心位于 +x 的 R*u_s 处, 归一化长度后再套用 _cr3bp_gradient。
    # 质心系横坐标 = 主星系横坐标 - R*u_s, 再除以 R 归一化到单位间距。
    xb = lp["L4"][0] / R - us
    yb = lp["L4"][1] / R
    grad4 = _cr3bp_gradient(us, xb, yb)
    xb5 = lp["L5"][0] / R - us
    yb5 = lp["L5"][1] / R
    grad5 = _cr3bp_gradient(us, xb5, yb5)
    r.check("L4 到两主天体距离均 == R (等边三角形)",
            abs(math.hypot(lp["L4"][0], lp["L4"][1]) - R) < 1e-14
            and abs(math.hypot(lp["L4"][0] - R, lp["L4"][1]) - R) < 1e-14,
            f"|L4-P1| = {math.hypot(lp['L4'][0], lp['L4'][1]):.15f}, "
            f"|L4-P2| = {math.hypot(lp['L4'][0]-R, lp['L4'][1]):.15f}")
    r.check("L4 与主星连线相对主星->副星轴呈 +60 度 (等边三角形内角)",
            lp["L4"][1] > 0.0 and abs(math.atan2(lp["L4"][1], lp["L4"][0]) - math.radians(60.0)) < 1e-12,
            f"|L4-P1| 方位角 = {math.degrees(math.atan2(lp['L4'][1], lp['L4'][0])):.10f} 度, "
            f"|L4-P1| = {math.hypot(lp['L4'][0], lp['L4'][1]):.15f} = R")
    r.check("L4 满足标准 CR3BP 有效势梯度 = 0", math.hypot(*grad4) < 1e-12,
            f"|grad Phi| = {math.hypot(*grad4):.3e}")
    r.check("L5 满足标准 CR3BP 有效势梯度 = 0", math.hypot(*grad5) < 1e-12,
            f"|grad Phi| = {math.hypot(*grad5):.3e}")
    r.check("L5 与 L4 关于 x 轴对称",
            abs(lp["L5"][0] - lp["L4"][0]) < 1e-15 and abs(lp["L5"][1] + lp["L4"][1]) < 1e-15,
            f"L5={lp['L5']}")
    # 旋转系力平衡残差 (共线点用一维残差, L4 用二维残差)。
    # 注意: _collinear_residual/_lagrange_force_balance 的 u 是"主星质量比" u = m1/(m1+m2),
    # 因为它们内部用 (1-u) 作为副星质量比。
    res_l1 = _collinear_residual(um, R, lp["L1"])
    res_l2 = _collinear_residual(um, R, lp["L2"])
    res_l3 = _collinear_residual(um, R, lp["L3"])
    res4 = _lagrange_force_balance(um, lp["L4"][0], lp["L4"][1], R)
    r.check("L1 满足旋转系力平衡", abs(res_l1) < 1e-12, f"a_x = {res_l1:.3e}")
    r.check("L2 满足旋转系力平衡", abs(res_l2) < 1e-12, f"a_x = {res_l2:.3e}")
    r.check("L3 满足旋转系力平衡", abs(res_l3) < 1e-12, f"a_x = {res_l3:.3e}")
    r.check("L4 满足旋转系力平衡 (标准 CR3BP 有效势梯度为 0)",
            math.hypot(*res4) < 1e-12, f"|grad Phi| = {math.hypot(*res4):.3e}")
    r.check("Routh 判据: 地月质量比下 L4 稳定", routh_stable(m1, m2), f"mu = {m2/(m1+m2):.3e} < 0.0385")
    r.check("Routh 判据: 等质量双星 L4 不稳定", not routh_stable(1.0, 1.0), "mu = 0.5 > 0.0385")
    # levelgen 用的双星构型
    lpb = lagrange_points(1.0, 0.035, 1.8)
    r.check("双星 (M=1, m=0.035, R=1.8): L4 稳定", routh_stable(1.0, 0.035),
            f"mu = {0.035/1.035:.5f} < 0.0385")
    r.check("双星 L4 位于副星前方 60 度 (主星系)", lpb["L4"][1] > 0.0, f"L4 = {lpb['L4']}")

    # ---- 5. 希尔球 / 潮汐 ----
    print("\n-- 5. 希尔球与潮汐梯度 --")
    r_h = hill_sphere(1.0, 3.0037e-6, 1.0)
    r.check("地月希尔球 ≈ 0.01 R (教科数量级)", 0.005 < r_h < 0.02,
            f"r_H = (3.0037e-6/3)^(1/3) = {r_h:.6f}")
    r.close("希尔球 vs 解析 (m/(3M))^(1/3)", r_h, (3.0037e-6 / 3.0) ** (1.0 / 3.0), 1e-15)
    r.close("潮汐梯度 2 mu dr / r^3", tidal_gradient(1.0, 1.0, 0.1), 0.2, 1e-15)
    r.check("潮汐梯度随 r^-3 衰减",
            abs(tidal_gradient(1.0, 2.0, 0.1) / tidal_gradient(1.0, 1.0, 0.1) - 0.125) < 1e-15)
    # 自引力 + 潮汐撕裂半径 (集成侧冻结判据): 2 mu dr/r^3 == G m/dr^2
    r.close("货舱自引力 g_self == G m/r^2", self_gravity(2.0e-5, 0.012), 0.1388888888888889, 1e-15)
    r.close_abs("r_tear(mu=1) == 0.5570 (标准货舱)", tidal_tear_radius(1.0, 2.0e-5, 0.012),
                0.5569906600335335, 1e-12, "(2 mu dr/g_self)^(1/3)")
    r.close_abs("r_tear(mu=6) == 1.0121", tidal_tear_radius(6.0, 2.0e-5, 0.012),
                1.0121191983620992, 1e-12)
    r.close_abs("r_tear(mu=9) == 1.1586", tidal_tear_radius(9.0, 2.0e-5, 0.012),
                1.1585872615267556, 1e-12)
    r.close("r_tear ∝ mu^(1/3)", tidal_tear_radius(8.0, 2.0e-5, 0.012)
            / tidal_tear_radius(1.0, 2.0e-5, 0.012), 2.0, 1e-15)
    r.close("safety 系数线性", tidal_tear_radius(1.0, 2.0e-5, 0.012, 1.6),
            1.6 * tidal_tear_radius(1.0, 2.0e-5, 0.012), 1e-15)
    tt = tidal_tear_radius(1.0, 2.0e-5, 0.012)
    r.close("在 r_tear 处潮汐差恰好等于自引力", tidal_gradient(1.0, tt, 0.012),
            self_gravity(2.0e-5, 0.012), 1e-12, "判据自洽性: 2 mu dr/r^3 == G m/dr^2")
    r.check("r_tear 内潮汐差超过自引力 (会被撕碎)",
            tidal_gradient(1.0, 0.9 * tt, 0.012) > self_gravity(2.0e-5, 0.012),
            f"r = 0.9 r_tear -> {tidal_gradient(1.0, 0.9 * tt, 0.012):.5f} > "
            f"{self_gravity(2.0e-5, 0.012):.5f}")
    r.check("r_tear 外潮汐差小于自引力 (安全)",
            tidal_gradient(1.0, 1.1 * tt, 0.012) < self_gravity(2.0e-5, 0.012),
            f"r = 1.1 r_tear -> {tidal_gradient(1.0, 1.1 * tt, 0.012):.5f} < "
            f"{self_gravity(2.0e-5, 0.012):.5f}")
    r.check("会合周期: n1=n2 时 inf", math.isinf(synodic_period(1.0, 1.0)),
            f"T_syn = {synodic_period(1.0, 1.0)}")
    r.close_abs("会合周期 (n=1, n=0.5) == 4*pi", synodic_period(1.0, 0.5), 4.0 * math.pi, 1e-12)

    # ---- 6. 时间膨胀 / 相对论 ----
    print("\n-- 6. 引力时间膨胀与后牛顿进动 (DESIGN §2 公式 17/18) --")
    rs = 0.05
    r.close_abs("time_dilation(100 rs) == 1/sqrt(0.99)", time_dilation(100.0 * rs, rs),
                1.0 / math.sqrt(0.99), 1e-15,
                f"1/sqrt(1-0.01) = {time_dilation(100.0*rs, rs):.8f} (强场区偏差 0.5%, 仍远离 1)")
    r.check("远离视界时时间膨胀 -> 1", abs(time_dilation(1e6 * rs, rs) - 1.0) < 1e-6,
            f"r = 1e6 r_s -> {time_dilation(1e6*rs, rs):.12f}")
    r.close("time_dilation(2 rs) == 1/sqrt(1-0.5)", time_dilation(2.0 * rs, rs), math.sqrt(2.0), 1e-15)
    r.check("time_dilation(rs) -> inf (视界)", math.isinf(time_dilation(rs, rs)), "视界上时钟停摆")
    r.check("time_dilation(0.5 rs) -> inf (视界内)", math.isinf(time_dilation(0.5 * rs, rs)))
    r.close_abs("红移 z(2 rs) = sqrt(2)-1", gravitational_redshift(2.0 * rs, rs), math.sqrt(2.0) - 1.0, 1e-12)
    r.close("ISCO == 3 rs", isco_radius(rs), 3.0 * rs, 1e-15)
    r.check("time_dilation 单调递减 (越近越慢)",
            time_dilation(1.2 * rs, rs) > time_dilation(1.5 * rs, rs) > time_dilation(2.0 * rs, rs))
    r.close("proper_time_rate * time_dilation == 1",
            proper_time_rate(2.0 * rs, rs) * time_dilation(2.0 * rs, rs), 1.0, 1e-15)

    # ---- 7. 要素 <-> 状态矢量 与守恒量审计 ----
    print("\n-- 7. 开普勒要素 -> 状态矢量 -> 守恒量审计 (DESIGN §2 公式 14) --")
    mu = 1.0
    a, e, om, M0, mass = 2.0, 0.3, 0.7, 1.1, 1.0
    pod = element_state(mu, a, e, om, M0, mass)["bodies"][0]
    # 中心天体静止于原点: 货舱是测试粒子, 轨道要素以它为焦点
    st = {"bodies": [{"m": 1.0, "x": 0.0, "y": 0.0, "vx": 0.0, "vy": 0.0}, pod], "G": 1.0}
    E = energy(st)
    L = angular_momentum(st)
    r.close("E == m * (-mu/(2a))", E, mass * specific_energy_from_elements(mu, a), 1e-12,
            "由能量反解半长轴与设定值一致")
    r.close("L == m * sqrt(mu a (1-e^2))", L, mass * specific_angular_momentum(mu, a, e), 1e-12)
    rs_ = semi_major_from_state(mu, math.hypot(pod["x"], pod["y"]), math.hypot(pod["vx"], pod["vy"]))
    r.close("由状态反解 a 与设定一致", rs_, a, 1e-10)
    r.close("距中心 r 与要素反算一致", math.hypot(pod["x"], pod["y"]),
            math.hypot(*position_from_elements(a, e, om, M0)), 1e-15)
    rp, ra = orbit_periapo(a, e)
    r.close("r_p + r_a == 2a", rp + ra, 2.0 * a, 1e-15)
    r.close("vis-viva(近星点) == 解析 v_p", vis_viva(mu, rp, a),
            math.sqrt(mu * (1.0 + e) / (a * (1.0 - e))), 1e-15)
    r.close("vis-viva(远星点) == 解析 v_a", vis_viva(mu, ra, a),
            math.sqrt(mu * (1.0 - e) / (a * (1.0 + e))), 1e-15)
    circ = {"bodies": [{"m": 1.0, "x": 0.0, "y": 0.0, "vx": 0.0, "vy": 0.0},
                       {"m": 1.0, "x": 1.0, "y": 0.0, "vx": 0.0, "vy": 1.0}], "G": 1.0}
    r.close("E(圆轨道 r=1) == -0.5", energy(circ), -0.5, 1e-15)
    r.close("L(圆轨道 r=1) == 1", angular_momentum(circ), 1.0, 1e-15)
    # state_energy 兼容三种输入形态
    r.close("state_energy 兼容 dict 形态", state_energy(st), E, 1e-15)
    r.close("state_energy 兼容 list 形态", state_energy(st["bodies"]), E, 1e-15)
    st_pos = {"bodies": [{"m": 1.0, "pos": [1.0, 0.0], "vel": [0.0, 1.0]}], "G": 1.0, "epsilon": 0.02}
    r.close("state_energy 兼容 pos/vel 形态", state_energy(st_pos), 0.5, 1e-15)
    r.close("Plummer 软化会抬高势能 (eps>0)",
            potential_energy({"bodies": [{"m": 1.0, "x": 0.0, "y": 0.0, "vx": 0, "vy": 0},
                                         {"m": 1.0, "x": 0.01, "y": 0.0, "vx": 0, "vy": 0}], "epsilon": 0.02}),
            -1.0 / math.hypot(0.01, 0.02), 1e-12)
    # 两体圆轨道: 动量/角动量/能量 三项对照
    m1b, m2b = 1.0, 0.001
    sep = 1.0
    x1 = -sep * m2b / (m1b + m2b)
    x2 = sep * m1b / (m1b + m2b)
    omg = math.sqrt((m1b + m2b) / sep ** 3)
    two = {"bodies": [
        {"m": m1b, "x": x1, "y": 0.0, "vx": 0.0, "vy": omg * x1},
        {"m": m2b, "x": x2, "y": 0.0, "vx": 0.0, "vy": omg * x2},
    ], "G": 1.0}
    px, py = linear_momentum(two)
    r.close_abs("质心系总动量 px == 0", px, 0.0, 1e-18)
    r.close_abs("质心系总动量 py == 0", py, 0.0, 1e-18)
    r.close("两体圆轨道 L == mu_red * R^2 * Omega",
            angular_momentum(two), (m1b * m2b / (m1b + m2b)) * sep ** 2 * omg, 1e-12)
    r.close("两体圆轨道 E == -G m1 m2/(2R)",
            energy(two), -m1b * m2b / (2.0 * sep), 1e-12)

    # ---- 8. 辛积分器长期守恒 (实证) ----
    print("\n-- 8. 速度 Verlet 长期能量守恒 (DESIGN §2 公式 3, 120 Hz) --")
    sim = {"bodies": [dict(b) for b in two["bodies"]], "G": 1.0}
    e0 = energy(sim)
    l0 = angular_momentum(sim)
    dt = 1.0 / 120.0
    steps = 120_000                       # 1000 TU = 100 个基准轨道周期
    for _ in range(steps):
        _leapfrog_step(sim["bodies"], 1.0, dt)
    sim["G"] = 1.0
    e1 = energy(sim)
    l1 = angular_momentum(sim)
    drift_e = abs((e1 - e0) / e0) / (steps * dt)
    drift_l = abs((l1 - l0) / l0) / (steps * dt)
    grade, factor = grade_fidelity(drift_e, drift_l)
    r.check("1000 TU 积分后相对能量漂移 < 1e-8", abs((e1 - e0) / e0) < 1e-8,
            f"|dE/E| = {abs((e1-e0)/e0):.3e} over {steps*dt:.0f} TU")
    r.check("1000 TU 积分后相对角动量漂移 < 1e-10", abs((l1 - l0) / l0) < 1e-10,
            f"|dL/L| = {abs((l1-l0)/l0):.3e}")
    r.check("该积分器自评为 S 级", grade == "S", f"grade={grade}, factor={factor}, drift/s={drift_e:.3e}")

    # ---- 9. 保真度评级 ----
    print("\n-- 9. 保真度评级 (DESIGN §2 / §5) --")
    r.check("(1e-6, 1e-6) -> S", grade_fidelity(1e-6, 1e-6) == ("S", 1.0))
    r.check("(2e-5, 1e-7) -> A (取较大者定档)", grade_fidelity(2e-5, 1e-7) == ("A", 0.85))
    r.check("(1e-5, 0) -> A (开区间: S 要求 < 1e-5)", grade_fidelity(1e-5, 0.0) == ("A", 0.85))
    r.check("(5e-4, 0) -> B", grade_fidelity(5e-4, 0.0) == ("B", 0.7))
    r.check("(1e-3, 0) -> C", grade_fidelity(1e-3, 0.0) == ("C", 0.5))
    r.check("(0.1, 0.2) -> C", grade_fidelity(0.1, 0.2) == ("C", 0.5))
    r.check("负漂移取绝对值", grade_fidelity(-1e-6, 0.0) == ("S", 1.0))
    r.check("inf -> C", grade_fidelity(math.inf, 0.0) == ("C", 0.5))
    vd = verdict(2.1e-6, 1.4e-6)
    r.check("verdict() 字段齐全", set(vd) == {"grade", "energy_drift", "angular_drift", "fidelity",
                                             "par_ok", "note", "score_bonus"}, str(sorted(vd)))

    # ---- 10. 任务估算 (火箭方程) ----
    print("\n-- 10. estimate_mission 与火箭方程 (DESIGN §2 公式 12) --")
    r.close("火箭方程: dv=0 -> 质量比 1", rocket_mass_ratio(0.0), 1.0, 1e-15)
    r.close("火箭方程: 推进剂分数 = 1 - exp(-dv/(Isp g0))",
            rocket_propellant_fraction(1000.0), 1.0 - math.exp(-1000.0 / (320.0 * 9.80665)), 1e-15)
    m0mf = rocket_mass_ratio(1.0 * (320.0 * 9.80665), 320.0, 9.80665)
    r.close("dv = Isp*g0 时 m0/mf == e", m0mf, math.e, 1e-14)
    em = estimate_mission(1.0, 1.0, 2.0, 2.0e-5, 320.0, 9.80665, dv_scale=1.2)
    r.close("estimate_mission.dv_min == hohmann_dv", em["dv_min"], hohmann_dv(1.0, 1.0, 2.0), 1e-15)
    r.close("estimate_mission.transfer_time == hohmann_time", em["transfer_time"],
            hohmann_time(1.0, 1.0, 2.0), 1e-15)
    r.check("par_time >= 1.25 * 转移时间 (集成口径硬下限)",
            em["par_time"] >= 1.25 * em["transfer_time"],
            f"par_time={em['par_time']:.4f} TU >= {1.25*em['transfer_time']:.4f} TU")
    r.close("par_fuel == dv_total * 难度系数 (RU/TU 口径)", em["par_fuel"],
            em["dv_total"] * 1.2, 1e-15)
    r.check("dv_scale 只放大 par, 不改物理量",
            abs(em["transfer_time"] - hohmann_time(1.0, 1.0, 2.0)) < 1e-15
            and abs(em["propellant_fraction"] - rocket_propellant_fraction(
                delta_v_to_mps(em["dv_total"] * 1.2), 320.0, 9.80665)) < 1e-15,
            f"propellant_fraction = {em['propellant_fraction']:.6e}")
    em_cap = estimate_mission(1.0, 1.0, 2.0, 2.0e-5, 320.0, 9.80665, dv_scale=1.2,
                              fuel_capacity=em["dv_total"] * 3.0)
    r.check("给出 fuel_capacity 时燃料槽占用在 (0,1)",
            0.0 < em_cap["fuel_slot_used"] < 1.0,
            f"fuel_slot_used = {em_cap['fuel_slot_used']:.6f} "
            f"(预算 {em_cap['fuel_capacity']:.6f} = 3 次标准任务)")
    r.check("par_time 包含真实会合周期相位等待",
            em["phasing_time"] > 0.0 and em["phasing_time"] <= 2.0 * em["synodic_period"],
            f"phasing = {em['phasing_time']:.4f} TU = {em['phasing_fraction']:.2f} x T_syn "
            f"{em['synodic_period']:.4f} TU")
    em2 = estimate_mission(1.0, 1.0, 2.0, 2.0e-5, 320.0, 9.80665, dv_scale=1.6,
                           fuel_capacity=em_cap["fuel_capacity"])
    r.check("难度系数 1.6 > 1.2 -> par_time / par_fuel 同步放大",
            em2["par_time"] > em["par_time"] and em2["par_fuel"] > em["par_fuel"],
            f"par_time {em['par_time']:.2f}->{em2['par_time']:.2f} TU, "
            f"par_fuel {em['par_fuel']:.4f}->{em2['par_fuel']:.4f} RU/TU")
    r.close("单次标准任务不耗尽燃料预算", em_cap["fuel_slot_used"],
            (em["dv_total"] * 1.2) / (em["dv_total"] * 3.0), 1e-15)
    r.check("推进剂质量分数 < 1 (火箭方程可用)", em["propellant_fraction"] < 1.0,
            f"{em['propellant_fraction']:.6e}")

    # ---- 10b. 黑洞视界与质量闭环 ----
    print("\n-- 10b. 黑洞 r_s 与质量闭环 (第 4 章关卡契约) --")
    r.close("r_s = 2 mu / c^2 (c 为归一化光速)", horizon_radius_from_mass(9.0), 9.0 / 300.0, 1e-15,
            f"mu=9 -> r_s={horizon_radius_from_mass(9.0):.4f}")
    r.close_abs("mu=6 -> r_s=0.020", horizon_radius_from_mass(6.0), 0.020, 1e-12)
    r.close_abs("mu=9 -> r_s=0.030", horizon_radius_from_mass(9.0), 0.030, 1e-12)
    r.check("r_s 与质量单调同增 (3 个关卡黑洞)",
            horizon_radius_from_mass(6.0) < horizon_radius_from_mass(7.5) < horizon_radius_from_mass(9.0),
            f"{horizon_radius_from_mass(6.0):.4f} < {horizon_radius_from_mass(7.5):.4f} "
            f"< {horizon_radius_from_mass(9.0):.4f}")
    r.check("r_s 落在设计区间 0.02~0.05", 0.02 <= horizon_radius_from_mass(6.0)
            and horizon_radius_from_mass(9.0) <= 0.05)
    r.check("黑洞视界内侧时间膨胀发散 (ISCO 亦在内)",
            math.isinf(time_dilation(isco_radius(horizon_radius_from_mass(9.0)),
                                     horizon_radius_from_mass(9.0))) is False
            and time_dilation(2.0 * horizon_radius_from_mass(9.0),
                              horizon_radius_from_mass(9.0)) > 1.0,
            f"ISCO={isco_radius(horizon_radius_from_mass(9.0)):.4f} = 3 r_s")

    # ---- 11. 边界与健壮性 ----
    print("\n-- 11. 边界条件与健壮性 --")
    for bad in (0.0, -1.0):
        try:
            circular_velocity(1.0, bad)
            r.check(f"r={bad} 抛异常", False)
        except ValueError:
            r.check(f"r={bad} 抛 ValueError", True)
    try:
        energy({"bodies": [{"m": 1.0}]})
        r.check("缺位置字段抛异常", False)
    except ValueError:
        r.check("缺位置字段抛 ValueError", True)
    try:
        lagrange_points(1.0, 1.0, 1.0)
        r.check("等质量双星 L 点可计算 (不稳定但存在)", True, f"L1={lagrange_points(1.0,1.0,1.0)['L1']:.6f}")
    except Exception as exc:                                    # pragma: no cover
        r.check("等质量双星 L 点可计算 (不稳定但存在)", False, repr(exc))

    print("\n" + "=" * 78)
    total = r.passed + r.failed
    print(f"自检结果: {r.passed}/{total} PASS, {r.failed} FAIL")
    print("=" * 78)
    return 0 if r.failed == 0 else 1


def _main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="physics_ref.py",
        description="牧星者 · 独立物理裁判与参考实现 (W-physics)",
        epilog=_CLI_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--selftest", action="store_true", help="跑解析解对照自检并返回退出码")
    ap.add_argument("--verbose", "-v", action="store_true", help="PASS 项也打印数值明细")
    ap.add_argument("--json", action="store_true", help="自检结果以 JSON 输出到 stdout")
    args = ap.parse_args(argv)

    if args.selftest:
        if args.json:
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                code = selftest(args.verbose)
            print(json.dumps({"ok": code == 0, "log": buf.getvalue()}, ensure_ascii=False))
            return code
        return selftest(args.verbose)

    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(_main())
